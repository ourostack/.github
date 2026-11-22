import { test } from "node:test";
import assert from "node:assert/strict";
import { repoList, run, waitingOn } from "./yield.mjs";

const NOW = Date.parse("2026-11-22T20:00:00Z");
const old = "2026-11-22T19:50:00Z";
const fake = (tree) => (path) => {
  if (!(path in tree)) throw new Error(`HTTP 404 ${path}`);
  return tree[path];
};
const base = (repo, runs = [], jobs = {}) => ({
  [`repos/${repo}`]: { default_branch: "main" },
  [`repos/${repo}/actions/runs?status=queued&per_page=100`]: { workflow_runs: runs.filter((r) => r.status === "queued") },
  [`repos/${repo}/actions/runs?status=in_progress&per_page=100`]: { workflow_runs: runs.filter((r) => r.status !== "queued") },
  ...Object.fromEntries(Object.entries(jobs).map(([id, j]) => [`repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100`, { jobs: j }])),
});
const mainRun = [{ id: 1, status: "in_progress", event: "push", head_branch: "main" }];
const queuedJob = { 1: [{ name: "build", status: "queued", created_at: old }] };

test("repoList puts the PR's own repository first and dedupes", () => {
  assert.deepEqual(repoList("o/a", "o", ["b", "o/a", "x/c"]), ["o/a", "o/b", "x/c"]);
});

test("a main push with a job queued without a runner makes the pull request wait", () => {
  const w = waitingOn({ repos: ["o/b"], call: fake(base("o/b", mainRun, queuedJob)), now: NOW });
  assert.equal(w.length, 1);
  assert.equal(w[0].job, "build");
});

test("no queued default-branch job, a pull request run, a branch push and a fresh job all let it go", () => {
  const runs = [
    ...mainRun,
    { id: 2, status: "queued", event: "pull_request", head_branch: "feat" },
    { id: 3, status: "queued", event: "push", head_branch: "feat" },
  ];
  const jobs = {
    1: [{ name: "a", status: "in_progress", created_at: old }, { name: "fresh", status: "queued", created_at: "2026-11-22T19:59:50Z" }],
    2: [{ name: "b", status: "queued", created_at: old }],
    3: [{ name: "c", status: "queued", created_at: old }],
  };
  assert.deepEqual(waitingOn({ repos: ["o/b"], call: fake(base("o/b", runs, jobs)), now: NOW }), []);
});

test("merge_group and release runs count", () => {
  const runs = [
    { id: 1, status: "queued", event: "merge_group", head_branch: "gh-readonly-queue/main/pr-1" },
    { id: 2, status: "in_progress", event: "release", head_branch: "v1" },
  ];
  const jobs = { 1: [{ name: "q", status: "queued", created_at: old }], 2: [{ name: "r", status: "queued", created_at: old }] };
  assert.equal(waitingOn({ repos: ["o/b"], call: fake(base("o/b", runs, jobs)), now: NOW }).length, 2);
});

test("run waits, then goes when the queue clears", async () => {
  let t = NOW;
  let jobCalls = 0;
  const tree = fake(base("o/own", mainRun, queuedJob));
  const call = (p) => {
    if (p.includes("/jobs")) return { jobs: [{ name: "build", status: ++jobCalls <= 2 ? "queued" : "in_progress", created_at: old }] };
    return tree(p);
  };
  const logs = [];
  const r = await run({ repo: "o/own", repos: [], call, sleep: async (ms) => (t += ms), clock: () => t, log: (m) => logs.push(m) });
  assert.equal(r.outcome, "clear");
  assert.equal(r.polls, 2);
  assert.match(logs[0], /own run 1 "build"/);
});

test("the PR's own repository's main counts even when it is not in the list", async () => {
  const tree = fake(base("o/own", mainRun, queuedJob));
  const call = (p) => (p.includes("elsewhere") ? (p.endsWith("elsewhere") ? { default_branch: "main" } : { workflow_runs: [] }) : tree(p));
  const r = await run({ repo: "o/own", repos: ["elsewhere"], call, capMs: 30_000, sleep: async () => {}, clock: () => NOW, log() {} });
  assert.equal(r.outcome, "cap");
});

test("the cap proceeds", async () => {
  let t = NOW;
  const r = await run({ repo: "o/own", repos: [], call: fake(base("o/own", mainRun, queuedJob)), capMs: 5 * 60_000, sleep: async (ms) => (t += ms), clock: () => t, log() {} });
  assert.equal(r.outcome, "cap");
  assert.ok(r.waitedMs >= 4 * 60_000 && r.waitedMs <= 5 * 60_000);
});

test("any API error, 403 or 429 proceeds at once", async () => {
  for (const msg of ["HTTP 403", "HTTP 429", "HTTP 500"]) {
    let slept = 0;
    const r = await run({ repo: "o/own", repos: [], call: () => { throw new Error(msg); }, sleep: async () => slept++, log() {} });
    assert.equal(r.outcome, "api-error");
    assert.equal(slept, 0);
  }
});
