import assert from "node:assert/strict";
import { test } from "node:test";
import { OWNERS } from "./red-main.mjs";
import {
  CONFIG, MARKER, analyse, envFor, ghError, check, classifyFailure, culprit, culprits, decide, distances, fixLanded, fixPrOpen, ignored, knownOnMain, landReverts, landable, main, onlyKnown,
  KNOWN_MARKER, FLAKE_MARKER, codeNames, flakeIssue, reproducedNow, earlierReds, evidence, jobKey, knownBefore, laterPass, loneCleared, messageNamed, openFlakes, softJob, softJobs, markPartial, mentions, parseLog, parseLog1e, PARSE_VERSION, readHistory, references, revert, revertBody, revertData, revertOf, runFailures, runJobs, scannedDirs, settledBy, stepBlock, textNamed, verdicts,
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
  { sha: sha("n"), parent: sha("u"), subject: "Newest (#13)", pr: 13, files: ["README.md"] },
  { sha: sha("u"), parent: sha("b"), subject: "Unrelated (#12)", pr: 12, files: ["src/z.ts"] },
  { sha: sha("b"), parent: sha("g"), subject: "Breaks y (#11)", pr: 11, files: ["src/y.ts"] },
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
function fakeGitHub(runs, logs, { open = [], checks = {}, dispatched = [], jobsOf = {}, comments = [], issues = [] } = {}) {
  const calls = [];
  return {
    calls,
    get: async (p) => {
      calls.push(["get", p]);
      if (p.includes("event=workflow_dispatch")) return { workflow_runs: dispatched };
      if (p.includes("/git/matching-refs/")) return [];
      if (/\/actions\/(workflows\/[^/]+\/)?runs\?/.test(p)) return { workflow_runs: runs.filter((r) => !/created=/.test(p) || true) };
      const jobs = /\/runs\/(\d+)\/jobs/.exec(p);
      if (jobs && jobsOf[jobs[1]]) return { jobs: jobsOf[jobs[1]] };
      if (jobs) return { jobs: logs[jobs[1]] ? [{ id: Number(jobs[1]) * 10, name: "npm test (ubuntu-latest, 3/14)", status: "completed", conclusion: "failure", runner_id: 1, steps: [{ name: "npm test", conclusion: "failure" }] }] : [] };
      if (p.includes("/annotations")) return [];
      if (/\/issues\/\d+\/comments/.test(p)) return comments;
      if (/\/issues\?state=open/.test(p)) return issues;
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
    patch: async (p, b) => calls.push(["patch", p, b]),
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

test("verdict: newer is commit order, not finish time or run number: an older commit's red finishing later says nothing", () => {
  const green = run({ conclusion: "success", head_sha: sha("g") });
  const newer = run({ conclusion: "success", head_sha: sha("n"), updated_at: at(20) });
  const older = run({ head_sha: sha("b"), updated_at: at(5) });
  const order = new Map([[sha("g"), 1], [sha("b"), 2], [sha("n"), 3]]);
  assert.equal(verdicts([older, newer, green], order)[0].state, "green", "b's run numbered after n's, finished after it, still older");
  assert.equal(verdicts([older, newer, green])[0].state, "red", "by run number alone it would be red");
  const tip = run({ status: "in_progress", conclusion: null, head_sha: sha("n") });
  const [v] = verdicts([older, tip, green], order);
  assert.equal(v.state, "red", "the newest commit still running says nothing; the older commit's red stands");
  assert.deepEqual(v.reds.map((r) => r.id), [older.id]);
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

test("verdict: a run cancelled only in a job its retry covered, with its gate job passed, is green", async () => {
  const old = run({ conclusion: "failure", head_sha: sha("o"), updated_at: at(60) });
  const cancelled = run({ conclusion: "cancelled", head_sha: sha("n"), run_started_at: at(40), updated_at: at(8) });
  const jobs = [{ name: "Retry / Tests", conclusion: "success" }, { name: "Tests", conclusion: "cancelled" }, { name: "Real unfold", conclusion: "success" }];
  await markPartial("o/r", [cancelled, old], async () => ({ jobs }));
  assert.equal(cancelled.recovered, true);
  assert.equal(verdicts([cancelled, old])[0].state, "green");
  const bare = run({ conclusion: "cancelled", head_sha: sha("m"), run_started_at: at(40), updated_at: at(8) });
  await markPartial("o/r", [bare, old], async () => ({ jobs: jobs.slice(0, 2) }));
  assert.equal(bare.recovered, false, "no gate job passed, so it stays without a verdict");
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

test("readHistory: a tagRuns workflow's main runs are its runs dispatched on a release tag, never a verify branch or a hand-run on a branch", async () => {
  const pages = [];
  const tagged = (tag, extra = {}) => run({ event: "workflow_dispatch", head_branch: tag, ...extra });
  const runs = [tagged("v0.2.40", { run_number: 9 }), tagged("auto-revert/verify-abc"), tagged("main"), tagged("v0.3.0-alpha.1"), tagged("v0.2.39", { conclusion: "success", run_number: 8 })];
  const got = await readHistory("o/r", async (p) => (pages.push(p), { workflow_runs: p.includes("/mac-guards.yml/") ? runs : [run({ conclusion: "success" })] }), { workflows: ["ci", "mac-guards"], tagRuns: ["mac-guards"] });
  assert.match(pages[0], /\/actions\/workflows\/ci\.yml\/runs\?branch=main&event=push&/, "ci stays push runs on main");
  assert.match(pages[1], /\/actions\/workflows\/mac-guards\.yml\/runs\?event=workflow_dispatch&per_page=50&page=1$/);
  assert.deepEqual(got.filter((r) => r.event === "workflow_dispatch").map((r) => r.head_branch), ["v0.2.40", "v0.2.39"]);
  assert.deepEqual(verdicts(got.filter((r) => r.event === "workflow_dispatch")).map((v) => v.state), ["red"], "a red guard on the newest promoted release is red main");
});

test("readHistory: a bisectRuns workflow's runs dispatched on a bisect branch are read beside its push runs, marked bisect", async () => {
  const pages = [];
  const dispatched = (branch, extra = {}) => run({ event: "workflow_dispatch", head_branch: branch, ...extra });
  const runs = [dispatched("auto-revert/bisect-bbbb"), dispatched("auto-revert/verify-cccc"), dispatched("main")];
  const got = await readHistory("o/r", async (p) => (pages.push(p), { workflow_runs: p.includes("event=workflow_dispatch") ? runs : [run({ conclusion: "success" })] }), { workflows: ["ci", "burst"], bisectRuns: ["burst"] });
  assert.match(pages.at(-1), /\/actions\/workflows\/burst\.yml\/runs\?event=workflow_dispatch&per_page=50&page=1$/);
  assert.equal(pages.filter((p) => p.includes("event=workflow_dispatch")).length, 1, "one page");
  assert.deepEqual(got.filter((r) => r.bisect).map((r) => r.head_branch), ["auto-revert/bisect-bbbb"], "never a verify run or a hand-run");
});

test("check: a bisect run narrows a red range by commit order, and a green one never clears main by its newer run number", async () => {
  // Main g, b (#11), u (#12), n (#13). The workflow ran on g (green) and n (red) only; it bisected the range itself: green at b,
  // red at u, both run after n. The failure names nothing a pull request changed, so only the range can name a culprit.
  const g = run({ conclusion: "success", head_sha: sha("g") });
  const n = run({ head_sha: sha("n"), updated_at: at(2) });
  const bisect = (c, extra) => run({ event: "workflow_dispatch", head_branch: `auto-revert/bisect-${c}`, head_sha: sha(c), ...extra });
  const u = bisect("u", { updated_at: at(1) });
  const b = bisect("b", { conclusion: "success", updated_at: at(1) });
  const logs = { [n.id]: TAP("w works", "test/w.test.ts"), [u.id]: TAP("w works", "test/w.test.ts") };
  const order = new Map([sha("g"), sha("b"), sha("u"), sha("n")].map((x, i) => [x, i + 1]));
  const lines = [];
  await check("o/r", { workflows: ["ci"], bisectRuns: ["ci"], minRedMinutes: 0 }, { a: fakeGitHub([n, g], logs, { dispatched: [b, u] }), now: NOW, apply: false, log: (l) => lines.push(l), source: async () => src({ order: async () => order }) });
  assert.ok(lines.some((l) => /failing since u+ \(run \d+\), passing at b+, 2 runs -> #12/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /would open revert PR "Revert "Unrelated" \(#12\)"/.test(l)), lines.join("\n"));
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

test("a test depends on what it reads as text: a path, path.join's pieces, a quoted name, a non-module's name anywhere (Tandem #4096's rule)", () => {
  const files = new Set(["src/app/shell.tsx", "src/app/other.tsx", "test/fixtures/day.json", "docs/a.md", "test/hui.test.ts", "src/index.ts"]);
  const t = `import fs from "node:fs";\nconst read = (p) => fs.readFileSync(p, "utf8");\nconst shell = read("src/app/shell.tsx");\nconst o = fs.readFileSync(path.join(ROOT, "src", "app", "other.tsx"));\nconst day = load(\"fixtures\" + "/day.json");\n// see docs/a.md; index.ts unquoted says too little\n`;
  assert.deepEqual(references("test/hui.test.ts", t, files).sort(), ["docs/a.md", "src/app/other.tsx", "src/app/shell.tsx", "test/fixtures/day.json"]);
  assert.deepEqual(textNamed(`x "shell.tsx"`, files), ["src/app/shell.tsx"], "a source's name counts in quotes");
  assert.deepEqual(textNamed("shell.tsx day.json", files), ["test/fixtures/day.json"], "a non-module's name counts anywhere, a source's doesn't");
  assert.deepEqual(references("src/app/x.ts", `const a = "shell.tsx";`, files), [], "only a test reads by name");
});

test("a test that scans a directory depends on every file added under it", async () => {
  const files = new Set([...FILES, "flows/agent/a.flow.ts", "test/flows.test.ts"]);
  const t = `const all = fs.readdirSync(path.join(ROOT, "flows", "agent"));`;
  assert.deepEqual(scannedDirs(t, new Set(["flows", "flows/agent", "src"])), ["flows/agent"]);
  assert.deepEqual(scannedDirs(`const s = "flows/agent";`, new Set(["flows/agent"])), [], "naming a directory without scanning it is not reading it");
  const dist = await distances(["test/flows.test.ts"], { read: async (p) => (p === "test/flows.test.ts" ? t : null), files });
  const commits = [{ sha: sha("m"), subject: "Edit (#21)", pr: 21, files: ["flows/agent/a.flow.ts"], added: [] }, { sha: sha("p"), subject: "Add (#20)", pr: 20, files: ["flows/agent/b.flow.ts"], added: ["flows/agent/b.flow.ts"] }];
  const c = culprit(commits, dist);
  assert.equal(c.pr, 20);
  assert.match(c.how, /added flows\/agent\/b\.flow\.ts under flows\/agent\/, which a test 1 reference from the failure scans/);
});

test("PRs tied at the closest file: the one whose change touches the names the failing assertion uses wins, not the newest", async () => {
  const test = `test("rail", () => {\n  assert.match(shell, /railBadge\\(e, \\{ activityNew: railActivityNew/, "Activity's number on the rail is Teams' badge");\n});`;
  const f = { file: "test/hui.test.ts", text: `  error: "Activity's number on the rail is Teams' badge"\n  code: 'ERR_ASSERTION'` };
  const ties = [{ pr: 4089, sha: sha("b"), file: "src/app/shell.tsx", how: "changed src/app/shell.tsx, 1 reference from the failure", distance: 1 }, { pr: 4081, sha: sha("c"), file: "src/app/shell.tsx", how: "changed src/app/shell.tsx, 1 reference from the failure", distance: 1 }];
  const diffs = { [sha("b")]: "+  useEffect(() => (listReady ? markListPaintedAfterFrame() : undefined), [listReady]);", [sha("c")]: "-          count: railBadge(e, { activityNew: railActivityNew, chats: chatCount })\n+          count: railBadge(e, { activityNew: countsHeld ? 0 : railActivityNew })" };
  const s = { read: async () => test, diff: async (x) => diffs[x] };
  const won = await evidence({ ...ties[0], ties }, f, { src: s, testSha: sha("n") });
  assert.equal(won.pr, 4081);
  assert.match(won.how, /of 2 pull requests that did, its change has 3 of the names the failing assertion uses/);
  assert.deepEqual([...codeNames("assert.match(shell, /railBadge/); const row_who = 1; plain words here")].sort(), ["railBadge", "row_who"]);
  assert.equal((await evidence({ ...ties[0], ties }, { ...f, text: "" }, { src: s, testSha: sha("n") })).pr, 4089, "no evidence: the newest still wins");
});

test("a test's graph doesn't follow another test file its sources name: a planner's list of tests isn't code the test runs", async () => {
  // Tandem, 2026-11-26: places-motion-window.test.ts -> its helper -> the WebKit planner -> the test planner, which names
  // native-auth.test.ts in a list -> that test names Windows' EngineHost.cs: a flake was blamed on a Windows change.
  const src = {
    "test/a.test.ts": 'import { h } from "./helpers/h.ts";',
    "test/helpers/h.ts": 'import { plan } from "../../scripts/plan.ts";',
    "scripts/plan.ts": 'export const SLOW = ["test/b.test.ts"];',
    "test/b.test.ts": 'const host = "app/Host.cs";',
    "app/Host.cs": "class Host {}",
  };
  const files = new Set(Object.keys(src));
  const dist = await distances(["test/a.test.ts"], { read: async (p) => src[p] ?? null, files });
  assert.deepEqual(Object.fromEntries(dist), { "test/a.test.ts": 0, "test/helpers/h.ts": 1, "scripts/plan.ts": 2 });
  assert.equal((await distances(["test/b.test.ts"], { read: async (p) => src[p] ?? null, files })).get("app/Host.cs"), 1, "a failing test's own references still count");
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

test("analyse: a failure open past the walk is bisected among the older reds down to the green run, not left beyond the runs read", async () => {
  const g = run({ conclusion: "success", head_sha: sha("g") });
  const b = run({ head_sha: sha("b") });
  const u = run({ head_sha: sha("u") });
  const n = run({ head_sha: sha("n") });
  const logs = { [n.id]: TAP("x works", "test/x.test.ts"), [u.id]: TAP("x works", "test/x.test.ts"), [b.id]: TAP("x works", "test/x.test.ts") };
  const [v] = verdicts([n, u, b, g]);
  const r = await analyse("o/r", v, { a: fakeGitHub([n, u, b, g], logs), src: src(), maxWalk: 1 });
  const [x] = r.results;
  assert.equal(x.first.id, b.id, "it began at b, two runs past the walk");
  assert.equal(x.base.id, g.id);
  assert.equal(x.runs, 3);
  assert.equal(x.blame.pr, 11);
  // Began at u: b, older, passes it.
  const later = await analyse("o/r", v, { a: fakeGitHub([n, u, b, g], { ...logs, [b.id]: TAP("y works", "test/y.test.ts") }), src: src(), maxWalk: 1 });
  const y = later.results.find((z) => z.failure.key === x.failure.key);
  assert.equal(y.first.id, u.id);
  assert.equal(y.base.id, b.id);
  assert.equal(y.blame.pr, 12, "the only pull request between b and u");
  // Failing at the green run too: it began before the range, as before.
  const before = await analyse("o/r", verdicts([n, u, b, g])[0], { a: fakeGitHub([n, u, b, g], { ...logs, [g.id]: TAP("x works", "test/x.test.ts") }), src: src(), maxWalk: 1 });
  assert.equal(before.results[0].why, "where it began is beyond the runs read");
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
  assert.equal(decide({ ...culprits(passed.results)[0] }, { minutes: 9, minRedMinutes: 0 }).action, "flake");
});

test("analyse: a failure that began in the newer run is blamed on the commits after the older red run only", async () => {
  const g = run({ conclusion: "success", head_sha: sha("g") });
  const b = run({ head_sha: sha("b") });
  const n = run({ head_sha: sha("n") });
  const logs = { [b.id]: TAP("x works", "test/x.test.ts"), [n.id]: [...TAP("x works", "test/x.test.ts"), ...TAP("readme", "README.md")] };
  const reads = async (_, p) => (p === "test/x.test.ts" ? `${SRC[p]}readFileSync("README.md");\n` : SRC[p] ?? null);
  const r = await analyse("o/r", verdicts([n, b, g])[0], { a: fakeGitHub([n, b, g], logs), src: src({ read: reads }) });
  const readme = r.results.find((x) => x.failure.test === "readme");
  assert.equal(readme.first.id, n.id);
  assert.equal(readme.base.id, b.id);
  assert.equal(readme.blame.pr, 13);
  assert.deepEqual(culprits(r.results).map((c) => c.pr), [13, 11], "two breaks in one range: both culprits, reverted in one cycle");
});

test("analyse: a list judge's red (Tandem's WebKit burst) is a failure per case, each traced to the merge that began it", async () => {
  const judged = (cs) => cs.map(([c, why]) => `2026-11-25T10:33:20.1Z ##[error]webkit failed test/x.test.ts:${c}, which test/webkit-known-failing.json doesn't list: ${why}`);
  const p = await parseLog([...judged([["x works", "Expected values to be strictly equal"]]), "##[error]webkit failed test/x.test.ts, which test/webkit-known-failing.json doesn't list: 2 subtests failed", "##[error]Process completed with exit code 1."]);
  assert.deepEqual(p.tests.map((t) => [t.name, t.location]), [["x works", "test/x.test.ts"], ["test/x.test.ts", "test/x.test.ts"]], "a case, and a file listed whole");
  const g = run({ conclusion: "success", head_sha: sha("g") });
  const b = run({ head_sha: sha("b") });
  const n = run({ head_sha: sha("n") });
  // The burst stayed red from b on one case; n's run fails a new one as well. Keyed by the judge's step, both were one failure.
  const logs = { [b.id]: judged([["x works", "Expected values to be strictly equal"]]), [n.id]: judged([["x works", "Expected values to be strictly equal"], ["readme", "see README.md"]]) };
  const reads = async (_, p) => (p === "test/x.test.ts" ? `${SRC[p]}readFileSync("README.md");\n` : SRC[p] ?? null);
  const r = await analyse("o/r", verdicts([n, b, g])[0], { a: fakeGitHub([n, b, g], logs), src: src({ read: reads }) });
  const readme = r.results.find((x) => x.failure.test === "readme");
  assert.equal(readme.first.id, n.id);
  assert.equal(readme.base.id, b.id);
  assert.equal(readme.blame.pr, 13);
  assert.deepEqual(culprits(r.results).map((c) => c.pr), [13, 11], "each case's own break, both reverted in one cycle");
});

test("analyse: a cached parse from an older parseLog is read again, so a burst red before #482 shows the cases it failed", async () => {
  const judged = (c) => [`##[error]webkit failed test/x.test.ts:${c}, which test/webkit-known-failing.json doesn't list: see README.md`];
  const g = run({ conclusion: "success", head_sha: sha("g") });
  const b = run({ head_sha: sha("b") });
  const n = run({ head_sha: sha("n") });
  // b's job was cached by the old parser: no tests. Read as such, the case began at n and #13 took the blame.
  const stale = { jobs: { [b.id * 10]: { tests: [], errors: ["##[error]Process completed with exit code 1."] } } };
  const r = await analyse("o/r", verdicts([n, b, g])[0], { a: fakeGitHub([n, b, g], { [b.id]: judged("readme"), [n.id]: judged("readme") }), src: src(), cache: stale });
  const [x] = r.results;
  assert.equal(x.first.id, b.id, "the stale entry is parsed again: the case failed at b already");
  assert.equal(stale.jobs[b.id * 10].v, PARSE_VERSION, "and cached again at this version");
});

test("cache: a completed run's jobs and a failed job's annotations are read once, and again only for an unfinished run", async () => {
  const jobsOf = (id, status) => [{ id: id * 10, name: "build", status, conclusion: status === "completed" ? "failure" : null, runner_id: 1, steps: [], html_url: "x" }];
  const cache = {};
  const done = run({ head_sha: sha("b") });
  const going = run({ status: "in_progress", conclusion: null, head_sha: sha("n") });
  const gh = () => fakeGitHub([going, done], {}, { jobsOf: { [done.id]: jobsOf(done.id, "completed"), [going.id]: jobsOf(going.id, "in_progress") } });
  const reads = (a, re) => a.calls.filter(([k, p]) => k === "get" && re.test(p)).length;
  const first = gh();
  const [a] = [first];
  for (const r of [done, going]) await runFailures("o/r", r, { a, files: new Set(), cache });
  const second = gh();
  for (const r of [done, going]) await runFailures("o/r", r, { a: second, files: new Set(), cache });
  assert.equal(reads(first, /\/jobs\?/), 2);
  assert.equal(reads(first, /annotations/), 1, "only the finished job has annotations to read");
  assert.equal(reads(second, /\/jobs\?/), 1, "the unfinished run's jobs are read again, the completed run's are not");
  assert.equal(reads(second, /annotations/), 0);
  assert.equal(cache.runJobs[`${done.id}/1/1`][0].html_url, undefined);
  assert.equal(await runJobs((p) => second.get(p), cache, "o/r", done).then((j) => j.length), 1);
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

test("a failing test file is blamed only on a PR that changes its own import graph, not a file its failure merely names (Tandem #6797)", async () => {
  const files = new Set([...FILES, "test/helpers/reply-box.ts", "test/other-window.test.ts"]);
  const g = run({ conclusion: "success", head_sha: sha("g") });
  const n = run({ head_sha: sha("n") });
  const gh = () => fakeGitHub([n, g], { [n.id]: TAP("x works", "test/x.test.ts", "see test/helpers/reply-box.ts:9") });
  const named = { sha: sha("n"), subject: "Reply box (#6797)", pr: 6797, files: ["test/helpers/reply-box.ts", "test/other-window.test.ts"] };
  const only = async (commits) => (await analyse("o/r", verdicts([n, g])[0], { a: gh(), src: src({ files: async () => files, commits: async () => commits }) })).results[0];
  const one = await only([named]);
  assert.equal(one.blame, null, "the range's one PR changed only a file the test doesn't import");
  assert.match(one.why, /#6797 changed test\/helpers\/reply-box\.ts, which test\/x\.test\.ts does not import or read \(its import graph is 3 files\), so it is cleared/);
  const two = await only([named, { sha: sha("b"), subject: "Breaks y (#11)", pr: 11, files: ["src/y.ts"] }]);
  assert.equal(two.blame.pr, 11, "a PR inside the graph is still blamed, and the one outside is passed over");
  const self = await only([named, { sha: sha("b"), subject: "Edits the test (#12)", pr: 12, files: ["test/x.test.ts"] }]);
  assert.equal(self.blame.pr, 12);
});

test("a file the failure's message names by its bare name names the pull request that changed it, before any import is followed", async () => {
  // test/workflow-checkout.test.ts reads the fail-fast action's file and scans the workflows. Of 7 pull requests in the
  // range, #34 changed .github/workflows/windows-tray.yml, the file its message names; #35 changed the action, 1 reference away.
  const files = new Set([...FILES, "test/workflow-checkout.test.ts", ".github/workflows/windows-tray.yml", ".github/workflows/ci.yml", ".github/actions/pr-fail-fast/action.yml", "docs/ci/windows-tray.yml"]);
  const reads = { ...SRC, "test/workflow-checkout.test.ts": `const action = read(".github/actions/pr-fail-fast/action.yml");\nfor (const wf of fs.readdirSync(".github/workflows")) test(wf, () => {});\n` };
  const range = [
    { sha: sha("7"), parent: sha("6"), subject: "Docs (#37)", pr: 37, files: ["README.md"] },
    { sha: sha("6"), parent: sha("5"), subject: "Types (#36)", pr: 36, files: ["src/z.ts"] },
    { sha: sha("5"), parent: sha("4"), subject: "Fail fast (#35)", pr: 35, files: [".github/actions/pr-fail-fast/action.yml"] },
    { sha: sha("4"), parent: sha("3"), subject: "Tray build (#34)", pr: 34, files: [".github/workflows/windows-tray.yml"] },
    { sha: sha("3"), parent: sha("2"), subject: "Ci (#33)", pr: 33, files: [".github/workflows/ci.yml"] },
    { sha: sha("2"), parent: sha("1"), subject: "Readme (#32)", pr: 32, files: ["README.md"] },
    { sha: sha("1"), parent: sha("g"), subject: "Other (#31)", pr: 31, files: ["src/x.ts"] },
  ];
  const g = run({ conclusion: "success", head_sha: sha("g") });
  const n = run({ head_sha: sha("7") });
  const fail = [
    "# Subtest: windows-tray.yml",
    "not ok 12 - windows-tray.yml",
    "  ---",
    "  duration_ms: 1.2",
    "  location: '/home/runner/work/r/r/test/workflow-checkout.test.ts:2:39'",
    "  failureType: 'testCodeFailure'",
    "  error: 'windows-tray.yml: no action is downloaded from this repository'",
    "  code: 'ERR_ASSERTION'",
    "  stack: |-",
    "    TestContext.<anonymous> (file:///home/runner/work/r/r/test/workflow-checkout.test.ts:2:39)",
    "  ...",
  ];
  const blame = async (commits) => (await analyse("o/r", verdicts([n, g])[0], { a: fakeGitHub([n, g], { [n.id]: fail }), src: src({ files: async () => files, read: async (_, p) => reads[p] ?? null, commits: async () => commits }) })).results[0].blame;
  const one = await blame(range);
  assert.equal(one.pr, 34, `${one.pr}: ${one.how}`);
  assert.equal(one.how, "changed .github/workflows/windows-tray.yml, which the failure's message names");
  assert.deepEqual(one.ties.map((t) => t.pr), [34]);
  // Two pull requests changed a windows-tray.yml: both are suspects, so a repository that reverts only one named alone opens an issue.
  const two = await blame([{ sha: sha("8"), parent: sha("7"), subject: "Tray docs (#38)", pr: 38, files: ["docs/ci/windows-tray.yml"] }, ...range]);
  assert.deepEqual(two.ties.map((t) => t.pr), [38, 34]);
  const c = { pr: two.pr, sha: two.sha, confirmed: true, failures: [{ failure: {}, prs: 8, blame: two }] };
  assert.equal(decide(c, { minutes: 0, minRedMinutes: 0, namedOnly: true }).action, "issue");
  // A fix to the named file on main since settles it.
  const fixed = { pr: 34, sha: sha("4"), confirmed: true, failures: [{ failure: { job: "npm test", roots: ["test/workflow-checkout.test.ts"] }, prs: 7, blame: one }] };
  assert.match(decide(fixed, { minutes: 0, minRedMinutes: 0, changedLater: [{ sha: sha("9"), pr: 39, files: [".github/workflows/windows-tray.yml"] }] }).reason, /#39 .* changed \.github\/workflows\/windows-tray\.yml on main since/);
  // A name with a directory is a path: its end, or the checkout's path before it. Never a temp or package path, or a file:line.
  const index = [{ sha: sha("2"), pr: 2, files: ["src/other/index.ts"] }, { sha: sha("1"), pr: 1, files: ["src/app/index.ts", ".vscode/settings.json", "lib/index.ts"] }];
  for (const said of ["src/app/index.ts does not export foo", "app/index.ts does not export foo", "/home/runner/work/r/r/src/app/index.ts does not export foo"]) assert.deepEqual(messageNamed(index, said).ties.map((t) => t.pr), [1], said);
  assert.deepEqual(messageNamed(index, "index.ts does not export foo").ties.map((t) => t.pr), [2, 1], "a bare name: every pull request that changed one");
  for (const said of ['ENOENT: no such file or directory, open "/tmp/t-1/settings.json"', "node_modules/ws/lib/index.ts is stale", "at run (src/app/index.ts:9:3)"]) assert.equal(messageNamed(index, said), null, said);
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
  gh.get = async (p) => (p.includes(`/runs/${n.id}/jobs?`) ? { jobs: [{ id: n.id * 10, name: "native", status: "completed", conclusion: "failure", runner_id: 1, steps: [{ name: "The window covers nothing", conclusion: "failure" }] }] } : jobsGet(p));
  const r = await analyse("o/r", verdicts([n, g])[0], { a: gh, src: src({ read: async (_, p) => (p === ".github/workflows/ci.yml" ? yml : SRC[p] ?? null) }) });
  assert.deepEqual(r.results[0].failure.roots, ["test/x.test.ts"]);
  assert.equal(r.results[0].blame.pr, 11);
});

// Tandem, 2026-11-26, replayed: the release's engine build is a job of a reusable workflow ci.yml calls ("stage / build-and-sign"),
// and it failed on every run from the merge that added a gh shim's action before its steps, with a line that names no file.
test("a job's failing step that nothing explains is blamed on the setup its earlier steps ran, read from its reusable workflow", async () => {
  const files = new Set([...FILES, ".github/workflows/ci.yml", ".github/workflows/release-stage.yml", ".github/actions/api-count/action.yml", ".github/actions/api-count/gh", ".github/actions/gh-retry/gh", ".github/actions/sign/action.yml", "engine/crates/tandem/src/main.rs", "engine/crates/tandem/tests/mock_serve.rs", "release/engine.ts"]);
  const ci = "on: push\njobs:\n  plan:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node release/plan.ts\n  stage:\n    needs: plan\n    uses: ./.github/workflows/release-stage.yml\n";
  const stage = (cmd) => `on: workflow_call\njobs:\n  build-and-sign:\n    runs-on: macos-latest\n    steps:\n      - uses: actions/checkout@v7\n      - uses: ./.github/actions/api-count\n        continue-on-error: true\n      - uses: "./.github/actions/gh-retry" # quoted\n      - name: Build the Mac engine on an exact cache miss\n        run: ${cmd}\n      - name: Sign\n        uses: ./.github/actions/sign\n`;
  const log = [
    "2026-11-26T18:33:30.1Z error: could not compile `tandem` (bin \"tandem\")",
    "2026-11-26T18:33:30.2Z   could not execute process `rustc --crate-name tandem --edition=2021 crates/tandem/src/main.rs --error-format=json` (never executed)",
    "2026-11-26T18:33:30.3Z   Resource temporarily unavailable (os error 35)",
    "2026-11-26T18:33:30.4Z ##[error]Process completed with exit code 101.",
  ];
  const shim = { sha: sha("b"), subject: "ci: count each step's GitHub API calls (#6981)", pr: 6981, files: [".github/actions/api-count/action.yml", ".github/actions/api-count/gh", ".github/workflows/ci.yml", ".github/workflows/release-stage.yml"] };
  const range = [
    { sha: sha("n"), subject: "The draft guard's test times one request (#7137)", pr: 7137, files: ["engine/crates/tandem/tests/mock_serve.rs", "release/engine.ts"] },
    { sha: sha("u"), subject: "Unrelated (#7139)", pr: 7139, files: ["src/z.ts"] },
    shim,
  ];
  const replay = async (cmd, commits = range) => {
    const g = run({ conclusion: "success", head_sha: sha("g") });
    const b = run({ head_sha: sha("b") });
    const n = run({ head_sha: sha("n") });
    const jobsOf = Object.fromEntries([b, n].map((r) => [r.id, [{ id: r.id * 10, name: "stage / build-and-sign", status: "completed", conclusion: "failure", runner_id: 1, steps: [{ name: "Build the Mac engine on an exact cache miss", conclusion: "failure" }] }]]));
    const read = async (_, p) => ({ ".github/workflows/ci.yml": ci, ".github/workflows/release-stage.yml": stage(cmd) })[p] ?? SRC[p] ?? null;
    return (await analyse("o/r", verdicts([n, b, g])[0], { a: fakeGitHub([n, b, g], { [b.id]: log, [n.id]: log }, { jobsOf }), src: src({ files: async () => files, read, commits: async () => commits }) })).results[0];
  };
  const r = await replay("(cd engine && cargo build --release --locked -p tandem)");
  assert.deepEqual(r.failure.roots, [], "the failing line and the cargo step name no file of the tree");
  assert.deepEqual(r.failure.setup, [".github/actions/api-count/action.yml", ".github/actions/api-count/gh", ".github/actions/gh-retry/gh"], "the local actions run before it, not the one after");
  assert.equal(r.blame.pr, 6981);
  assert.equal(r.blame.distance, 0);
  assert.match(r.why, /changed \.github\/actions\/api-count\/action\.yml, the setup the job ran before its failing step/);
  assert.equal(r.confirmed, true, "red the same way on both runs");
  const [c] = culprits([r]);
  assert.equal(decide(c, { minutes: 30, minRedMinutes: 0, namedOnly: true }).action, "revert", "named alone among three pull requests: reverted, not an issue");
  assert.equal(r.touched, false, "the setup isn't what the failure names");
  assert.match(knownBefore(r, { pr: 6981, earlier: [{ run: run({ head_sha: sha("e") }), keys: new Set([r.failure.key]) }] }), /failed the same way on main before #6981/, "a failure main already had stays main's");
  const fixed = [{ sha: sha("f"), subject: "gh wrappers take the next gh on the PATH (#7194)", pr: 7194, files: [".github/actions/api-count/gh"] }];
  assert.equal(decide(c, { minutes: 30, minRedMinutes: 0, namedOnly: true, changedLater: fixed }).action, "skip", "a later change to the setup settles it");
  const script = await replay("node release/engine.ts");
  assert.equal(script.blame.pr, 7137, "a pull request that changed what the failing step runs is blamed before the setup");
  const none = await replay("(cd engine && cargo build --release --locked -p tandem)", range.slice(0, 2));
  assert.equal(none.blame, null, "no pull request changed the setup either");
  assert.equal(none.why, "its failure names no file and its step runs none");
});

test("#257: a report-only or continue-on-error job's red, or one already red on the green run before, blames no one", async () => {
  const yml = [
    "on: push", "jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps:", "      - run: make",
    "  probe:", "    name: Hitch probe", "    continue-on-error: true", "    steps:", "      - name: Build for Release", "        run: make release",
    "  matrix:", "    name: \"Lint\"", "    continue-on-error: true", "    strategy:", "      matrix:", "        continue-on-error: false",
  ].join("\n");
  assert.deepEqual([...softJobs(yml)].sort(), ["Hitch probe", "Lint", "matrix", "probe"]);
  assert.equal(softJob("Lint (ubuntu-latest)", softJobs(yml)), true);
  assert.equal(softJob("Gallery hitch probe (main and releases, report only)"), true);
  assert.equal(softJob("build", softJobs(yml)), false);
  const read = async (_, p) => (p === ".github/workflows/ci.yml" ? yml : SRC[p] ?? null);
  const failing = (r, name, step = "Build for Release") => ({ id: r.id * 10, name, status: "completed", conclusion: "failure", runner_id: 1, steps: [{ name: step, conclusion: "failure" }] });
  const errorLog = ["2026-11-21T03:20:00.0Z src/y.ts:1:1: error: sending 'node' risks causing data races"];
  // Only the continue-on-error job failed: nothing of the code's.
  {
    const g = run({ conclusion: "success", head_sha: sha("g") });
    const n = run({ head_sha: sha("n") });
    const gh = fakeGitHub([n, g], { [n.id]: errorLog }, { jobsOf: { [n.id]: [failing(n, "Hitch probe")] } });
    const r = await analyse("o/r", verdicts([n, g])[0], { a: gh, src: src({ read }) });
    assert.match(r.infra, /report-only/);
    assert.equal(r.results, undefined);
  }
  // Main is red for another job (a flake) and the probe failed too: the probe is not a failure, so only the other is judged.
  {
    const g = run({ conclusion: "success", head_sha: sha("g") });
    const n = run({ head_sha: sha("n") });
    const jobs = [failing(n, "Gallery hitch probe (main and releases, report only)"), { ...failing(n, "build", "Run make"), id: n.id * 10 + 1 }];
    const gh = fakeGitHub([n, g], { [n.id]: errorLog }, { jobsOf: { [n.id]: jobs } });
    const r = await analyse("o/r", verdicts([n, g])[0], { a: gh, src: src({ read }) });
    assert.deepEqual(r.results.map((x) => x.failure.job), ["build"]);
  }
  // A job the workflow does not mark, red on the green run before the range too: it did not begin in the range.
  {
    const g = run({ conclusion: "success", head_sha: sha("g") });
    const n = run({ head_sha: sha("n") });
    const gh = fakeGitHub([n, g], { [n.id]: errorLog, [g.id]: errorLog }, { jobsOf: { [n.id]: [failing(n, "build")], [g.id]: [failing(g, "build")] } });
    const r = await analyse("o/r", verdicts([n, g])[0], { a: gh, src: src({ read: async (_, p) => (p === ".github/workflows/ci.yml" ? "jobs:\n  build:\n    steps:\n      - name: Build for Release\n        run: make\n" : SRC[p] ?? null) }) });
    assert.equal(r.results[0].blame, null);
    assert.equal(r.results[0].base, null);
  }
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
  // revertOnlyNamed: one picked from several pull requests in its range gets an issue; one named alone is reverted.
  const several = { ...c, failures: [{ prs: 4, failure: {} }] };
  assert.equal(decide(several, { minutes: 0, minRedMinutes: 0, namedOnly: true }).action, "issue");
  assert.match(decide(several, { minutes: 0, minRedMinutes: 0, namedOnly: true }).reason, /picked from 4 pull requests/);
  assert.equal(decide({ ...c, failures: [{ prs: 1, failure: {} }] }, { minutes: 0, minRedMinutes: 0, namedOnly: true }).action, "revert");
  assert.equal(decide(several, { minutes: 0, minRedMinutes: 0 }).action, "revert", "off by default");
  // Named alone by the failure (Tandem, #5789, 2026-11-25): it names a file only this pull request in the range changed, so
  // it's reverted, the job that only adds the others up riding along; a file two changed, or one a reference away, isn't.
  const names = (distance, ties = [{ pr: 11 }]) => ({ prs: 2, failure: {}, blame: { pr: 11, distance, ties } });
  assert.equal(decide({ ...c, failures: [names(0), names(1)] }, { minutes: 0, minRedMinutes: 0, namedOnly: true }).action, "revert");
  assert.equal(decide({ ...c, failures: [names(1)] }, { minutes: 0, minRedMinutes: 0, namedOnly: true }).action, "issue", "a reference away is a pick among several");
  assert.equal(decide({ ...c, failures: [names(0, [{ pr: 11 }, { pr: 12 }])] }, { minutes: 0, minRedMinutes: 0, namedOnly: true }).action, "issue", "two changed a file it names");
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

test("settled: a failure whose test a later commit changed reverts nothing; a later run that passed it settles nothing on its own", async () => {
  assert.equal(jobKey("npm test (ubuntu-latest, 3/14)"), "npm test (ubuntu-latest)");
  assert.equal(jobKey("devbox npm (4/7)"), "devbox npm");
  const f = { job: "npm test (ubuntu-latest)", file: "test/x.test.ts", roots: ["test/x.test.ts"] };
  const changedLater = [{ sha: sha("f"), pr: 21, files: ["test/x.test.ts"] }];
  assert.match(settledBy(f, { changedLater }), /#21 \(fffffffff\) changed test\/x\.test\.ts/);
  assert.equal(settledBy(f, { changedLater: [{ sha: sha("f"), pr: 21, files: ["src/y.ts"] }] }), null);
  const c = { pr: 11, sha: sha("b"), subject: "Breaks y (#11)", confirmed: true, failures: [{ failure: f }, { failure: { ...f, job: "other", roots: ["test/w.test.ts"] } }] };
  assert.equal(decide(c, { minutes: 0, minRedMinutes: 0, changedLater }).action, "revert", "one failure not settled still reverts");
  assert.equal(decide({ ...c, failures: c.failures.slice(0, 1) }, { minutes: 0, minRedMinutes: 0, changedLater }).action, "skip");
});

test("check: Tandem, #6242: a merge that edits a file a repository-wide test scans, failing on every push after it, is named and reverted, through a jobs list that answers 502", async () => {
  // test/candidates.test.ts imports src/x.ts and scans src/candidates; it fails naming the folder whose README #22 edited.
  // #21 changed src/x.ts, a reference away: it was the pick among three, and revertOnlyNamed opened an issue instead.
  const files = new Set([...FILES, "test/candidates.test.ts", "src/candidates/quote/README.md", "src/candidates/card/README.md"]);
  const reads = { ...SRC, "test/candidates.test.ts": `import { x } from "../src/x.ts";\nconst all = fs.readdirSync(path.join(ROOT, "src/candidates"));\ntest("every candidate README names its upstream API", () => { for (const d of all) assert.match(read(d + "/README.md"), /Upstream/, d); });\n` };
  const range = [
    { sha: sha("c"), subject: "Unrelated (#23)", pr: 23, files: ["src/z.ts"] },
    { sha: sha("q"), subject: "Quote's README links its port (#22)", pr: 22, files: ["src/candidates/quote/README.md"], added: [] },
    { sha: sha("b"), subject: "Runtime (#21)", pr: 21, files: ["src/x.ts"] },
  ];
  const s = src({ files: async () => files, read: async (_, p) => reads[p] ?? null, commits: async (base, head) => (base === sha("g") ? range : []) });
  const g = run({ conclusion: "success", head_sha: sha("g") });
  const r1 = run({ head_sha: sha("c"), updated_at: at(35) });
  const r2 = run({ head_sha: sha("n"), updated_at: at(2), run_attempt: 2 });
  const fail = TAP("every candidate README names its upstream API", "test/candidates.test.ts", "'src/candidates/quote'");
  const gh = fakeGitHub([r2, r1, g], { [r1.id]: fail, [r2.id]: fail });
  const get = gh.get;
  gh.get = async (p) => {
    if (/\/jobs\?.*per_page=100/.test(p)) throw new Error(`GET ${p}: gh: Server Error (HTTP 502)`);
    return get(p);
  };
  const lines = [];
  await check("o/r", { workflows: ["ci"], minRedMinutes: 0, revertOnlyNamed: true }, { a: gh, now: NOW, apply: false, log: (l) => lines.push(l), source: async () => s });
  assert.ok(lines.some((l) => /-> #22 \(changed src\/candidates\/quote\/README\.md under src\/candidates\/quote\/, which the failure names/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /would open revert PR "Revert "Quote's README links its port" \(#22\)"/.test(l)), lines.join("\n"));
  assert.ok(!lines.some((l) => /#21|#23|an issue/.test(l)), lines.join("\n"));
  assert.ok(gh.calls.some(([, p]) => /\/jobs\?.*per_page=50&page=1$/.test(p)), "the 502'd page was read as pages of 50");
  const dist = await distances(["test/candidates.test.ts"], { read: async (p) => reads[p] ?? null, files });
  assert.equal(culprit([{ sha: sha("q"), pr: 22, files: ["src/candidates/quote/README.md"] }], dist, ["src/candidates"]).distance, 1, "naming the scanned directory itself names no one file in it");
  assert.equal(culprit([{ sha: sha("q"), pr: 22, files: ["src/candidates/quote/README.md"] }], dist, ["src/candidates/quote"]).distance, 0);
  assert.equal(culprit([{ sha: sha("q"), pr: 22, files: ["src/other/quote/README.md"] }], Object.assign(new Map(dist), { dirs: new Map() }), ["src/other/quote"]).distance, Infinity, "a named directory no test scans is not followed");
});

test("ghError: gh's own error, not GH_DEBUG's request trace before it", () => {
  const stderr = "* Request at 2026-11-27 23:44:01\n* Request to https://api.github.com/repos/o/r/actions/runs/1/jobs\n> GET /repos/o/r/actions/runs/1/jobs HTTP/1.1\n< HTTP/2.0 502 Bad Gateway\n* Request took 10s\n{\n  \"message\": \"Server Error\"\n}\ngh: Server Error (HTTP 502)\n";
  assert.match(ghError(stderr), /gh: Server Error \(HTTP 502\)$/);
  assert.doesNotMatch(ghError(stderr), /Request at/);
});

test("check: #4262: a red run at an older commit reverts nothing while a newer main run that passed the test starts a cause check, or once a newer PR changed the test", async () => {
  const g = run({ conclusion: "success", head_sha: sha("g") });
  const b = run({ head_sha: sha("b"), updated_at: at(35) });
  const n = run({ head_sha: sha("n"), updated_at: at(2) });
  const f = run({ head_sha: sha("f"), status: "in_progress", conclusion: null });
  const logs = { [b.id]: TAP("x works", "test/x.test.ts"), [n.id]: TAP("x works", "test/x.test.ts") };
  const cfg = { workflows: ["ci"], minRedMinutes: 0 };
  const fix = [{ sha: sha("f"), at: at(1), subject: "Fake the clock (#21)", body: "" }];
  const passed = fakeGitHub([f, n, b, g], { ...logs, [f.id]: ["ok 4 - x works"] }, { jobsOf: { [f.id]: [{ id: f.id * 10, name: "npm test (ubuntu-latest, 3/14)", status: "completed", conclusion: "success" }] } });
  const lines = [];
  await check("o/r", cfg, { a: passed, now: NOW, apply: true, log: (l) => lines.push(l), source: async () => src({ later: async () => fix }) });
  assert.ok(lines.some((l) => new RegExp(`culprit #11 .*revert pending: \`x works\` \\(test/x\\.test\\.ts\\) passed in https://x/run/${f.id} at f{9} on main since, which contains #11; a cause check runs it`).test(l)), lines.join("\n"));
  assert.ok(!passed.calls.some((c) => c[0] === "gql"), "no revert");
  const changed = fakeGitHub([f, n, b, g], logs);
  const commits = async (base, head) => (head === "refs/remotes/origin/main" ? [{ sha: sha("f"), pr: 21, files: ["test/x.test.ts"] }] : src().commits(base, head));
  lines.length = 0;
  await check("o/r", cfg, { a: changed, now: NOW, apply: true, log: (l) => lines.push(l), source: async () => src({ later: async () => fix, commits }) });
  assert.ok(lines.some((l) => /culprit #11 .*not reverting: #21 \(f{9}\) changed test\/x\.test\.ts on main since/.test(l)), lines.join("\n"));
  assert.ok(!changed.calls.some((c) => c[0] === "gql"), "no revert");
});

test("check: one red run over the range dispatches its workflow on a verify branch at that commit, re-runs its failed jobs once, and waits", async () => {
  const g = run({ conclusion: "success", head_sha: sha("g") });
  const n = run({ head_sha: sha("n") });
  const gh = fakeGitHub([n, g], { [n.id]: TAP("x works", "test/x.test.ts") });
  const lines = [];
  await check("o/r", { workflows: ["ci"], minRedMinutes: 0 }, { a: gh, now: NOW, apply: true, log: (l) => lines.push(l), source: async () => src() });
  assert.deepEqual(gh.calls.filter((c) => c[0] === "post" || c[0] === "gql").map((c) => [c[1], c[2]]), [
    [`/repos/o/r/actions/runs/${n.id}/rerun-failed-jobs`, {}],
    ["/repos/o/r/git/refs", { ref: `refs/heads/auto-revert/verify-${"n".repeat(12)}`, sha: sha("n") }],
    ["/repos/o/r/actions/workflows/ci.yml/dispatches", { ref: `auto-revert/verify-${"n".repeat(12)}` }],
  ]);
  const again = fakeGitHub([{ ...n, run_attempt: 2 }, g], { [n.id]: TAP("x works", "test/x.test.ts") });
  await check("o/r", { workflows: ["ci"], minRedMinutes: 0 }, { a: again, now: NOW, apply: true, log() {}, source: async () => src() });
  assert.ok(!again.calls.some((c) => /rerun-failed-jobs/.test(c[1] ?? "")), "a second attempt is never re-run");
  assert.ok(lines.some((l) => /culprit #11 .*revert pending: not yet reproduced/.test(l)), lines.join("\n"));
});

test("check: a red run on infrastructure only blames nothing and re-runs its failed and cancelled jobs once", async () => {
  // Tandem's rollup says a cancelled job "cancelled, not judged" with title=infra (2026-11-26: #7039 was blamed for one).
  const g = run({ conclusion: "success", head_sha: sha("g") });
  const n = run({ head_sha: sha("n") });
  const lost = [{ id: n.id * 10, name: "test (windows-latest)", status: "completed", conclusion: "failure", runner_id: 1, steps: [{ name: "Every test job of this system passed", conclusion: "success" }] }];
  const gh = fakeGitHub([n, g], {}, { jobsOf: { [n.id]: lost } });
  const lines = [];
  await check("o/r", { workflows: ["ci"], minRedMinutes: 0 }, { a: gh, now: NOW, apply: true, log: (l) => lines.push(l), source: async () => src() });
  assert.ok(lines.some((l) => /on infrastructure only/.test(l)), lines.join("\n"));
  assert.deepEqual(gh.calls.filter((c) => c[0] === "post" || c[0] === "gql").map((c) => c[1]), [`/repos/o/r/actions/runs/${n.id}/rerun-failed-jobs`]);
  const again = fakeGitHub([{ ...n, run_attempt: 2 }, g], {}, { jobsOf: { [n.id]: lost } });
  await check("o/r", { workflows: ["ci"], minRedMinutes: 0 }, { a: again, now: NOW, apply: true, log() {}, source: async () => src() });
  assert.ok(!again.calls.some((c) => /rerun-failed-jobs/.test(c[1] ?? "")), "once: a second attempt is never re-run");
});

test("check: red by run number but green by commit order is not red, and nothing is written", async () => {
  const g = run({ conclusion: "success", head_sha: sha("g") });
  const n = run({ conclusion: "success", head_sha: sha("n") });
  const b = run({ head_sha: sha("b") });
  const gh = fakeGitHub([b, n, g], { [b.id]: TAP("x works", "test/x.test.ts") });
  const lines = [];
  const order = async () => new Map([[sha("g"), 1], [sha("b"), 2], [sha("n"), 3]]);
  await check("o/r", { workflows: ["ci"], minRedMinutes: 0 }, { a: gh, now: NOW, apply: true, log: (l) => lines.push(l), source: async () => src({ order }) });
  assert.ok(lines.includes("o/r: main is not red"), lines.join("\n"));
  assert.ok(!gh.calls.some((c) => c[0] === "post" || c[0] === "gql"));
});

test("check: a repository with \"rerun\": false never re-runs a main run, and still verifies on a branch", async () => {
  const g = run({ conclusion: "success", head_sha: sha("g") });
  const n = run({ head_sha: sha("n") });
  const gh = fakeGitHub([n, g], { [n.id]: TAP("x works", "test/x.test.ts") });
  await check("o/r", { workflows: ["ci"], minRedMinutes: 0, rerun: false }, { a: gh, now: NOW, apply: true, log() {}, source: async () => src() });
  assert.ok(!gh.calls.some((c) => /rerun-failed-jobs/.test(c[1] ?? "")));
  assert.ok(gh.calls.some((c) => c[0] === "post" && /dispatches/.test(c[1])));
});

test("check: rerunOnly re-runs the failed jobs of a first red and does nothing else", async () => {
  const g = run({ conclusion: "success", head_sha: sha("g") });
  const n = run({ head_sha: sha("n") });
  const gh = fakeGitHub([n, g], {});
  await check("o/r", { workflows: ["ci"] }, { a: gh, now: NOW, apply: true, log() {}, source: async () => assert.fail("no clone"), rerunOnly: true });
  assert.deepEqual(gh.calls.filter((c) => c[0] !== "get" && c[0] !== "lines").map((c) => c[1]), [`/repos/o/r/actions/runs/${n.id}/rerun-failed-jobs`]);
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

test("land: a revert whose own checks fail only with main's known failures, none its culprit's, lands over them", async () => {
  // Tandem's #4641 (reverting #4635) waited 33 minutes: its gate failed on #4640's clock test, red on main without it.
  const known = knownOnMain([{ results: [
    { failure: { key: "test/compose.test.ts :: the @ picker offers the chat's members" }, blame: { pr: 4635 } },
    { failure: { key: "site/browser.test.mjs :: every use of the real clock is pinned" }, blame: { pr: 4640 } },
    { failure: { key: "test/x.test.ts :: a flake" }, blame: null },
  ] }]);
  const gate = { key: "job pr gate :: Every pull request job", test: null, job: "pr gate" };
  const clock = { key: "site/browser.test.mjs :: every use of the real clock is pinned", test: "every use of the real clock is pinned", job: "npm test" };
  assert.equal(onlyKnown([clock, gate], known, 4635, ["pr gate"]), true, "the gate's own job only adds the others up");
  assert.equal(onlyKnown([clock, { key: "test/compose.test.ts :: the @ picker offers the chat's members", test: "x" }], known, 4635, ["pr gate"]), false, "never over its own culprit's failure: then it doesn't fix main");
  assert.equal(onlyKnown([{ key: "test/new.test.ts :: something else", test: "y" }], known, 4635, ["pr gate"]), false, "never over a failure main doesn't have");
  assert.equal(onlyKnown([gate], known, 4635, ["pr gate"]), false, "nothing of its own to judge");
  assert.equal(onlyKnown([{ key: "test/x.test.ts :: a flake", test: "a flake" }], known, 4635, ["pr gate"]), true, "a known flake on main");
  // landReverts: a failed gate, still nothing running, merges only with failuresOf saying so.
  const mine = { number: 4641, title: 'Revert "Everyone in @" (#4635)', body: `x\n${MARKER}`, head: { ref: "revert-4635-everyone", sha: sha("h") } };
  const checks = { check_runs: [
    { name: "pr gate", status: "completed", conclusion: "failure", details_url: "https://github.com/o/r/actions/runs/7/job/70" },
    { name: "npm test (ubuntu-latest, 2/5)", status: "completed", conclusion: "failure", details_url: "https://github.com/o/r/actions/runs/7/job/71" },
  ] };
  const gh = fakeGitHub([], {}, { checks: { [sha("h")]: checks } });
  await landReverts("o/r", [mine], { a: gh, required: ["pr gate"], apply: true, log() {}, known, failuresOf: async () => [clock, gate] });
  assert.equal(gh.calls.filter((c) => c[0] === "put").length, 1);
  const held = fakeGitHub([], {}, { checks: { [sha("h")]: checks } });
  await landReverts("o/r", [mine], { a: held, required: ["pr gate"], apply: true, log() {}, known, failuresOf: async () => [{ key: "test/new.test.ts :: y", test: "y" }] });
  assert.equal(held.calls.filter((c) => c[0] === "put").length, 0);
  const running = fakeGitHub([], {}, { checks: { [sha("h")]: { check_runs: [...checks.check_runs, { name: "x", status: "in_progress" }] } } });
  await landReverts("o/r", [mine], { a: running, required: ["pr gate"], apply: true, log() {}, known, failuresOf: async () => [clock] });
  assert.equal(running.calls.filter((c) => c[0] === "put").length, 0, "not while a check still runs");
});

test("git log parsing: each first-parent commit's files, and its PR only when it is a squash", () => {
  const out = `\x1e${sha("n")}\x1f${sha("u")}\x1f2026-11-19T23:00:00Z\x1fNewest (#3877) (#13)\n\nM\tREADME.md\nA\tsrc/x.ts\n\x1e${sha("m")}\x1f${sha("u")} ${sha("v")}\x1f2026-11-19T22:00:00Z\x1fMerge branch (#7)\n\nsrc/y.ts\n`;
  const cs = parseLog1e(out);
  assert.deepEqual(cs.map((c) => [c.pr, c.files, c.added]), [[13, ["README.md", "src/x.ts"], ["src/x.ts"]], [null, ["src/y.ts"], []]]);
  const moved = parseLog1e(`\x1e${sha("r")}\x1f${sha("n")}\x1f2026-11-19T23:30:00Z\x1fMove a test (#14)\n\nR100\ttest/a.test.ts\ttest/b.test.ts\nD\ttest/c.test.ts\n`)[0];
  assert.deepEqual([moved.files, moved.added, moved.deleted], [["test/b.test.ts", "test/c.test.ts"], ["test/b.test.ts"], ["test/a.test.ts", "test/c.test.ts"]], "a rename adds its new path and removes its old one");
});

test("main --self checks only that repo; a green ci and green Mac guards are one call each; --as-of never acts", async () => {
  const lines = [];
  const orig = console.log;
  console.log = (l) => lines.push(l);
  try {
    await main(["--self", "teams-microsoft/tandem"], NOW, fakeGitHub([run({ conclusion: "success" })], {}), { source: async () => src() });
  } finally {
    console.log = orig;
  }
  assert.deepEqual(lines, ["auto-revert: dry run (pass --apply to act)", "teams-microsoft/tandem: main is not red", "auto-revert: 2 API calls (2 read, 0 write)"]);
  await assert.rejects(main(["--self", "o/r", "--apply", "--as-of", at(5)], NOW, fakeGitHub([], {})), /never acts/);
});

test("config: Tandem counts ci and its Mac guards' tag runs, ignores its newest-commit gates, acts at once and runs as its own caller; ourostack repos keep the hour", () => {
  const t = CONFIG.repos["teams-microsoft/tandem"];
  assert.equal(t.enabled, false);
  assert.deepEqual(t.workflows, ["ci", "mac-guards"]);
  assert.deepEqual(t.tagRuns, ["mac-guards"], "main's Mac guards run on each promoted release's tag, not on a push");
  assert.deepEqual(t.ignoreWorkflows, ["first-run-gate", "basics"]);
  assert.equal(t.minRedMinutes, 0);
  assert.equal(CONFIG.minRedMinutes, 60);
  assert.ok(Object.entries(CONFIG.repos).filter(([r]) => r.startsWith("ourostack/") && r !== "ourostack/gatefold").every(([, c]) => c.enabled));
  for (const r of ["hackamore", "ouro-ui-core", "m365crawl", "ouro-ui", "ouro-ui-apple", "gatefold"]) assert.ok(OWNERS.repos[`ourostack/${r}`], `${r} has an owner`);
});

test("main: an exhausted rate limit warns, stops the tick and never fails it", async () => {
  const lines = [];
  const orig = console.log;
  console.log = (l) => lines.push(l);
  const prev = process.exitCode;
  const gh = fakeGitHub([], {});
  gh.get = async () => {
    throw new Error("GET /repos/o/r/actions/runs: gh: API rate limit exceeded for user ID 1.");
  };
  try {
    await main(["--self", "o/r"], NOW, gh, { source: async () => src() });
    assert.equal(process.exitCode ?? 0, 0);
  } finally {
    console.log = orig;
    process.exitCode = prev;
  }
  assert.ok(lines.some((l) => /^::warning::.*rate limit/.test(l)));
});

test("main: any other failed read still fails the tick", async () => {
  const orig = console.log;
  console.log = () => {};
  const prev = process.exitCode;
  const gh = fakeGitHub([], {});
  gh.get = async () => {
    throw new Error("HTTP 500");
  };
  try {
    await main(["--self", "o/r"], NOW, gh, { source: async () => src() });
    assert.equal(process.exitCode, 1);
  } finally {
    console.log = orig;
    process.exitCode = prev;
  }
});

test("known: a failure main already had, or an open known flake, is not the culprit's, unless the culprit changed what failed", () => {
  const md = [
    "# Main's flakes",
    "| Cause | Fix |",
    "| `test/old.test.ts` | fixed by #1 |",
    "## Open known flakes",
    "",
    "Auto-revert never blames a pull request for these.",
    "- `test/sent-echo-window.test.ts:348`: Windows runners' stalls and the reply box's B172 (#5243, #5247)",
    "| `test/b.test.ts` | watched |",
    "## Fixed",
    "- `test/fixed.test.ts`: fixed by #2",
  ].join("\n");
  const flakes = openFlakes(md);
  assert.deepEqual([...flakes.keys()], ["test/sent-echo-window.test.ts", "test/b.test.ts"], "only under the open heading, a line ref dropped");
  const x = (over = {}) => ({ failure: { key: "test/x.test.ts :: x works", file: "test/x.test.ts", test: "x works" }, touched: false, ...over });
  const seen = [{ run: run({ head_sha: sha("e"), created_at: at(300) }), keys: new Set(["test/x.test.ts :: x works"]) }];
  assert.match(knownBefore(x(), { pr: 11, earlier: seen }), /failed the same way on main before #11: https:\/\/x\/run\/\d+ \(eeeeeeeee, /);
  assert.equal(knownBefore(x({ touched: true }), { pr: 11, earlier: seen }), null, "the culprit changed the test or what its failure names");
  assert.equal(knownBefore(x(), { pr: 11, earlier: [{ ...seen[0], keys: new Set(["test/x.test.ts :: another test"]) }] }), null, "never failed this way before");
  const sent = x({ failure: { key: "test/sent-echo-window.test.ts :: a name picked with @", file: "test/sent-echo-window.test.ts", test: "a name picked with @" } });
  assert.match(knownBefore(sent, { pr: 5241, flakes, flakeDoc: "docs/main-flake-table.md" }), /open known flake in docs\/main-flake-table\.md: .*B172/);
  assert.equal(knownBefore({ ...sent, touched: true }, { pr: 5241, flakes }), null);
});

test("check: Tandem, #5252: a failure main had on a run in the 24 hours before the range reverts nothing and posts the evidence; one the PR changed still reverts", async () => {
  // e: an earlier red of the same test, 5 hours before the green g; then #11 lands and b, n fail it again.
  const e = run({ head_sha: sha("e"), created_at: at(300), updated_at: at(290) });
  const old = run({ head_sha: sha("o"), created_at: at(60 * 30), updated_at: at(60 * 30) });
  const g = run({ conclusion: "success", head_sha: sha("g"), created_at: at(70) });
  const b = run({ head_sha: sha("b"), updated_at: at(35) });
  const n = run({ head_sha: sha("n"), updated_at: at(2) });
  const logs = { [e.id]: TAP("x works", "test/x.test.ts"), [old.id]: TAP("w works", "test/w.test.ts"), [b.id]: TAP("x works", "test/x.test.ts"), [n.id]: TAP("x works", "test/x.test.ts") };
  const cfg = { workflows: ["ci"], minRedMinutes: 0 };
  const gh = fakeGitHub([n, b, g, e, old], logs);
  const lines = [];
  await check("o/r", cfg, { a: gh, now: NOW, apply: true, log: (l) => lines.push(l), source: async () => src() });
  assert.ok(lines.some((l) => /culprit #11 .*not reverting: it failed the same way on main before #11: https:\/\/x\/run\/\d+ \(eeeeeeeee/.test(l)), lines.join("\n"));
  assert.ok(!gh.calls.some((c) => c[0] === "gql"), "no revert");
  const posted = gh.calls.filter((c) => c[0] === "post");
  assert.equal(posted.length, 1);
  assert.equal(posted[0][1], "/repos/o/r/issues/11/comments");
  assert.ok(posted[0][2].body.startsWith(KNOWN_MARKER) && /`x works` \(test\/x\.test\.ts\): it failed the same way on main before #11/.test(posted[0][2].body), posted[0][2].body);
  const again = fakeGitHub([n, b, g, e, old], logs, { comments: [{ body: `${KNOWN_MARKER} ...` }] });
  await check("o/r", cfg, { a: again, now: NOW, apply: true, log() {}, source: async () => src() });
  assert.ok(!again.calls.some((c) => c[0] === "post"), "the evidence is posted once per pull request");
  // #11 changed the failing test itself: main having failed it before doesn't clear it.
  const touching = COMMITS.map((c) => (c.pr === 11 ? { ...c, files: ["src/y.ts", "test/x.test.ts"] } : c));
  const commits = async (base, head) => {
    const order = touching.map((c) => c.sha);
    return touching.slice(order.indexOf(head), base === sha("g") ? order.length : order.indexOf(base));
  };
  const live = fakeGitHub([n, b, g, e, old], logs);
  lines.length = 0;
  await check("o/r", cfg, { a: live, now: NOW, apply: true, log: (l) => lines.push(l), source: async () => src({ commits }) });
  assert.ok(lines.some((l) => /culprit #11 .*: revert$/.test(l)), lines.join("\n"));
  assert.ok(live.calls.some((c) => c[0] === "gql"), "revert opened");
  // A range with a known failure and a new one: reverted for the new one only.
  const both = { ...logs, [b.id]: [...TAP("x works", "test/x.test.ts"), ...TAP("y works", "test/x.test.ts", "src/y.ts")], [n.id]: [...TAP("x works", "test/x.test.ts"), ...TAP("y works", "test/x.test.ts", "src/y.ts")] };
  const mixed = fakeGitHub([n, b, g, e, old], both);
  lines.length = 0;
  await check("o/r", cfg, { a: mixed, now: NOW, apply: false, log: (l) => lines.push(l), source: async () => src() });
  assert.ok(lines.some((l) => /not blaming #11 for test\/x\.test\.ts :: x works: it failed the same way/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /would open revert PR "Revert "Breaks y" \(#11\)"/.test(l)), "y works never failed before: still reverted");
  // A red run more than 24 hours before the range, of another test, clears nothing: a new failure still reverts (the tests above).
  const reds = await earlierReds("o/r", n, g.created_at, { a: fakeGitHub([n, b, g, e, old], logs), files: FILES });
  assert.deepEqual(reds.map((x) => x.run.id), [e.id], "only the 24 hours before the range, and never the range's own runs");
});

test("check: a failure in a test the flake table names as an open known flake reverts nothing", async () => {
  const g = run({ conclusion: "success", head_sha: sha("g"), created_at: at(70) });
  const b = run({ head_sha: sha("b"), updated_at: at(35) });
  const n = run({ head_sha: sha("n"), updated_at: at(2) });
  const logs = { [b.id]: TAP("x works", "test/x.test.ts"), [n.id]: TAP("x works", "test/x.test.ts") };
  const doc = "## Open known flakes\n- `test/x.test.ts`: the runner stalls (#40)\n";
  const read = async (_, p) => (p === "docs/flakes.md" ? doc : SRC[p] ?? null);
  const gh = fakeGitHub([n, b, g], logs);
  const lines = [];
  await check("o/r", { workflows: ["ci"], minRedMinutes: 0, knownFlakes: "docs/flakes.md" }, { a: gh, now: NOW, apply: false, log: (l) => lines.push(l), source: async () => src({ read }) });
  assert.ok(lines.some((l) => /culprit #11 .*not reverting: test\/x\.test\.ts is an open known flake in docs\/flakes\.md: `test\/x\.test\.ts`: the runner stalls \(#40\)/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /would post the evidence on #11/.test(l)));
  assert.ok(!lines.some((l) => /would open revert PR/.test(l)));
});

test("lone: a range's one pull request is cleared only when it changed existing test files and documents, none the failure is or reaches", () => {
  const f = { key: "test/x.test.ts :: x works", file: "test/x.test.ts" };
  const pr = (files, over = {}) => ({ pr: 5241, sha: sha("t"), files, added: [], deleted: [], ...over });
  assert.match(loneCleared(pr(["test/organization.test.ts"]), f), /#5241 was blamed only as the range's one pull request, and it changed only test files and documents \(test\/organization\.test\.ts\)/, "a test's types only");
  assert.ok(loneCleared(pr(["test/organization.test.ts", "docs/notes.md"]), f), "and a document");
  assert.equal(loneCleared(pr(["test/new.test.ts"], { added: ["test/new.test.ts"] }), f), null, "an added test file moves the shards' files");
  assert.equal(loneCleared(pr(["test/b.test.ts"], { added: ["test/b.test.ts"], deleted: ["test/a.test.ts"] }), f), null, "a rename too");
  assert.equal(loneCleared(pr(["test/old.test.ts"], { deleted: ["test/old.test.ts"] }), f), null, "a removed one too");
  for (const x of ["src/x.ts", "test/helpers/window.ts", "test/fixtures/a.json", "scripts/test-shard.ts", ".github/workflows/ci.yml", "package.json", "package-lock.json", ".github/README.md"])
    assert.equal(loneCleared(pr(["test/organization.test.ts", x]), f), null, x);
  assert.equal(loneCleared(pr(["test/x.test.ts"]), f), null, "the failing test itself");
});

test("check: Tandem, #5252: the range's one pull request, a test's types only, isn't reverted and gets the evidence; one that added a test file is reverted", async () => {
  const g = run({ conclusion: "success", head_sha: sha("g"), created_at: at(70) });
  const b = run({ head_sha: sha("b"), updated_at: at(35) });
  const n = run({ head_sha: sha("n"), updated_at: at(2) });
  const logs = { [b.id]: TAP("x works", "test/x.test.ts"), [n.id]: TAP("x works", "test/x.test.ts") };
  const cfg = { workflows: ["ci"], minRedMinutes: 0 };
  const lone = (c) => async () => [{ sha: sha("n"), subject: "Type the organization test (#5241)", pr: 5241, ...c }];
  const gh = fakeGitHub([n, b, g], logs);
  const lines = [];
  await check("o/r", cfg, { a: gh, now: NOW, apply: true, log: (l) => lines.push(l), source: async () => src({ commits: lone({ files: ["test/organization.test.ts"], added: [], deleted: [] }) }) });
  assert.ok(lines.some((l) => /culprit #5241 .*not reverting: #5241 was blamed only as the range's one pull request/.test(l)), lines.join("\n"));
  assert.ok(!gh.calls.some((c) => c[0] === "gql"), "no revert");
  const posted = gh.calls.filter((c) => c[0] === "post");
  assert.deepEqual(posted.map((c) => c[1]), ["/repos/o/r/issues/5241/comments"]);
  assert.match(posted[0][2].body, /none of its failures is #5241's/);
  const added = fakeGitHub([n, b, g], logs);
  lines.length = 0;
  await check("o/r", cfg, { a: added, now: NOW, apply: true, log: (l) => lines.push(l), source: async () => src({ commits: lone({ files: ["test/organization.test.ts"], added: ["test/organization.test.ts"], deleted: [] }) }) });
  assert.ok(lines.some((l) => /culprit #5241 .*: revert$/.test(l)), lines.join("\n"));
  assert.ok(added.calls.some((c) => c[0] === "gql"), "reverted: an added test file can shift what each shard runs");
});

test("a new issue is written with ISSUE_TOKEN when it is set; reads with READ_TOKEN; other writes, pull request comments too, with GH_TOKEN", () => {
  const env = { GH_TOKEN: "pat", READ_TOKEN: "read", ISSUE_TOKEN: "issue" };
  assert.equal(envFor("GET", "/repos/o/r/issues?state=open", env).GH_TOKEN, "read");
  assert.equal(envFor("POST", "/repos/o/r/issues", env).GH_TOKEN, "issue", "an issue for a suspect: the PAT was refused with 403");
  assert.equal(envFor("POST", "/repos/o/r/issues/42/comments", env).GH_TOKEN, "pat", "a comment is on a pull request: the caller's token, pull-requests: read, was refused with 403");
  assert.equal(envFor("POST", "/repos/o/r/pulls", env).GH_TOKEN, "pat", "a revert pull request stays the PAT's, so its checks run");
  assert.equal(envFor("PUT", "/repos/o/r/pulls/7/merge", env).GH_TOKEN, "pat");
  assert.equal(envFor("POST", "/repos/o/r/issues", { GH_TOKEN: "pat" }).GH_TOKEN, "pat", "no ISSUE_TOKEN: as before");
});

test("check: Tandem, #7976: a culprit is reverted only for a failure that itself failed again at the same commit, not one that passed there", async () => {
  // #11 is blamed for two failures in one red run. The verify run fails "x works" again, but main failed it before #11 (e),
  // so it is dropped; "y works" passed in the verify run. Nothing left reproduced: declined as a flake, never reverted.
  const e = run({ head_sha: sha("e"), created_at: at(300), updated_at: at(290) });
  const g = run({ conclusion: "success", head_sha: sha("g"), created_at: at(70) });
  const n = run({ head_sha: sha("n"), updated_at: at(2) });
  const verify = run({ event: "workflow_dispatch", head_branch: `auto-revert/verify-${"n".repeat(12)}`, head_sha: sha("n") });
  const both = [...TAP("x works", "test/x.test.ts"), ...TAP("y works", "test/x.test.ts", "src/y.ts")];
  const cfg = { workflows: ["ci"], minRedMinutes: 0, flakeIssue: { title: "Health: auto-revert declined a revert", labels: ["delivery-health"] } };
  const logs = { [e.id]: TAP("x works", "test/x.test.ts"), [n.id]: both, [verify.id]: TAP("x works", "test/x.test.ts") };
  const gh = fakeGitHub([n, g, e], logs, { dispatched: [verify] });
  const lines = [];
  await check("o/r", cfg, { a: gh, now: NOW, apply: true, log: (l) => lines.push(l), source: async () => src() });
  assert.ok(lines.some((l) => /not blaming #11 for test\/x\.test\.ts :: x works/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /culprit #11 .*not reverting: passed when its workflow was dispatched at the same commit: a flake/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /declined revert, a flake to fix: #11: `y works` \(test\/x\.test\.ts\) failed in main's `ci` \(https:\/\/x\/run\/\d+\) and passed when https:\/\/x\/run\/\d+ ran/.test(l)), lines.join("\n"));
  assert.ok(!gh.calls.some((c) => c[0] === "gql"), "no revert");
  const issue = gh.calls.find((c) => c[0] === "post" && c[1] === "/repos/o/r/issues");
  assert.equal(issue?.[2].title, cfg.flakeIssue.title);
  assert.deepEqual(issue[2].labels, ["delivery-health"]);
  assert.ok(issue[2].body.includes(FLAKE_MARKER) && /- #11: `y works`/.test(issue[2].body) && !/x works/.test(issue[2].body), issue[2].body);
  // "y works" fails again too: reproduced, so #11 is reverted as fast as before, and the body says so.
  const again = run({ event: "workflow_dispatch", head_branch: `auto-revert/verify-${"n".repeat(12)}`, head_sha: sha("n") });
  const live = fakeGitHub([n, g, e], { ...logs, [again.id]: both }, { dispatched: [again] });
  lines.length = 0;
  await check("o/r", cfg, { a: live, now: NOW, apply: true, log: (l) => lines.push(l), source: async () => src() });
  assert.ok(lines.some((l) => /culprit #11 .*: revert$/.test(l)), lines.join("\n"));
  assert.ok(live.calls.some((c) => c[0] === "gql"), "reverted");
  assert.ok(!live.calls.some((c) => c[0] === "post" && c[1] === "/repos/o/r/issues"), "nothing declined, no flake issue");
  // Still running: it waits for the verify run rather than reverting on the failure main already had.
  assert.equal(reproducedNow({ failures: [{ confirmed: false, flake: false }] }).action, "wait");
});

test("flakeIssue: a new declined revert is added to the one open issue by its title, once; none open, one is opened", async () => {
  const cfg = { title: "Flakes auto-revert declined", labels: ["delivery-health"] };
  const old = "#5: `a` (test/a.test.ts) failed in main's `ci` (u) and passed when v ran at the same commit (aaaaaaaaa)";
  const gh = fakeGitHub([], {}, { issues: [{ number: 8, title: cfg.title, body: `head\n\n- ${old}` }] });
  await flakeIssue("o/r", cfg, [old, "#6: `b` new", "#6: `b` new"], { apply: true, a: gh, log() {} });
  assert.deepEqual(gh.calls.filter((c) => c[0] !== "get"), [["patch", "/repos/o/r/issues/8", { body: `head\n\n- ${old}\n- #6: \`b\` new` }]]);
  assert.ok(gh.calls.some((c) => c[0] === "get" && /labels=delivery-health/.test(c[1])));
  const same = fakeGitHub([], {}, { issues: [{ number: 8, title: cfg.title, body: `- ${old}` }] });
  await flakeIssue("o/r", cfg, [old], { apply: true, a: same, log() {} });
  assert.equal(same.calls.filter((c) => c[0] !== "get").length, 0, "already listed: no write");
  const dry = fakeGitHub([], {});
  const lines = [];
  await flakeIssue("o/r", cfg, [old], { apply: false, a: dry, log: (l) => lines.push(l) });
  assert.equal(dry.calls.length, 0);
  assert.match(lines[0], /would open the flake issue "Flakes auto-revert declined"/);
  assert.equal(envFor("PATCH", "/repos/o/r/issues/8", { GH_TOKEN: "pat", ISSUE_TOKEN: "issue" }).GH_TOKEN, "issue", "the issue's edit, like its opening, with ISSUE_TOKEN");
});

// 2026-11-28, as it happened in a consuming app: main's burst went red at p, the commit of #21 (release promotion code that
// the failing test doesn't reach; the range's one pull request), on a racy test. It failed again when the burst ran at p,
// then passed at d (#22), after #21. Commits, oldest first: g, p (#21), d (#22).
const ROWS = "rows draw again only when their own message changed";
const ROWS_KEY = `test/rows.test.ts :: ${ROWS}`;
const BURST = { name: "burst", path: ".github/workflows/burst.yml" };
const rowsSrc = () => src({
  files: async () => new Set(["test/rows.test.ts", "src/rows.ts", "release/promote.ts", "src/other.ts"]),
  read: async (_, p) => ({ "test/rows.test.ts": `import { rows } from "../src/rows.ts";\n`, "src/rows.ts": "export const rows = 1;\n" })[p] ?? null,
  commits: async (base, head) => {
    const shas = [sha("d"), sha("p"), sha("g")];
    const range = [
      { sha: sha("d"), parent: sha("p"), subject: "Later (#22)", pr: 22, files: ["src/other.ts"] },
      { sha: sha("p"), parent: sha("g"), subject: "Promote releases (#21)", pr: 21, files: ["release/promote.ts"] },
    ];
    return range.slice(head === "refs/remotes/origin/main" ? 0 : shas.indexOf(head), shas.indexOf(base));
  },
  order: async () => new Map([[sha("g"), 1], [sha("p"), 2], [sha("d"), 3]]),
  later: async (x) => (x === sha("p") ? [{ sha: sha("d"), subject: "Later (#22)", body: "" }] : []),
});
// later: the burst's run at d (null: none yet), its test job's conclusion and log; cause: [side, failed, status] per cause run.
function rowsCase({ later = {}, job = "success", laterLog = [`ok 7 - ${ROWS}`], verified = true, cause = [], open = [], extra = [], jobsOf = {} } = {}) {
  const g = run({ ...BURST, conclusion: "success", head_sha: sha("g"), created_at: at(70) });
  const red = run({ ...BURST, head_sha: sha("p"), updated_at: at(20) });
  const verify = run({ ...BURST, event: "workflow_dispatch", head_branch: `auto-revert/verify-${"p".repeat(12)}`, head_sha: sha("p") });
  const d = later && run({ ...BURST, head_sha: sha("d"), status: "in_progress", conclusion: null, ...later });
  const fail = TAP(ROWS, "test/rows.test.ts");
  const logs = { [red.id]: fail, [verify.id]: fail, ...Object.fromEntries(Object.keys(jobsOf).map((id) => [id, [`ok 7 - ${ROWS}`]])) };
  if (d) {
    jobsOf[d.id] = [{ id: d.id * 10, name: "npm test (ubuntu-latest, 3/14)", status: "completed", conclusion: job }];
    logs[d.id] = laterLog;
  }
  const causeRuns = cause.map(([c, failed, status = "completed"], i) => {
    const r = run({ ...BURST, event: "workflow_dispatch", head_branch: `auto-revert/verify-${c.repeat(12)}-cause-21-${i % 5 + 1}-burst`, head_sha: sha(c), status, conclusion: status === "completed" ? (failed ? "failure" : "success") : null });
    if (failed) logs[r.id] = fail;
    return r;
  });
  const checks = { [sha("h")]: { check_runs: [{ name: "ci checks", status: "completed", conclusion: "success" }] } };
  const gh = Object.assign(fakeGitHub([d, red, g].filter(Boolean), logs, { dispatched: [...(verified ? [verify] : []), ...causeRuns, ...extra], jobsOf, open, checks }), { open });
  return { gh, g, red, verify, d, causeRuns };
}
const CAUSE_CFG = { workflows: ["burst"], bisectRuns: ["burst"], minRedMinutes: 0, rerun: false, flakeIssue: { title: "Flakes auto-revert declined", labels: [] } };
const side = (c, failures, status) => Array.from({ length: 5 }, (_, i) => [c, i < failures, status]);
const tick = async (gh, cfg = CAUSE_CFG) => {
  const lines = [];
  await check("o/r", cfg, { a: gh, now: NOW, apply: true, log: (l) => lines.push(l), source: async () => rowsSrc() });
  return lines;
};
const writes = (gh) => gh.calls.filter((c) => !["get", "lines"].includes(c[0]));
const rowsRevert = (red, g, verify) => {
  const c = { pr: 21, sha: sha("p"), parent: sha("g"), subject: "Promote releases (#21)", failures: [{ failure: { key: ROWS_KEY, test: ROWS, file: "test/rows.test.ts", job: "npm test (ubuntu-latest)" }, first: red, base: g, runs: 1, confirmed: true, verify, prs: 1, blame: { how: "was the only pull request in the range" } }] };
  return { number: 99, node_id: "R", title: 'Revert "Promote releases" (#21)', body: revertBody({ repo: "o/r", c, run: red, minutes: 3 }), head: { ref: "revert-21-promote", sha: sha("h") } };
};

test("cause: a reproduced failure a later main run passed, at a commit with the culprit, is run 5 times at the culprit's parent and at the culprit, not reverted", async () => {
  // The reproduction rule holds first: before the verify run at the red commit fails it, the culprit waits, and no cause check runs.
  const unverified = rowsCase({ verified: false });
  let lines = await tick(unverified.gh);
  assert.ok(lines.some((l) => /culprit #21 .*revert pending: not yet reproduced/.test(l)), lines.join("\n"));
  assert.ok(!writes(unverified.gh).some((c) => c[0] === "gql" || /-cause-/.test(JSON.stringify(c))), "neither a revert nor a cause check");
  // Reproduced, and passed at d since: a cause check, 5 runs on their own branches at each commit, and no revert.
  const { gh, d } = rowsCase();
  lines = await tick(gh);
  assert.ok(lines.some((l) => l.includes(`culprit #21 "Promote releases (#21)": revert pending: \`${ROWS}\` (test/rows.test.ts) passed in https://x/run/${d.id} at ddddddddd on main since, which contains #21; a cause check runs it at #21's parent (ggggggggg) and at #21 (ppppppppp)`)), lines.join("\n"));
  assert.ok(!writes(gh).some((c) => c[0] === "gql"), "no revert");
  const refs = writes(gh).filter((c) => c[1] === "/repos/o/r/git/refs").map((c) => c[2].ref);
  assert.equal(refs.length, 10);
  assert.deepEqual([refs[0], refs[9]], [`refs/heads/auto-revert/verify-${"g".repeat(12)}-cause-21-1-burst`, `refs/heads/auto-revert/verify-${"p".repeat(12)}-cause-21-5-burst`]);
  assert.deepEqual(writes(gh).filter((c) => /dispatches$/.test(c[1]))[0][2], { ref: `auto-revert/verify-${"g".repeat(12)}-cause-21-1-burst` });
  // A workflow that takes a repeat count and a file filter: one run at each commit, of the failing file only.
  const repeat = rowsCase();
  await tick(repeat.gh, { ...CAUSE_CFG, repeatInput: "repeat", testInput: "files" });
  assert.deepEqual(writes(repeat.gh).filter((c) => /dispatches$/.test(c[1])).map((c) => c[2]), [
    { ref: `auto-revert/verify-${"g".repeat(12)}-cause-21-1-burst`, inputs: { repeat: "5", files: "test/rows.test.ts" } },
    { ref: `auto-revert/verify-${"p".repeat(12)}-cause-21-1-burst`, inputs: { repeat: "5", files: "test/rows.test.ts" } },
  ]);
  // Runs at the parent already there (another culprit's at that commit are not): only the culprit's side is dispatched.
  const half = rowsCase({ cause: side("g", 0) });
  await tick(half.gh);
  assert.deepEqual([...new Set(writes(half.gh).filter((c) => /dispatches$/.test(c[1])).map((c) => c[2].ref.slice(0, 31)))], [`auto-revert/verify-${"p".repeat(12)}`]);
});

test("cause: a failure two red runs confirmed, which passed when its workflow ran again at the red commit, starts a cause check, not a revert", async () => {
  const g = run({ ...BURST, conclusion: "success", head_sha: sha("g"), created_at: at(70) });
  const first = run({ ...BURST, head_sha: sha("p"), updated_at: at(30) });
  const red = run({ ...BURST, head_sha: sha("d"), updated_at: at(20) });
  const passed = run({ ...BURST, event: "workflow_dispatch", head_branch: `auto-revert/verify-${"d".repeat(12)}`, head_sha: sha("d"), conclusion: "success" });
  const fail = TAP(ROWS, "test/rows.test.ts");
  const gh = fakeGitHub([red, first, g], { [first.id]: fail, [red.id]: fail }, { dispatched: [passed] });
  const lines = await tick(gh);
  assert.ok(lines.some((l) => l.includes(`culprit #21 "Promote releases (#21)": revert pending: \`${ROWS}\` (test/rows.test.ts) passed when its workflow ran again at ddddddddd; a cause check runs it`)), lines.join("\n"));
  assert.ok(!writes(gh).some((c) => c[0] === "gql"), "no revert");
});

test("laterPass: a log that couldn't be read counts as nothing and is read again on the next tick", async () => {
  const red = run({ head_sha: sha("b") });
  const later = run({ head_sha: sha("n") });
  const f = { key: "test/x.test.ts :: x works", test: "x works", file: "test/x.test.ts", job: "npm test (ubuntu-latest)" };
  const gh = fakeGitHub([], { [later.id]: ["ok 4 - x works"] }, { jobsOf: { [later.id]: [{ id: later.id * 10, name: "npm test (ubuntu-latest, 3/14)", status: "completed", conclusion: "success" }] } });
  const lines = gh.lines;
  gh.lines = () => (async function* () { throw new Error("HTTP 502"); })();
  const cache = {};
  assert.equal(await laterPass("o/r", [later, red], red, f, { a: gh, cache }), null);
  assert.equal(cache.passes, undefined, "nothing kept");
  gh.lines = lines;
  assert.equal((await laterPass("o/r", [later, red], red, f, { a: gh, cache }))?.id, later.id);
});

test("cause: still running, it reverts nothing and dispatches nothing again", async () => {
  const { gh } = rowsCase({ cause: [...side("g", 1), ...side("p", 0, "in_progress")] });
  const lines = await tick(gh);
  assert.ok(lines.some((l) => /culprit #21 .*revert pending: .*; its cause check is running$/.test(l)), lines.join("\n"));
  assert.deepEqual(writes(gh), [], "no revert, no dispatch, no branch deleted");
});

test("cause: the parent failing 1 of 5 and the culprit 2 of 5 is a race on main: no revert, a line in the flake issue, and an open revert is closed, not merged", async () => {
  const { gh, causeRuns } = rowsCase({ cause: [...side("g", 1), ...side("p", 2)] });
  const lines = await tick(gh);
  assert.ok(lines.some((l) => /culprit #21 .*not reverting: .*failed in 1 of 5 runs at #21's parent \(ggggggggg\) and in 2 of 5 runs at #21 \(ppppppppp\).*: a race on main, not #21's/.test(l)), lines.join("\n"));
  assert.ok(!writes(gh).some((c) => c[0] === "gql"), "no revert");
  const issue = writes(gh).find((c) => c[1] === "/repos/o/r/issues");
  assert.ok(issue[2].body.includes(`- #21: \`${ROWS}\` (test/rows.test.ts) passed in`) && issue[2].body.includes(causeRuns[0].html_url) && issue[2].body.includes(causeRuns[5].html_url), issue[2].body);
  // The revert opened before main passed at d is green and main is green now: judged again, closed, naming the runs.
  const live = rowsCase({ later: { status: "completed", conclusion: "success" }, cause: [...side("g", 1), ...side("p", 2)], open: [{}] });
  const pr = Object.assign(live.gh.open[0], rowsRevert(live.red, live.g, live.verify));
  assert.deepEqual(revertData(pr.body).failures.map((f) => f.key), [ROWS_KEY]);
  const said = await tick(live.gh);
  assert.ok(said.some((l) => /main is not red/.test(l)) && said.some((l) => /close revert #99: .*a race on main, not #21's/.test(l)), said.join("\n"));
  assert.ok(!writes(live.gh).some((c) => c[0] === "put"), "not merged");
  const comment = writes(live.gh).find((c) => c[1] === "/repos/o/r/issues/99/comments");
  assert.ok(comment[2].body.startsWith("Closed, not merged:") && comment[2].body.includes(live.causeRuns[0].html_url), comment[2].body);
  assert.deepEqual(writes(live.gh).find((c) => c[0] === "patch"), ["patch", "/repos/o/r/pulls/99", { state: "closed" }]);
  assert.ok(writes(live.gh).some((c) => c[1] === "/repos/o/r/issues"), "the flake issue gets it");
});

test("cause: the parent passing 5 of 5 and the culprit failing reverts, and an open revert merges", async () => {
  const { gh } = rowsCase({ cause: [...side("g", 0), ...side("p", 2)] });
  const lines = await tick(gh);
  assert.ok(lines.some((l) => /culprit #21 .*: revert: .*failed in 0 of 5 runs at #21's parent \(ggggggggg\) and in 2 of 5 runs at #21 \(ppppppppp\).*, so #21 caused it/.test(l)), lines.join("\n"));
  assert.ok(writes(gh).some((c) => c[0] === "gql"), "reverted");
  const live = rowsCase({ later: { status: "completed", conclusion: "success" }, cause: [...side("g", 0), ...side("p", 2)], open: [{}] });
  Object.assign(live.gh.open[0], rowsRevert(live.red, live.g, live.verify));
  await tick(live.gh);
  const put = writes(live.gh).find((c) => c[0] === "put");
  assert.equal(put?.[1], "/repos/o/r/pulls/99/merge");
  assert.ok(!put[2].commit_message.includes("<!--"), "the merge message carries no hidden data");
});

test("cause: a later green run at a commit before the culprit, or one that skipped the test, starts no cause check: the revert goes ahead", async () => {
  const pass = { name: "npm test (ubuntu-latest, 3/14)", status: "completed", conclusion: "success" };
  // A bisect run at g, before #21 in commit order, though created after the red run.
  const bisect = run({ ...BURST, event: "workflow_dispatch", head_branch: `auto-revert/bisect-${"g".repeat(12)}`, head_sha: sha("g"), conclusion: "success" });
  const before = rowsCase({ later: null, extra: [bisect], jobsOf: { [bisect.id]: [{ ...pass, id: bisect.id * 10 }] } });
  let lines = await tick(before.gh);
  assert.ok(lines.some((l) => /culprit #21 .*: revert$/.test(l)), lines.join("\n"));
  assert.ok(!writes(before.gh).some((c) => /-cause-/.test(JSON.stringify(c))), "no cause check");
  for (const later of [{ laterLog: [`ok 7 - ${ROWS} # SKIP`] }, { laterLog: ["Not run: 1 cases that failed on main's last two runs too:", `  test/rows.test.ts > ${ROWS}`, "| test/rows.test.ts | 3 | 0 | 1 | 9 |"] }, { job: "skipped" }, { laterLog: ["ok 7 - another test"] }]) {
    const { gh } = rowsCase(later);
    lines = await tick(gh);
    assert.ok(lines.some((l) => /culprit #21 .*: revert$/.test(l)), `${JSON.stringify(later)}\n${lines.join("\n")}`);
    assert.ok(!writes(gh).some((c) => /-cause-/.test(JSON.stringify(c))), "no cause check");
  }
  // A known-failing list's judge, with no TAP: its log naming the file it judged is the test run.
  const judged = rowsCase({ laterLog: ["| test/rows.test.ts | 3 | 0 | 0 | 9 |"] });
  lines = await tick(judged.gh);
  assert.ok(lines.some((l) => /culprit #21 .*revert pending: .*a cause check runs it/.test(l)), lines.join("\n"));
});
