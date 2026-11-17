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

// Green, nothing but the merge itself holding it, and nobody turned auto-merge on.
export function readyWithoutAutoMerge(pr) {
  if (pr.isDraft || pr.autoMergeRequest) return false;
  if (!["BLOCKED", "CLEAN"].includes(pr.mergeStateStatus)) return false;
  if (["REVIEW_REQUIRED", "CHANGES_REQUESTED"].includes(pr.reviewDecision)) return false;
  return pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state === "SUCCESS";
}

const QUERY = `query($q:String!,$after:String){search(query:$q,type:ISSUE,first:50,after:$after){
  pageInfo{hasNextPage endCursor}
  nodes{... on PullRequest{id number title body url isDraft mergeStateStatus reviewDecision
    repository{nameWithOwner}
    autoMergeRequest{mergeMethod commitHeadline commitBody}
    commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}`;

function gql(query, vars) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push("-f", `${k}=${v}`);
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).data;
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

const DISABLE = `mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){clientMutationId}}`;
const ENABLE = `mutation($id:ID!,$m:PullRequestMergeMethod!,$h:String!,$b:String!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$m,commitHeadline:$h,commitBody:$b}){clientMutationId}}`;
const MERGE = `mutation($id:ID!,$m:PullRequestMergeMethod!,$h:String!,$b:String!){mergePullRequest(input:{pullRequestId:$id,mergeMethod:$m,commitHeadline:$h,commitBody:$b}){clientMutationId}}`;

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

function main() {
  const args = new Set(process.argv.slice(2));
  const opts = { dryRun: args.has("--dry-run") };
  const prs = openPrs();
  let acted = 0;
  for (const pr of prs) {
    try {
      if (needsRearm(pr)) { acted++; rearm(pr, opts); }
      else if (args.has("--merge-ready") && readyWithoutAutoMerge(pr)) { acted++; mergeNow(pr, opts); }
    } catch (err) {
      console.log(`failed on ${label(pr)}: ${String(err.stderr ?? err.message).trim().split("\n")[0]}`);
      process.exitCode = 1;
    }
  }
  console.log(`${prs.length} open PRs checked, ${acted} needed action.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
