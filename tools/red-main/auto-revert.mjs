#!/usr/bin/env node
// Auto-revert: a main that has stayed red because of one PR's commit gets that PR reverted, so nobody has to be awake.
// (Tandem, 2026-11: one regression stayed red 793 minutes overnight.) Build on red-main: same run history, same owners.
//
//   node tools/red-main/auto-revert.mjs            # dry run: say what it would do for every opted-in repo
//   node tools/red-main/auto-revert.mjs --apply    # rerun the failed job and open the revert PR
//   node tools/red-main/auto-revert.mjs --repo o/r # only that repo (it must still be opted in, enabled or not, for a dry run)
//
// A repo's "ignoreWorkflows" in auto-revert.json lists workflows whose red never counts (file name without .yml, or workflow name); it applies in
// --self mode too, so a caller's exclusions live here and not in its workflow.
// A repo is reverted only when it is listed in auto-revert.json with "enabled": true and, all at once:
//   1. main has been red for at least minRedMinutes (60);
//   2. the first red commit is the last commit on main and a squash-merged PR (one parent, one merged PR) -
//      nothing has merged on top, so the revert is clean and the blame is not shared;
//   3. no open PR already reverts or fixes it (this tool's own revert PR counts, so it never opens two);
//   4. the failure is not infrastructure (a job annotated `title=infra`, runner lost or never started, checkout or credential errors, ENOTFOUND,
//      disk full, cancelled, timed out, startup failure) and the annotations could be read (unreadable means can't tell: no revert);
//   5. the failure reproduces: the failed run's jobs were rerun and failed again. The first tick requests the rerun
//      (rerun-failed-jobs) and a later tick (every 10 minutes) reads its result, so no job waits on a runner.
// Then it opens the revert PR with GitHub's revertPullRequest, turns on auto-merge with a clean message and comments
// the owner from owners.json on it (red-main's gate already wakes the owner on a red main).
// It reads only the open red stretch: main's newest push runs, newest first, 25 at a time, back to the last green commit (1 call when main is green),
// never a time window. It prints the API calls the run spent.
// `--self <owner/repo>` is the caller-workflow mode: that one repo, opted in by the caller, with the caller's own token. Needs GH_TOKEN with contents and
// pull-request write on the opted-in repos (the REARM_MERGES_TOKEN secret); it talks to GitHub through `gh api`.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { OWNERS, RUNNER_LOST, commitVerdicts, episodes, markInfra, neverStarted } from "./red-main.mjs";
import { cleanBody } from "../rearm-merges/rearm-merges.mjs";

export const CONFIG = JSON.parse(readFileSync(new URL("./auto-revert.json", import.meta.url), "utf8"));

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

// jobs: failed jobs of the latest attempt, { name, conclusion, steps: [{ name, conclusion }], log }.
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
  const short = sha.slice(0, 7);
  const refs = new RegExp(`(^|[^0-9])#${n}([^0-9]|$)|${short}`);
  return openPrs.find((o) => o.head?.ref?.startsWith(`revert-${n}-`) || (/^revert\b|\b(fix|fixes|repair)\b/i.test(o.title ?? "") && refs.test(`${o.title}\n${o.body ?? ""}`)));
}

// facts: everything gathered about one repo's open red. Returns { action: "revert" | "rerun" | "skip", reason }.
export function evaluate(f, { minRedMinutes = CONFIG.minRedMinutes } = {}) {
  const skip = (reason) => ({ action: "skip", reason });
  if (f.minutes < minRedMinutes) return skip(`red for ${f.minutes}m, under ${minRedMinutes}m`);
  if (f.laterCommits > 0) return skip(`${f.laterCommits} commit(s) merged since the first red commit`);
  const merged = (f.pulls ?? []).filter((p) => p.merged_at && p.merge_commit_sha === f.sha);
  if (merged.length !== 1) return skip(`the first red commit is ${merged.length} merged PRs, not one`);
  if (f.parents !== 1) return skip("the first red commit is a merge commit, not a squash");
  const pr = merged[0];
  const fix = fixPrOpen(f.openPrs ?? [], pr, f.sha);
  if (fix) return skip(`a fix or revert PR is already open (#${fix.number})`);
  if (f.run.status && f.run.status !== "completed") return skip("the rerun is still in progress");
  const infra = classifyFailure(f.run, f.failedJobs ?? []);
  if (infra.infra) return skip(`infrastructure failure: ${infra.reason}`);
  if ((f.run.attempt ?? 1) < 2) return { action: "rerun", reason: "failure not yet reproduced; rerunning the failed jobs", pr };
  return { action: "revert", reason: "failure reproduced on rerun", pr, jobs: f.failedJobs.map((j) => j.name) };
}

export function revertBody({ repo, pr, sha, run, jobs, minutes }) {
  return [
    `Automatic revert of #${pr.number} (${pr.title}).`,
    "",
    `- Main in ${repo} has been red for ${minutes} minutes since its squash commit ${sha}.`,
    `- Failing job${jobs.length > 1 ? "s" : ""}: ${jobs.map((j) => `\`${j}\``).join(", ")} (${run.name ?? "workflow"}), ${run.url}.`,
    "- The failure reproduced when the failed jobs were rerun, it is not an infrastructure error, #" + pr.number + " is the only PR merged since the last green main, and no fix PR was open.",
    "",
    `Merge this to turn main green again, then re-land #${pr.number} with the fix. To keep the change instead, close this PR and fix forward. Opened by tools/red-main/auto-revert.mjs in ourostack/.github.`,
  ].join("\n");
}

const run = promisify(execFile);
// Reads use READ_TOKEN (the caller's GITHUB_TOKEN, which can have checks: read); writes use GH_TOKEN (AUTO_REVERT_TOKEN).
async function http(method, path, body) {
  const env = method === "GET" && process.env.READ_TOKEN ? { ...process.env, GH_TOKEN: process.env.READ_TOKEN } : process.env;
  const args = ["api", "-X", method, path.replace(/^\/graphql$/, "graphql"), ...(body ? ["--input", "-"] : [])];
  const child = run("gh", args, { maxBuffer: 64 * 1024 * 1024, env });
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
export const api = {
  get: (path) => http("GET", path),
  post: (path, body) => http("POST", path, body ?? {}),
  async graphql(query, variables) {
    const r = await http("POST", "/graphql", { query, variables });
    if (r.errors) throw new Error(r.errors.map((e) => e.message).join("; "));
    return r.data;
  },
};

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

export const PAGE = 25;
export const MAX_PAGES = 8;

// main's push runs newest first, one small page at a time, until the first commit whose runs all passed (the red stretch
// ends there) or main's newest commits are all that is needed. Returns { runs: the stretch's runs plus that green commit's,
// complete: false when MAX_PAGES pages never reached a green commit (the stretch's start is unknown) }.
// A commit's runs may continue on the next page, so the page's last commit is judged only once another page shows it whole.
export async function readRedStretch(repo, get, { perPage = PAGE, maxPages = MAX_PAGES, ignore = [] } = {}) {
  const all = new Map();
  for (let page = 1; page <= maxPages; page++) {
    const body = await get(`/repos/${repo}/actions/runs?branch=main&event=push&per_page=${perPage}&page=${page}`);
    const got = body.workflow_runs ?? [];
    for (const r of got) if (!ignored(r, ignore)) all.set(r.id, r);
    const last = page * perPage >= (body.total_count ?? 0) || got.length < perPage;
    const runs = [...all.values()];
    const edge = last ? null : got[got.length - 1]?.head_sha;
    const settled = commitVerdicts(runs.filter((r) => r.head_sha !== edge));
    const green = settled.filter((c) => c.state === "green").at(-1);
    if (green) return { runs: runs.filter((r) => r.head_sha === green.sha || ms(r.run_started_at ?? r.created_at) >= green.start), complete: true };
    if (last) return { runs, complete: true };
  }
  return { runs: [...all.values()], complete: false };
}
// A run of a workflow the repo lists in auto-revert.json's "ignoreWorkflows" (its file name without .yml, or its name) is not read at all:
// its red neither starts nor extends a red stretch, so no revert follows from it.
export function ignored(run, ignore) {
  const stem = String(run.path ?? "").split("@")[0].split("/").pop().replace(/\.ya?ml$/, "");
  return ignore.includes(stem) || ignore.includes(run.name);
}
const ms = (t) => new Date(t).getTime();

// Reads the repo's open red and everything the guards need. Returns null when main is not red.
export async function gather(repo, now, a = api, { ignore = [] } = {}) {
  const get = (p) => a.get(p);
  const stretch = await readRedStretch(repo, get, { ignore });
  const eps = episodes(commitVerdicts(await markInfra(repo, stretch.runs, get)));
  const open = eps.find((e) => e.to === null);
  if (!open) return null;
  if (!stretch.complete) return { repo, tooLong: true, minutes: Math.round((now - open.from) / 60000) };
  if (!open) return null;
  const [after, pulls, commit, openPrs, jobsBody] = await Promise.all([
    a.get(`/repos/${repo}/compare/${open.sha}...main`),
    a.get(`/repos/${repo}/commits/${open.sha}/pulls`),
    a.get(`/repos/${repo}/commits/${open.sha}`),
    a.get(`/repos/${repo}/pulls?state=open&per_page=100`),
    a.get(`/repos/${repo}/actions/runs/${open.runId}/jobs?filter=latest&per_page=100`),
  ]);
  const run = await a.get(`/repos/${repo}/actions/runs/${open.runId}`);
  const failed = jobsBody.jobs.filter((j) => ["failure", "cancelled", "timed_out", "startup_failure"].includes(j.conclusion));
  const failedJobs = await Promise.all(
    failed.map(async (j) => ({ ...(await readNotes(a, repo, j.id)), name: j.name, conclusion: j.conclusion, runner_id: j.runner_id, steps: j.steps ?? [], log: await a.get(`/repos/${repo}/actions/jobs/${j.id}/logs`).then((t) => String(t).slice(-200000), () => "") })),
  );
  return {
    repo,
    sha: open.sha,
    minutes: Math.round((now - open.from) / 60000),
    since: open.from,
    laterCommits: after.ahead_by,
    pulls,
    parents: commit.parents.length,
    openPrs,
    failedJobs,
    run: { id: run.id, status: run.status, conclusion: run.conclusion, attempt: run.run_attempt, name: run.name, url: run.html_url },
  };
}

const ENABLE = `mutation($id:ID!,$h:String!,$b:String!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:SQUASH,commitHeadline:$h,commitBody:$b}){clientMutationId}}`;
const REVERT = `mutation($id:ID!,$t:String!,$b:String!){revertPullRequest(input:{pullRequestId:$id,title:$t,body:$b,draft:false}){revertPullRequest{id number url}}}`;

export async function act(repo, f, verdict, { apply, now, log = console.log, a = api, owners = OWNERS } = {}) {
  const { pr } = verdict;
  if (verdict.action === "rerun") {
    log(`${apply ? "" : "would "}rerun failed jobs of run ${f.run.id} in ${repo} (first red commit is #${pr.number})`);
    if (apply) await a.post(`/repos/${repo}/actions/runs/${f.run.id}/rerun-failed-jobs`);
    return;
  }
  const title = `Revert "${pr.title}" (#${pr.number})`;
  const body = revertBody({ repo, pr, sha: f.sha, run: f.run, jobs: verdict.jobs, minutes: f.minutes });
  log(`${apply ? "" : "would "}open revert PR "${title}" in ${repo}: red ${f.minutes}m, jobs ${verdict.jobs.join(", ")}`);
  if (!apply) return;
  const { node_id } = await a.get(`/repos/${repo}/pulls/${pr.number}`);
  const made = (await a.graphql(REVERT, { id: node_id, t: title, b: body })).revertPullRequest.revertPullRequest;
  await a.graphql(ENABLE, { id: made.id, h: `${title.replace(/ \(#\d+\)$/, "")} (#${made.number})`, b: cleanBody(body) });
  const owner = owners.repos[repo] ?? owners.fallback;
  await a.post(`/repos/${repo}/issues/${made.number}/comments`, { body: `Owner: ${owner.name} (session ${owner.session}). Main is red in ${repo}; merging this reverts #${pr.number}. The red-main gate wakes the owner.` });
  log(`opened ${made.url} with auto-merge on`);
}

// Counts every API call a run makes, by method.
export function counted(a = api) {
  const calls = { GET: 0, POST: 0, graphql: 0 };
  return {
    calls,
    get: (p) => (calls.GET++, a.get(p)),
    post: (p, b) => (calls.POST++, a.post(p, b)),
    graphql: (q, v) => (calls.graphql++, a.graphql(q, v)),
  };
}

export async function main(argv = process.argv.slice(2), now = Date.now(), base = api) {
  const a = counted(base);
  const apply = argv.includes("--apply");
  const self = argv.includes("--self") ? argv[argv.indexOf("--self") + 1] : null;
  const only = self ?? argv[argv.indexOf("--repo") + 1];
  console.log(apply ? "auto-revert: applying" : "auto-revert: dry run (pass --apply to act)");
  const repos = self ? { [self]: { ...CONFIG.repos[self], enabled: true } } : CONFIG.repos;
  for (const [repo, cfg] of Object.entries(repos)) {
    if (only && only !== repo) continue;
    if (!cfg.enabled && !only) {
      console.log(`${repo}: disabled in auto-revert.json`);
      continue;
    }
    try {
      const f = await gather(repo, now, a, { ignore: cfg.ignoreWorkflows ?? [] });
      if (!f) {
        console.log(`${repo}: main is not red`);
        continue;
      }
      if (f.tooLong) {
        console.log(`${repo}: red ${f.minutes}m+ across more than ${MAX_PAGES * PAGE} runs, start of the stretch unknown, not reverting`);
        continue;
      }
      const v = evaluate(f);
      if (v.action === "skip") console.log(`${repo}: red ${f.minutes}m, not reverting: ${v.reason}`);
      else await act(repo, f, v, { apply: apply && cfg.enabled, now, a });
    } catch (err) {
      console.log(`${repo}: could not check: ${err.message}`);
      process.exitCode = 1;
    }
  }
  const { GET, POST, graphql } = a.calls;
  console.log(`auto-revert: ${GET + POST + graphql} API calls (${GET} read, ${POST + graphql} write)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
