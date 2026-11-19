import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG, act, healTargets, rerunHeal, ignored, main, classifyFailure, evaluate, fixPrOpen, gather, readRedStretch, revertBody } from "./auto-revert.mjs";

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

test("act: a dry run changes nothing; apply reverts, arms a clean merge and comments the owner", async () => {
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
  assert.match(calls[3][2].body, /Owner: tooling coordinator \(session 4deb13bb\)/);
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
      if (p.includes("/annotations")) return [];
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

test("main --self checks only that repo, opted in by the caller", async () => {
  const lines = [];
  const orig = console.log;
  console.log = (l) => lines.push(l);
  try {
    await main(["--self", "teams-microsoft/tandem"], NOW, { get: async () => ({ workflow_runs: [] }) });
  } finally {
    console.log = orig;
  }
  assert.deepEqual(lines, ["auto-revert: dry run (pass --apply to act)", "teams-microsoft/tandem: main is not red", "auto-revert: 1 API calls (1 read, 0 write)"]);
});

test("a job annotated title=infra is never reverted, and gather reads the annotation", async () => {
  assert.equal(classifyFailure({ conclusion: "failure" }, [{ name: "t", conclusion: "failure", infra: "pool down", steps: [{ name: "Run tests", conclusion: "failure" }] }]).infra, true);
  const day = (m) => new Date(NOW - m * 60000).toISOString();
  const runs = [{ id: 5, name: "CI", event: "push", head_sha: SHA, status: "completed", conclusion: "failure", run_attempt: 1, run_started_at: day(100), created_at: day(100), updated_at: day(90), html_url: "https://x/run/5" }];
  const a = {
    get: async (p) => {
      if (p.includes("/actions/runs?")) return { workflow_runs: runs };
      if (p.includes("/jobs?")) return { jobs: [{ id: 1, name: "test", conclusion: "failure", steps: [{ name: "Run tests", conclusion: "failure" }] }] };
      if (p.includes("/annotations")) return [{ title: "infra", message: "pool down" }];
      throw new Error(p);
    },
  };
  const f = await gather("o/r", NOW, a);
  assert.equal(f.sha, undefined, "an unreran red run is rerun first, before any guard is read");
  assert.deepEqual(f.heal, [{ id: 5, name: "CI" }]);
});

test("runner lost, never started, system cancel and annotation text are infra, never reverted", () => {
  const infra = [
    job({ runner_id: 0, steps: [{ name: "Run tests", conclusion: "failure" }] }),
    job({ runner_id: null }),
    job({ log: "The job was not acquired by Runner of type hosted even after multiple attempts" }),
    job({ log: "The operation was canceled." }),
    job({ log: "Runner lost communication with the server" }),
    job({ notes: "The runner has received a shutdown signal. This can happen when the runner service is stopped" }),
    job({ conclusion: "startup_failure" }),
  ];
  for (const j of infra) assert.equal(evaluate(facts({ failedJobs: [j] })).action, "skip", JSON.stringify(j));
  assert.equal(classifyFailure({ conclusion: "failure" }, [job({ runner_id: 42 })]).infra, false);
});

test("annotations that cannot be read mean can't tell: gather flags it and evaluate does not revert", async () => {
  const day = (m) => new Date(NOW - m * 60000).toISOString();
  const runs = [{ id: 5, name: "CI", event: "push", head_sha: SHA, status: "completed", conclusion: "failure", run_attempt: 2, run_started_at: day(100), created_at: day(100), updated_at: day(90), html_url: "https://x/run/5" }];
  const get = (annotations) => async (p) => {
    if (p.includes("/actions/runs?")) return { workflow_runs: runs };
    if (p.includes("/annotations")) return annotations(p);
    if (p.includes("/compare/")) return { ahead_by: 0 };
    if (p.endsWith("/pulls")) return [PR];
    if (p.endsWith(`/commits/${SHA}`)) return { parents: [{}] };
    if (p.includes("/pulls?state=open")) return [];
    if (p.endsWith("/jobs?filter=latest&per_page=100")) return { jobs: [{ id: 1, name: "test", conclusion: "failure", runner_id: 3, steps: [{ name: "Run tests", conclusion: "failure" }] }] };
    if (p.endsWith("/logs")) return "boom";
    if (p.endsWith("/runs/5")) return { id: 5, status: "completed", conclusion: "failure", run_attempt: 2, name: "CI", html_url: "https://x/run/5" };
    throw new Error(p);
  };
  const forbidden = () => Promise.reject(new Error("GET: 403 Resource not accessible by personal access token"));
  const blind = await gather("o/r", NOW, { get: get(forbidden) });
  assert.equal(blind.failedJobs[0].unreadable, true);
  const v = evaluate(blind);
  assert.equal(v.action, "skip");
  assert.match(v.reason, /annotations unreadable, can't tell/);
  assert.equal(evaluate(await gather("o/r", NOW, { get: get(async () => []) })).action, "revert");
});

// A fake main: `shas` newest first, each with one run (a state of "red" or "green"), served by the real list endpoint's paging.
function fakeMain(states, { perRun = 1 } = {}) {
  const runs = [];
  states.forEach((st, i) => {
    for (let k = 0; k < perRun; k++) {
      const t = new Date(NOW - (i * 10 + k) * 60000).toISOString();
      runs.push({ id: 1000 + i * 10 + k, name: `W${k}`, event: "push", head_sha: String(i).padStart(40, "0"), status: "completed", conclusion: st === "red" ? "failure" : "success", run_attempt: 1, run_started_at: t, created_at: t, updated_at: t, html_url: "https://x" });
    }
  });
  const paths = [];
  const get = async (p) => {
    paths.push(p);
    const per = Number(/per_page=(\d+)/.exec(p)[1]);
    const page = Number(/[?&]page=(\d+)/.exec(p)[1]);
    return { total_count: runs.length, workflow_runs: runs.slice((page - 1) * per, page * per) };
  };
  return { get, paths };
}

test("reading a green main costs one call, never a time window", async () => {
  const m = fakeMain(["green", ...Array(60).fill("green")]);
  const r = await readRedStretch("o/r", m.get);
  assert.equal(m.paths.length, 1);
  assert.match(m.paths[0], /per_page=25/);
  assert.ok(!m.paths[0].includes("created="));
  assert.equal(commitsOf(r.runs), 1);
  assert.equal(await gather("o/r", NOW, { get: m.get }), null);
});

for (const n of [1, 3, 12, 40]) {
  test(`a red stretch of ${n} commits reads ceil((${n}+1)/page) pages and stops at the last green commit`, async () => {
    const m = fakeMain([...Array(n).fill("red"), "green", ...Array(80).fill("green")]);
    const r = await readRedStretch("o/r", m.get);
    assert.equal(r.complete, true);
    assert.equal(commitsOf(r.runs), n + 1);
    assert.equal(m.paths.length, Math.floor(n / 25) + 1 + (n % 25 === 24 ? 1 : 0));
  });
}

test("a commit split across two pages is judged whole, and a stretch longer than the cap is reported incomplete", async () => {
  const split = fakeMain(["red", "red", "red", "red", "red", "red", "red", "red", "red", "red", "red", "red", "green", "green"], { perRun: 5 });
  const r = await readRedStretch("o/r", split.get, { perPage: 8 });
  assert.equal(commitsOf(r.runs), 13);
  const endless = fakeMain(Array(100).fill("red"));
  const capped = await readRedStretch("o/r", endless.get, { perPage: 10, maxPages: 3 });
  assert.equal(capped.complete, false);
  assert.equal(endless.paths.length, 3);
});

test("main prints the API calls a run spent", async () => {
  const m = fakeMain(["green", "green"]);
  const lines = [];
  const orig = console.log;
  console.log = (l) => lines.push(l);
  try {
    await main(["--self", "o/r"], NOW, { get: m.get });
  } finally {
    console.log = orig;
  }
  assert.equal(lines.at(-1), "auto-revert: 1 API calls (1 read, 0 write)");
});

test("config: tandem ignores first-run-gate, which gates only the newest commit", () => {
  assert.deepEqual(CONFIG.repos["teams-microsoft/tandem"].ignoreWorkflows, ["first-run-gate"]);
});

// Two commits: the newest has a red gate beside a green CI; the one before is all green.
const gateRun = (sha, name, path, conclusion, i) => ({ id: i, name, path, event: "push", head_sha: sha, status: "completed", conclusion, run_attempt: 1, run_started_at: new Date(NOW - i * 60000).toISOString(), created_at: new Date(NOW - i * 60000).toISOString(), html_url: "https://x" });
const gateMain = (gatePath = ".github/workflows/first-run-gate.yml") => ({
  get: async () => ({ total_count: 3, workflow_runs: [gateRun("a".repeat(40), "First run gate", gatePath, "failure", 1), gateRun("a".repeat(40), "CI", ".github/workflows/ci.yml", "success", 2), gateRun("b".repeat(40), "CI", ".github/workflows/ci.yml", "success", 3)] }),
});

test("an ignored workflow's red does not open a red stretch, so nothing is reverted", async () => {
  assert.equal(await gather("o/r", NOW, gateMain(), { ignore: ["first-run-gate"] }), null);
  const byName = await gather("o/r", NOW, gateMain(".github/workflows/x.yml"), { ignore: ["First run gate"] });
  assert.equal(byName, null);
});

test("without the exclusion, the same red gate is a red stretch; another workflow's red still counts", async () => {
  const r = await readRedStretch("o/r", gateMain().get);
  assert.equal(r.runs.length, 3);
  const other = await readRedStretch("o/r", gateMain(".github/workflows/other.yml").get, { ignore: ["first-run-gate"] });
  assert.equal(other.runs.length, 3);
  assert.ok(other.runs.some((r) => r.conclusion === "failure"));
  assert.ok(!(await readRedStretch("o/r", gateMain().get, { ignore: ["first-run-gate"] })).runs.some((r) => r.conclusion === "failure"));
  assert.equal(ignored({ path: ".github/workflows/first-run-gate.yml@refs/heads/main" }, ["first-run-gate"]), true);
});

test("main --self reads the repo's ignoreWorkflows row: a red first-run-gate is not a red main", async () => {
  const lines = [];
  const orig = console.log;
  console.log = (l) => lines.push(l);
  try {
    await main(["--self", "teams-microsoft/tandem"], NOW, gateMain());
  } finally {
    console.log = orig;
  }
  assert.equal(lines[1], "teams-microsoft/tandem: main is not red");
});

function commitsOf(runs) {
  return new Set(runs.map((r) => r.head_sha)).size;
}

const run = (over = {}) => ({ id: 1, name: "ci", event: "push", head_sha: SHA, status: "completed", conclusion: "failure", run_attempt: 1, created_at: "2026-11-17T11:00:00Z", ...over });

test("heal: main's newest commit's unreran failed runs are rerun once; reran, cancelled, running and older-commit runs are not", () => {
  const old = run({ id: 2, head_sha: "b".repeat(40), created_at: "2026-11-17T10:00:00Z" });
  assert.deepEqual(healTargets([run(), old]), [{ id: 1, name: "ci" }]);
  assert.equal(healTargets([run({ conclusion: "timed_out" })]).length, 1);
  for (const over of [{ run_attempt: 2 }, { conclusion: "cancelled" }, { conclusion: "startup_failure" }, { conclusion: "success" }, { status: "in_progress", conclusion: null }]) assert.deepEqual(healTargets([run(over)]), [], JSON.stringify(over));
  assert.deepEqual(healTargets([]), []);
});

test("heal: a fresh red main is rerun at 1 minute old, before the 60-minute guard; a dry run only says it would", async () => {
  const posts = [];
  const t = new Date(NOW - 60000).toISOString();
  const base = {
    get: async () => ({ total_count: 1, workflow_runs: [run({ id: 9, created_at: t, run_started_at: t, updated_at: t })] }),
    post: async (p) => posts.push(p),
  };
  const lines = [];
  const orig = console.log;
  console.log = (l) => lines.push(l);
  try {
    await main(["--self", "o/r"], NOW, base);
    assert.deepEqual(posts, []);
    assert.ok(lines.some((l) => /would rerun its failed jobs once/.test(l)));
    await main(["--self", "o/r", "--apply"], NOW, base);
  } finally {
    console.log = orig;
  }
  assert.deepEqual(posts, ["/repos/o/r/actions/runs/9/rerun-failed-jobs"]);
  await rerunHeal("o/r", [{ id: 4, name: "ci" }], { apply: true, a: base, log() {} });
  assert.equal(posts.at(-1), "/repos/o/r/actions/runs/4/rerun-failed-jobs");
});

test("heal: a rejected rerun is reported and lets the revert guards decide instead of blocking them", async () => {
  const lines = [];
  const ok = await rerunHeal("o/r", [{ id: 4, name: "ci" }], { apply: true, a: { post: async () => { throw new Error("403 run too old"); } }, log: (l) => lines.push(l) });
  assert.equal(ok, false);
  assert.ok(lines.some((l) => /could not rerun run 4/.test(l)));
  assert.equal(await rerunHeal("o/r", [{ id: 4, name: "ci" }], { apply: true, a: { post: async () => ({}) }, log() {} }), true);
});
