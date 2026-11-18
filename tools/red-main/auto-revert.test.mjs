import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG, act, classifyFailure, evaluate, fixPrOpen, gather, revertBody } from "./auto-revert.mjs";

const NOW = Date.UTC(2026, 10, 17, 12, 0);
const SHA = "a".repeat(40);
const PR = { number: 7, title: "Add thing", merged_at: "2026-11-17T09:00:00Z", merge_commit_sha: SHA };
const job = (over = {}) => ({ name: "test", conclusion: "failure", steps: [{ name: "Run tests", conclusion: "failure" }], log: "AssertionError: 1 !== 2", ...over });
const facts = (over = {}) => ({
  repo: "ourostack/desk",
  sha: SHA,
  minutes: 90,
  since: NOW - 90 * 60000,
  laterCommits: 0,
  pulls: [PR],
  parents: 1,
  openPrs: [],
  failedJobs: [job()],
  run: { id: 5, status: "completed", conclusion: "failure", attempt: 2, name: "CI", url: "https://x/run/5" },
  ...over,
});

test("reverts a reproduced, deterministic failure from a single squash-merged PR after 60 minutes", () => {
  const v = evaluate(facts());
  assert.equal(v.action, "revert");
  assert.equal(v.pr.number, 7);
  assert.deepEqual(v.jobs, ["test"]);
});

test("guard: never before main has been red for 60 minutes", () => {
  assert.match(evaluate(facts({ minutes: 59 })).reason, /under 60m/);
  assert.equal(evaluate(facts({ minutes: 60 })).action, "revert");
});

test("guard: never when another commit merged since", () => {
  const v = evaluate(facts({ laterCommits: 1 }));
  assert.equal(v.action, "skip");
  assert.match(v.reason, /merged since/);
});

test("guard: the red commit must be exactly one merged PR and a squash", () => {
  assert.match(evaluate(facts({ pulls: [] })).reason, /not one/);
  assert.match(evaluate(facts({ pulls: [PR, { ...PR, number: 8 }] })).reason, /not one/);
  assert.match(evaluate(facts({ pulls: [{ ...PR, merge_commit_sha: "b".repeat(40) }] })).reason, /not one/);
  assert.match(evaluate(facts({ parents: 2 })).reason, /not a squash/);
});

test("guard: never when a fix or revert PR is already open, this tool's own included", () => {
  const open = (o) => evaluate(facts({ openPrs: [o] }));
  assert.match(open({ number: 9, title: "Fix the build from #7", body: "", head: { ref: "fix-build" } }).reason, /#9/);
  assert.match(open({ number: 9, title: 'Revert "Add thing"', body: "Reverts #7", head: { ref: "x" } }).reason, /#9/);
  assert.match(open({ number: 9, title: "anything", body: "", head: { ref: "revert-7-add-thing" } }).reason, /#9/);
  assert.equal(open({ number: 9, title: "Fix typo in #70", body: "", head: { ref: "typo" } }).action, "revert");
  assert.equal(open({ number: 9, title: "Add feature", body: "", head: { ref: "feat" } }).action, "revert");
  assert.equal(fixPrOpen([{ number: 3, title: "Fix", body: `after ${SHA.slice(0, 7)}`, head: { ref: "f" } }], PR, SHA).number, 3);
});

test("guard: never reverts an infrastructure failure", () => {
  const infra = [
    job({ steps: [] }),
    job({ steps: [{ name: "Set up job", conclusion: "failure" }] }),
    job({ steps: [{ name: "Run actions/checkout@v7", conclusion: "failure" }] }),
    job({ log: "getaddrinfo ENOTFOUND registry.npmjs.org" }),
    job({ log: "System.IO.IOException: No space left on device" }),
    job({ log: "The runner has received a shutdown signal." }),
    job({ log: "fatal: could not read Username for 'https://github.com'" }),
    job({ conclusion: "cancelled" }),
  ];
  for (const j of infra) assert.equal(evaluate(facts({ failedJobs: [j] })).action, "skip", JSON.stringify(j));
  for (const conclusion of ["startup_failure", "timed_out", "cancelled", "action_required"]) {
    assert.match(evaluate(facts({ run: { ...facts().run, conclusion } })).reason, /infrastructure/);
  }
  assert.equal(classifyFailure({ conclusion: "failure" }, [job()]).infra, false);
});

test("a failure not yet reproduced asks for a rerun first; a rerun in progress waits", () => {
  const first = { ...facts().run, attempt: 1 };
  assert.equal(evaluate(facts({ run: first })).action, "rerun");
  assert.match(evaluate(facts({ run: { ...first, status: "in_progress" } })).reason, /in progress/);
});

test("the revert body names the PR, the failing job and the run", () => {
  const b = revertBody({ repo: "o/r", pr: PR, sha: SHA, run: facts().run, jobs: ["test"], minutes: 90 });
  assert.match(b, /#7 \(Add thing\)/);
  assert.match(b, /`test`.*https:\/\/x\/run\/5/);
});

test("config: disabled by default for tandem, enabled for ourostack repos", () => {
  assert.equal(CONFIG.repos["teams-microsoft/tandem"].enabled, false);
  assert.ok(Object.entries(CONFIG.repos).filter(([r]) => r.startsWith("ourostack/")).every(([, c]) => c.enabled));
  assert.equal(CONFIG.minRedMinutes, 60);
});

test("act: a dry run changes nothing; apply reverts, arms a clean merge and wakes the owner", async () => {
  const calls = [];
  const a = {
    get: async (p) => (calls.push(["get", p]), { node_id: "PR_node" }),
    post: async (p, b) => (calls.push(["post", p, b])),
    graphql: async (q) => (calls.push(["gql", q.slice(0, 30)]), q.includes("revertPullRequest") ? { revertPullRequest: { revertPullRequest: { id: "N", number: 12, url: "https://x/pull/12" } } } : {}),
  };
  const v = { action: "revert", pr: PR, jobs: ["test"] };
  const logs = [];
  await act("ourostack/desk", facts(), v, { apply: false, now: NOW, a, log: (l) => logs.push(l) });
  assert.equal(calls.length, 0);
  assert.match(logs[0], /would open revert PR/);
  await act("ourostack/desk", facts(), v, { apply: true, now: NOW, a, log: (l) => logs.push(l) });
  assert.deepEqual(calls.map((c) => c[0]), ["get", "gql", "gql", "post"]);
  assert.ok(logs.some((l) => /^WAKE 4deb13bb/.test(l)));
  assert.match(calls[3][2].body, /Wake/);
});

test("act: a rerun posts rerun-failed-jobs only when applying", async () => {
  const calls = [];
  const a = { post: async (p) => calls.push(p) };
  const v = { action: "rerun", pr: PR };
  await act("o/r", facts(), v, { apply: false, now: NOW, a, log() {} });
  await act("o/r", facts(), v, { apply: true, now: NOW, a, log() {} });
  assert.deepEqual(calls, ["/repos/o/r/actions/runs/5/rerun-failed-jobs"]);
});

test("gather: reads the open red, the commits since and the failed job's log", async () => {
  const day = (m) => new Date(NOW - m * 60000).toISOString();
  const runs = [{ id: 5, name: "CI", event: "push", head_sha: SHA, status: "completed", conclusion: "failure", run_attempt: 2, run_started_at: day(100), created_at: day(100), updated_at: day(90), html_url: "https://x/run/5" }];
  const a = {
    get: async (p) => {
      if (p.includes("/actions/runs?")) return { workflow_runs: runs };
      if (p.includes("/compare/")) return { ahead_by: 0 };
      if (p.endsWith("/pulls")) return [PR];
      if (p.endsWith(`/commits/${SHA}`)) return { parents: [{}] };
      if (p.includes("/pulls?state=open")) return [];
      if (p.endsWith("/jobs?filter=latest&per_page=100")) return { jobs: [{ id: 1, name: "test", conclusion: "failure", steps: [{ name: "Run tests", conclusion: "failure" }] }] };
      if (p.endsWith("/logs")) return "boom";
      if (p.endsWith("/runs/5")) return { id: 5, status: "completed", conclusion: "failure", run_attempt: 2, name: "CI", html_url: "https://x/run/5" };
      throw new Error(p);
    },
  };
  const f = await gather("o/r", NOW, a);
  assert.equal(f.minutes, 90);
  assert.equal(evaluate(f).action, "revert");
  assert.equal(await gather("o/r", NOW, { get: async () => ({ workflow_runs: [{ ...runs[0], conclusion: "success" }] }) }), null);
});
