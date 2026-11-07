import assert from "node:assert/strict";
import { test } from "node:test";
import { autoMergeOff, blocker, fmtAge, late, owner, render } from "./pr-clock.mjs";

const NOW = "2026-11-07T20:00:00Z";
const run = (name, status, conclusion = null, startedAt = "2026-11-07T19:40:00Z") => ({ __typename: "CheckRun", name, status, conclusion, startedAt });
const pr = (over = {}, checks = []) => ({
  number: 1,
  title: "A change",
  url: "https://github.com/ourostack/x/pull/1",
  createdAt: "2026-11-07T19:00:00Z",
  isDraft: false,
  body: "",
  headRefName: "fix/thing",
  author: { login: "arimendelow" },
  repository: { nameWithOwner: "ourostack/x", autoMergeAllowed: true },
  mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED",
  reviewDecision: null,
  autoMergeRequest: null,
  mergeQueueEntry: null,
  assignees: { nodes: [] },
  labels: { nodes: [] },
  reviewRequests: { nodes: [] },
  commits: { nodes: [{ commit: { message: "x", statusCheckRollup: { contexts: { nodes: checks } } } }] },
  ...over,
});

test("ages read at a glance", () => {
  assert.equal(fmtAge(45), "45m");
  assert.equal(fmtAge(125), "2h 05m");
  assert.equal(fmtAge(60 * 24 * 3 + 60), "3d 1h");
});

test("a red check names itself", () => {
  const b = blocker(pr({}, [run("lint", "COMPLETED", "SUCCESS"), run("browser (1/6)", "COMPLETED", "FAILURE")]), NOW);
  assert.deepEqual(b, { kind: "red", text: "red: `browser (1/6)`" });
});

test("pending checks say how long, and queued ones say they wait for a runner", () => {
  assert.equal(blocker(pr({}, [run("build", "IN_PROGRESS")]), NOW).text, "checks running: `build` for 20m");
  assert.equal(blocker(pr({}, [run("iPad", "QUEUED")]), NOW).text, "waiting for a runner: `iPad` for 20m");
});

test("mergeable now means merge it, even with an advisory red", () => {
  const b = blocker(pr({ mergeStateStatus: "UNSTABLE" }, [run("contract", "COMPLETED", "FAILURE")]), NOW);
  assert.equal(b.kind, "green");
  assert.match(b.text, /merge now.*advisory red: `contract`/);
  assert.match(blocker(pr({ mergeStateStatus: "CLEAN", autoMergeRequest: { enabledAt: NOW } }), NOW).text, /auto-merge has not fired/);
});

test("a PR published without auto-merge is a finding, except where GitHub offers none", () => {
  assert.equal(autoMergeOff(pr()), true);
  assert.equal(autoMergeOff(pr({ autoMergeRequest: { enabledAt: NOW } })), false);
  assert.equal(autoMergeOff(pr({ repository: { nameWithOwner: "arimendelow/desk", autoMergeAllowed: false } })), false);
  assert.equal(autoMergeOff(pr({ mergeQueueEntry: { state: "QUEUED" } })), false);
  const view = render([pr({ mergeStateStatus: "CLEAN" })], NOW);
  assert.match(view.body, /🟢 green: merge now · ⏸️ auto-merge off/);
  assert.match(view.body, /⏸️ 1 without auto-merge/);
});

test("queue, conflicts, behind, drafts and Ari each get their own blocker", () => {
  assert.equal(blocker(pr({ mergeQueueEntry: { state: "QUEUED", position: 2, enqueuedAt: "2026-11-07T19:15:00Z" } }), NOW).text, "in the merge queue (#2) for 45m");
  assert.equal(blocker(pr({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }), NOW).kind, "conflict");
  assert.equal(blocker(pr({ mergeStateStatus: "BEHIND" }), NOW).kind, "behind");
  assert.equal(blocker(pr({ isDraft: true }), NOW).kind, "draft");
  assert.equal(blocker(pr({ reviewRequests: { nodes: [{ requestedReviewer: { login: "arimendelow" } }] } }), NOW).text, "waiting on Ari");
});

test("owner comes from the Desk-Task line first, then assignees, then the branch", () => {
  assert.equal(owner(pr({ body: "Fixes it.\n\nDesk-Task: agent-capacity/prs-merge" })), "desk `agent-capacity/prs-merge`");
  assert.equal(owner(pr({ assignees: { nodes: [{ login: "slugger" }] } })), "@slugger");
  assert.equal(owner(pr({ author: { login: "dependabot[bot]" } })), "dependabot");
  assert.equal(owner(pr()), "branch `fix/thing`");
});

test("only PRs at 30 minutes or older are late; easiest wins sort first", () => {
  const young = pr({ number: 2, createdAt: "2026-11-07T19:45:00Z" });
  const red = pr({ number: 3, createdAt: "2026-11-07T10:00:00Z" }, [run("t", "COMPLETED", "FAILURE")]);
  const green = pr({ number: 4, mergeStateStatus: "CLEAN" });
  assert.deepEqual(late([young, red, green], NOW).map((r) => r.pr.number), [4, 3]);
});

test("all clear says so, and the title says so too", () => {
  const view = render([pr({ createdAt: "2026-11-07T19:35:00Z" })], NOW);
  assert.equal(view.title, "PRs past 30 minutes: all clear");
  assert.match(view.body, /^## 🟢 All clear/);
  assert.match(view.body, /1 open, the oldest at 25m; 1 will pass 30 minutes soon/);
  assert.match(render([], NOW).body, /No open PRs anywhere/);
});

test("late PRs render one line each, with a count in the title", () => {
  const view = render([pr({ title: "Pipes | in title" }, [run("t", "COMPLETED", "FAILURE")])], NOW);
  assert.equal(view.title, "PRs past 30 minutes: 1");
  const lines = view.body.split("\n").filter((l) => l.startsWith("| 1h"));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Pipes \\\| in title/);
  assert.match(lines[0], /🔴 red: `t`/);
});
