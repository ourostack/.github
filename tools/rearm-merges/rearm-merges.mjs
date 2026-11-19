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
export const TRANSIENT = /\bHTTP 50[0234]\b|\b50[0234] (Bad Gateway|Service Unavailable|Gateway Time-?out)\b|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i;
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

function gql(query, vars) {
  if (transport) return transport(query, vars);
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push("-f", `${k}=${v}`);
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

function main() {
  const args = new Set(process.argv.slice(2));
  const opts = { dryRun: args.has("--dry-run") };
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
