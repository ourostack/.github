import assert from "node:assert/strict";
import { test } from "node:test";
import { OWNERS, commitVerdicts, episodes, fetchMainRuns, fmtMin, measure, median, route, table } from "./red-main.mjs";

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

test("a commit is red on any failure, ignoring cancelled and skipped runs", () => {
  const v = commitVerdicts([run("a", "ci", "success", 0, 5), run("a", "win", "failure", 0, 8), run("b", "ci", "cancelled", 10, 11), run("b", "x", "skipped", 10, 11), run("b", "ci2", "success", 10, 14)]);
  assert.deepEqual(v.map((c) => [c.sha, c.state, c.at]), [["a", "red", at(8)], ["b", "green", at(14)]]);
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
  assert.equal(m.redMinutes, 25);
  assert.equal(m.episodes, 1);
  assert.equal(m.medianToGreen, 25);
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
  assert.equal(m.redMinutes, 10 + 30 + 3);
  assert.deepEqual([m.episodes, m.medianToGreen], [3, 20]);
  assert.equal(median([1, 3]), 2);
});

test("fetchMainRuns pages until a short page", async () => {
  const pages = [Array(100).fill(run("a", "ci", "success", 0, 1)), [run("b", "ci", "success", 0, 1)]];
  const seen = [];
  const runs = await fetchMainRuns("o/r", at(0), async (p) => (seen.push(p), { workflow_runs: pages.shift() }));
  assert.equal(runs.length, 101);
  assert.match(seen[0], /branch=main&event=push&created=%3E%3D2026-11-17/);
});

const red = (minutes, name = "check") => ({ since: at(0), url: "https://x/run/1", name, minutes });

test("a product red wakes its owner with the run link and not the tooling coordinator", () => {
  const w = route({ "ourostack/ouro-ui": red(), "teams-microsoft/tandem": red(), "gim-home/CIT-pages": red(), "ourostack/ouroboros": red() }, { now: at(10) });
  assert.deepEqual(w.map((x) => [x.repo, x.session, x.reason]), [
    ["ourostack/ouro-ui", "34c6f98e", "owner"],
    ["teams-microsoft/tandem", "86423aa7", "owner"],
    ["gim-home/CIT-pages", "16caf80c", "owner"],
    ["ourostack/ouroboros", "9603c7f8", "owner"],
  ]);
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
  assert.match(out, /o\/r \| 0m \| 0.0% \| 0 \| - \| -/);
  assert.equal(fmtMin(125), "2h 05m");
});
