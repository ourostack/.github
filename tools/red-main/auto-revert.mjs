#!/usr/bin/env node
// Auto-revert: when main's ci goes red, find the pull request that broke it and revert it, so nobody has to be awake.
// (Tandem, 2026-11: one regression stayed red 793 minutes overnight; on 2026-11-19 main stayed red 90 minutes while the old
// version, which judged only the newest commit and reverted only the last one, kept saying "main is not red".)
//
//   node tools/red-main/auto-revert.mjs                 # dry run: say what it would do for every opted-in repo
//   node tools/red-main/auto-revert.mjs --apply         # rerun, revert and land the revert
//   node tools/red-main/auto-revert.mjs --repo o/r      # only that repo (it must be listed in auto-revert.json, enabled or not)
//   node tools/red-main/auto-revert.mjs --self o/r      # caller-workflow mode: that repo, opted in by the caller, with its token
//   --as-of <ISO time>   replay: judge main as it stood then (runs created later are unseen, runs finishing later still running)
//   --git <dir>          read commits and files from this clone of the repo (default: a blobless clone of its own)
//   --cache <file>       keep each finished job's parsed failures, so a later tick doesn't read its log again
//
// Red is a verdict, not a tip. Each workflow that counts (the repo's "workflows" in auto-revert.json, or every push workflow
// but its "ignoreWorkflows") is judged by its newest COMPLETED push run on main: a pending or running run says nothing, a run
// cancelled or replaced by concurrency says nothing, and one whose every failure is infrastructure says nothing. Main is red
// while that verdict is a code failure; a newer completed green run clears it. Because main's runs share a concurrency
// group, a verdict covers every commit since the run before it, so the culprit is found over a range:
//   1. Failures: the red run's failed jobs (latest attempt) are read from their logs: each failing test (TAP `not ok`, its
//      `location:` file and every repository file its failure text names), or, for a job with no test failure, the job and
//      the files its error lines name. A job with no test failure that is infrastructure (classifyFailure) is dropped.
//   2. Range: for each failure, the older completed runs are read until one where it didn't fail. The failure was introduced
//      by a commit after that run and up to the first run where it failed.
//   3. Attribution: from the failing test file and the files its failure names (distance 0), the code is followed through its
//      runtime imports and the repository paths it names as strings (type-only imports don't count), at the commit that
//      first failed. The squash-merged PR in the range whose files are closest is the culprit; a tie goes to the newest. With
//      nothing reachable, the range's only PR is the culprit; with several, the failure is reported unattributed.
//   4. Confirmation (flake guard): heal first, the newest red run's failed jobs are rerun once (attempt 1 only, any cause).
//      A failure is confirmed when it failed again on that rerun, or in two runs in a row. Only confirmed culprits are reverted.
//   5. Guards: skip a culprit already reverted or fixed on main since the red run (a later commit names #N), with an open fix or
//      revert PR, or while main has been red under the repo's minRedMinutes (Tandem: 0, act on confirmation).
// Then it opens the revert with GitHub's revertPullRequest (one per culprit, so two breaks in one range are both reverted in
// one cycle), tries auto-merge, and on every tick lands its own open revert PRs whose head checks are green (the repo's
// .github/merge-checks.json `required` list when it has one; never with a failed check), with a squash merge.
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

// Main's push runs of the workflows that count, newest first, back to each one's newest completed green run (or MAX_PAGES).
// With `workflows`, each is read from its own list; otherwise every push run, less `ignore`.
export async function readHistory(repo, get, { workflows = null, ignore = [], asOf = null, perPage = PAGE, maxPages = MAX_PAGES } = {}) {
  const created = asOf ? `&created=${encodeURIComponent(`<=${new Date(asOf).toISOString()}`)}` : "";
  const lists = workflows?.length ? workflows.map((w) => `/repos/${repo}/actions/workflows/${/\.ya?ml$/.test(w) ? w : `${w}.yml`}/runs`) : [`/repos/${repo}/actions/runs`];
  const all = [];
  for (const base of lists) {
    for (let page = 1; page <= maxPages; page++) {
      const body = await get(`${base}?branch=main&event=push&per_page=${perPage}&page=${page}${created}`);
      const got = (body.workflow_runs ?? []).map((r) => replay(r, asOf)).filter((r) => r && !ignored(r, ignore));
      all.push(...got);
      const byWf = groupBy(all, wfKey);
      const done = byWf.size > 0 && [...byWf.values()].every((rs) => rs.some(isGreen));
      if (done || (body.workflow_runs ?? []).length < perPage) break;
    }
  }
  return all;
}
const wfKey = (r) => r.workflow_id ?? r.name;
const isGreen = (r) => r.status === "completed" && r.conclusion === "success";
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

const NO_VERDICT = new Set(["cancelled", "skipped", "stale", "neutral", "action_required", "startup_failure"]);
// A run cancelled after it started (by hand, or by a lane making room) still judged the jobs it finished: when one of them
// failed it is a red verdict for those jobs (`partial`). Only cancelled runs newer than their workflow's newest green, that
// ran at least 3 minutes, are looked at (a run replaced while it waited never started).
export async function markPartial(repo, runs, get) {
  for (const rs of groupBy(runs, wfKey).values()) {
    const sorted = [...rs].sort((a, b) => (b.run_number ?? 0) - (a.run_number ?? 0) || ms(b.created_at) - ms(a.created_at));
    for (const r of sorted) {
      if (isGreen(r)) break;
      if (r.status !== "completed" || r.conclusion !== "cancelled" || ms(r.updated_at) - ms(r.run_started_at ?? r.created_at) < 3 * 60000) continue;
      r.jobs = (await get(`/repos/${repo}/actions/runs/${r.id}/jobs?filter=latest&per_page=100`)).jobs ?? [];
      r.partial = r.jobs.some((j) => j.conclusion === "failure");
    }
  }
  return runs;
}

// Per workflow, newest first: its verdict is its newest completed run that has one. Returns
// [{ workflow, state: "green" | "red" | "rerunning" | "none", reds: [newest red, the red before it, ...], green, rerun }].
export function verdicts(runs) {
  const out = [];
  for (const rs of groupBy(runs, wfKey).values()) {
    const sorted = [...rs].sort((a, b) => (b.run_number ?? 0) - (a.run_number ?? 0) || ms(b.created_at) - ms(a.created_at));
    const v = { workflow: sorted[0].name, state: "none", reds: [], green: null, rerun: null };
    for (const r of sorted) {
      if (r.status !== "completed") {
        if ((r.run_attempt ?? 1) > 1 && !v.reds.length && !v.rerun) v.rerun = r;
        continue;
      }
      if (NO_VERDICT.has(r.conclusion) && !r.partial) continue;
      if (r.conclusion === "success") {
        v.green = r;
        break;
      }
      v.reds.push(r);
    }
    v.state = v.rerun ? "rerunning" : v.reds.length ? "red" : v.green ? "green" : "none";
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

// A run's failures: [{ key, test, file, roots: [repo files at distance 0], job }], or { infra: reason } when none is the code's.
export async function runFailures(repo, run, { a, files, cache = null }) {
  const jobs = run.jobs ?? (await a.get(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`)).jobs ?? [];
  const failed = jobs.filter((j) => ["failure", "timed_out", "cancelled", "startup_failure"].includes(j.conclusion));
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
    const jobName = j.name.replace(/,?\s*\d+\s*\/\s*\d+\)/, ")").replace(/\s*\(\)$/, "");
    if (parsed.tests.length) {
      for (const t of parsed.tests) {
        const file = t.location ? mentions(t.location.replace(/:\d+(:\d+)?$/, ""), files)[0] ?? null : null;
        const named = mentions(`${t.name}\n${t.text}`, files);
        const roots = [...new Set([file, ...named].filter(Boolean))];
        out.push({ key: `${file ?? "?"} :: ${t.name}`, test: t.name, file, roots, job: jobName });
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
    out.push({ key: `job ${jobName} :: ${step}`, test: null, file: null, roots: mentions(parsed.errors.join("\n"), files), job: jobName, step });
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
  out.delete(path);
  return [...out];
}

// Distance from the failure's roots to every file it reaches through references(), at one commit.
export async function distances(roots, { read, files, maxDepth = 12, maxFiles = 6000 }) {
  const dist = new Map(roots.map((r) => [r, 0]));
  let frontier = [...roots];
  for (let d = 1; d <= maxDepth && frontier.length && dist.size < maxFiles; d++) {
    const next = [];
    const srcs = await pool(frontier.filter((f) => CODE.test(f)), 16, async (f) => [f, await read(f)]);
    for (const [f, src] of srcs) {
      if (src == null) continue;
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
export function culprit(commits, dist) {
  let best = null;
  for (const c of commits) {
    if (!c.pr) continue;
    for (const f of c.files) {
      const d = dist.get(f);
      if (d === undefined) continue;
      if (!best || d < best.distance) best = { pr: c.pr, sha: c.sha, subject: c.subject, distance: d, file: f, how: d === 0 ? `changed ${f}, which the failure names` : `changed ${f}, ${d} reference${d > 1 ? "s" : ""} from the failure` };
    }
  }
  if (best) return best;
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
export async function analyse(repo, v, { a, src, cache = null, maxWalk = 8 }) {
  const files = await src.files(v.reds[0].head_sha);
  const chain = [];
  for (const run of v.reds.slice(0, maxWalk)) {
    const r = await runFailures(repo, run, { a, files, cache });
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
  const older = [...chain.slice(chain.indexOf(newest) + 1).filter((c) => c.failures), ...(v.green && (chain.length === v.reds.length || chain.length < maxWalk) ? [{ run: v.green, failures: [] }] : [])];
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
    const confirmed = runs >= 2 || (newest.run.run_attempt ?? 1) >= 2;
    const r = { failure: f, first: first.run, base, runs, confirmed };
    if (!base) {
      results.push({ ...r, blame: null, why: "where it began is beyond the runs read" });
      continue;
    }
    // A pull request already reverted after the failure began (its revert landed and the failure stayed) is not the culprit.
    const reverted = new Set((first.run.head_sha === newest.run.head_sha ? [] : await src.commits(first.run.head_sha, newest.run.head_sha)).map((c) => revertOf(c.subject)).filter(Boolean));
    const commits = (await src.commits(base.head_sha, first.run.head_sha)).filter((c) => !reverted.has(c.pr));
    const firstFiles = first.run.head_sha === v.reds[0].head_sha ? files : await src.files(first.run.head_sha);
    const dist = await distances(f.roots.filter((x) => firstFiles.has(x)), { read: (p) => src.read(first.run.head_sha, p), files: firstFiles });
    const blame = culprit(commits, dist);
    results.push({ ...r, prs: commits.filter((c) => c.pr).length, blame, why: blame ? blame.how : f.roots.length ? "no pull request in the range touches what it reaches" : "its failure names no file" });
  }
  return { newest: newest.run, results };
}

// Groups the attributed failures by culprit: [{ pr, sha, subject, failures, confirmed }].
export function culprits(results) {
  const m = new Map();
  for (const r of results.filter((x) => x.blame)) {
    const c = m.get(r.blame.pr) ?? { pr: r.blame.pr, sha: r.blame.sha, subject: r.blame.subject, failures: [], confirmed: false, first: r.first };
    c.failures.push(r);
    c.confirmed ||= r.confirmed;
    m.set(r.blame.pr, c);
  }
  return [...m.values()].sort((x, y) => y.pr - x.pr);
}

// Per culprit: { action: "revert" | "wait" | "skip", reason }.
export function decide(c, { later = [], openPrs = [], minutes, minRedMinutes }) {
  const landed = fixLanded(later, c.pr);
  if (landed) return { action: "skip", reason: `${short(landed.sha)} on main since names #${c.pr}: ${landed.subject}` };
  const open = fixPrOpen(openPrs, { number: c.pr }, c.sha);
  if (open) return { action: "skip", reason: `a fix or revert PR is already open (#${open.number})` };
  if (!c.confirmed) return { action: "wait", reason: "not yet reproduced: the rerun of its failed jobs decides" };
  if (minutes < minRedMinutes) return { action: "wait", reason: `red for ${minutes}m, under ${minRedMinutes}m` };
  return { action: "revert", reason: "reproduced" };
}

export function revertBody({ repo, c, run, minutes }) {
  const lines = c.failures.map((r) => `- ${r.failure.test ? `\`${r.failure.test}\` (${r.failure.file ?? r.failure.jobs.join(", ")})` : `job \`${r.failure.job}\`${r.failure.step ? `, step "${r.failure.step}"` : ""}`}: first failed in ${r.first.html_url} (${short(r.first.head_sha)}), passed in ${r.base.html_url} (${short(r.base.head_sha)}); of the ${r.prs} pull requests between, #${c.pr} ${r.blame.how}. Failed in ${r.runs} run${r.runs > 1 ? "s" : ""}${r.runs < 2 ? ", again on the rerun" : " in a row"}.`);
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
      const out = await git(at, ["log", "--first-parent", "--no-renames", "--format=%x1e%H%x1f%P%x1f%cI%x1f%s", "--name-only", `${base}..${head}`]);
      return parseLog1e(out);
    },
    // Commits on main after `sha` (up to asOf), with their messages, to see a fix or revert that already landed.
    async later(sha) {
      const out = await git(at, ["log", "--first-parent", ...until, "--format=%x1e%H%x1f%P%x1f%cI%x1f%s%x1f%b", `${sha}..refs/remotes/origin/main`]);
      return out.split("\x1e").filter((s) => s.trim()).map((rec) => {
        const [sha, , at, subject, body] = rec.split("\x1f");
        return { sha, at, subject, body };
      });
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
export function parseLog1e(out) {
  return out.split("\x1e").filter((s) => s.trim()).map((rec) => {
    const [head, ...rest] = rec.split("\n");
    const [sha, parents, at, subject] = head.split("\x1f");
    const pr = parents.trim().split(" ").length === 1 ? Number(/\(#(\d+)\)\s*$/.exec(subject)?.[1]) || null : null;
    return { sha, at, subject, pr, files: rest.map((l) => l.trim()).filter(Boolean) };
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
export function landable(checks, required) {
  const runs = checks.check_runs ?? [];
  if (runs.some((r) => ["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(r.conclusion))) return { ok: false, why: "a check failed" };
  if (required?.length) {
    const missing = required.filter((n) => !runs.some((r) => r.name === n && r.status === "completed" && r.conclusion === "success"));
    return missing.length ? { ok: false, why: `waiting for ${missing.join(", ")}` } : { ok: true };
  }
  if (!runs.length || runs.some((r) => r.status !== "completed")) return { ok: false, why: "checks still running" };
  return { ok: true };
}
export async function landReverts(repo, openPrs, { a, required, apply, log = console.log }) {
  // Where auto-merge took, GitHub merges it; this lands only the reverts in repositories without auto-merge.
  for (const pr of openPrs.filter((p) => /^revert-\d+-/.test(p.head?.ref ?? "") && String(p.body ?? "").includes(MARKER) && !p.draft && !p.auto_merge)) {
    const v = landable(await a.get(`/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`), required);
    if (!v.ok) {
      log(`${repo}: revert #${pr.number} not merged yet: ${v.why}`);
      continue;
    }
    log(`${repo}: revert #${pr.number} is green; ${apply ? "" : "would "}merge it`);
    if (apply) await a.put(`/repos/${repo}/pulls/${pr.number}/merge`, { merge_method: "squash", sha: pr.head.sha, commit_title: `${pr.title} (#${pr.number})`, commit_message: cleanBody(pr.body) });
  }
}

export async function rerunHeal(repo, runs, { apply, a = api, log = console.log } = {}) {
  let ok = true;
  for (const r of runs) {
    log(`  ${apply ? "" : "would "}rerun the failed jobs of run ${r.id} (${short(r.head_sha)}) once, to tell a flake from a break`);
    if (!apply) continue;
    try {
      await a.post(`/repos/${repo}/actions/runs/${r.id}/rerun-failed-jobs`);
    } catch (e) {
      log(`  could not rerun run ${r.id} (${e.message}); two red runs in a row confirm instead`);
      ok = false;
    }
  }
  return ok;
}

function describe(r) {
  const f = r.failure;
  const what = f.test ? `${f.file ?? "?"} "${f.test}"` : `job "${f.job}"${f.step ? ` step "${f.step}"` : ""}`;
  const where = r.base ? `failing since ${short(r.first.head_sha)} (run ${r.first.id}), passing at ${short(r.base.head_sha)}` : `failing since ${short(r.first.head_sha)}`;
  const who = r.blame ? `#${r.blame.pr} (${r.blame.how}${r.prs ? `; ${r.prs} PRs in range` : ""})` : `unattributed: ${r.why}`;
  return `  ${what}: ${where}, ${r.runs} run${r.runs > 1 ? "s" : ""}${r.confirmed ? "" : ", unconfirmed"} -> ${who}`;
}

// One repo, one tick.
export async function check(repo, cfg, { a, now, apply, asOf = null, gitDir = null, cache = null, log = console.log, source = gitSource }) {
  const minRedMinutes = cfg.minRedMinutes ?? CONFIG.minRedMinutes;
  const runs = await readHistory(repo, (p) => a.get(p), { workflows: cfg.workflows ?? null, ignore: cfg.ignoreWorkflows ?? [], asOf });
  const vs = verdicts(await markPartial(repo, runs, (p) => a.get(p)));
  const red = vs.filter((v) => v.state === "red");
  let openPrs = null;
  let src = null;
  const getSrc = async () => (src ??= await source(repo, { dir: gitDir, asOf }));
  if (apply && !asOf) {
    openPrs = await a.get(`/repos/${repo}/pulls?state=open&per_page=100`);
    if (openPrs.some((p) => String(p.body ?? "").includes(MARKER))) await landReverts(repo, openPrs, { a, required: await (await getSrc()).mergeChecks(), apply, log });
  }
  for (const v of vs.filter((x) => x.state === "rerunning")) log(`${repo}: ${v.workflow}'s newest verdict is being rerun (run ${v.rerun.id}), waiting for it`);
  if (!red.length) {
    log(`${repo}: main is not red`);
    src?.close?.();
    return;
  }
  try {
    await judge();
  } finally {
    src?.close?.();
  }
  async function judge() {
    for (const v of red) {
      const s = await getSrc();
      const r = await analyse(repo, v, { a, src: s, cache });
      if (r.infra) {
        log(`${repo}: ${v.workflow} failed at ${short(v.reds[0].head_sha)} on infrastructure only (${r.infra}); not red`);
        if ((v.reds[0].run_attempt ?? 1) < 2) await rerunHeal(repo, [v.reds[0]], { apply, a, log });
        continue;
      }
      const since = Math.min(...r.results.map((x) => ms(x.first.updated_at)));
      const minutes = Math.round((now - since) / 60000);
      log(`${repo}: ${v.workflow} red at ${short(r.newest.head_sha)} (run ${r.newest.id}, finished ${hhmm(r.newest.updated_at)}), red ${minutes}m, ${r.results.length} failure${r.results.length > 1 ? "s" : ""}:`);
      for (const x of r.results) log(describe(x));
      if ((r.newest.run_attempt ?? 1) < 2 && r.results.some((x) => !x.confirmed)) await rerunHeal(repo, [r.newest], { apply, a, log });
      const cs = culprits(r.results);
      if (!cs.length) {
        log(`  no culprit to revert; red-main wakes the owner`);
        continue;
      }
      openPrs ??= asOf ? [] : await a.get(`/repos/${repo}/pulls?state=open&per_page=100`);
      const later = await s.later(r.newest.head_sha);
      for (const c of cs.slice(0, 5)) {
        const d = decide(c, { later, openPrs, minutes, minRedMinutes });
        log(`  culprit #${c.pr} "${c.subject.slice(0, 90)}": ${d.action === "revert" ? "revert" : `${d.action === "wait" ? "revert pending" : "not reverting"}: ${d.reason}`}`);
        if (d.action !== "revert") continue;
        try {
          await revert(repo, c, { run: r.newest, minutes, apply, log, a });
        } catch (e) {
          log(`  could not revert #${c.pr}: ${e.message}`);
          process.exitCode = 1;
        }
      }
    }
  }
}

export async function main(argv = process.argv.slice(2), now = Date.now(), base = api, { source = gitSource } = {}) {
  const a = counted(base);
  const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const apply = argv.includes("--apply");
  const asOf = opt("--as-of");
  const self = opt("--self");
  const only = self ?? opt("--repo");
  const cachePath = opt("--cache");
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
      await check(repo, cfg, { a, now: asOf ? ms(asOf) : now, apply: apply && cfg.enabled, asOf, gitDir: opt("--git"), cache, source });
    } catch (err) {
      console.log(`${repo}: could not check: ${err.message}`);
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
