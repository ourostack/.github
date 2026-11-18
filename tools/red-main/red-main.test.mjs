import assert from "node:assert/strict";
import { test } from "node:test";
import { OWNERS, commitVerdicts, episodes, fetchMainRuns, fmtMin, infraFailures, markInfra, measure, median, route, table } from "./red-main.mjs";

const T = (min) => new Date(Date.UTC(2026, 10, 17, 0, 0) + min * 60000).toISOString();
const at = (min) => Date.UTC(2026, 10, 17, 0, 0) + min * 60000;
const run = (sha, name, conclusion, startMin, endMin, over = {}) => ({
  head_sha: sha,
  name,
  event: "push",
  status: conclusion ? "completed" : "in_progress",
  conclusion,
  run_started_at: T(startMin),
  created_at: T(startMin),
  updated_at: T(endMin),
  html_url: `https://github.com/o/r/actions/runs/${sha}-${name}`,
  ...over,
});

test("a commit is red on any failure, ignoring skipped runs and runs cancelled by a newer push", () => {
  const v = commitVerdicts([run("a", "ci", "success", 0, 5), run("a", "win", "failure", 0, 8), run("b", "ci", "cancelled", 10, 11), run("b", "x", "skipped", 10, 11), run("b", "ci2", "success", 10, 14), run("c", "ci", "success", 20, 22)]);
  assert.deepEqual(v.map((c) => [c.sha, c.state, c.at]), [["a", "red", at(8)], ["b", "green", at(14)], ["c", "green", at(22)]]);
  assert.equal(v[0].url, "https://github.com/o/r/actions/runs/a-win");
});

test("a commit still running is pending and closes nothing", () => {
  const v = commitVerdicts([run("a", "ci", "failure", 0, 5), run("b", "ci", null, 10, 12)]);
  assert.equal(v[1].state, "pending");
  assert.equal(episodes(v)[0].to, null);
});

test("red runs from the first failure to the next all-green head, across several red commits", () => {
  const runs = [run("a", "ci", "success", 0, 5), run("b", "ci", "failure", 10, 15), run("c", "ci", "failure", 20, 25), run("d", "ci", "success", 30, 40)];
  const m = measure(runs, { since: at(0), now: at(100) });
  assert.equal(m.redMinutes, 15);
  assert.equal(m.waitMinutes, 10);
  assert.equal(m.episodes, 1);
  assert.equal(m.medianToGreen, 15);
  assert.equal(m.open, null);
});

test("an open red counts up to now and is reported with its run link", () => {
  const m = measure([run("a", "ci", "success", 0, 5), run("b", "brand", "failure", 10, 15)], { since: at(0), now: at(75) });
  assert.equal(m.redMinutes, 60);
  assert.equal(m.open.minutes, 60);
  assert.equal(m.open.name, "brand");
  assert.equal(m.medianToGreen, null);
});

test("an episode is clipped to the window and median spans closed episodes", () => {
  const runs = [run("a", "ci", "failure", 0, 10), run("b", "ci", "success", 20, 30), run("c", "ci", "failure", 50, 60), run("d", "ci", "success", 70, 90), run("e", "ci", "failure", 100, 101), run("f", "ci", "success", 102, 104)];
  const m = measure(runs, { since: at(20), now: at(200) });
  assert.equal(m.redMinutes, 0 + 10 + 1);
  assert.deepEqual([m.episodes, m.medianToGreen], [3, 10]);
  assert.equal(median([1, 3]), 2);
});

test("fetchMainRuns pages until a short page", async () => {
  const pages = [Array.from({ length: 100 }, (_, i) => run("a", "ci", "success", 0, 1, { id: i })), [run("b", "ci", "success", 0, 1, { id: 100 })]];
  const seen = [];
  const runs = await fetchMainRuns("o/r", at(0), async (p) => (seen.push(p), { workflow_runs: pages.shift() }), at(60));
  assert.equal(runs.length, 101);
  assert.match(decodeURIComponent(seen[0]), /branch=main&event=push&created=2026-11-17T00:00:00Z\.\.2026-11-17T01:00:00Z/);
});

test("fetchMainRuns splits a window that reports more than 1000 runs, so the whole window is read", async () => {
  const day = (h) => Date.UTC(2026, 10, 17, h);
  const ranges = [];
  const get = async (p) => {
    const [from, to] = decodeURIComponent(p.match(/created=([^&]+)/)[1]).split("..").map((t) => Date.parse(t));
    ranges.push([from, to]);
    const hours = (to - from) / 3600000;
    const mine = [0, 1, 2, 3].filter((h) => day(h) >= from && day(h) <= to);
    const page = Number(p.match(/&page=(\d+)/)[1]);
    return { total_count: hours > 2 ? 1200 : mine.length, workflow_runs: page === 1 ? mine.map((h) => ({ id: h, head_sha: String(h) })) : [] };
  };
  const runs = await fetchMainRuns("o/r", day(0), get, day(3) + 1000);
  assert.deepEqual(runs.map((r) => r.id).sort(), [0, 1, 2, 3]);
  assert.ok(ranges.length > 1);
});

const failedJob = (n = 1) => ({ jobs: [{ id: n, conclusion: "failure" }] });
const infraGet = (notes, log = "exit 1") => async (p) => {
  if (p.includes("/jobs?")) return failedJob();
  if (p.includes("/annotations")) return notes;
  if (p.endsWith("/logs")) return log;
  throw new Error(p);
};

test("a failed job annotated title=infra is infra: counted apart, not red", async () => {
  const runs = [run("a", "ci", "success", 0, 5), run("b", "ci", "failure", 10, 15, { id: 7 }), run("c", "ci", "success", 20, 25)];
  await markInfra("o/r", runs, infraGet([{ title: "infra", message: "runner pool exhausted" }]));
  assert.equal(runs[1].infra, "runner pool exhausted");
  const m = measure(runs, { since: at(0), now: at(100) });
  assert.deepEqual([m.redMinutes, m.episodes, m.infra], [0, 0, 1]);
  assert.equal(m.infraRuns[0].reason, "runner pool exhausted");
  assert.equal(route(m.open ? { "o/r": m.open } : {}, { now: at(100) }).length, 0);
});

test("an infra annotation does not hide a code failure in the same commit", async () => {
  const runs = [run("b", "ci", "failure", 10, 15, { id: 7, infra: "x" }), run("b", "win", "failure", 10, 16, { id: 8 })];
  assert.equal(measure(runs, { since: at(0), now: at(100) }).redMinutes, 84);
  assert.equal(infraFailures(runs, { since: at(0), now: at(100) }).length, 0);
});

test("a run whose only failure is a GitHub 5xx or ETIMEDOUT is infra; a plain test failure is red", async () => {
  for (const log of ["gh: POST /graphql: 504", "HTTP 502 Bad Gateway", "connect ETIMEDOUT 140.82.1.1:443"]) {
    const runs = [run("b", "ci", "failure", 10, 15, { id: 7 })];
    await markInfra("o/r", runs, infraGet([], log));
    assert.ok(runs[0].infra, log);
  }
  const runs = [run("b", "ci", "failure", 10, 15, { id: 7 })];
  await markInfra("o/r", runs, infraGet([{ title: "Test failed" }], "expected 504 items"));
  assert.equal(runs[0].infra, undefined);
});

const red = (minutes, name = "check") => ({ since: at(0), url: "https://x/run/1", name, minutes });

test("a product red wakes its owner with the run link and not the tooling coordinator", () => {
  const w = route({ "ourostack/ouro-ui": red(), "teams-microsoft/tandem": red(), "gim-home/CIT-pages": red(), "ourostack/ouroboros": red() }, { now: at(10) });
  const repos = ["ourostack/ouro-ui", "teams-microsoft/tandem", "gim-home/CIT-pages", "ourostack/ouroboros"];
  assert.deepEqual(w.map((x) => [x.repo, x.session, x.reason]), repos.map((repo) => [repo, OWNERS.repos[repo].session, "owner"]));
  assert.match(w[0].message, /https:\/\/x\/run\/1/);
});

test("repos the tooling coordinator owns wake it once; unknown repos fall back to it", () => {
  const w = route({ "ourostack/desk": red(), "ourostack/hackamore": red(), "ourostack/new-thing": red() }, { now: at(5) });
  assert.deepEqual(w.map((x) => x.session), ["4deb13bb", "4deb13bb", "4deb13bb"]);
  assert.ok(w.every((x) => x.reason === "owner"));
});

test("a red past the threshold escalates to the tooling coordinator, once, and only before it", () => {
  assert.equal(route({ "ourostack/ouro-ui": red() }, { now: at(59) }).length, 1);
  const w = route({ "ourostack/ouro-ui": red() }, { now: at(60) });
  assert.deepEqual(w.map((x) => [x.session, x.reason]), [["34c6f98e", "owner"], ["4deb13bb", "escalation"]]);
  assert.equal(route({ "ourostack/desk": red() }, { now: at(600) }).length, 1);
});

test("every watched repo is mapped", () => {
  assert.equal(Object.keys(OWNERS.repos).length, 13);
});

test("the table marks unreadable repos instead of showing green", () => {
  const out = table([{ repo: "gim-home/CIT", error: "404 Not Found" }, { repo: "o/r", m: measure([run("a", "ci", "success", 0, 5)], { since: at(0), now: at(100) }) }]);
  assert.match(out, /gim-home\/CIT \| unreadable/);
  assert.match(out, /o\/r \| 0m \| 0.0% \| 0m \| 0.0% \| 0 \| - \| -/);
  assert.equal(fmtMin(125), "2h 05m");
});

test("startup_failure and a system cancel are infra; a concurrency cancel by a newer push is not a failure", async () => {
  const runs = [run("a", "ci", "startup_failure", 0, 1, { id: 1 }), run("b", "ci", "cancelled", 10, 11, { id: 2 }), run("c", "ci", "success", 20, 25, { id: 3 })];
  await markInfra("o/r", runs, async () => { throw new Error("no reads needed"); });
  assert.equal(runs[0].infra, "startup_failure");
  const m = measure(runs, { since: at(0), now: at(100) });
  assert.deepEqual([m.redMinutes, m.episodes, m.infra], [0, 0, 1]);
  // the same cancel with no later push of that workflow is infra; with one, concurrency cancelled it
  assert.equal(commitVerdicts([run("b", "ci", "cancelled", 10, 11), run("c", "ci", "success", 20, 25)]).filter((c) => c.sha === "b").length, 0);
  assert.equal(commitVerdicts([run("b", "ci", "cancelled", 10, 11)])[0].state, "infra");
});

test("a failed job that never started, or whose log or annotation shows a lost runner, is infra", async () => {
  const job = (o) => async (p) => {
    if (p.includes("/jobs?")) return { jobs: [{ id: 1, conclusion: "failure", ...o.job }] };
    if (p.includes("/annotations")) return o.notes ?? [];
    if (p.endsWith("/logs")) return o.log ?? "exit 1";
    throw new Error(p);
  };
  const cases = [
    { job: { steps: [] } },
    { job: { runner_id: 0 } },
    { job: { runner_id: null } },
    { log: "The runner has received a shutdown signal." },
    { log: "lost communication with the server" },
    { log: "The job was not acquired by Runner of type hosted" },
    { log: "The operation was canceled." },
    { notes: [{ title: "", message: "The runner has received a shutdown signal. This can happen" }] },
  ];
  for (const c of cases) {
    const runs = [run("b", "ci", "failure", 10, 15, { id: 7 })];
    await markInfra("o/r", runs, job(c));
    assert.ok(runs[0].infra, JSON.stringify(c));
  }
  const runs = [run("b", "ci", "failure", 10, 15, { id: 7 })];
  await markInfra("o/r", runs, job({ job: { runner_id: 5, steps: [{ name: "t", conclusion: "failure" }] } }));
  assert.equal(runs[0].infra, undefined);
});

test("a fix commit that waits an hour for runners ends the red at its push; the queue is wait, not red", () => {
  const runs = [run("a", "ci", "failure", 0, 10), run("b", "ci", "success", 20, 80)];
  const m = measure(runs, { since: at(0), now: at(200) });
  assert.deepEqual([m.redMinutes, m.waitMinutes, m.medianToGreen, m.open], [20 - 10, 60, 10, null]);
});

test("a fix commit whose runs fail keeps the stretch red until a later commit passes", () => {
  const runs = [run("a", "ci", "failure", 0, 10), run("b", "ci", "failure", 20, 80), run("c", "ci", "success", 100, 110)];
  const m = measure(runs, { since: at(0), now: at(200) });
  assert.deepEqual([m.redMinutes, m.waitMinutes, m.episodes], [90, 10, 1]);
});

test("a fix commit still queued leaves the stretch open", () => {
  const m = measure([run("a", "ci", "failure", 0, 10), run("b", "ci", null, 20, 30)], { since: at(0), now: at(100) });
  assert.deepEqual([m.redMinutes, m.waitMinutes, m.open.minutes], [90, 0, 90]);
});

test("overlapping pushes: a green commit pushed before the failure lands closes at the failure, and waits never overlap red", () => {
  const runs = [run("a", "ci", "failure", 5, 30), run("b", "ci", "success", 10, 70), run("c", "ci", "failure", 40, 50), run("d", "ci", "success", 60, 65)];
  const m = measure(runs, { since: at(0), now: at(200) });
  assert.deepEqual([m.redMinutes, m.waitMinutes, m.episodes], [10, 20 + 5, 2]);
});
