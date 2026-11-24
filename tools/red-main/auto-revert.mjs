#!/usr/bin/env node
// Auto-revert: when main's ci goes red, find the pull request that broke it and revert it, so nobody has to be awake.
// (Tandem, 2026-11: one regression stayed red 793 minutes overnight; on 2026-11-19 main stayed red 90 minutes while the old
// version, which judged only the newest commit and reverted only the last one, kept saying "main is not red".)
//
//   node tools/red-main/auto-revert.mjs                 # dry run: say what it would do for every opted-in repo
//   node tools/red-main/auto-revert.mjs --apply         # verify, revert and land the revert
//   node tools/red-main/auto-revert.mjs --repo o/r      # only that repo (it must be listed in auto-revert.json, enabled or not)
//   node tools/red-main/auto-revert.mjs --self o/r      # caller-workflow mode: that repo, opted in by the caller, with its token
//   --as-of <ISO time>   replay: judge main as it stood then (runs created later are unseen, runs finishing later still running)
//   --git <dir>          read commits and files from this clone of the repo (default: a blobless clone of its own)
//   --cache <file>       keep each finished job's parsed failures, so a later tick doesn't read its log again
//
// Red is a verdict, not a tip. Each workflow that counts (the repo's "workflows" in auto-revert.json, or every push workflow
// but its "ignoreWorkflows") is judged by its newest COMPLETED push run on main (for a workflow in the repo's "tagRuns", its
// newest completed run dispatched on a release tag of a commit on main; for one in "bisectRuns", its runs dispatched on an
// `auto-revert/bisect-<sha>` branch inside a red range count too, by commit order): a pending or running run says nothing, a run
// cancelled or replaced by concurrency says nothing, and one whose every failure is infrastructure says nothing. Main is red
// while that verdict is a code failure; a newer completed green run clears it. "Newer" is commit order on main (first parent),
// never finish time: when each push has a run of its own (no shared concurrency group), an older commit's run can finish
// after a newer one's, and its red then says nothing about main. Runs are ordered by run number (push order) and, once main
// looks red, by their commits' first-parent order in the clone. A verdict can cover several commits (runs that share a
// concurrency group test only the newest of a burst), so the culprit is found over a range:
//   1. Failures: the red run's failed jobs (latest attempt) are read from their logs: each failing test (TAP `not ok`, its
//      `location:` file and every repository file its failure text names), or, for a job with no test failure, the job and
//      the files its error lines name and its failing step's `run:` names in the workflow file at that commit. A job with no test failure that is infrastructure (classifyFailure) is dropped, and so is a
//      job the workflow lets fail (job-level `continue-on-error: true`, or named report-only: softJobs).
//   2. Range: for each failure, the older completed runs are read until one where it didn't fail. The failure was introduced
//      by a commit after that run and up to the first run where it failed. The newest green run is read like the reds: a job
//      already red there did not begin in the range.
//   3. Attribution: from the failing test file and the files its failure names (distance 0), the code is followed through its
//      runtime imports and the repository paths it names as strings (type-only imports don't count), and, from a test, what
//      it reads as text (Tandem #4096's rule) and every file added under a directory it scans, at the commit that first failed.
//      The squash-merged PR in the range whose files are closest is the culprit; a tie goes to the PR whose change touches
//      the most code names the failing assertion uses, else the newest. With
//      nothing reachable, the range's only PR is the culprit; with several, the failure is reported unattributed.
//   4. Confirmation (flake guard): the first time a red push run (attempt 1) has a failure not yet confirmed, its failed jobs are
//      re-run once (rerunFailed), so a flake clears within minutes instead of holding main red until the next push. A re-attempt
//      goes back to pending in main's shared concurrency group and may be replaced by the next push, losing its verdict (markPartial
//      keeps the failed jobs of its previous attempt). So the workflow is also dispatched (workflow_dispatch,
//      its own group) on a throwaway branch `auto-revert/verify-<sha>` at the red run's commit. A failure is confirmed when it
//      fails again in that run, or in two main runs in a row; one that passes there is a flake and is never reverted. Only
//      confirmed culprits are reverted. Verify branches are deleted once main has moved past them.
//   5. Guards: skip a culprit already reverted or fixed on main since the red run (a later commit names #N), whose every failure
//      is settled since (its job passed whole in a newer run of the workflow, or a newer commit changed its test), with an open fix or
//      revert PR, or while main has been red under the repo's minRedMinutes (Tandem: 0, act on confirmation). And a failure main
//      already had is never blamed on the range (knownBefore): one its runs of the workflow failed the same way in the 24 hours
//      before the range began, or whose test the repo's flake table (its "knownFlakes" file, under "Open known flakes") names,
//      unless the culprit changed the failing test or a file its failure names. A culprit left with no failure is not
//      reverted, and the evidence is posted on its pull request instead.
// Then it opens the revert with GitHub's revertPullRequest (one per culprit, so two breaks in one range are both reverted in
// one cycle), tries auto-merge, and on every tick lands its own open revert PRs whose head checks are green (the repo's
// .github/merge-checks.json `required` list when it has one; never with a failed check, unless main already fails it now
// and its culprit isn't the revert's), with a squash merge.
// It prints the API calls it spent. Reads use READ_TOKEN when set (the caller's GITHUB_TOKEN, which can read Checks); writes use
// GH_TOKEN (contents, pull-requests and actions write).

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { OWNERS, RUNNER_LOST, neverStarted } from "./red-main.mjs";
import { cleanBody } from "../rearm-merges/rearm-merges.mjs";

export const CONFIG = JSON.parse(readFileSync(new URL("./auto-revert.json", import.meta.url), "utf8"));
export const MARKER = "Opened by tools/red-main/auto-revert.mjs in ourostack/.github.";

// A failure that says nothing about the commit under test.
const INFRA_LOG = [
  RUNNER_LOST,
  /ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ECONNREFUSED/,
  /could not resolve host/i,
  /no space left on device/i,
  /fatal: could not read (username|password)/i,
  /remote: (invalid username|repository not found|permission to .* denied)/i,
  /bad credentials|resource not accessible by integration|requires authentication/i,
  /unable to resolve action/i,
  /rate limit exceeded/i,
  /\b(502|503|504) (bad gateway|service unavailable|gateway time-?out)\b/i,
];
const INFRA_STEP = /^(set up job|initialize containers|complete job|post |run actions\/checkout|checkout)/i;
const INFRA_RUN = new Set(["startup_failure", "action_required", "timed_out", "cancelled", "stale"]);

// jobs: failed jobs of the latest attempt, { name, conclusion, steps: [{ name, conclusion }], log, notes, infra }.
export function classifyFailure(run, jobs) {
  if (INFRA_RUN.has(run.conclusion)) return { infra: true, reason: `run ${run.conclusion}` };
  if (!jobs.length) return { infra: true, reason: "no failed job to inspect" };
  for (const j of jobs) {
    if (["cancelled", "timed_out", "startup_failure"].includes(j.conclusion)) return { infra: true, reason: `job "${j.name}" ${j.conclusion}` };
    if (j.unreadable) return { infra: true, reason: `job "${j.name}": annotations unreadable, can't tell infra from code, not reverting` };
    if (neverStarted(j)) return { infra: true, reason: `job "${j.name}" never started (no runner assigned)` };
    const hitNote = INFRA_LOG.find((re) => re.test(j.notes ?? ""));
    if (hitNote) return { infra: true, reason: `job "${j.name}" annotation matches ${hitNote}` };
    if (j.infra) return { infra: true, reason: `job "${j.name}" is annotated title=infra: ${j.infra}` };
    const failedSteps = (j.steps ?? []).filter((s) => s.conclusion === "failure");
    if (!failedSteps.length) return { infra: true, reason: `job "${j.name}" failed with no failed step (runner lost)` };
    const bad = failedSteps.find((s) => INFRA_STEP.test(s.name));
    if (bad) return { infra: true, reason: `job "${j.name}" failed in "${bad.name}"` };
    const hit = INFRA_LOG.find((re) => re.test(j.log ?? ""));
    if (hit) return { infra: true, reason: `job "${j.name}" log matches ${hit}` };
  }
  return { infra: false };
}

// An open PR that already reverts or fixes the red PR (or is this tool's own revert of it).
export function fixPrOpen(openPrs, pr, sha) {
  const n = pr.number;
  const short = (sha ?? "").slice(0, 7);
  const refs = new RegExp(`(^|[^0-9])#${n}([^0-9]|$)${short ? `|${short}` : ""}`);
  return openPrs.find((o) => o.head?.ref?.startsWith(`revert-${n}-`) || (/^revert\b|\b(fix|fixes|repair)\b/i.test(o.title ?? "") && refs.test(`${o.title}\n${o.body ?? ""}`)));
}

// A commit on main after the red run that names #N (a fix forward or a revert of it): the culprit is already handled.
export function fixLanded(later, n) {
  const re = new RegExp(`(^|[^0-9])#${n}([^0-9]|$)`);
  return later.find((c) => re.test(`${c.subject}\n${c.body ?? ""}`));
}

const ms = (t) => new Date(t).getTime();
const short = (sha) => String(sha).slice(0, 9);
const hhmm = (t) => new Date(t).toISOString().slice(11, 16) + "Z";

// A run of a workflow the repo lists in auto-revert.json's "ignoreWorkflows" (its file name without .yml, or its name) is not read at all.
export function ignored(run, ignore) {
  return ignore.includes(stem(run)) || ignore.includes(run.name);
}
const stem = (run) => String(run.path ?? "").split("@")[0].split("/").pop().replace(/\.ya?ml$/, "");

export const PAGE = 50;
export const MAX_PAGES = 6;

// A release tag, vX.Y.Z: the ref a `tagRuns` workflow's main runs are dispatched on.
export const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
// The branch a `bisectRuns` workflow dispatches itself on, at a commit on main inside a red range, to find the commit that
// broke it: `auto-revert/bisect-<sha>`.
export const BISECT = "auto-revert/bisect-";

// Main's push runs of the workflows that count, newest first, back to each one's newest completed green run (or MAX_PAGES).
// With `workflows`, each is read from its own list; otherwise every push run, less `ignore`. A workflow in `tagRuns` (also
// listed in `workflows`) has no push runs: its main runs are dispatched on the release tag of a commit on main (Tandem's
// Mac guards, started on each promoted release), so its workflow_dispatch runs on a release tag are read instead, each
// judging its tag's commit like a push run. A workflow in `bisectRuns` (also in `workflows`) runs on some of main's commits
// only (a shared concurrency group: a burst of merges, one run), and bisects a red range itself: its workflow_dispatch runs
// on a `BISECT` branch at a commit inside the range are read too, one page, marked `bisect`. They judge their commits like
// push runs once runs are in commit order (check), so a red range narrows to the one commit that broke it.
export async function readHistory(repo, get, { workflows = null, ignore = [], tagRuns = [], bisectRuns = [], asOf = null, perPage = PAGE, maxPages = MAX_PAGES } = {}) {
  const created = asOf ? `&created=${encodeURIComponent(`<=${new Date(asOf).toISOString()}`)}` : "";
  const stemOf = (w) => w.replace(/\.ya?ml$/, "");
  const lists = workflows?.length ? workflows.map((w) => ({ base: `/repos/${repo}/actions/workflows/${/\.ya?ml$/.test(w) ? w : `${w}.yml`}/runs`, tags: tagRuns.includes(stemOf(w)) })) : [{ base: `/repos/${repo}/actions/runs`, tags: false }];
  const all = [];
  for (const { base, tags } of lists) {
    for (let page = 1; page <= maxPages; page++) {
      const body = await get(`${base}?${tags ? "event=workflow_dispatch" : "branch=main&event=push"}&per_page=${perPage}&page=${page}${created}`);
      const got = (body.workflow_runs ?? []).filter((r) => !tags || RELEASE_TAG.test(String(r.head_branch ?? ""))).map((r) => replay(r, asOf)).filter((r) => r && !ignored(r, ignore));
      all.push(...got);
      const byWf = groupBy(all, wfKey);
      const done = byWf.size > 0 && [...byWf.values()].every((rs) => rs.some(isGreen));
      if (done || (body.workflow_runs ?? []).length < perPage) break;
    }
  }
  for (const w of (workflows ?? []).filter((x) => bisectRuns.includes(stemOf(x)))) {
    const body = await get(`/repos/${repo}/actions/workflows/${/\.ya?ml$/.test(w) ? w : `${w}.yml`}/runs?event=workflow_dispatch&per_page=${perPage}&page=1${created}`);
    all.push(...(body.workflow_runs ?? []).filter((r) => String(r.head_branch ?? "").startsWith(BISECT)).map((r) => replay(r, asOf)).filter(Boolean).map((r) => ({ ...r, bisect: true })));
  }
  return all;
}
const wfKey = (r) => r.workflow_id ?? r.name;
// Newest first: by the commits' first-parent order on main when `order` (sha -> position, larger is newer) knows both, else
// by run number (push order), then creation.
const newestFirst = (order) => (a, b) => {
  const pa = order?.get(a.head_sha), pb = order?.get(b.head_sha);
  if (pa !== undefined && pb !== undefined && pa !== pb) return pb - pa;
  return (b.run_number ?? 0) - (a.run_number ?? 0) || ms(b.created_at) - ms(a.created_at);
};
const isGreen = (r) => r.status === "completed" && (r.conclusion === "success" || r.recovered === true);
// As of `asOf`: a run created later doesn't exist yet; one that finished later is still running.
function replay(r, asOf) {
  if (!asOf) return r;
  const t = ms(asOf);
  if (ms(r.created_at) > t) return null;
  if (r.status === "completed" && ms(r.updated_at) > t) return { ...r, status: "in_progress", conclusion: null, run_attempt: 1 };
  return r;
}
function groupBy(xs, key) {
  const m = new Map();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
}

// A job that stands for its whole workflow: it passes only when every required job of the run passed, an in-run retry of a
// cancelled shard included (gatefold#557, #563). GitHub still ends such a run `cancelled`, because one job it retried was.
const GATE_JOB = /^(Real unfold$|Full suite passed on tree )/;
const NO_VERDICT = new Set(["cancelled", "skipped", "stale", "neutral", "action_required", "startup_failure"]);
// A run cancelled after it started (by hand, or by a lane making room) still judged the jobs it finished: when one of them
// failed it is a red verdict for those jobs (`partial`). Only cancelled runs newer than their workflow's newest green, that
// ran at least 3 minutes, are looked at (a run replaced while it waited never started).
export async function markPartial(repo, runs, get, order = null) {
  for (const rs of groupBy(runs, wfKey).values()) {
    const sorted = [...rs].sort(newestFirst(order));
    for (const r of sorted) {
      if (isGreen(r)) break;
      // A main run someone re-attempted goes back to pending in main's group and is usually replaced, losing its verdict: its
      // previous attempt's failed jobs still stand.
      if ((r.run_attempt ?? 1) > 1 && (r.status !== "completed" || r.conclusion === "cancelled")) {
        r.jobs = (await get(`/repos/${repo}/actions/runs/${r.id}/attempts/${r.run_attempt - 1}/jobs?per_page=100`)).jobs ?? [];
        r.partial = r.jobs.some((j) => j.conclusion === "failure");
        continue;
      }
      if (r.status !== "completed" || r.conclusion !== "cancelled" || ms(r.updated_at) - ms(r.run_started_at ?? r.created_at) < 3 * 60000) continue;
      r.jobs = (await get(`/repos/${repo}/actions/runs/${r.id}/jobs?filter=latest&per_page=100`)).jobs ?? [];
      r.partial = r.jobs.some((j) => j.conclusion === "failure");
      // Cancelled, yet its gate job passed and no job failed: the retry covered the cancelled job, so the run is green.
      r.recovered = !r.partial && r.jobs.some((j) => GATE_JOB.test(j.name) && j.conclusion === "success");
    }
  }
  return runs;
}

// Per workflow, newest first (commit order with `order`, see newestFirst): its verdict is its newest completed run that has
// one. Returns [{ workflow, state: "green" | "red" | "none", reds: [newest red, the red before it, ...], green }].
export function verdicts(runs, order = null) {
  const out = [];
  for (const rs of groupBy(runs, wfKey).values()) {
    const sorted = [...rs].sort(newestFirst(order));
    const v = { workflow: sorted[0].name, state: "none", reds: [], green: null };
    for (const r of sorted) {
      if (r.partial) {
        v.reds.push(r);
        continue;
      }
      if (r.status !== "completed") continue;
      if (NO_VERDICT.has(r.conclusion) && !r.partial && !r.recovered) continue;
      if (r.conclusion === "success" || r.recovered) {
        v.green = r;
        break;
      }
      v.reds.push(r);
    }
    v.state = v.reds.length ? "red" : v.green ? "green" : "none";
    out.push(v);
  }
  return out;
}

// --- Failures, from a job's log --------------------------------------------------------------------------------------

const STAMP = /^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const PATHISH = /(?:[A-Za-z]:)?[\w@.+~\-\/\\]*[\w\-]\.(?:[cm]?[jt]sx?|json|swift|cs|ps1|psm1|sh|ya?ml|css|html|md|py|go|rs|kt|java|c|cc|cpp|h|m|mm|xml|plist|txt|toml|sql)\b/g;
const BLOCK_LINES = 400;

// One job's log lines -> { tests: [{ name, location, text }], errors: [line] }: node:test's TAP `not ok` blocks with their
// YAML (location, error), and, for jobs without them, the error lines near the end.
export async function parseLog(lines) {
  const tests = [];
  const tail = [];
  let cur = null;
  for await (const raw of lines) {
    const line = String(raw).replace(STAMP, "").replace(ANSI, "").replace(/\r$/, "");
    if (cur) {
      if (cur.indent === null && /^\s*---\s*$/.test(line)) {
        cur.indent = /^\s*/.exec(line)[0];
        continue;
      }
      if ((cur.indent !== null && line === `${cur.indent}...`) || /^\s*(not )?ok \d+ - /.test(line) || /^\s*# Subtest: /.test(line)) {
        tests.push(cur);
        cur = null;
      } else {
        const loc = /^\s*location: '(.+?)'\s*$/.exec(line);
        if (loc) cur.location = loc[1];
        else if (cur.lines < BLOCK_LINES) {
          cur.text += line.slice(0, 1000) + "\n";
          cur.lines++;
        }
        continue;
      }
    }
    const nok = /^\s*not ok \d+ - (.+?)(\s+# .*)?$/.exec(line);
    if (nok) {
      cur = { name: nok[1].trim(), location: null, text: "", lines: 0, indent: null };
      continue;
    }
    if (/##\[error\]|\berror\b|\bfail(ed|ure)?\b|✖|AssertionError/i.test(line)) {
      tail.push(line.slice(0, 1000));
      if (tail.length > 200) tail.shift();
    }
  }
  if (cur) tests.push(cur);
  // A subtest's failure fails its parent too: keep the innermost (the parent has the same location or none).
  return { tests: tests.map(({ name, location, text }) => ({ name, location, text })), errors: tail };
}

// Repository files a text names: each path-like token matched by its longest suffix that is a file of the tree.
export function mentions(text, files) {
  const out = new Set();
  for (const m of String(text).matchAll(PATHISH)) {
    const p = m[0].replace(/\\/g, "/").replace(/^file:\/+/, "/");
    if (p.includes("node_modules/")) continue;
    const parts = p.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const c = parts.slice(i).join("/");
      if (files.has(c)) {
        out.add(c);
        break;
      }
    }
  }
  return [...out];
}

// The workflow step a failed job failed in, as the workflow file has it at that commit: the files its `run:` names (the
// script it runs) are where a job failure with no failing test starts. Steps are matched by name ("Run <command>" when unnamed).
export function stepBlock(yml, step) {
  const lines = String(yml ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)- (?:name: (.+)|run: (.+))$/.exec(lines[i]);
    if (!m) continue;
    const name = (m[2] ?? `Run ${m[3]}`).trim().replace(/^(["'])(.*)\1$/, "$2");
    if (name !== step && !(m[3] && step.startsWith("Run ") && m[3].trim().startsWith(step.slice(4).trim()))) continue;
    const out = [lines[i]];
    for (let k = i + 1; k < lines.length; k++) {
      const ind = /^\s*/.exec(lines[k])[0].length;
      if (lines[k].trim() && (ind < m[1].length || (ind === m[1].length && lines[k].trim().startsWith("- ")))) break;
      out.push(lines[k]);
    }
    return out.join("\n");
  }
  return "";
}

// A run's failures: [{ key, test, file, roots: [repo files at distance 0], job }], or { infra: reason } when none is the code's.
// A job's name without its shard ("npm test (ubuntu-latest, 3/7)" -> "npm test (ubuntu-latest)"): a failure's job, and the
// jobs a later run passed.
export const jobKey = (name) => name.replace(/,?\s*\d+\s*\/\s*\d+\)/, ")").replace(/\s*\(\)$/, "");

// Jobs whose failure never fails the run: those the workflow marks `continue-on-error: true` at job level, by id and by
// name. A report-only job (a hitch probe on a hosted VM) is red on most runs, so its red says nothing about a change
// (ouro-ui-apple #257 reverted a README change for one).
export function softJobs(yml) {
  const out = new Set();
  const lines = String(yml ?? "").split("\n");
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return out;
  let jobIndent = null;
  let cur = null;
  const flush = () => cur?.soft && [cur.id, cur.name].filter(Boolean).forEach((n) => out.add(n));
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = /^ */.exec(line)[0].length;
    if (indent === 0) break;
    jobIndent ??= indent;
    if (indent === jobIndent) {
      flush();
      cur = { id: /^\s*([\w-]+):/.exec(line)?.[1] ?? null, name: null, soft: false, keyIndent: null };
      continue;
    }
    if (!cur) continue;
    cur.keyIndent ??= indent;
    if (indent !== cur.keyIndent) continue;
    const name = /^\s*name:\s*(.+?)\s*$/.exec(line);
    if (name) cur.name = name[1].replace(/^(["'])(.*)\1$/, "$2");
    if (/^\s*continue-on-error:\s*true\s*$/.test(line)) cur.soft = true;
  }
  flush();
  return out;
}

// A job whose red does not fail its run: named report-only, or listed by softJobs (a matrix job's name adds " (…)").
export const softJob = (name, soft = new Set()) =>
  /\breport[ -]only\b/i.test(name) || [...soft].some((n) => name === n || name.startsWith(`${n} (`));

export async function runFailures(repo, run, { a, files, cache = null, read = null }) {
  const jobs = run.jobs ?? (await a.get(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`)).jobs ?? [];
  const red = jobs.filter((j) => ["failure", "timed_out", "cancelled", "startup_failure"].includes(j.conclusion));
  const soft = red.length && read && run.path ? softJobs(await read(run.path.split("@")[0])) : new Set();
  const failed = red.filter((j) => !softJob(j.name, soft));
  if (red.length && !failed.length) return { infra: `only report-only jobs failed (${red.map((j) => j.name).join(", ")})` };
  const out = [];
  const infra = [];
  for (const j of failed) {
    let parsed = cache?.jobs?.[j.id];
    if (!parsed) {
      parsed = { tests: [], errors: [] };
      if (!neverStarted(j) && j.conclusion === "failure") {
        try {
          parsed = await parseLog(a.lines(`/repos/${repo}/actions/jobs/${j.id}/logs`));
        } catch {
          parsed = { tests: [], errors: [], unreadableLog: true };
        }
      }
      if (cache && j.status === "completed") (cache.jobs ??= {})[j.id] = parsed;
    }
    const jobName = jobKey(j.name);
    if (parsed.tests.length) {
      for (const t of parsed.tests) {
        const file = t.location ? mentions(t.location.replace(/:\d+(:\d+)?$/, ""), files)[0] ?? null : null;
        const named = mentions(`${t.name}\n${t.text}`, files);
        const roots = [...new Set([file, ...named].filter(Boolean))];
        out.push({ key: `${file ?? "?"} :: ${t.name}`, test: t.name, file, roots, job: jobName, text: t.text.slice(0, 4000) });
      }
      continue;
    }
    const notes = await readNotes(a, repo, j.id);
    const verdict = classifyFailure({ conclusion: "failure" }, [{ ...notes, name: j.name, conclusion: j.conclusion, runner_id: j.runner_id, steps: j.steps ?? [], log: parsed.errors.join("\n") }]);
    if (verdict.infra) {
      infra.push(verdict.reason);
      continue;
    }
    const step = (j.steps ?? []).find((s) => s.conclusion === "failure")?.name ?? "";
    const runs = step && read && run.path ? mentions(stepBlock(await read(run.path.split("@")[0]), step).replace(/^\s*- name: .*$/m, ""), files) : [];
    out.push({ key: `job ${jobName} :: ${step}`, test: null, file: null, roots: [...new Set([...mentions(parsed.errors.join("\n"), files), ...runs])], job: jobName, step });
  }
  if (!out.length) return { infra: infra[0] ?? (failed.length ? "no failure of the code's" : "no failed job") };
  return { failures: dedupe(out) };
}
function dedupe(fs) {
  const m = new Map();
  for (const f of fs) {
    const had = m.get(f.key);
    if (!had) m.set(f.key, { ...f, jobs: [f.job] });
    else {
      had.jobs = [...new Set([...had.jobs, f.job])];
      had.roots = [...new Set([...had.roots, ...f.roots])];
    }
  }
  return [...m.values()];
}

// Annotations need Checks read, which a fine-grained write token lacks: unreadable means "can't tell", never "code".
async function readNotes(a, repo, id) {
  try {
    const notes = await a.get(`/repos/${repo}/check-runs/${id}/annotations?per_page=100`);
    if (!Array.isArray(notes)) return { unreadable: true };
    const n = notes.find((x) => String(x.title ?? "").trim().toLowerCase() === "infra");
    return { infra: n ? n.message || "infra" : undefined, notes: notes.map((x) => x.message ?? "").join("\n") };
  } catch {
    return { unreadable: true };
  }
}

// --- Attribution -----------------------------------------------------------------------------------------------------

const CODE = /\.(?:[cm]?[jt]sx?)$/;
const RESOLVE_EXT = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs", ".jsx", ".json", "/index.ts", "/index.js", "/index.mjs"];

// The repository files a source file depends on at run time: its imports and re-exports that aren't type-only, dynamic
// imports and requires, and string literals that name a repository path (a spawned script, a fixture).
export function references(path, src, files) {
  const dir = posix.dirname(path);
  const out = new Set();
  const resolve = (spec, fromRoot) => {
    const base = spec.startsWith(".") ? posix.normalize(posix.join(dir, spec)) : fromRoot ? posix.normalize(spec) : null;
    if (!base || base.startsWith("..")) return;
    const stemmed = base.replace(/\.(?:[cm]?js|jsx)$/, "");
    for (const ext of RESOLVE_EXT) {
      for (const c of [base + ext, stemmed + ext]) if (files.has(c)) return void out.add(c);
    }
  };
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  for (const m of code.matchAll(/(?:^|[;\n}])\s*(import|export)\s+(type\s+)?([^;'"`]*?)\bfrom\s*["']([^"']+)["']/g)) if (!m[2]) resolve(m[4]);
  for (const m of code.matchAll(/(?:^|[;\n])\s*import\s*["']([^"']+)["']/g)) resolve(m[1]);
  for (const m of code.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) resolve(m[1]);
  const rest = code.replace(/(?:^|[;\n}])\s*(?:import|export)\s+[^;'"`]*?\bfrom\s*["'][^"']+["']/g, "\n");
  for (const m of rest.matchAll(/["'`]((?:\.{1,2}\/)?[\w@.\-]+(?:\/[\w@.\-]+)+\.[A-Za-z]{1,5})["'`]/g)) {
    resolve(m[1]);
    resolve(m[1], true);
  }
  for (const p of joinedPaths(rest)) {
    resolve(p);
    resolve(p, true);
  }
  // A test (or a test helper) reads what it names as text, not only what it imports (test/hui-views.test.ts reads
  // src/app/shell.tsx): Tandem's PR test selection uses the same rule (scripts/affected-tests.ts, textReaders, #4096): a file's
  // path anywhere, its name in quotes, or, for a file that isn't a module, its name anywhere.
  // Import specifiers are left out: a type-only import still doesn't count.
  if (isTestFile(path)) for (const f of textNamed(src.replace(/(?:^|[;\n}])\s*(?:import|export)\s+[^;'"`]*?\bfrom\s*["'][^"']+["']/g, "\n"), files)) out.add(f);
  out.delete(path);
  return [...out];
}

const SOURCE = /\.(?:ts|tsx|mts|mjs|js)$/;
export const isTestFile = (p) => /^tests?\//.test(p) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p);
// The quoted pieces of path.join(...) / path.resolve(...), joined: path.join(root, "src", "app", "shell.tsx") is src/app/shell.tsx.
function joinedPaths(code) {
  const out = [];
  for (const m of code.matchAll(/\bpath\.(?:posix\.)?(?:join|resolve)\(([^()]*)\)/g)) {
    const parts = [...m[1].matchAll(/["'`]([^"'`\n]+)["'`]/g)].map((x) => x[1]);
    if (parts.length) out.push(parts.join("/").replace(/\/+/g, "/"));
  }
  return out;
}
const bases = new WeakMap();
function baseIndex(files) {
  if (!bases.has(files)) {
    const m = new Map();
    for (const f of files) {
      const b = posix.basename(f);
      m.set(b, [...(m.get(b) ?? []), f]);
    }
    bases.set(files, m);
  }
  return bases.get(files);
}
// The repository files a text names, by #4096's rule (Tandem scripts/affected-tests.ts `names`).
export function textNamed(text, files) {
  const out = new Set();
  const index = baseIndex(files);
  for (const t of text.match(/[\w@.+\-\/]+/g) ?? []) {
    const p = t.replace(/^(?:\.{1,2}\/)+/, "");
    if (files.has(p)) out.add(p);
  }
  for (const m of text.matchAll(/["'`]([\w@.+\-]+\.[A-Za-z0-9]{1,6})["'`]/g)) for (const f of index.get(m[1]) ?? []) out.add(f);
  for (const t of new Set(text.match(/[\w@+\-]+\.[A-Za-z0-9]{1,6}\b/g) ?? [])) for (const f of index.get(t) ?? []) if (!SOURCE.test(f)) out.add(f);
  return [...out];
}

// The repository directories a file scans (readdirSync and the like over a path it names): it depends on every file added there.
export function scannedDirs(src, dirs) {
  if (!/\b(?:readdirSync|readdir|opendirSync|opendir|globSync|glob|walk|walkSync)\s*\(/.test(src)) return [];
  const out = new Set();
  const outside = src.replace(/\bpath\.(?:posix\.)?(?:join|resolve)\([^()]*\)/g, " ");
  const cands = [...joinedPaths(src), ...[...outside.matchAll(/["'`]([\w@.\-]+(?:\/[\w@.\-]+)*)\/?["'`]/g)].map((m) => m[1])];
  for (const c of cands) {
    const d = c.replace(/^(?:\.{1,2}\/)+/, "").replace(/\/$/, "");
    if (d && dirs.has(d)) out.add(d);
  }
  return [...out];
}
const dirsOf = new WeakMap();
function dirSet(files) {
  if (!dirsOf.has(files)) {
    const s = new Set();
    for (const f of files) for (let d = posix.dirname(f); d !== "."; d = posix.dirname(d)) s.add(d);
    dirsOf.set(files, s);
  }
  return dirsOf.get(files);
}

// Distance from the failure's roots to every file it reaches through references(), at one commit.
// Directories a file scans are kept in `dist.dirs` (directory -> distance): a file added under one is that far.
export async function distances(roots, { read, files, maxDepth = 12, maxFiles = 6000 }) {
  const dist = new Map(roots.map((r) => [r, 0]));
  dist.dirs = new Map();
  let frontier = [...roots];
  for (let d = 1; d <= maxDepth && frontier.length && dist.size < maxFiles; d++) {
    const next = [];
    const srcs = await pool(frontier.filter((f) => CODE.test(f)), 16, async (f) => [f, await read(f)]);
    for (const [f, src] of srcs) {
      if (src == null) continue;
      if (isTestFile(f)) for (const dir of scannedDirs(src, dirSet(files))) if (!dist.dirs.has(dir)) dist.dirs.set(dir, d);
      for (const r of references(f, src, files)) {
        if (dist.has(r)) continue;
        dist.set(r, d);
        next.push(r);
      }
    }
    frontier = next;
  }
  return dist;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  }));
  return out;
}

// commits: the range's first-parent commits on main, newest first: { sha, subject, at, files, pr }.
// Returns { pr, sha, subject, distance, file, how } or null.
// `ties`: every PR at the best distance (newest first), for a tie-break on what the failure says (evidence()).
export function culprit(commits, dist) {
  let best = null;
  const at = new Map();
  for (const c of commits) {
    if (!c.pr) continue;
    for (const f of c.files) {
      let d = dist.get(f);
      let file = f;
      let how = null;
      if (d === undefined && (c.added ?? []).includes(f)) {
        for (let dir = posix.dirname(f); dir !== "."; dir = posix.dirname(dir)) {
          const dd = dist.dirs?.get(dir);
          if (dd !== undefined && (d === undefined || dd < d)) {
            d = dd;
            how = `added ${f} under ${dir}/, which a test ${dd} reference${dd > 1 ? "s" : ""} from the failure scans`;
          }
        }
      }
      if (d === undefined) continue;
      how ??= d === 0 ? `changed ${f}, which the failure names` : `changed ${file}, ${d} reference${d > 1 ? "s" : ""} from the failure`;
      if (!at.has(c.pr) || d < at.get(c.pr).distance) at.set(c.pr, { pr: c.pr, sha: c.sha, subject: c.subject, distance: d, file, how });
      if (!best || d < best.distance) best = at.get(c.pr);
    }
  }
  if (best) return { ...best, ties: [...at.values()].filter((x) => x.distance === best.distance) };
  const prs = commits.filter((c) => c.pr);
  if (prs.length === 1) return { pr: prs[0].pr, sha: prs[0].sha, subject: prs[0].subject, distance: Infinity, file: null, how: "the only pull request in the range" };
  return null;
}

// The pull request a squash-merged revert takes back: `Revert "<title>" (#N) (#M)` or `Revert "<title> (#N)" (#M)`.
export function revertOf(subject) {
  const m = /^Revert\b.*\(#(\d+)\)"?\s*\(#\d+\)\s*$/.exec(subject ?? "");
  return m ? Number(m[1]) : null;
}

// Each failure of the newest red run, traced back through the older completed runs to where it began, and attributed.
// reds: the workflow's red runs, newest first; green: the run before them (or null).
export async function analyse(repo, v, { a, src, cache = null, maxWalk = 8, asOf = null }) {
  const files = await src.files(v.reds[0].head_sha);
  const chain = [];
  for (const run of v.reds.slice(0, maxWalk)) {
    const r = await runFailures(repo, run, { a, files, cache, read: (p) => src.read(run.head_sha, p) });
    chain.push({ run, ...r });
    if (chain.length === 1 && r.infra) continue;
    const head = chain.find((c) => c.failures);
    if (!head) continue;
    const open = head.failures.filter((f) => chain.filter((c) => c.failures).every((c) => c.failures.some((g) => g.key === f.key)));
    if (!open.length) break;
  }
  const reds = chain.filter((c) => c.failures);
  if (!reds.length) return { infra: chain[0]?.infra ?? "no failure", newest: v.reds[0] };
  const newest = reds[0];
  const check = await verification(repo, newest.run, { a, files, cache, src, asOf });
  // The green run that bounds the range is read too: a job red there (one the workflow lets fail) was already failing
  // before the range, so the range did not start it.
  const green = v.green && (chain.length === v.reds.length || chain.length < maxWalk)
    ? { run: v.green, failures: (await runFailures(repo, v.green, { a, files, cache, read: (p) => src.read(v.green.head_sha, p) })).failures ?? [] }
    : null;
  const older = [...chain.slice(chain.indexOf(newest) + 1).filter((c) => c.failures), ...(green ? [green] : [])];
  const results = [];
  for (const f of newest.failures) {
    let first = newest;
    let base = null;
    let runs = 1;
    for (const c of older) {
      if (c.failures.some((g) => g.key === f.key)) {
        first = c;
        runs++;
      } else {
        base = c.run;
        break;
      }
    }
    const again = check.state === "done" && check.keys.has(f.key);
    const confirmed = runs >= 2 || again;
    const flake = !confirmed && check.state === "done";
    const r = { failure: f, first: first.run, base, runs, confirmed, flake, verify: check.run ?? null };
    if (!base) {
      results.push({ ...r, blame: null, why: "where it began is beyond the runs read" });
      continue;
    }
    // A pull request already reverted after the failure began (its revert landed and the failure stayed) is not the culprit.
    const reverted = new Set((first.run.head_sha === newest.run.head_sha ? [] : await src.commits(first.run.head_sha, newest.run.head_sha)).map((c) => revertOf(c.subject)).filter(Boolean));
    const commits = (await src.commits(base.head_sha, first.run.head_sha)).filter((c) => !reverted.has(c.pr));
    const firstFiles = first.run.head_sha === v.reds[0].head_sha ? files : await src.files(first.run.head_sha);
    const dist = await distances(f.roots.filter((x) => firstFiles.has(x)), { read: (p) => src.read(first.run.head_sha, p), files: firstFiles });
    let blame = culprit(commits, dist);
    if (blame?.ties?.length > 1 && src.diff) blame = await evidence(blame, f, { src, testSha: first.run.head_sha });
    // Its PR changed the failing test or a file its failure names: a failure seen on main before still counts against it.
    const touched = blame?.distance === 0;
    results.push({ ...r, prs: commits.filter((c) => c.pr).length, blame, touched, why: blame ? blame.how : f.roots.length ? "no pull request in the range touches what it reaches" : "its failure names no file and its step runs none" });
  }
  return { newest: newest.run, results, check };
}

export const VERIFY = "auto-revert/verify-";
export const verifyBranch = (sha) => `${VERIFY}${sha.slice(0, 12)}`;

// The verification of a red main run: its workflow dispatched on `auto-revert/verify-<sha>` at the same commit. Returns
// { state: "none" | "running" | "done", run, keys: the failure keys it reproduced }.
export async function verification(repo, run, { a, files, cache = null, src = null, asOf = null }) {
  const list = (await a.get(`/repos/${repo}/actions/runs?head_sha=${run.head_sha}&event=workflow_dispatch&per_page=20`)).workflow_runs ?? [];
  const mine = list
    .map((r) => replay(r, asOf))
    .filter((r) => r && (r.workflow_id ?? r.name) === (run.workflow_id ?? run.name) && String(r.head_branch ?? "").startsWith(VERIFY) && !["cancelled", "skipped", "stale"].includes(r.conclusion))
    .sort((x, y) => ms(y.created_at) - ms(x.created_at));
  const vr = mine[0];
  if (!vr) return { state: "none", keys: new Set() };
  if (vr.status !== "completed") return { state: "running", run: vr, keys: new Set() };
  if (vr.conclusion === "success") return { state: "done", run: vr, keys: new Set() };
  const r = await runFailures(repo, vr, { a, files, cache, read: src ? (p) => src.read(vr.head_sha, p) : null });
  return { state: "done", run: vr, keys: new Set((r.failures ?? []).map((f) => f.key)) };
}

// Dispatches the red run's workflow on a throwaway branch at its commit: its own concurrency group, so nothing on main waits
// on it or replaces it. Never re-runs the main run itself.
export async function dispatchVerify(repo, run, { apply, a = api, log = console.log } = {}) {
  const branch = verifyBranch(run.head_sha);
  const file = String(run.path ?? "").split("@")[0].split("/").pop();
  log(`  ${apply ? "" : "would "}dispatch ${file} on ${branch} (${short(run.head_sha)}) to tell a flake from a break`);
  if (!apply) return true;
  try {
    await a.post(`/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: run.head_sha }).catch((e) => {
      if (!/Reference already exists|422/.test(e.message)) throw e;
    });
    await a.post(`/repos/${repo}/actions/workflows/${file}/dispatches`, { ref: branch });
    return true;
  } catch (e) {
    log(`  could not dispatch ${file} (${e.message.slice(0, 120)}); two red runs in a row confirm instead`);
    return false;
  }
}

// First red on a push run: re-run its failed jobs once. Attempt 2 is never re-run again; a 403 is logged and the tick goes on.
export async function rerunFailed(repo, run, { apply, a = api, log = console.log } = {}) {
  if ((run.run_attempt ?? 1) > 1 || run.status !== "completed" || run.event !== "push" || run.conclusion !== "failure") return false;
  log(`  ${apply ? "" : "would "}re-run the failed jobs of run ${run.id} once (attempt 1)`);
  if (!apply) return true;
  try {
    await a.post(`/repos/${repo}/actions/runs/${run.id}/rerun-failed-jobs`, {});
    return true;
  } catch (e) {
    log(`  could not re-run run ${run.id} (${e.message.slice(0, 120)})`);
    return false;
  }
}

// Verify branches for commits main no longer needs verified are deleted.
export async function pruneVerify(repo, keep, { apply, a = api, log = console.log } = {}) {
  let refs = [];
  try {
    refs = await a.get(`/repos/${repo}/git/matching-refs/heads/${VERIFY}`);
  } catch {
    return;
  }
  for (const r of Array.isArray(refs) ? refs : []) {
    const name = r.ref.replace(/^refs\/heads\//, "");
    if (keep.has(name)) continue;
    log(`${repo}: ${apply ? "" : "would "}delete ${name}, no longer needed`);
    if (apply) await a.del(`/repos/${repo}/git/${r.ref}`).catch(() => {});
  }
}

// Names in code (camelCase, snake_case, $-names) a failure's assertion uses: the line of the test that carries the failure's
// message, and the failure text itself.
const KEYWORDS = new Set(["assert", "match", "equal", "deepEqual", "strictEqual", "const", "true", "false", "null", "undefined", "await", "async", "return", "function", "length", "expected", "actual", "operator", "failureType", "testCodeFailure", "duration_ms", "AssertionError", "ERR_ASSERTION"]);
export function codeNames(text) {
  return new Set([...String(text).matchAll(/[A-Za-z_$][\w$]{3,}/g)].map((m) => m[0]).filter((w) => !KEYWORDS.has(w) && (/[a-z][A-Z]|_|\$/.test(w))));
}
// PRs tied at the closest distance: the one whose change to that file touches the most names the failing assertion uses wins
// (#4081 changed `railBadge(e, { activityNew: ...` that hui-views asserts; #4089, newer, only moved another line of the same file).
export async function evidence(blame, f, { src, testSha }) {
  // The assertion's message, as node:test prints it (`error: "..."`, or `error: |-` and the lines under it).
  const err = /^\s*error: (?:[|>][-+]?\s*\n\s*)?["']?(.+?)["']?\s*$/m.exec(f.text ?? "")?.[1] ?? "";
  const pieces = err.split(/["'`\\]/).filter((x) => x.trim().length >= 12).map((x) => x.slice(0, 50));
  let assertion = "";
  if (f.file && pieces.length) {
    const test = (await src.read(testSha, f.file)) ?? "";
    assertion = test.split("\n").filter((l) => pieces.some((m) => l.includes(m))).join("\n");
  }
  const names = codeNames(`${assertion}\n${(f.text ?? "").split("\n").slice(0, 12).join("\n")}`);
  if (!names.size) return blame;
  const scored = await Promise.all(blame.ties.map(async (t) => {
    const changed = (await src.diff(t.sha, t.file)) ?? "";
    return { ...t, score: [...names].filter((n) => changed.includes(n)).length };
  }));
  const top = scored.reduce((a, b) => (b.score > a.score ? b : a));
  if (!top.score || scored.filter((x) => x.score === top.score).length > 1) return blame;
  return { ...top, ties: blame.ties, how: `${top.how}; of ${blame.ties.length} pull requests that did, its change has ${top.score} of the names the failing assertion uses` };
}

// Groups the attributed failures by culprit: [{ pr, sha, subject, failures, confirmed }].
export function culprits(results) {
  const m = new Map();
  for (const r of results.filter((x) => x.blame)) {
    const c = m.get(r.blame.pr) ?? { pr: r.blame.pr, sha: r.blame.sha, subject: r.blame.subject, failures: [], confirmed: false, first: r.first };
    c.failures.push(r);
    c.confirmed ||= r.confirmed;
    c.flake = (c.flake ?? true) && r.flake;
    m.set(r.blame.pr, c);
  }
  return [...m.values()].sort((x, y) => y.pr - x.pr);
}

// The jobs that passed whole on main after a red run: for each job (by jobKey), the newest commit after `newest` whose run
// of the same workflow has every one of its shards done and green (skipped ones aside, one at least green). Reads the jobs
// of up to `max` newer runs, newest first, running or done: a run still going counts for the jobs it finished.
export async function laterGreen(repo, runs, newest, { a, order = null, max = 3, asOf = null }) {
  const newer = runs
    .filter((r) => wfKey(r) === wfKey(newest) && r.id !== newest.id && r.head_sha !== newest.head_sha && newestFirst(order)(r, newest) < 0)
    .sort(newestFirst(order))
    .slice(0, max);
  const green = new Map();
  for (const r of newer) {
    // Always the latest attempt's jobs: markPartial may have left a run's previous attempt in r.jobs.
    let jobs = [];
    for (let page = 1; page <= 3; page++) {
      const got = (await a.get(`/repos/${repo}/actions/runs/${r.id}/jobs?filter=latest&per_page=100&page=${page}`)).jobs ?? [];
      jobs.push(...got);
      if (got.length < 100) break;
    }
    if (asOf) jobs = jobs.map((j) => (j.completed_at && ms(j.completed_at) > ms(asOf) ? { ...j, status: "in_progress", conclusion: null } : j));
    for (const [name, js] of groupBy(jobs, (j) => jobKey(j.name))) {
      const done = js.every((j) => j.status === "completed" && ["success", "skipped"].includes(j.conclusion)) && js.some((j) => j.conclusion === "success");
      if (done && !green.has(name)) green.set(name, r.head_sha);
    }
  }
  return green;
}

// Why a failure no longer needs its culprit reverted, or null: its job passed whole on main since (greenLater), or a commit
// on main since changed the test or a file its failure names (changedLater, first-parent commits after the red run with
// their files). Tandem, 2026-11-20: two reverts of #4243 were opened over a test #4252 had already fixed, judged from a run
// at an older commit that was still main's newest finished one while the runs after it waited for runners.
export function settledBy(f, { greenLater = new Map(), changedLater = [] } = {}) {
  const passed = greenLater.get(f.job);
  if (passed) return `${f.job} passed at ${short(passed)} on main since`;
  const named = new Set(f.roots ?? (f.file ? [f.file] : []));
  const changed = named.size ? changedLater.find((c) => c.files?.some((x) => named.has(x))) : null;
  if (changed) return `${changed.pr ? `#${changed.pr}` : short(changed.sha)} (${short(changed.sha)}) changed ${changed.files.find((x) => named.has(x))} on main since`;
  return null;
}

// Per culprit: { action: "revert" | "wait" | "skip", reason }.
export function decide(c, { later = [], openPrs = [], minutes, minRedMinutes, greenLater = new Map(), changedLater = [] }) {
  const landed = fixLanded(later, c.pr);
  if (landed) return { action: "skip", reason: `${short(landed.sha)} on main since names #${c.pr}: ${landed.subject}` };
  const settled = (c.failures ?? []).map((x) => settledBy(x.failure, { greenLater, changedLater }));
  if (settled.length && settled.every(Boolean)) return { action: "skip", reason: settled.join("; ") };
  const open = fixPrOpen(openPrs, { number: c.pr }, c.sha);
  if (open) return { action: "skip", reason: `a fix or revert PR is already open (#${open.number})` };
  if (!c.confirmed && c.flake) return { action: "skip", reason: "passed when its workflow was dispatched at the same commit: a flake" };
  if (!c.confirmed) return { action: "wait", reason: "not yet reproduced: the verify run at the same commit decides" };
  if (minutes < minRedMinutes) return { action: "wait", reason: `red for ${minutes}m, under ${minRedMinutes}m` };
  return { action: "revert", reason: "reproduced" };
}

// --- Failures main already had: never blamed on the range -----------------------------------------------------------
// A failure that main's runs of the workflow already had in the KNOWN_HOURS before the range began (its base run), or whose
// test the repository's flake table names as an open known flake, did not begin in the range, so no pull request there is
// its culprit, unless that pull request changed the failing test or a file its failure names. Tandem, 2026-11-24: #5252
// reverted #5241 (types only, in test/organization.test.ts) for sent-echo-window.test.ts's mention test, which had failed
// the same way on main at d6e0dd53 and e2da1c5b before it (Windows runners' stalls and a reply-box bug, B172).
export const KNOWN_HOURS = 24;
/** The newest red runs before a range that are read for its failures (each a jobs list, and its failed jobs' logs once: --cache). */
export const KNOWN_RUNS = 12;
export const KNOWN_MARKER = "Not reverted by tools/red-main/auto-revert.mjs in ourostack/.github:";

// The open known flakes a repository's flake table names: under a heading "Open known flakes", each list item or table row
// naming a file in backticks. Returns Map(file -> that line).
export function openFlakes(md) {
  const out = new Map();
  let level = 0;
  for (const line of String(md ?? "").split("\n")) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      if (level && h[1].length <= level) level = 0;
      if (/\bopen known flakes\b/i.test(h[2])) level = h[1].length;
      continue;
    }
    if (!level || !/^\s*(?:[-*]|\|)/.test(line) || /^\s*\|\s*-/.test(line)) continue;
    for (const m of line.matchAll(/`([^`\s]+\.[A-Za-z]+)(?::\d+)?`/g)) if (!out.has(m[1])) out.set(m[1], line.trim().replace(/^[-*|]\s*/, "").slice(0, 300));
  }
  return out;
}

// Main's red runs of the run's workflow (push runs only) in the `hours` before `before`, newest first, at most `max`, with
// their failures' keys: [{ run, keys }].
export async function earlierReds(repo, run, before, { a, files, cache = null, src = null, hours = KNOWN_HOURS, max = KNOWN_RUNS }) {
  if (run.event && run.event !== "push") return [];
  const to = ms(before);
  const from = to - hours * 3600000;
  const range = encodeURIComponent(`${new Date(from).toISOString()}..${new Date(to).toISOString()}`);
  const list = (await a.get(`/repos/${repo}/actions/workflows/${run.workflow_id}/runs?branch=main&event=push&per_page=100&created=${range}`)).workflow_runs ?? [];
  const reds = list
    .filter((r) => r.status === "completed" && ["failure", "cancelled"].includes(r.conclusion) && ms(r.created_at) < to && ms(r.created_at) >= from && r.id !== run.id)
    .sort((x, y) => ms(y.created_at) - ms(x.created_at))
    .slice(0, max);
  const out = [];
  for (const r of reds) {
    const got = await runFailures(repo, r, { a, files, cache, read: src ? (p) => src.read(r.head_sha, p) : null });
    if (got.failures) out.push({ run: r, keys: new Set(got.failures.map((f) => f.key)) });
  }
  return out;
}

// Why one attributed failure (an analyse result) is not its culprit's, or null: main already had it (`earlier`, from
// earlierReds), or its test is an open known flake (`flakes`, from openFlakes). Never when the culprit touched it.
export function knownBefore(x, { pr, earlier = [], flakes = new Map(), flakeDoc = "the flake table" }) {
  if (x.touched) return null;
  const f = x.failure;
  const flake = f.file ? flakes.get(f.file) : null;
  if (flake) return `${f.file} is an open known flake in ${flakeDoc}: ${flake}`;
  const seen = earlier.find((e) => e.keys.has(f.key));
  if (seen) return `it failed the same way on main before #${pr}: ${seen.run.html_url} (${short(seen.run.head_sha)}, ${hhmm(seen.run.created_at)})`;
  return null;
}

// Posts the evidence on the pull request it didn't revert, once per pull request.
export async function postKnown(repo, c, reasons, { run, apply, a = api, log = console.log }) {
  const body = [
    `${KNOWN_MARKER} main's \`${run.name}\` went red (${run.html_url}) in a range whose only suspect was #${c.pr}, but each failure was already failing on main before it:`,
    "",
    ...c.failures.map((x, i) => `- ${x.failure.test ? `\`${x.failure.test}\` (${x.failure.file ?? x.failure.jobs.join(", ")})` : `job \`${x.failure.job}\`${x.failure.step ? `, step "${x.failure.step}"` : ""}`}: ${reasons[i]}.`),
    "",
    "So #" + c.pr + " stays. A failure it changed, or one main never had before, is still reverted.",
  ].join("\n");
  log(`  ${apply ? "" : "would "}post the evidence on #${c.pr}`);
  if (!apply) return;
  const had = (await a.get(`/repos/${repo}/issues/${c.pr}/comments?per_page=100`)) ?? [];
  if (had.some((m) => String(m.body ?? "").includes(KNOWN_MARKER))) return log(`  #${c.pr} already has it`);
  await a.post(`/repos/${repo}/issues/${c.pr}/comments`, { body });
}

export function revertBody({ repo, c, run, minutes }) {
  const lines = c.failures.map((r) => `- ${r.failure.test ? `\`${r.failure.test}\` (${r.failure.file ?? r.failure.jobs.join(", ")})` : `job \`${r.failure.job}\`${r.failure.step ? `, step "${r.failure.step}"` : ""}`}: first failed in ${r.first.html_url} (${short(r.first.head_sha)}), passed in ${r.base.html_url} (${short(r.base.head_sha)}); of the ${r.prs} pull requests between, #${c.pr} ${r.blame.how}. Failed in ${r.runs} run${r.runs > 1 ? "s" : ""}${r.runs < 2 ? `, and again when ${r.verify?.html_url ?? "its workflow"} ran at the same commit` : " in a row"}.`);
  return [
    `Automatic revert of #${c.pr} (${c.subject.replace(/\s*\(#\d+\)\s*$/, "")}).`,
    "",
    `Main's \`${run.name}\` in ${repo} has been red for ${minutes} minutes (${run.html_url}). What it failed and why #${c.pr}:`,
    "",
    ...lines,
    "",
    `Merging this turns those failures green. Re-land #${c.pr} with the fix; to keep it instead, close this and fix forward. ${MARKER}`,
  ].join("\n");
}

// --- GitHub ----------------------------------------------------------------------------------------------------------

const run = promisify(execFile);
const readEnv = (method) => (method === "GET" && process.env.READ_TOKEN ? { ...process.env, GH_TOKEN: process.env.READ_TOKEN } : process.env);
// GitHub's own transient failures (5xx, a reset connection) are tried once more after a pause.
async function http(method, path, body) {
  try {
    return await http1(method, path, body);
  } catch (e) {
    if (!/HTTP 5\d\d|ECONNRESET|ETIMEDOUT|EOF/.test(e.message)) throw e;
    await new Promise((r) => setTimeout(r, 5000));
    return http1(method, path, body);
  }
}
async function http1(method, path, body) {
  const args = ["api", "-X", method, path.replace(/^\/graphql$/, "graphql"), ...(body ? ["--input", "-"] : [])];
  const child = run("gh", args, { maxBuffer: 64 * 1024 * 1024, env: readEnv(method) });
  if (body) child.child.stdin.end(JSON.stringify(body));
  else child.child.stdin.end();
  let out;
  try {
    out = (await child).stdout;
  } catch (err) {
    throw new Error(`${method} ${path}: ${String(err.stderr || err.message).trim().slice(0, 200)}`);
  }
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}
// A job's log, a line at a time: logs run to hundreds of megabytes, so they are streamed, never held.
async function* lines(path) {
  const child = spawn("gh", ["api", path, "--allow-escape-sequences"], { env: readEnv("GET"), stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const done = new Promise((res) => child.on("close", res));
  yield* createInterface({ input: child.stdout, crlfDelay: Infinity });
  if ((await done) !== 0) throw new Error(`GET ${path}: ${err.trim().slice(0, 200)}`);
}
export const api = {
  get: (path) => http("GET", path),
  post: (path, body) => http("POST", path, body ?? {}),
  put: (path, body) => http("PUT", path, body ?? {}),
  del: (path) => http("DELETE", path),
  lines,
  async graphql(query, variables) {
    const r = await http("POST", "/graphql", { query, variables });
    if (r.errors) throw new Error(r.errors.map((e) => e.message).join("; "));
    return r.data;
  },
};

// Counts every API call a run makes, by method.
export function counted(a = api) {
  const calls = { GET: 0, POST: 0, graphql: 0 };
  return {
    calls,
    get: (p) => (calls.GET++, a.get(p)),
    lines: (p) => (calls.GET++, a.lines(p)),
    post: (p, b) => (calls.POST++, a.post(p, b)),
    put: (p, b) => (calls.POST++, a.put(p, b)),
    del: (p) => (calls.POST++, a.del(p)),
    graphql: (q, v) => (calls.graphql++, a.graphql(q, v)),
  };
}

// --- The repository's history, from git ------------------------------------------------------------------------------

// In Actions, git authenticates with the reading token through the environment (GIT_CONFIG_*), never the command line or a
// config file, so no error message or log line can carry it. Elsewhere git uses the machine's own sign-in.
function gitEnv() {
  const token = process.env.GITHUB_ACTIONS === "true" ? process.env.READ_TOKEN || process.env.GH_TOKEN : "";
  if (!token) return process.env;
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  return { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: header, GIT_TERMINAL_PROMPT: "0" };
}
// `at`: ["-C", dir] for a working clone, ["--git-dir", dir] for a bare one (some machines refuse -C on a bare repository).
const git = (at, args) =>
  run("git", [...at, ...args], { maxBuffer: 256 * 1024 * 1024, env: gitEnv() }).then(
    (r) => r.stdout,
    (e) => {
      throw new Error(`git ${args[0]} failed: ${String(e.stderr ?? "").trim().split("\n").pop()?.slice(0, 200) ?? ""}`);
    },
  );

function gitInput(at, args, input, env = {}) {
  const child = run("git", [...at, ...args], { maxBuffer: 256 * 1024 * 1024, env: { ...gitEnv(), ...env } });
  child.child.stdin.end(input);
  return child.then(
    (r) => r.stdout,
    (e) => {
      throw new Error(`git ${args.filter((x) => !x.startsWith("-"))[0]} failed: ${String(e.stderr ?? "").trim().split("\n").pop()?.slice(0, 200) ?? ""}`);
    },
  );
}

// One `git cat-file --batch` for every read: `<sha>:<path>` in, the blob (or null when there is none) out, in order.
function catFile(at) {
  let child = null;
  let buf = Buffer.alloc(0);
  const waiting = [];
  const pump = () => {
    while (waiting.length) {
      const nl = buf.indexOf(10);
      if (nl < 0) return;
      const head = /^\S+ (\w+) (\d+)$/.exec(buf.subarray(0, nl).toString());
      if (!head) {
        buf = buf.subarray(nl + 1);
        waiting.shift()(null);
        continue;
      }
      const size = Number(head[2]);
      if (buf.length < nl + 1 + size + 1) return;
      const body = buf.subarray(nl + 1, nl + 1 + size).toString("utf8");
      buf = buf.subarray(nl + 1 + size + 1);
      waiting.shift()(head[1] === "blob" ? body : null);
    }
  };
  const read = (spec) =>
    new Promise((resolve) => {
      if (!child) {
        child = spawn("git", [...at, "cat-file", "--batch"], { env: gitEnv(), stdio: ["pipe", "pipe", "ignore"] });
        child.stdout.on("data", (d) => {
          buf = Buffer.concat([buf, d]);
          pump();
        });
        child.on("close", () => waiting.splice(0).forEach((w) => w(null)));
        child.stdin.on("error", () => {});
      }
      waiting.push(resolve);
      child.stdin.write(`${spec}\n`);
    });
  read.close = () => child?.stdin.end();
  return read;
}

// A clone to read commits and files from: `dir` as given, or a blobless clone of the repo's main of its own.
export async function gitSource(repo, { dir = null, asOf = null } = {}) {
  let at = ["-C", dir];
  if (!dir) {
    dir = join(process.env.RUNNER_TEMP ?? join(homedir(), ".cache"), "auto-revert", repo.replace("/", "__"));
    if (!existsSync(join(dir, "HEAD"))) {
      mkdirSync(dirname(dir), { recursive: true });
      await git([], ["clone", "-q", "--bare", "--filter=blob:none", "--single-branch", "--branch", "main", `https://github.com/${repo}.git`, dir]);
    }
    at = ["--git-dir", dir];
  }
  await git(at, ["fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main"]).catch(() => {});
  const lists = new Map();
  const reads = new Map();
  const until = asOf ? [`--until=${new Date(asOf).toISOString()}`] : [];
  const batch = catFile(at);
  // The tree's file list, and, in a blobless clone, every source file's blob at that commit fetched in one request rather
  // than one lazy fetch per file the attribution reads.
  async function tree(sha) {
    const entries = (await git(at, ["ls-tree", "-r", "-z", sha])).split("\0").filter(Boolean).map((e) => {
      const [meta, path] = e.split("\t");
      return { oid: meta.split(" ")[2], type: meta.split(" ")[1], path };
    });
    const code = entries.filter((e) => e.type === "blob" && CODE.test(e.path)).map((e) => e.oid);
    const have = await gitInput(at, ["cat-file", "--batch-check"], code.join("\n") + "\n", { GIT_NO_LAZY_FETCH: "1" });
    const missing = have.split("\n").filter((l) => l.endsWith(" missing")).map((l) => l.split(" ")[0]);
    if (missing.length) await gitInput(at, ["-c", "fetch.negotiationAlgorithm=noop", "fetch", "-q", "--no-tags", "--no-write-fetch-head", "--recurse-submodules=no", "--filter=blob:none", "--stdin", "origin"], missing.join("\n") + "\n");
    return new Set(entries.map((e) => e.path));
  }
  return {
    dir,
    close: () => batch.close(),
    files(sha) {
      if (!lists.has(sha)) lists.set(sha, tree(sha));
      return lists.get(sha);
    },
    read(sha, path) {
      const k = `${sha}:${path}`;
      if (!reads.has(k)) reads.set(k, batch(k));
      return reads.get(k);
    },
    // First-parent commits in (base, head], newest first, with the files each changed and its squash-merged PR.
    async commits(base, head) {
      const out = await git(at, ["log", "--first-parent", "--no-renames", "--format=%x1e%H%x1f%P%x1f%cI%x1f%s", "--name-status", `${base}..${head}`]);
      return parseLog1e(out);
    },
    // Main's first-parent commits, newest last: sha -> position, so runs are judged in commit order, not by finish time.
    async order() {
      const shas = (await git(at, ["rev-list", "--first-parent", "--max-count=2000", ...until, "refs/remotes/origin/main"])).split("\n").filter(Boolean);
      return new Map(shas.map((sha, i) => [sha, shas.length - i]));
    },
    // Commits on main after `sha` (up to asOf), with their messages, to see a fix or revert that already landed.
    async later(sha) {
      const out = await git(at, ["log", "--first-parent", ...until, "--format=%x1e%H%x1f%P%x1f%cI%x1f%s%x1f%b", `${sha}..refs/remotes/origin/main`]);
      return out.split("\x1e").filter((s) => s.trim()).map((rec) => {
        const [sha, , at, subject, body] = rec.split("\x1f");
        return { sha, at, subject, body };
      });
    },
    // The lines a commit changed in one file (its +/- lines), for evidence().
    async diff(sha, path) {
      try {
        return (await git(at, ["show", "--format=", "--no-ext-diff", "-U0", sha, "--", path])).split("\n").filter((l) => /^[-+](?![-+]{2})/.test(l)).join("\n");
      } catch {
        return null;
      }
    },
    async mergeChecks() {
      try {
        return JSON.parse(await git(at, ["cat-file", "blob", "refs/remotes/origin/main:.github/merge-checks.json"])).required ?? null;
      } catch {
        return null;
      }
    },
  };
}
// `git log --name-status` records: each line is "<status>\t<path>" (a bare path, from --name-only, counts as modified).
export function parseLog1e(out) {
  return out.split("\x1e").filter((s) => s.trim()).map((rec) => {
    const [head, ...rest] = rec.split("\n");
    const [sha, parents, at, subject] = head.split("\x1f");
    const pr = parents.trim().split(" ").length === 1 ? Number(/\(#(\d+)\)\s*$/.exec(subject)?.[1]) || null : null;
    const entries = rest.map((l) => l.trim()).filter(Boolean).map((l) => (/^[ACDMRTUX]\d*\t/.test(l) ? l.split("\t") : ["M", l]));
    return { sha, at, subject, pr, files: entries.map((e) => e.at(-1)), added: entries.filter((e) => e[0] === "A").map((e) => e.at(-1)) };
  });
}

// --- Acting ----------------------------------------------------------------------------------------------------------

const ENABLE = `mutation($id:ID!,$h:String!,$b:String!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:SQUASH,commitHeadline:$h,commitBody:$b}){clientMutationId}}`;
const REVERT = `mutation($id:ID!,$t:String!,$b:String!){revertPullRequest(input:{pullRequestId:$id,title:$t,body:$b,draft:false}){revertPullRequest{id number url}}}`;

export async function revert(repo, c, { run, minutes, apply, log = console.log, a = api, owners = OWNERS }) {
  const title = `Revert "${c.subject.replace(/\s*\(#\d+\)\s*$/, "")}" (#${c.pr})`;
  const body = revertBody({ repo, c, run, minutes });
  log(`  ${apply ? "" : "would "}open revert PR "${title}"`);
  if (!apply) return null;
  const { node_id } = await a.get(`/repos/${repo}/pulls/${c.pr}`);
  const made = (await a.graphql(REVERT, { id: node_id, t: title, b: body })).revertPullRequest.revertPullRequest;
  log(`  opened ${made.url}`);
  try {
    await a.graphql(ENABLE, { id: made.id, h: `${title.replace(/ \(#\d+\)$/, "")} (#${made.number})`, b: cleanBody(body) });
    log(`  auto-merge on`);
  } catch (e) {
    log(`  auto-merge unavailable (${e.message.slice(0, 80)}); a later tick merges it once its checks are green`);
  }
  const owner = owners.repos[repo] ?? owners.fallback;
  await a.post(`/repos/${repo}/issues/${made.number}/comments`, { body: `Owner: ${owner.name} (session ${owner.session}). Main is red in ${repo}; merging this reverts #${c.pr}. The red-main gate wakes the owner.` });
  return made;
}

// The tool's own open revert PRs whose head checks are green merge now (squash), the way any pull request lands.
// `over`: its failed checks carry only main's known failures (onlyKnown), so a failed check doesn't hold it, and a required
// check that ended counts as reported.
export function landable(checks, required, over = false) {
  const runs = checks.check_runs ?? [];
  if (!over && runs.some((r) => FAILED.includes(r.conclusion))) return { ok: false, why: "a check failed" };
  if (over && runs.some((r) => r.status !== "completed")) return { ok: false, why: "checks still running" };
  if (required?.length) {
    const missing = required.filter((n) => !runs.some((r) => r.name === n && r.status === "completed" && (r.conclusion === "success" || (over && FAILED.includes(r.conclusion)))));
    return missing.length ? { ok: false, why: `waiting for ${missing.join(", ")}` } : { ok: true };
  }
  if (!runs.length || runs.some((r) => r.status !== "completed")) return { ok: false, why: "checks still running" };
  return { ok: true };
}
const FAILED = ["failure", "timed_out", "cancelled", "action_required", "startup_failure"];

// Main's red now, failure by failure: each failure's key and the pull request blamed for it (null: a flake, or not
// attributed). A revert may carry these and still land (onlyKnown).
export function knownOnMain(analyses) {
  const m = new Map();
  for (const r of analyses) for (const x of r?.results ?? []) m.set(x.failure.key, x.blame?.pr ?? null);
  return m;
}

// Whether a revert's own failures are all main's already and none is its culprit's: it adds no red and takes its culprit's
// out, so it lands over them (Tandem's #4641 waited 33 minutes behind #4640's failure in its own gate). A required check's
// own job, which only adds the others up, is left out.
export function onlyKnown(failures, known, culpritPr, required = []) {
  const own = (failures ?? []).filter((f) => !(f.test == null && (required ?? []).some((n) => f.job === n)));
  return own.length > 0 && own.every((f) => known.has(f.key) && known.get(f.key) !== culpritPr);
}

export async function landReverts(repo, openPrs, { a, required, apply, log = console.log, known = new Map(), failuresOf = null }) {
  // Where auto-merge took, GitHub merges it; this lands only the reverts in repositories without auto-merge.
  for (const pr of openPrs.filter((p) => /^revert-\d+-/.test(p.head?.ref ?? "") && String(p.body ?? "").includes(MARKER) && !p.draft && !p.auto_merge)) {
    const checks = await a.get(`/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`);
    let v = landable(checks, required);
    let over = null;
    if (!v.ok && v.why === "a check failed" && known.size && failuresOf) {
      const target = Number(/^revert-(\d+)-/.exec(pr.head.ref)[1]);
      const fs = await failuresOf(checks).catch(() => null);
      if (fs && onlyKnown(fs, known, target, required)) {
        const w = landable(checks, required, true);
        if (w.ok) { v = w; over = [...new Set(fs.filter((f) => known.has(f.key)).map((f) => f.test ?? f.key))]; }
        else v = w;
      }
    }
    if (!v.ok) {
      log(`${repo}: revert #${pr.number} not merged yet: ${v.why}`);
      continue;
    }
    log(over ? `${repo}: revert #${pr.number} fails only what main already fails without it (${over.slice(0, 3).join("; ")}); ${apply ? "" : "would "}merge it` : `${repo}: revert #${pr.number} is green; ${apply ? "" : "would "}merge it`);
    if (apply) await a.put(`/repos/${repo}/pulls/${pr.number}/merge`, { merge_method: "squash", sha: pr.head.sha, commit_title: `${pr.title} (#${pr.number})`, commit_message: cleanBody(pr.body) });
  }
}


function describe(r) {
  const f = r.failure;
  const what = f.test ? `${f.file ?? "?"} "${f.test}"` : `job "${f.job}"${f.step ? ` step "${f.step}"` : ""}`;
  const where = r.base ? `failing since ${short(r.first.head_sha)} (run ${r.first.id}), passing at ${short(r.base.head_sha)}` : `failing since ${short(r.first.head_sha)}`;
  const who = r.blame ? `#${r.blame.pr} (${r.blame.how}${r.prs ? `; ${r.prs} PRs in range` : ""})` : `unattributed: ${r.why}`;
  return `  ${what}: ${where}, ${r.runs} run${r.runs > 1 ? "s" : ""}${r.confirmed ? "" : r.flake ? ", passed at the same commit (flake)" : ", unconfirmed"} -> ${who}`;
}

// One repo, one tick.
export async function check(repo, cfg, { a, now, apply, asOf = null, gitDir = null, cache = null, log = console.log, source = gitSource, rerunOnly = false }) {
  const minRedMinutes = cfg.minRedMinutes ?? CONFIG.minRedMinutes;
  const runs = await readHistory(repo, (p) => a.get(p), { workflows: cfg.workflows ?? null, ignore: cfg.ignoreWorkflows ?? [], tagRuns: cfg.tagRuns ?? [], bisectRuns: cfg.bisectRuns ?? [], asOf });
  // A bisect run is at an older commit than the push run it narrows, but newer by run number: by push order it says nothing.
  let vs = verdicts(await markPartial(repo, runs.filter((r) => !r.bisect), (p) => a.get(p)));
  let red = vs.filter((v) => v.state === "red");
  // Re-run only: a caller whose token has actions write and nothing else (the revert stays with the central cron's PAT).
  if (rerunOnly) {
    if (!red.length) log(`${repo}: main is not red`);
    for (const v of red) {
      log(`${repo}: ${v.workflow} red at ${short(v.reds[0].head_sha)} (run ${v.reds[0].id})`);
      if (cfg.rerun !== false) await rerunFailed(repo, v.reds[0], { apply, a, log });
    }
    return;
  }
  let openPrs = null;
  let src = null;
  let order = null;
  const getSrc = async () => (src ??= await source(repo, { dir: gitDir, asOf }));
  // Red by push order: judged again by commit order before anything acts, so an older commit's run that finished after a
  // newer one's never makes main red.
  if (red.length) {
    order = (await (await getSrc()).order?.()) ?? null;
    if (order?.size) {
      for (const r of runs) delete r.partial;
      vs = verdicts(await markPartial(repo, runs, (p) => a.get(p), order), order);
      red = vs.filter((v) => v.state === "red");
    }
  }
  if (apply && !asOf) openPrs = await a.get(`/repos/${repo}/pulls?state=open&per_page=100`);
  const mine = () => apply && !asOf && openPrs.some((p) => String(p.body ?? "").includes(MARKER));
  if (!red.length && mine()) await landReverts(repo, openPrs, { a, required: await (await getSrc()).mergeChecks(), apply, log });
  if (!red.length) {
    log(`${repo}: main is not red`);
    src?.close?.();
    if (apply && !asOf) await pruneVerify(repo, new Set(), { apply, a, log });
    return;
  }
  const keep = new Set();
  const analyses = [];
  // Failures main had before a range (earlierReds), by the range's start, and the flake table's open flakes, read once a tick.
  const earlier = new Map();
  let flakes = null;
  const flakesNow = async (sha) => (flakes ??= cfg.knownFlakes ? openFlakes((await (await getSrc()).read(sha, cfg.knownFlakes)) ?? "") : new Map());
  try {
    await judge();
    // Main is red: a revert may land over what main already fails without it, but never over its own culprit's failure.
    if (red.length && mine()) {
      const s = await getSrc();
      const head = red[0].reds[0].head_sha;
      const files = await s.files(head);
      const failuresOf = async (checks) => {
        const ids = [...new Set((checks.check_runs ?? []).filter((r) => FAILED.includes(r.conclusion)).map((r) => /\/actions\/runs\/(\d+)\//.exec(r.details_url ?? "")?.[1]).filter(Boolean))];
        if (!ids.length) return null;
        const out = [];
        for (const id of ids) {
          const run = await a.get(`/repos/${repo}/actions/runs/${id}`);
          const r = await runFailures(repo, run, { a, files, cache, read: (p) => s.read(head, p) });
          if (!r.failures) return null;
          out.push(...r.failures);
        }
        return out;
      };
      await landReverts(repo, openPrs, { a, required: await s.mergeChecks(), apply, log, known: knownOnMain(analyses), failuresOf });
    }
  } finally {
    src?.close?.();
  }
  if (apply && !asOf) await pruneVerify(repo, keep, { apply, a, log });
  async function judge() {
    for (const v of red) {
      const s = await getSrc();
      const r = await analyse(repo, v, { a, src: s, cache, asOf });
      analyses.push(r);
      if (r.infra) {
        log(`${repo}: ${v.workflow} failed at ${short(v.reds[0].head_sha)} on infrastructure only (${r.infra}); not red, the next run decides`);
        continue;
      }
      const since = Math.min(...r.results.map((x) => ms(x.first.updated_at)));
      const minutes = Math.round((now - since) / 60000);
      log(`${repo}: ${v.workflow} red at ${short(r.newest.head_sha)} (run ${r.newest.id}, finished ${hhmm(r.newest.updated_at)}), red ${minutes}m, ${r.results.length} failure${r.results.length > 1 ? "s" : ""}:`);
      for (const x of r.results) log(describe(x));
      const pending = r.results.some((x) => !x.confirmed && !x.flake);
      if (pending && !asOf && cfg.rerun !== false) await rerunFailed(repo, r.newest, { apply, a, log });
      if (pending && r.check.state === "none") await dispatchVerify(repo, r.newest, { apply, a, log });
      if (r.check.state === "running") log(`  verifying at ${short(r.newest.head_sha)}: run ${r.check.run.id} on ${r.check.run.head_branch}`);
      if (pending || r.check.state === "running") keep.add(verifyBranch(r.newest.head_sha));
      const cs = culprits(r.results);
      if (!cs.length) {
        log(`  no culprit to revert; red-main wakes the owner`);
        continue;
      }
      openPrs ??= asOf ? [] : await a.get(`/repos/${repo}/pulls?state=open&per_page=100`);
      const later = await s.later(r.newest.head_sha);
      const after = new Set(later.map((c) => c.sha));
      const changedLater = later.length && s.commits ? (await s.commits(r.newest.head_sha, "refs/remotes/origin/main")).filter((c) => after.has(c.sha)) : [];
      const greenLater = later.length ? await laterGreen(repo, runs, r.newest, { a, order, asOf }) : new Map();
      for (const c of cs.slice(0, 5)) {
        let d = decide(c, { later, openPrs, minutes, minRedMinutes, greenLater, changedLater });
        let culpritNow = c;
        if (d.action === "revert") {
          const reasons = [];
          for (const x of c.failures) {
            const before = x.base?.created_at ?? x.first.created_at;
            if (!earlier.has(before) && !x.touched) earlier.set(before, await earlierReds(repo, r.newest, before, { a, files: await s.files(r.newest.head_sha), cache, src: s }).catch(() => []));
            reasons.push(knownBefore(x, { pr: c.pr, earlier: earlier.get(before) ?? [], flakes: await flakesNow(r.newest.head_sha), flakeDoc: cfg.knownFlakes }));
          }
          if (reasons.every(Boolean)) {
            d = { action: "known", reason: reasons.join("; ") };
          } else if (reasons.some(Boolean)) {
            for (const [i, x] of c.failures.entries()) if (reasons[i]) log(`  not blaming #${c.pr} for ${x.failure.key}: ${reasons[i]}`);
            culpritNow = { ...c, failures: c.failures.filter((_, i) => !reasons[i]) };
          }
        }
        log(`  culprit #${c.pr} "${c.subject.slice(0, 90)}": ${d.action === "revert" ? "revert" : `${d.action === "wait" ? "revert pending" : "not reverting"}: ${d.reason}`}`);
        if (d.action === "known") {
          await postKnown(repo, c, c.failures.map((x) => knownBefore(x, { pr: c.pr, earlier: earlier.get(x.base?.created_at ?? x.first.created_at) ?? [], flakes: flakes ?? new Map(), flakeDoc: cfg.knownFlakes })), { run: r.newest, apply: apply && !asOf, a, log }).catch((e) => log(`  could not post the evidence on #${c.pr}: ${e.message}`));
          continue;
        }
        if (d.action !== "revert") continue;
        try {
          await revert(repo, culpritNow, { run: r.newest, minutes, apply, log, a });
        } catch (e) {
          log(`  could not revert #${c.pr}: ${e.message}`);
          if (!isRateLimit(e)) process.exitCode = 1;
        }
      }
    }
  }
}

// GitHub's quota running out says nothing about main: a tick that hits it waits for the next one, with a warning, and never fails.
export const isRateLimit = (e) => /rate limit exceeded|secondary rate limit/i.test(e?.message ?? "");

export async function main(argv = process.argv.slice(2), now = Date.now(), base = api, { source = gitSource } = {}) {
  const a = counted(base);
  const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const apply = argv.includes("--apply");
  const asOf = opt("--as-of");
  const self = opt("--self");
  const only = self ?? opt("--repo");
  const cachePath = opt("--cache");
  const rerunOnly = argv.includes("--rerun-only");
  const cache = cachePath ? (existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {}) : null;
  if (asOf && apply) throw new Error("--as-of replays the past: it never acts (drop --apply)");
  console.log(apply ? "auto-revert: applying" : `auto-revert: dry run${asOf ? ` as of ${asOf}` : ""} (pass --apply to act)`);
  const repos = self ? { [self]: { ...CONFIG.repos[self], enabled: true } } : CONFIG.repos;
  for (const [repo, cfg] of Object.entries(repos)) {
    if (only && only !== repo) continue;
    if (!cfg.enabled && !only) {
      console.log(`${repo}: disabled in auto-revert.json`);
      continue;
    }
    try {
      await check(repo, cfg, { a, now: asOf ? ms(asOf) : now, apply: apply && cfg.enabled, asOf, gitDir: opt("--git"), cache, source, rerunOnly });
    } catch (err) {
      console.log(`${repo}: could not check: ${err.message}`);
      if (isRateLimit(err)) {
        console.log(`::warning::GitHub's API rate limit is exhausted; the remaining repositories wait for the next tick.`);
        break;
      }
      process.exitCode = 1;
    }
  }
  if (cachePath) {
    const ids = Object.keys(cache.jobs ?? {}).sort((x, y) => Number(y) - Number(x));
    for (const id of ids.slice(400)) delete cache.jobs[id];
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache));
  }
  const { GET, POST, graphql } = a.calls;
  console.log(`auto-revert: ${GET + POST + graphql} API calls (${GET} read, ${POST + graphql} write)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
