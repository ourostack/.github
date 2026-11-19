#!/usr/bin/env node
// Re-arms auto-merge with an explicit clean message on every open ourostack PR whose auto-merge uses GitHub's
// default message. The default squash message carries the branch commits' AI co-author lines, which the org ruleset
// "No AI co-author credit" rejects, so the PR shows BLOCKED with every check green and never merges.
// The rule: agents/prs-merge-within-30-minutes.md ("Merge with an explicit message").
//
//   node tools/rearm-merges/rearm-merges.mjs             # re-arm what needs it
//   node tools/rearm-merges/rearm-merges.mjs --dry-run   # only say what it would do
//   node tools/rearm-merges/rearm-merges.mjs --merge-ready   # also merge green PRs that have no auto-merge
//
// Needs GH_TOKEN with write access to the repositories' pull requests. Idempotent: a PR whose auto-merge already has an
// explicit headline is left alone.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const ORG = process.env.REARM_ORG ?? "ourostack";
// A trailer-style line ("Co-authored-by: ...") that names an AI tool or a bot.
const AI_CREDIT = /^\s*[A-Za-z-]+-by\s*:.*(\[bot\]|(^|[^A-Za-z0-9])(copilot|claude|anthropic|openai|chatgpt|gpt|codex|gemini|cursor|devin|aider)([^A-Za-z]|$))/i;
// The org ruleset's own pattern, used to prove a message is clean.
export const RULESET = /co-authored-by:[^\n]*(\[bot\]|copilot)/i;

export function cleanBody(body) {
  const lines = String(body ?? "").replace(/\r/g, "").split("\n").filter((l) => !AI_CREDIT.test(l));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function messageFor(pr) {
  return { headline: `${pr.title} (#${pr.number})`, body: cleanBody(pr.body) };
}

// Auto-merge is on and will use GitHub's default message.
export function needsRearm(pr) {
  const a = pr.autoMergeRequest;
  return Boolean(a) && !a.commitHeadline;
}

// Auto-merge is on but the branch is behind main. With "require branches to be up to date" (rulesets/) GitHub waits
// for the branch to be updated and never does it itself, so the job brings the merged tree up to date and CI reruns on it.
export function needsUpdate(pr) {
  return Boolean(pr.autoMergeRequest) && pr.mergeStateStatus === "BEHIND";
}

// Green, nothing but the merge itself holding it, and nobody turned auto-merge on.
export function readyWithoutAutoMerge(pr) {
  if (pr.isDraft || pr.autoMergeRequest) return false;
  if (!["BLOCKED", "CLEAN"].includes(pr.mergeStateStatus)) return false;
  if (["REVIEW_REQUIRED", "CHANGES_REQUESTED"].includes(pr.reviewDecision)) return false;
  return pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state === "SUCCESS";
}

// PR cannot be merged due to conflicts or unmergeable state.
export function isUnmergeable(pr) {
  return pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "CONFLICTING";
}

const QUERY = `query($q:String!,$after:String){search(query:$q,type:ISSUE,first:50,after:$after){
  pageInfo{hasNextPage endCursor}
  nodes{... on PullRequest{id number title body url isDraft mergeable mergeStateStatus reviewDecision
    repository{nameWithOwner}
    autoMergeRequest{mergeMethod commitHeadline commitBody}
    commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}`;

// A GitHub 5xx or a dropped connection is retried with backoff; anything else (a rejected mutation, a 4xx) fails at once.
export const TRANSIENT = /Something went wrong while executing your query|secondary rate limit|abuse detection|\bHTTP 50[0234]\b|\b50[0234] (Bad Gateway|Service Unavailable|Gateway Time-?out)\b|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i;
export const RETRY_DELAYS_MS = [2000, 5000, 15000, 30000];
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function withRetry(call, { delays = RETRY_DELAYS_MS, sleep = sleepSync, log = console.error } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return call();
    } catch (err) {
      const text = `${err.stderr ?? ""}\n${err.message ?? ""}`;
      if (attempt >= delays.length || !TRANSIENT.test(text)) throw err;
      log(`GitHub answered with a server error (${text.trim().split("\n")[0]}); retrying in ${delays[attempt] / 1000}s`);
      sleep(delays[attempt]);
    }
  }
}

let transport = null;
// Tests swap the GitHub transport; null means the real gh call.
export function setTransport(fn) {
  transport = fn;
}

// gh sends -f as a string and -F as a typed value; an Int! variable (the PR number) fails as a string.
export function ghArgs(query, vars) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
  return args;
}

function gql(query, vars) {
  if (transport) return transport(query, vars);
  const args = ghArgs(query, vars);
  return JSON.parse(withRetry(() => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }))).data;
}

export function openPrs() {
  const out = [];
  let after = "";
  for (;;) {
    const d = gql(QUERY, { q: `org:${ORG} is:pr is:open draft:false`, ...(after ? { after } : {}) }).search;
    out.push(...d.nodes.filter((n) => n?.number));
    if (!d.pageInfo.hasNextPage) return out;
    after = d.pageInfo.endCursor;
  }
}

const UPDATE = `mutation($id:ID!){updatePullRequestBranch(input:{pullRequestId:$id}){clientMutationId}}`;
const DISABLE = `mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){clientMutationId}}`;
const ENABLE = `mutation($id:ID!,$m:PullRequestMergeMethod!,$h:String!,$b:String!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$m,commitHeadline:$h,commitBody:$b}){clientMutationId}}`;
const MERGE = `mutation($id:ID!,$m:PullRequestMergeMethod!,$h:String!,$b:String!){mergePullRequest(input:{pullRequestId:$id,mergeMethod:$m,commitHeadline:$h,commitBody:$b}){clientMutationId}}`;

const REREAD = `query($id:ID!){node(id:$id){... on PullRequest{state autoMergeRequest{commitHeadline}}}}`;

// A write that failed may have lost a race with a merge. Re-read the PR: merged or closed, or auto-merge already
// carrying an explicit message, means the wanted state holds and the failure is not one.
export function settledAfterFailure(pr) {
  let now;
  try {
    now = gql(REREAD, { id: pr.id }).node;
  } catch {
    return false;
  }
  if (!now) return false;
  if (now.state === "MERGED" || now.state === "CLOSED") return true;
  return Boolean(now.autoMergeRequest?.commitHeadline);
}

const label = (pr) => `${pr.repository.nameWithOwner}#${pr.number}`;

export function rearm(pr, { dryRun = false, log = console.log } = {}) {
  const { headline, body } = messageFor(pr);
  const method = pr.autoMergeRequest?.mergeMethod ?? "SQUASH";
  if (dryRun) return log(`would re-arm ${label(pr)} (${method}) as "${headline}"`);
  gql(DISABLE, { id: pr.id });
  try {
    gql(ENABLE, { id: pr.id, m: method, h: headline, b: body });
    log(`re-armed ${label(pr)} (${method}) as "${headline}"`);
  } catch (err) {
    // A PR that is already mergeable cannot wait on auto-merge, so merge it with the same message.
    if (!/clean status|unstable status/i.test(String(err.stderr ?? err.message))) {
      log(`could not re-arm ${label(pr)}: ${String(err.stderr ?? err.message).trim().split("\n")[0]}`);
      return;
    }
    gql(MERGE, { id: pr.id, m: method, h: headline, b: body });
    log(`merged ${label(pr)} (${method}) as "${headline}"`);
  }
}

export function mergeNow(pr, { dryRun = false, log = console.log } = {}) {
  const { headline, body } = messageFor(pr);
  if (dryRun) return log(`would merge ${label(pr)} as "${headline}"`);
  gql(MERGE, { id: pr.id, m: "SQUASH", h: headline, b: body });
  log(`merged ${label(pr)} as "${headline}"`);
}

export function processPrs(prs, args, opts = {}) {
  let acted = 0;
  let failed = 0;
  const unmergeable = [];
  for (const pr of prs) {
    try {
      if (isUnmergeable(pr)) {
        unmergeable.push(label(pr));
      } else if (needsUpdate(pr)) {
        acted++;
        if (opts.dryRun) console.log(`would update the branch of ${label(pr)}`);
        else {
          gql(UPDATE, { id: pr.id });
          console.log(`updated the branch of ${label(pr)} so its checks run on the current main`);
        }
        if (needsRearm(pr)) rearm(pr, opts);
      } else if (needsRearm(pr)) {
        acted++;
        rearm(pr, opts);
      } else if (args.has("--merge-ready") && readyWithoutAutoMerge(pr)) {
        acted++;
        mergeNow(pr, opts);
      }
    } catch (err) {
      const msg = String(err.stderr ?? err.message).trim().split("\n")[0];
      // Only fail on actual errors, not on unmergeable PRs
      if (/not mergeable|CONFLICTING/i.test(msg)) {
        unmergeable.push(`${label(pr)} (${msg})`);
      } else if (!opts.dryRun && settledAfterFailure(pr)) {
        console.log(`${label(pr)} changed under us (${msg}); on re-read it is merged, closed or already armed, so nothing to do`);
      } else {
        console.log(`failed on ${label(pr)}: ${msg}`);
        failed++;
      }
    }
  }
  return { acted, failed, unmergeable };
}

// ---- Merge queues: an entry whose head cannot merge blocks every entry behind it, so it is taken out. ----

export const STUCK_AFTER_MS = 10 * 60 * 1000;
const MARKER = "<!-- ourostack:rearm-merges:dequeued -->";

const QUEUES_QUERY = `query($org:String!,$after:String){organization(login:$org){repositories(first:50,after:$after,isArchived:false){
  pageInfo{hasNextPage endCursor}
  nodes{nameWithOwner defaultBranchRef{name} mergeQueue{entries(first:50){nodes{id state enqueuedAt headCommit{oid}
    pullRequest{id number title mergeable mergeStateStatus headRefName
      autoMergeRequest{mergeMethod commitHeadline commitBody}
      commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}}}}}`;

// A red rollup counts every check, optional ones too. For those PRs, ask which failed checks the base requires.
const REQUIRED_QUERY = `query($id:ID!,$n:Int!){node(id:$id){... on PullRequest{commits(last:1){nodes{commit{statusCheckRollup{state
  contexts(first:100){nodes{__typename ... on CheckRun{name conclusion isRequired(pullRequestNumber:$n)}
    ... on StatusContext{context state isRequired(pullRequestNumber:$n)}}}}}}}}}}`;

function withRequiredContexts(pr) {
  if (!["FAILURE", "ERROR"].includes(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state)) return pr;
  const commits = gql(REQUIRED_QUERY, { id: pr.id, n: pr.number }).node?.commits;
  return commits ? { ...pr, commits } : pr;
}

export function queueEntries() {
  const out = [];
  let after = "";
  for (;;) {
    const d = gql(QUEUES_QUERY, { org: ORG, ...(after ? { after } : {}) }).organization.repositories;
    for (const repo of d.nodes) {
      for (const e of repo.mergeQueue?.entries?.nodes ?? []) {
        out.push({ ...e, pullRequest: e.pullRequest && withRequiredContexts(e.pullRequest), repo: repo.nameWithOwner, base: repo.defaultBranchRef?.name ?? "main" });
      }
    }
    if (!d.pageInfo.hasNextPage) return out;
    after = d.pageInfo.endCursor;
  }
}

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED"]);

// The required checks that failed on the PR's head. A failed optional check never blocks the queue, and counting
// one kept a green PR out (gatefold#491's Shots). Without per-check detail, the rollup's state stands in.
export function failedChecks(pr) {
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const contexts = rollup?.contexts?.nodes;
  if (!contexts) return ["FAILURE", "ERROR"].includes(rollup?.state) ? ["required checks"] : [];
  const out = contexts.filter((c) => c.isRequired && FAILED.has(c.conclusion ?? c.state)).map((c) => c.name ?? c.context);
  return [...new Set(out)];
}

// Why an entry has to leave the queue, or null. Failed checks count after the entry has sat 10 minutes, so a rerun gets its chance.
export function stuckReason(entry, now = Date.now()) {
  const pr = entry.pullRequest;
  if (!pr) return null;
  const failing = failedChecks(pr).length > 0;
  if (failing && (entry.state === "UNMERGEABLE" || now - Date.parse(entry.enqueuedAt) > STUCK_AFTER_MS)) return "failed-checks";
  if (pr.mergeable === "CONFLICTING") return "conflict";
  return entry.state === "UNMERGEABLE" ? "unmergeable" : null;
}

const DEQUEUE = `mutation($id:ID!){dequeuePullRequest(input:{id:$id}){clientMutationId}}`;
const COMMENTS = `query($id:ID!){node(id:$id){... on PullRequest{comments(last:50){nodes{body}}}}}`;
const COMMENT = `mutation($id:ID!,$b:String!){addComment(input:{subjectId:$id,body:$b}){clientMutationId}}`;

export function processQueue(entries, { dryRun = false, now = Date.now(), log = console.log } = {}) {
  let dequeued = 0;
  let failed = 0;
  for (const entry of entries) {
    const pr = entry.pullRequest;
    const why = stuckReason(entry, now);
    if (!why) continue;
    const name = `${entry.repo}#${pr.number}`;
    if (dryRun) {
      log(`would dequeue ${name} (${why})`);
      continue;
    }
    try {
      gql(DEQUEUE, { id: pr.id });
      dequeued++;
      log(`dequeued ${name} (${why}) so the entries behind it can merge`);
      if (why === "failed-checks") {
        comment(pr, `Taken out of the merge queue: required checks failed (see the PR's Checks tab). Fix them and push; auto-merge re-queues it once green.`, log);
      } else if (why === "conflict") {
        comment(pr, `Taken out of the merge queue: it conflicts with \`${entry.base}\`. Rebase or merge \`${entry.base}\` and resolve the conflict; auto-merge re-queues it once green.`, log);
      } else {
        // A stale base is not a conflict: bring it up to date and arm it again.
        gql(UPDATE, { id: pr.id });
        const { headline, body } = messageFor({ ...pr, body: "" });
        gql(ENABLE, { id: pr.id, m: pr.autoMergeRequest?.mergeMethod ?? "SQUASH", h: headline, b: body });
        log(`updated ${name} from ${entry.base} and re-armed auto-merge`);
      }
    } catch (err) {
      const msg = String(err.stderr ?? err.message).trim().split("\n")[0];
      if (/conflict|not mergeable/i.test(msg)) {
        comment(pr, `Taken out of the merge queue: it cannot be updated from \`${entry.base}\` (${msg}). Resolve the conflict and push.`, log);
      } else {
        log(`failed on ${name}: ${msg}`);
        failed++;
      }
    }
  }
  return { dequeued, failed };
}

// ---- Orphaned merge-group runs: a reformed queue leaves the old groups' runs going, and they hold the runners. ----

let restTransport = null;
// Tests swap the REST transport; null means the real gh call.
export function setRest(fn) {
  restTransport = fn;
}

function rest(method, path) {
  if (restTransport) return restTransport(method, path);
  const out = withRetry(() => execFileSync("gh", ["api", "-X", method, path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  return out.trim() ? JSON.parse(out) : {};
}

// A merge_group run is live while some queue entry's group commit is its head. Any other queued or running one belongs to a
// group that no longer exists. A repository with no entries at all is left alone: nothing proves its groups are gone.
export function orphanRuns(runs, entries) {
  const live = new Set(entries.map((e) => e.headCommit?.oid).filter(Boolean));
  if (live.size === 0) return [];
  return runs.filter((r) => r.head_branch?.startsWith("gh-readonly-queue/") && !live.has(r.head_sha));
}

export function cancelOrphanRuns(entries, { dryRun = false, log = console.log } = {}) {
  const byRepo = Map.groupBy(entries, (e) => e.repo);
  let cancelled = 0;
  let failed = 0;
  const denied = new Set();
  for (const [repo, list] of byRepo) {
    const runs = ["queued", "in_progress"].flatMap((s) => rest("GET", `repos/${repo}/actions/runs?event=merge_group&status=${s}&per_page=100`).workflow_runs ?? []);
    for (const r of orphanRuns(runs, list)) {
      if (dryRun) {
        log(`would cancel ${repo} run ${r.id} (${r.name}) for ${r.head_branch}: its merge group is gone`);
        continue;
      }
      try {
        rest("POST", `repos/${repo}/actions/runs/${r.id}/cancel`);
        cancelled++;
        log(`cancelled ${repo} run ${r.id} (${r.name}) for ${r.head_branch}: its merge group is gone`);
      } catch (err) {
        const msg = String(err.stderr ?? err.message).trim().split("\n")[0];
        // A token without Actions write is a setup gap to warn about, not a run to fail; the other writes still ran.
        if (/Resource not accessible|HTTP 403/.test(msg)) {
          denied.add(repo);
          continue;
        }
        log(`failed to cancel ${repo} run ${r.id}: ${msg}`);
        failed++;
      }
    }
  }
  if (denied.size > 0) {
    log(`::warning title=REARM_MERGES_TOKEN cannot cancel runs::Orphaned merge-group runs were left running in ${[...denied].join(", ")}: the token needs the "actions: write" permission on those repositories.`);
  }
  return { cancelled, failed, denied: [...denied] };
}

// One comment per PR is enough: a PR that was already told stays quiet.
function comment(pr, text, log) {
  const prior = gql(COMMENTS, { id: pr.id }).node?.comments?.nodes ?? [];
  if (prior.some((c) => c.body?.includes(MARKER))) return log(`#${pr.number} was already told why it left the queue`);
  gql(COMMENT, { id: pr.id, b: `${text}\n\n${MARKER}` });
}

function main() {
  try {
    run();
  } catch (err) {
    const text = `${err.stderr ?? ""}\n${err.message ?? ""}`;
    if (!TRANSIENT.test(text)) throw err;
    const id = /\b([0-9A-F]{4}:[0-9A-F:]{6,})\b/.exec(text)?.[1] ?? "unknown";
    console.log(`::error title=infra::GitHub transient failure persisted after retries: ${text.trim().split("\n")[0].slice(0, 200)} (GitHub request id ${id})`);
    process.exit(1);
  }
}

function run() {
  const args = new Set(process.argv.slice(2));
  const opts = { dryRun: args.has("--dry-run") };
  const entries = queueEntries();
  const queued = processQueue(entries, opts);
  if (queued.failed > 0) process.exitCode = 1;
  // Entries just dequeued still count as live here; their runs go on the next pass.
  const orphans = cancelOrphanRuns(entries, opts);
  if (orphans.failed > 0) process.exitCode = 1;
  console.log(`${orphans.cancelled} orphaned merge-group run${orphans.cancelled === 1 ? "" : "s"} cancelled.`);
  console.log(`${queued.dequeued} stuck merge-queue entr${queued.dequeued === 1 ? "y" : "ies"} dequeued.`);
  const prs = openPrs();
  const { acted, failed, unmergeable } = processPrs(prs, args, opts);
  if (failed > 0) process.exitCode = 1;
  console.log(`${prs.length} open PRs checked, ${acted} needed action.`);
  if (unmergeable.length > 0) {
    console.log(`\nSkipped ${unmergeable.length} unmergeable PR(s):`);
    for (const pr of unmergeable) {
      console.log(`  - ${pr}`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
