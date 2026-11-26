import assert from "node:assert/strict";
import { test } from "node:test";
import { InfraError } from "../infra/infra.mjs";
import { gh, autoMergeOff, fetchRetry, fetchState, readGroup, blocker, fmtAge, late, owner, redMains, render, stalledQueues } from "./pr-clock.mjs";

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

test("UNSTABLE with a check still running waits for it instead of saying merge now", () => {
  const b = blocker(pr({ mergeStateStatus: "UNSTABLE" }, [run("lint", "COMPLETED", "SUCCESS"), run("e2e", "IN_PROGRESS")]), NOW);
  assert.equal(b.kind, "pending");
  assert.equal(b.text, "required checks green; `e2e` still running for 20m");
});

test("a private repository's late PR is counted but never named", () => {
  const secret = pr({ title: "Secret plan", repository: { nameWithOwner: "arimendelow/desk", isPrivate: true, autoMergeAllowed: false } });
  const view = render([secret], NOW);
  assert.equal(view.title, "PRs past 30 minutes: 1");
  assert.doesNotMatch(view.body, /Secret plan|arimendelow\/desk/);
  assert.match(view.body, /🔒 1 late PR in private repositories/);
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
  assert.equal(owner(pr({ assignees: { nodes: [{ login: "slugger" }] } })), "`slugger`");
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

const main = (state, over = {}, checks = [], message = "x") => ({
  repository: { nameWithOwner: "ourostack/gatefold", isPrivate: false },
  name: "main",
  commit: { oid: "dbcffdb0123456789", committedDate: "2026-11-07T18:00:00Z", message, statusCheckRollup: state && { state, contexts: { nodes: checks } } },
  ...over,
});

test("a red main is reported with its red checks, age and owner; green or pending mains are not", () => {
  const reds = redMains([
    main("FAILURE", {}, [run("iPad (place)", "COMPLETED", "FAILURE"), run("lint", "COMPLETED", "SUCCESS")], "Fix\n\nDesk-Task: agent-capacity/x"),
    main("SUCCESS", { repository: { nameWithOwner: "ourostack/ok" } }),
    main("PENDING", { repository: { nameWithOwner: "ourostack/running" } }),
    main(null, { repository: { nameWithOwner: "ourostack/no-ci" } }),
  ], NOW);
  assert.equal(reds.length, 1);
  assert.equal(reds[0].age, 120);
  assert.equal(reds[0].text, "red: `iPad (place)`");
  assert.equal(reds[0].owner, "desk `agent-capacity/x`");
  assert.equal(redMains([main("ERROR")], NOW)[0].owner, "its AGENTS.md (CI)");
});

test("a red main shows above the PRs and in the title, and is never all clear", () => {
  const view = render([], NOW, undefined, [main("FAILURE", {}, [run("App", "COMPLETED", "FAILURE")])]);
  assert.match(view.body, /## 🔴 1 red main branch\n/);
  assert.match(view.body, /\| 2h 00m \| \[ourostack\/gatefold\]\(https:\/\/github.com\/ourostack\/gatefold\) `main` \| \[dbcffdb\]/);
  assert.doesNotMatch(view.body, /All clear/);
  assert.equal(view.title, "PRs past 30 minutes: none · 1 red main");
  const late1 = render([pr({}, [run("t", "COMPLETED", "FAILURE")])], NOW, undefined, [main("FAILURE")]);
  assert.equal(late1.title, "PRs past 30 minutes: 1 · 1 red main");
});

test("a private repository's red main is counted but never named", () => {
  const view = render([], NOW, undefined, [main("FAILURE", { repository: { nameWithOwner: "arimendelow/desk", isPrivate: true } })]);
  assert.doesNotMatch(view.body, /arimendelow\/desk/);
  assert.match(view.body, /🔒 1 red main branch in private repositories/);
});

const queue = (entries, over = {}) => ({ configuration: { checkResponseTimeout: 3600 }, entries: { totalCount: entries }, ...over });

test("a queue with entries and no merge past its limit is stalled; healthy and queue-less repositories are not", () => {
  const stalled = main(null, { queue: queue(42), removals: [{ createdAt: "2026-11-07T19:30:00Z", reason: "BRANCH_PROTECTION_FAILURE", actor: { login: "arimendelow" } }] });
  const healthy = main(null, { repository: { nameWithOwner: "ourostack/ok" }, queue: queue(3), commit: { oid: "a", committedDate: "2026-11-07T19:30:00Z" } });
  const empty = main(null, { repository: { nameWithOwner: "ourostack/empty" }, queue: queue(0) });
  const none = main(null, { repository: { nameWithOwner: "ourostack/noqueue" }, queue: null });
  const found = stalledQueues([stalled, healthy, empty, none], NOW);
  assert.deepEqual(found.map((q) => [q.main.repository.nameWithOwner, q.age, q.limit, q.entries]), [["ourostack/gatefold", 120, 60, 42]]);
  assert.equal(stalledQueues([main(null, { queue: queue(1, { configuration: null }) })], NOW)[0].limit, 60);
});

test("a stalled queue shows above the PRs with its removals and in the title, and is never all clear", () => {
  const view = render([], NOW, undefined, [main(null, { queue: queue(42), removals: [{ createdAt: "2026-11-07T19:30:00Z", reason: "BRANCH_PROTECTION_FAILURE", actor: { login: "arimendelow" } }] })]);
  assert.match(view.body, /## 🟣 1 stalled merge queue\n/);
  assert.match(view.body, /\| 2h 00m \(limit 1h 00m\) \| \[ourostack\/gatefold\].*\| 42 \| BRANCH_PROTECTION_FAILURE by arimendelow 30m ago \|/);
  assert.doesNotMatch(view.body, /All clear/);
  assert.equal(view.title, "PRs past 30 minutes: none · 1 stalled queue");
  assert.doesNotMatch(render([], NOW, undefined, [main(null, { queue: queue(0) })]).body, /## 🟣/);
  assert.match(render([], NOW, undefined, [main(null, { queue: null })]).title, /all clear/);
});

test("a private repository's stalled queue is counted but never named", () => {
  const view = render([], NOW, undefined, [main(null, { repository: { nameWithOwner: "arimendelow/desk", isPrivate: true }, queue: queue(5) })]);
  assert.doesNotMatch(view.body, /arimendelow\/desk/);
  assert.match(view.body, /🔒 1 stalled merge queue in private repositories/);
});

test("fetchRetry retries a 504 with backoff, then returns the good response", async () => {
  const seq = [{ status: 504 }, new Error("ETIMEDOUT"), { status: 200 }];
  const waits = [];
  const res = await fetchRetry("u", {}, { sleep: async (ms) => waits.push(ms), doFetch: async () => { const x = seq.shift(); if (x instanceof Error) throw x; return x; } });
  assert.equal(res.status, 200);
  assert.deepEqual(waits, [1000, 2000]);
  const last = await fetchRetry("u", {}, { tries: 2, sleep: async () => {}, doFetch: async () => ({ status: 503 }) });
  assert.equal(last.status, 503);
});

// A fake GraphQL that 504s on any query asking for a big page or several repositories at once.
const fakeRun = (log) => async (query) => {
  const sizes = [...query.matchAll(/pullRequests\(states:OPEN,first:(\d+)/g)].map((m) => +m[1]);
  const names = [...query.matchAll(/name:"([^"]+)"/g)].map((m) => m[1]);
  log.push({ names: names.length, size: Math.max(...sizes) });
  if (Math.max(...sizes) > 5 || names.length > 1) throw new Error("POST /graphql: 504 timeout");
  const data = {};
  for (const m of query.matchAll(/(\w+):repository\(owner:"o",name:"([^"]+)"\)\{[^]*?pullRequests\(states:OPEN,first:(\d+)(?:,after:"(\d+)")?/g)) {
    const [, alias, name, size, after] = m;
    const total = name === "big" ? 7 : 1;
    const start = +(after ?? 0), end = Math.min(total, start + +size);
    data[alias] = { nameWithOwner: `o/${name}`, isPrivate: false, defaultBranchRef: null, pullRequests: { totalCount: total, pageInfo: { hasNextPage: end < total, endCursor: String(end) }, nodes: Array.from({ length: end - start }, (_, k) => ({ number: start + k + 1, url: `${name}${start + k + 1}` })) } };
  }
  return data;
};

test("a query that 504s is split and shrunk until it fits, and every PR is still read", async () => {
  const log = [];
  const { prs } = await fetchState(["o/a", "o/big", "o/c"], fakeRun(log));
  assert.equal(prs.length, 9);
  assert.ok(log.some((l) => l.size <= 5 && l.names === 1));
});

test("a persistent 5xx on one repository still fails loudly", async () => {
  await assert.rejects(readGroup(["o/a"], async () => { throw new Error("POST /graphql: 504 x"); }), /504/);
});

test("pages are small and followed by cursor", async () => {
  const log = [];
  const run = async (q) => { log.push(q); return fakeRun([])(q); };
  const { prs } = await fetchState(["o/big"], run);
  assert.equal(prs.length, 7);
  assert.ok(log.length > 1 && log.every((q) => !q.includes("OPEN,first:50")));
});

const reply = (status, json, headers = {}) => ({ status, ok: status < 400, headers: { get: (k) => headers[k] ?? null }, json: async () => json });
const GQL_BLIP = [{ message: "Something went wrong while executing your query. Please include `E840:2A3B4C:5D6E7F:691D8A1C` when reporting this issue." }];

test("gh passes after one transient GraphQL error", async () => {
  const seq = [reply(200, { errors: GQL_BLIP }), reply(200, { data: { ok: 1 } })];
  const waits = [];
  const json = await gh("/graphql", { token: "t", doFetch: async () => seq.shift(), sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(json.data, { ok: 1 });
  assert.equal(waits.length, 1);
});

test("gh throws InfraError with the request id after two transient failures", async () => {
  let calls = 0;
  await assert.rejects(
    gh("/graphql", { token: "t", doFetch: async () => (calls++, reply(200, { errors: GQL_BLIP })), sleep: async () => {} }),
    (err) => err instanceof InfraError && err.requestId === "E840:2A3B4C:5D6E7F:691D8A1C",
  );
  assert.equal(calls, 2);
  await assert.rejects(
    gh("/graphql", { token: "t", doFetch: async () => reply(503, { message: "unavailable" }, { "x-github-request-id": "ABCD:1234" }), sleep: async () => {} }),
    (err) => err instanceof InfraError && err.requestId === "ABCD:1234",
  );
});

test("gh fails normally on a real error and does not retry it", async () => {
  let calls = 0;
  await assert.rejects(
    gh("/graphql", { token: "t", doFetch: async () => (calls++, reply(200, { errors: [{ message: "Field 'nope' doesn't exist on type 'Query'" }] })), sleep: async () => {} }),
    (err) => !(err instanceof InfraError) && /doesn't exist/.test(err.message),
  );
  assert.equal(calls, 1);
});
