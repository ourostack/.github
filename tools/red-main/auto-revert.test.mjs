import assert from "node:assert/strict";
import { test } from "node:test";
import { OWNERS } from "./red-main.mjs";
import {
  CONFIG, MARKER, analyse, check, classifyFailure, culprit, culprits, decide, distances, fixLanded, fixPrOpen, ignored, landReverts, landable, main,
  markPartial, mentions, parseLog, parseLog1e, readHistory, references, revert, revertBody, revertOf, stepBlock, verdicts,
} from "./auto-revert.mjs";

const NOW = Date.UTC(2026, 10, 20, 0, 40);
const at = (m) => new Date(NOW - m * 60000).toISOString();
const sha = (c) => c.repeat(40);
let ids = 100;
const run = (over = {}) => {
  const id = ids++;
  return { id, run_number: id, workflow_id: 1, name: "ci", path: ".github/workflows/ci.yml", event: "push", status: "completed", conclusion: "failure", run_attempt: 1, head_sha: sha("a"), created_at: at(60), run_started_at: at(60), updated_at: at(30), html_url: `https://x/run/${id}`, ...over };
};

// A main of four commits, oldest first: g (green ci), b1 (PR #11 breaks x.test.ts), u (PR #12, unrelated), n (PR #13, newest).
// ci ran on g (green), b1 (red, x), n (red, x): b1..n share the red. Files: x.test.ts imports src/x.ts; src/x.ts imports src/y.ts.
const FILES = new Set(["test/x.test.ts", "src/x.ts", "src/y.ts", "src/z.ts", "README.md"]);
const SRC = {
  "test/x.test.ts": `import { test } from "node:test";\nimport type { T } from "../src/z.ts";\nimport { x } from "../src/x.ts";\n`,
  "src/x.ts": `import { y } from "./y.js";\nexport const x = y;\n`,
  "src/y.ts": `export const y = 1;\n`,
  "src/z.ts": `export type T = 1;\n`,
};
const COMMITS = [
  { sha: sha("n"), subject: "Newest (#13)", pr: 13, files: ["README.md"] },
  { sha: sha("u"), subject: "Unrelated (#12)", pr: 12, files: ["src/z.ts"] },
  { sha: sha("b"), subject: "Breaks y (#11)", pr: 11, files: ["src/y.ts"] },
];
const src = (over = {}) => ({
  files: async () => FILES,
  read: async (_, p) => SRC[p] ?? null,
  commits: async (base, head) => {
    const order = COMMITS.map((c) => c.sha);
    const from = order.indexOf(head);
    const to = base === sha("g") ? order.length : order.indexOf(base);
    return COMMITS.slice(from, to);
  },
  later: async () => [],
  mergeChecks: async () => ["ci checks"],
  ...over,
});
const TAP = (name, file, extra = "") => [
  `2026-11-19T23:13:09.1Z # Subtest: ${name}`,
  `2026-11-19T23:13:12.2Z not ok 4 - ${name}`,
  "2026-11-19T23:13:12.4Z   ---",
  "2026-11-19T23:13:12.4Z   duration_ms: 15.8",
  `2026-11-19T23:13:12.4Z   location: '/home/runner/work/r/r/${file}:42:3'`,
  "2026-11-19T23:13:12.4Z   error: |-",
  "2026-11-19T23:13:12.4Z     Expected values to be strictly equal:",
  "2026-11-19T23:13:12.4Z     ...",
  `2026-11-19T23:13:12.4Z     ${extra}`,
  "2026-11-19T23:13:12.4Z   ...",
  "2026-11-19T23:13:12.5Z ok 5 - next",
];
// A fake GitHub for runs, jobs and logs: logs[runId] is the failing job's log lines (none: the run is green).
function fakeGitHub(runs, logs, { open = [], checks = {}, dispatched = [] } = {}) {
  const calls = [];
  return {
    calls,
    get: async (p) => {
      calls.push(["get", p]);
      if (p.includes("event=workflow_dispatch")) return { workflow_runs: dispatched };
      if (p.includes("/git/matching-refs/")) return [];
      if (/\/actions\/(workflows\/[^/]+\/)?runs\?/.test(p)) return { workflow_runs: runs.filter((r) => !/created=/.test(p) || true) };
      const jobs = /\/runs\/(\d+)\/jobs/.exec(p);
      if (jobs) return { jobs: logs[jobs[1]] ? [{ id: Number(jobs[1]) * 10, name: "npm test (ubuntu-latest, 3/14)", status: "completed", conclusion: "failure", runner_id: 1, steps: [{ name: "npm test", conclusion: "failure" }] }] : [] };
      if (p.includes("/annotations")) return [];
      if (p.includes("/pulls?state=open")) return open;
      const cr = /\/commits\/(\w+)\/check-runs/.exec(p);
      if (cr) return checks[cr[1]] ?? { check_runs: [] };
      if (/\/pulls\/\d+$/.test(p)) return { node_id: "PR_node" };
      throw new Error(p);
    },
    lines: (p) => {
      calls.push(["lines", p]);
      return (async function* () {
        yield* logs[Number(/jobs\/(\d+)\//.exec(p)[1]) / 10] ?? [];
      })();
    },
    post: async (p, b) => calls.push(["post", p, b]),
    put: async (p, b) => calls.push(["put", p, b]),
    graphql: async (q) => (calls.push(["gql", q.slice(0, 40)]), q.includes("revertPullRequest") ? { revertPullRequest: { revertPullRequest: { id: "N", number: 99, url: "https://x/pull/99" } } } : {}),
  };
}

test("verdict: main is judged by its newest completed run, not its tip; a newer green clears it", () => {
  const green = run({ conclusion: "success", head_sha: sha("g") });
  const red = run({ head_sha: sha("b") });
  const tip = run({ status: "in_progress", conclusion: null, head_sha: sha("n") });
  const [v] = verdicts([tip, red, green]);
  assert.equal(v.state, "red");
  assert.deepEqual(v.reds.map((r) => r.id), [red.id]);
  assert.equal(v.green.id, green.id);
  assert.equal(verdicts([run({ conclusion: "success" }), tip, red, green])[0].state, "green");
  const replaced = run({ conclusion: "cancelled", head_sha: sha("u") });
  assert.equal(verdicts([replaced, red, green])[0].state, "red", "a run replaced by concurrency says nothing");
  const reattempted = run({ status: "in_progress", conclusion: null, run_attempt: 2, partial: true });
  assert.deepEqual(verdicts([reattempted, green])[0].reds.map((r) => r.id), [reattempted.id], "a re-attempted main run keeps its earlier attempt's red");
});

test("verdict: a run cancelled after its failed jobs finished is a red verdict for them", async () => {
  const green = run({ conclusion: "success" });
  const cancelled = run({ conclusion: "cancelled", run_started_at: at(40), updated_at: at(8) });
  const quick = run({ conclusion: "cancelled", run_started_at: at(9), updated_at: at(8) });
  const get = async () => ({ jobs: [{ name: "t", conclusion: "failure" }, { name: "u", conclusion: "cancelled" }] });
  await markPartial("o/r", [quick, cancelled, green], get);
  assert.equal(quick.partial, undefined, "a run that never really started isn't read");
  assert.equal(cancelled.partial, true);
  assert.deepEqual(verdicts([quick, cancelled, green])[0].reds.map((r) => r.id), [cancelled.id]);
});

test("readHistory: as of a past time, later runs are unseen and runs finishing later are still running", async () => {
  const pages = [];
  const runs = [run({ created_at: at(5) }), run({ created_at: at(50), updated_at: at(10) }), run({ conclusion: "success", created_at: at(90), updated_at: at(60) })];
  const got = await readHistory("o/r", async (p) => (pages.push(p), { workflow_runs: runs }), { workflows: ["ci"], asOf: at(20) });
  assert.match(pages[0], /\/actions\/workflows\/ci\.yml\/runs\?branch=main&event=push&per_page=50&page=1&created=%3C%3D/);
  assert.equal(got.length, 2);
  assert.equal(got[0].status, "in_progress");
  assert.equal(pages.length, 1, "a green run on the first page ends the read");
  assert.equal(ignored({ path: ".github/workflows/first-run-gate.yml@refs/heads/main" }, ["first-run-gate"]), true);
});

test("parseLog: node:test's failing tests with their location and error, the YAML's own '...' ending the block", async () => {
  const p = await parseLog([...TAP("migrates", "test/x.test.ts", "see src/y.ts:3"), "\u001b[31m##[error]Process completed with exit code 1.\u001b[0m"]);
  assert.equal(p.tests.length, 1);
  assert.equal(p.tests[0].name, "migrates");
  assert.equal(p.tests[0].location, "/home/runner/work/r/r/test/x.test.ts:42:3");
  assert.match(p.tests[0].text, /src\/y\.ts:3/, "a '...' inside the error doesn't end the block");
  assert.deepEqual(p.errors, ["##[error]Process completed with exit code 1."]);
});

test("mentions: repository files a failure names, by their longest suffix in the tree", () => {
  assert.deepEqual(mentions("at /home/runner/work/r/r/src/x.ts:3 and D:\\a\\r\\r\\src\\y.ts, not node_modules/src/z.ts nor /tmp/q.ts", FILES), ["src/x.ts", "src/y.ts"]);
});

test("references: runtime imports and repository paths, never type-only imports", () => {
  const files = new Set([...FILES, "src/daemon/main.mjs", "test/helpers.ts"]);
  const t = `import type { T } from "../src/z.ts";\nimport { a } from "./helpers.ts";\nexport { b } from "../src/x.js";\nconst args = ["src/daemon/main.mjs"];\nawait import("../src/y.ts");`;
  assert.deepEqual(references("test/x.test.ts", t, files).sort(), ["src/daemon/main.mjs", "src/x.ts", "src/y.ts", "test/helpers.ts"]);
});

test("attribution: the PR closest to the failure is the culprit; type-only and unrelated changes are not", async () => {
  const dist = await distances(["test/x.test.ts"], { read: async (p) => SRC[p], files: FILES });
  assert.deepEqual(Object.fromEntries(dist), { "test/x.test.ts": 0, "src/x.ts": 1, "src/y.ts": 2 });
  assert.equal(culprit(COMMITS, dist).pr, 11);
  const tie = [{ sha: sha("m"), subject: "Also y (#14)", pr: 14, files: ["src/y.ts"] }, ...COMMITS];
  assert.equal(culprit(tie, dist).pr, 14, "a tie goes to the newest");
  assert.equal(culprit([{ sha: sha("q"), subject: "Only (#5)", pr: 5, files: ["docs/a.md"] }], dist).how, "the only pull request in the range");
  assert.equal(culprit(COMMITS.slice(0, 2), dist), null, "nothing reachable and more than one PR: unattributed");
});

test("analyse: a red verdict covering a range of commits names the PR that broke it, and two red runs in a row confirm it", async () => {
  const g = run({ conclusion: "success", head_sha: sha("g") });
  const b = run({ head_sha: sha("b") });
  const n = run({ head_sha: sha("n") });
  const gh = fakeGitHub([n, b, g], { [n.id]: TAP("x works", "test/x.test.ts"), [b.id]: TAP("x works", "test/x.test.ts") });
  const [v] = verdicts([n, b, g]);
  const r = await analyse("o/r", v, { a: gh, src: src() });
  assert.equal(r.results.length, 1);
  const [x] = r.results;
  assert.equal(x.first.id, b.id);
  assert.equal(x.base.id, g.id);
  assert.equal(x.runs, 2);
  assert.equal(x.confirmed, true);
  assert.equal(x.blame.pr, 11);
  const only = await analyse("o/r", verdicts([n, g])[0], { a: fakeGitHub([n, g], { [n.id]: TAP("x works", "test/x.test.ts") }), src: src() });
  assert.equal(only.results[0].blame.pr, 11, "one red run over the whole range still finds #11");
  assert.equal(only.results[0].confirmed, false, "one run of attempt 1 is not confirmed: the rerun decides");
  const verify = (conclusion) => run({ event: "workflow_dispatch", head_branch: `auto-revert/verify-${"n".repeat(12)}`, head_sha: sha("n"), conclusion });
  const again = verify("failure");
  const reproduced = await analyse("o/r", verdicts([n, g])[0], { a: fakeGitHub([n, g], { [n.id]: TAP("x works", "test/x.test.ts"), [again.id]: TAP("x works", "test/x.test.ts") }, { dispatched: [again] }), src: src() });
  assert.equal(reproduced.results[0].confirmed, true, "it failed again in the verify run at the same commit");
  const passed = await analyse("o/r", verdicts([n, g])[0], { a: fakeGitHub([n, g], { [n.id]: TAP("x works", "test/x.test.ts") }, { dispatched: [verify("success")] }), src: src() });
  assert.equal(passed.results[0].flake, true, "it passed there: a flake");
  assert.equal(decide({ ...culprits(passed.results)[0] }, { minutes: 9, minRedMinutes: 0 }).action, "skip");
});

test("analyse: a failure that began in the newer run is blamed on the commits after the older red run only", async () => {
  const g = run({ conclusion: "success", head_sha: sha("g") });
  const b = run({ head_sha: sha("b") });
  const n = run({ head_sha: sha("n") });
  const logs = { [b.id]: TAP("x works", "test/x.test.ts"), [n.id]: [...TAP("x works", "test/x.test.ts"), ...TAP("readme", "README.md")] };
  const r = await analyse("o/r", verdicts([n, b, g])[0], { a: fakeGitHub([n, b, g], logs), src: src() });
  const readme = r.results.find((x) => x.failure.test === "readme");
  assert.equal(readme.first.id, n.id);
  assert.equal(readme.base.id, b.id);
  assert.equal(readme.blame.pr, 13);
  assert.deepEqual(culprits(r.results).map((c) => c.pr), [13, 11], "two breaks in one range: both culprits, reverted in one cycle");
});

test("analyse: a PR already reverted while the failure stayed is not blamed again; the next closest is", async () => {
  const g = run({ conclusion: "success", head_sha: sha("g") });
  const b = run({ head_sha: sha("b") });
  const n = run({ head_sha: sha("n") });
  const logs = { [b.id]: TAP("x works", "test/x.test.ts"), [n.id]: TAP("x works", "test/x.test.ts") };
  const s = src({
    commits: async (base, head) => {
      if (base === sha("b")) return [{ sha: sha("r"), subject: 'Revert "Breaks y (#11)" (#11) (#20)', pr: 20, files: ["src/y.ts"] }];
      return [...COMMITS.slice(2), { sha: sha("o"), subject: "Also x (#10)", pr: 10, files: ["src/x.ts"] }];
    },
  });
  const r = await analyse("o/r", verdicts([n, b, g])[0], { a: fakeGitHub([n, b, g], logs), src: s });
  assert.equal(r.results[0].blame.pr, 10);
  assert.equal(revertOf('Revert "First run (#3877)" (#3969) (#4050)'), 3969);
  assert.equal(revertOf("Fix the build (#4050)"), null);
});

test("an infrastructure-only red is no verdict: the run before it decides", async () => {
  const infra = [job({ steps: [] }), job({ log: "getaddrinfo ENOTFOUND registry.npmjs.org" }), job({ log: "The runner has received a shutdown signal." }), job({ conclusion: "cancelled" }), job({ steps: [{ name: "Run actions/checkout@v7", conclusion: "failure" }] }), job({ unreadable: true }), job({ infra: "pool down" })];
  for (const j of infra) assert.equal(classifyFailure({ conclusion: "failure" }, [j]).infra, true, JSON.stringify(j));
  assert.equal(classifyFailure({ conclusion: "failure" }, [job()]).infra, false);
  const g = run({ conclusion: "success", head_sha: sha("g") });
  const n = run({ head_sha: sha("n") });
  const gh = fakeGitHub([n, g], { [n.id]: ["2026-11-19T23:13:09.1Z ##[error]getaddrinfo ENOTFOUND registry.npmjs.org"] });
  const r = await analyse("o/r", verdicts([n, g])[0], { a: gh, src: src() });
  assert.match(r.infra, /ENOTFOUND/);
});
test("a job that fails with no failing test starts from the files its failing step runs, in the workflow at that commit", async () => {
  const yml = `jobs:\n  native:\n    steps:\n      - name: Build\n        run: make\n      - name: The window covers nothing\n        run: node test/x.test.ts --app "$RUNNER_TEMP/a"\n      - name: Upload\n        uses: actions/upload-artifact@v7\n        with:\n          path: src/z.ts\n`;
  assert.match(stepBlock(yml, "The window covers nothing"), /node test\/x\.test\.ts/);
  assert.doesNotMatch(stepBlock(yml, "The window covers nothing"), /src\/z\.ts/, "the step ends where the next begins");
  assert.match(stepBlock("      - run: npm run check -- --strict\n", "Run npm run check -- --strict"), /npm run check/);
  const g = run({ conclusion: "success", head_sha: sha("g") });
  const n = run({ head_sha: sha("n"), run_attempt: 2 });
  const gh = fakeGitHub([n, g], { [n.id]: ["2026-11-19T23:13:09.1Z ##[error]Process completed with exit code 1."] });
  const jobsGet = gh.get;
  gh.get = async (p) => (/\/jobs\?/.test(p) ? { jobs: [{ id: n.id * 10, name: "native", status: "completed", conclusion: "failure", runner_id: 1, steps: [{ name: "The window covers nothing", conclusion: "failure" }] }] } : jobsGet(p));
  const r = await analyse("o/r", verdicts([n, g])[0], { a: gh, src: src({ read: async (_, p) => (p === ".github/workflows/ci.yml" ? yml : SRC[p] ?? null) }) });
  assert.deepEqual(r.results[0].failure.roots, ["test/x.test.ts"]);
  assert.equal(r.results[0].blame.pr, 11);
});

const job = (over = {}) => ({ name: "test", conclusion: "failure", runner_id: 3, steps: [{ name: "Run tests", conclusion: "failure" }], log: "AssertionError: 1 !== 2", ...over });

test("guards: a fix or revert that landed since, or one that is open, holds the revert; an unconfirmed culprit waits", () => {
  const c = { pr: 11, sha: sha("b"), subject: "Breaks y (#11)", confirmed: true };
  assert.equal(decide(c, { minutes: 0, minRedMinutes: 0 }).action, "revert");
  assert.match(decide(c, { later: [{ sha: sha("f"), subject: "Fix y (main red since #11) (#21)" }], minutes: 0, minRedMinutes: 0 }).reason, /names #11/);
  assert.equal(fixLanded([{ sha: sha("f"), subject: "Fix z (#110)" }], 11), undefined);
  assert.match(decide(c, { openPrs: [{ number: 9, title: "anything", head: { ref: "revert-11-breaks" } }], minutes: 0, minRedMinutes: 0 }).reason, /#9/);
  assert.equal(fixPrOpen([{ number: 3, title: "Fix", body: `after ${sha("b").slice(0, 7)}`, head: { ref: "f" } }], { number: 11 }, sha("b")).number, 3);
  assert.equal(decide({ ...c, confirmed: false }, { minutes: 90, minRedMinutes: 0 }).action, "wait");
  assert.match(decide(c, { minutes: 59, minRedMinutes: 60 }).reason, /under 60m/);
});

test("check: Tandem acts the moment a culprit is confirmed, one revert per culprit, and a dry run changes nothing", async () => {
  const g = run({ conclusion: "success", head_sha: sha("g") });
  const b = run({ head_sha: sha("b"), updated_at: at(35) });
  const n = run({ head_sha: sha("n"), updated_at: at(2) });
  const logs = { [b.id]: TAP("x works", "test/x.test.ts"), [n.id]: TAP("x works", "test/x.test.ts") };
  const cfg = { workflows: ["ci"], minRedMinutes: 0 };
  const dry = fakeGitHub([n, b, g], logs);
  const lines = [];
  await check("o/r", cfg, { a: dry, now: NOW, apply: false, log: (l) => lines.push(l), source: async () => src() });
  assert.ok(lines.some((l) => /would open revert PR "Revert "Breaks y" \(#11\)"/.test(l)), lines.join("\n"));
  assert.ok(!lines.some((l) => /rerun/.test(l)), "a culprit confirmed by two red runs in a row needs no rerun");
  assert.equal(dry.calls.filter((c) => c[0] !== "get" && c[0] !== "lines").length, 0);
  const live = fakeGitHub([n, b, g], logs);
  await check("o/r", cfg, { a: live, now: NOW, apply: true, log() {}, source: async () => src() });
  const writes = live.calls.filter((c) => c[0] !== "get" && c[0] !== "lines").map((c) => (c[0] === "gql" ? c[1].slice(0, 20) : `${c[0]} ${c[1]}`));
  assert.deepEqual(writes, ["mutation($id:ID!,$t:", "mutation($id:ID!,$h:", "post /repos/o/r/issues/99/comments"]);
});

test("check: one red run over the range dispatches its workflow on a verify branch at that commit, never re-runs main's run, and waits", async () => {
  const g = run({ conclusion: "success", head_sha: sha("g") });
  const n = run({ head_sha: sha("n") });
  const gh = fakeGitHub([n, g], { [n.id]: TAP("x works", "test/x.test.ts") });
  const lines = [];
  await check("o/r", { workflows: ["ci"], minRedMinutes: 0 }, { a: gh, now: NOW, apply: true, log: (l) => lines.push(l), source: async () => src() });
  assert.deepEqual(gh.calls.filter((c) => c[0] === "post" || c[0] === "gql").map((c) => [c[1], c[2]]), [
    ["/repos/o/r/git/refs", { ref: `refs/heads/auto-revert/verify-${"n".repeat(12)}`, sha: sha("n") }],
    ["/repos/o/r/actions/workflows/ci.yml/dispatches", { ref: `auto-revert/verify-${"n".repeat(12)}` }],
  ]);
  assert.ok(!gh.calls.some((c) => /rerun|\/attempts\//.test(c[1] ?? "") && c[0] === "post"), "main's run is never re-run");
  assert.ok(lines.some((l) => /culprit #11 .*revert pending: not yet reproduced/.test(l)), lines.join("\n"));
});

test("check: a newer completed green run means main is not red, in one call", async () => {
  const red = run({});
  const gh = fakeGitHub([run({ conclusion: "success" }), red], {});
  const lines = [];
  await check("o/r", { workflows: ["ci"] }, { a: gh, now: NOW, apply: false, log: (l) => lines.push(l), source: async () => src() });
  assert.deepEqual(lines, ["o/r: main is not red"]);
  assert.equal(gh.calls.length, 1);
});

test("the revert body names each failure, where it began and why the PR", async () => {
  const g = run({ conclusion: "success", head_sha: sha("g") });
  const n = run({ head_sha: sha("n"), run_attempt: 2 });
  const r = await analyse("o/r", verdicts([n, g])[0], { a: fakeGitHub([n, g], { [n.id]: TAP("x works", "test/x.test.ts") }), src: src() });
  const [c] = culprits(r.results);
  const body = revertBody({ repo: "o/r", c, run: n, minutes: 12 });
  assert.match(body, /Automatic revert of #11 \(Breaks y\)/);
  assert.match(body, /`x works` \(test\/x\.test\.ts\): first failed in https:\/\/x\/run\/\d+ \(nnnnnnnnn\), passed in https:\/\/x\/run\/\d+ \(ggggggggg\); of the 3 pull requests between, #11 changed src\/y\.ts, 2 references from the failure/);
  assert.ok(body.endsWith(MARKER));
});

test("revert: apply opens it, tries auto-merge without failing when the repo has none, and comments the owner", async () => {
  const c = { pr: 11, subject: "Breaks y (#11)", failures: [] };
  const calls = [];
  const a = {
    get: async () => ({ node_id: "PR_node" }),
    post: async (p, b) => calls.push(["post", p, b]),
    graphql: async (q) => {
      calls.push(["gql", q.slice(0, 30)]);
      if (q.includes("enablePullRequestAutoMerge")) throw new Error("Pull request Auto merge is not allowed for this repository");
      return { revertPullRequest: { revertPullRequest: { id: "N", number: 99, url: "https://x/pull/99" } } };
    },
  };
  const logs = [];
  assert.equal(await revert("ourostack/desk", c, { run: run(), minutes: 3, apply: false, a, log: (l) => logs.push(l) }), null);
  assert.equal(calls.length, 0);
  const made = await revert("ourostack/desk", c, { run: run(), minutes: 3, apply: true, a, log: (l) => logs.push(l) });
  assert.equal(made.number, 99);
  assert.ok(logs.some((l) => /a later tick merges it once its checks are green/.test(l)));
  assert.match(calls.at(-1)[2].body, /Owner: tooling coordinator \(session 4deb13bb\)/);
});

test("land: the tool's own revert merges once its head's required checks are green, never with a failed check", async () => {
  assert.equal(landable({ check_runs: [{ name: "ci checks", status: "completed", conclusion: "success" }] }, ["ci checks"]).ok, true);
  assert.match(landable({ check_runs: [] }, ["ci checks"]).why, /waiting for ci checks/);
  assert.match(landable({ check_runs: [{ name: "ci checks", status: "completed", conclusion: "success" }, { name: "x", status: "completed", conclusion: "failure" }] }, ["ci checks"]).why, /failed/);
  assert.equal(landable({ check_runs: [{ name: "a", status: "in_progress" }] }, null).ok, false);
  const mine = { number: 99, title: 'Revert "Breaks y" (#11)', body: `x\n${MARKER}`, head: { ref: "revert-11-breaks", sha: sha("h") } };
  const other = { number: 98, title: "Revert something", body: "by hand", head: { ref: "revert-5-x", sha: sha("i") } };
  const gh = fakeGitHub([], {}, { checks: { [sha("h")]: { check_runs: [{ name: "ci checks", status: "completed", conclusion: "success" }] } } });
  await landReverts("o/r", [mine, other], { a: gh, required: ["ci checks"], apply: true, log() {} });
  const put = gh.calls.find((c) => c[0] === "put");
  assert.equal(put[1], "/repos/o/r/pulls/99/merge");
  assert.deepEqual({ ...put[2], commit_message: undefined }, { merge_method: "squash", sha: sha("h"), commit_title: 'Revert "Breaks y" (#11) (#99)', commit_message: undefined });
  assert.equal(gh.calls.filter((c) => c[0] === "put").length, 1, "a revert someone else opened is theirs to merge");
});

test("git log parsing: each first-parent commit's files, and its PR only when it is a squash", () => {
  const out = `\x1e${sha("n")}\x1f${sha("u")}\x1f2026-11-19T23:00:00Z\x1fNewest (#3877) (#13)\n\nREADME.md\nsrc/x.ts\n\x1e${sha("m")}\x1f${sha("u")} ${sha("v")}\x1f2026-11-19T22:00:00Z\x1fMerge branch (#7)\n\nsrc/y.ts\n`;
  const cs = parseLog1e(out);
  assert.deepEqual(cs.map((c) => [c.pr, c.files]), [[13, ["README.md", "src/x.ts"]], [null, ["src/y.ts"]]]);
});

test("main --self checks only that repo; a green ci is one call; --as-of never acts", async () => {
  const lines = [];
  const orig = console.log;
  console.log = (l) => lines.push(l);
  try {
    await main(["--self", "teams-microsoft/tandem"], NOW, fakeGitHub([run({ conclusion: "success" })], {}), { source: async () => src() });
  } finally {
    console.log = orig;
  }
  assert.deepEqual(lines, ["auto-revert: dry run (pass --apply to act)", "teams-microsoft/tandem: main is not red", "auto-revert: 1 API calls (1 read, 0 write)"]);
  await assert.rejects(main(["--self", "o/r", "--apply", "--as-of", at(5)], NOW, fakeGitHub([], {})), /never acts/);
});

test("config: Tandem counts only ci, ignores its newest-commit gates, acts at once and runs as its own caller; ourostack repos keep the hour", () => {
  const t = CONFIG.repos["teams-microsoft/tandem"];
  assert.equal(t.enabled, false);
  assert.deepEqual(t.workflows, ["ci"]);
  assert.deepEqual(t.ignoreWorkflows, ["first-run-gate", "basics"]);
  assert.equal(t.minRedMinutes, 0);
  assert.equal(CONFIG.minRedMinutes, 60);
  assert.ok(Object.entries(CONFIG.repos).filter(([r]) => r.startsWith("ourostack/")).every(([, c]) => c.enabled));
  for (const r of ["hackamore", "ouro-ui-core", "m365crawl", "ouro-ui", "ouro-ui-apple", "gatefold"]) assert.ok(OWNERS.repos[`ourostack/${r}`], `${r} has an owner`);
});
