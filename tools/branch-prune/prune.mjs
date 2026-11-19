#!/usr/bin/env node
// Deletes a repository's remote branches that no longer carry work, so the branch list stays the work in progress.
// The rule is decide(); the CLI lists the branches and pull requests with gh, deletes what decide() picks and prints
// the counts before and after.
//
// The rule, first match wins. Kept: the default branch; a protected branch or one a ruleset forbids deleting; a
// release or system branch (release/…, releases/…, hotfix/…, vX.Y.Z, gh-readonly-queue/…, gh-pages…); a branch with
// an open pull request from it or into it; a branch pushed to in the last min-age days (its last push, else its tip's
// commit date). Deleted: a branch fully merged into the default branch; a branch whose most recent pull request was
// merged, or closed unmerged, at least min-age days ago, while the branch still points where that pull request's head did.
// Everything else is kept with its reason. Pull requests count only when they come from this repository, not a fork.
//
// Usage (CI sets REPO and GH_TOKEN): GH_TOKEN=… REPO=owner/name node tools/branch-prune/prune.mjs [--dry-run] [--min-age-days 3]
// --dry-run lists what would go and deletes nothing. The exit code is 1 when a delete fails for any reason but a
// missing branch (another run deleted it first), or when GitHub cannot be read, since nothing can then be decided.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const PAGE_SIZE = 100;
const RELEASE_NAMES = [/^(release|releases|hotfix)([/-]|$)/, /^v\d+(\.\d+)*$/];
const SYSTEM_PREFIXES = ["gh-readonly-queue/", "gh-pages"];
// GitHub answers 404 for a branch that is gone, and 422 ("Reference does not exist") for a ref a delete finds missing.
const MISSING = /HTTP (404|422)\b|Reference does not exist/;
// A branch with no common history with the default branch has nothing merged into it: GitHub answers 404 to its compare.
const NO_COMMON_HISTORY = /No common ancestor/;

const keep = (reason) => ({ action: "keep", reason });
const isReleaseOrSystem = (name) => RELEASE_NAMES.some((pattern) => pattern.test(name)) || SYSTEM_PREFIXES.some((prefix) => name.startsWith(prefix));
const closedMs = (pull) => Date.parse(pull.closedAt) || 0;
const latestPull = (pulls) => [...pulls].sort((a, b) => closedMs(b) - closedMs(a) || b.number - a.number)[0];

/** The verdict from the name, protection and open pull requests alone; null when the rest of the rule decides. */
export function screen(branch, { defaultBranch }) {
  if (branch.name === defaultBranch) return keep("default branch");
  if (branch.protected) return keep("protected");
  if (isReleaseOrSystem(branch.name)) return keep("release or system branch");
  const open = (branch.prs ?? []).find((pull) => pull.state === "open");
  if (open) return keep(`open PR #${open.number}`);
  if (branch.targetOf) return keep(`open PR #${branch.targetOf} targets it`);
  return null;
}

/** The reason a branch pushed inside the window is kept, or null. now is in milliseconds. */
export function recentPushReason(branch, { now, minAgeDays }) {
  const pushed = Date.parse(branch.lastPushAt ?? branch.headCommitAt ?? "");
  if (Number.isNaN(pushed)) return "no push time known";
  const ageMs = now - pushed;
  if (ageMs >= minAgeDays * DAY_MS) return null;
  return `pushed ${Math.max(0, Math.floor(ageMs / HOUR_MS))}h ago`;
}

function verdict(branch, ctx) {
  const early = screen(branch, ctx);
  if (early) return early;
  if (branch.rulesDeletion) return keep("a ruleset forbids deleting");
  const recent = recentPushReason(branch, ctx);
  if (recent) return keep(recent);
  if (typeof branch.aheadBy !== "number") throw new TypeError(`decide needs aheadBy for ${branch.name}`);
  if (branch.aheadBy === 0) return { action: "delete", reason: `fully merged into ${ctx.defaultBranch}` };
  const last = latestPull(branch.prs ?? []);
  if (!last) return keep("no PR, not merged");
  // A squash or rebase merge leaves the branch's own commits outside the default branch, so it is not fully merged; its
  // pull request merged it all the same, and a branch still at that pull request's head carries nothing more.
  const how = last.merged ? "merged" : "closed unmerged";
  const closed = Date.parse(last.closedAt);
  if (Number.isNaN(closed)) return keep(`PR #${last.number} ${how}, close time unknown`);
  const days = Math.floor((ctx.now - closed) / DAY_MS);
  if (ctx.now - closed < ctx.minAgeDays * DAY_MS) return keep(`PR #${last.number} ${how} ${days} days ago`);
  if (last.headSha !== branch.sha) return keep(`PR #${last.number} ${how}, branch changed since`);
  return { action: "delete", reason: `PR #${last.number} ${how} ${days} days ago, unchanged since` };
}

/** Each branch with its action ("delete" or "keep") and reason. Branch records: see README.md. */
export function decide(branches, { defaultBranch, now = new Date(), minAgeDays = 3 } = {}) {
  if (!defaultBranch) throw new TypeError("decide needs the repository's defaultBranch");
  const ctx = { defaultBranch, now: new Date(now).getTime(), minAgeDays };
  return branches.map((branch) => ({ ...branch, ...verdict(branch, ctx) }));
}

/** Runs gh with the arguments; returns its status and output. */
export function ghCall(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 << 20 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function ghOk(gh, args) {
  const result = gh(args);
  if (result.status !== 0) throw new Error(`gh ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

const encodePath = (name) => name.split("/").map(encodeURIComponent).join("/");
const countBy = (items) => items.reduce((counts, item) => counts.set(item, (counts.get(item) ?? 0) + 1), new Map());

function listBranches(repo, gh) {
  const branches = [];
  for (let page = 1; ; page += 1) {
    const batch = JSON.parse(ghOk(gh, ["api", `repos/${repo}/branches?per_page=${PAGE_SIZE}&page=${page}`]));
    branches.push(...batch.map((branch) => ({ name: branch.name, sha: branch.commit.sha, protected: branch.protected === true })));
    if (batch.length < PAGE_SIZE) return branches;
  }
}

const pullOf = (pull) => ({ number: pull.number, state: pull.state, merged: pull.merged_at != null, closedAt: pull.closed_at ?? null, headSha: pull.head.sha });

/** The pull requests from this repository by head branch, and the number of an open one into each branch. */
function listPulls(repo, gh) {
  const byHead = new Map();
  const targets = new Map();
  for (let page = 1; ; page += 1) {
    const batch = JSON.parse(ghOk(gh, ["api", `repos/${repo}/pulls?state=all&per_page=${PAGE_SIZE}&page=${page}`]));
    for (const pull of batch) {
      if (pull.state === "open" && !targets.has(pull.base.ref)) targets.set(pull.base.ref, pull.number);
      if (pull.head?.repo?.full_name?.toLowerCase() !== repo.toLowerCase()) continue;
      byHead.set(pull.head.ref, [...(byHead.get(pull.head.ref) ?? []), pullOf(pull)]);
    }
    if (batch.length < PAGE_SIZE) return { byHead, targets };
  }
}

/** A branch's record for decide(), fetching only what the rule needs once the earlier verdicts have not decided it. */
function gather(repo, gh, branch, ctx, prs, targetOf) {
  const record = { ...branch, prs, targetOf, rulesDeletion: false, lastPushAt: null, headCommitAt: null, aheadBy: null };
  if (screen(record, ctx)) return record;
  const rules = JSON.parse(ghOk(gh, ["api", `repos/${repo}/rules/branches/${encodePath(branch.name)}`]));
  record.rulesDeletion = rules.some((rule) => rule.type === "deletion");
  if (record.rulesDeletion) return record;
  const [latest] = JSON.parse(ghOk(gh, ["api", `repos/${repo}/activity?ref=${encodeURIComponent(`refs/heads/${branch.name}`)}&per_page=1`]));
  record.lastPushAt = latest?.timestamp ?? null;
  if (record.lastPushAt === null) {
    record.headCommitAt = JSON.parse(ghOk(gh, ["api", `repos/${repo}/commits/${branch.sha}`])).commit.committer.date ?? null;
  }
  if (recentPushReason(record, ctx)) return record;
  const compare = gh(["api", `repos/${repo}/compare/${encodePath(ctx.defaultBranch)}...${branch.sha}`]);
  if (compare.status === 0) record.aheadBy = JSON.parse(compare.stdout).ahead_by;
  else if (NO_COMMON_HISTORY.test(compare.stderr)) record.aheadBy = Number.POSITIVE_INFINITY;
  else throw new Error(`gh api compare for ${branch.name} failed: ${compare.stderr.trim()}`);
  return record;
}

/** Deletes one branch unless it moved or gained an open pull request since the listing. */
function removeBranch(repo, gh, branch) {
  const tip = gh(["api", `repos/${repo}/branches/${encodePath(branch.name)}`]);
  if (tip.status !== 0) return MISSING.test(tip.stderr) ? { outcome: "gone" } : { outcome: "failed", stderr: tip.stderr };
  if (JSON.parse(tip.stdout).commit.sha !== branch.sha) return { outcome: "skipped", why: "its tip moved since the listing" };
  const owner = repo.split("/")[0];
  const open = gh(["api", `repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch.name}`)}`]);
  if (open.status !== 0) return { outcome: "failed", stderr: open.stderr };
  if (JSON.parse(open.stdout).length > 0) return { outcome: "skipped", why: "an open PR appeared since the listing" };
  const result = gh(["api", "-X", "DELETE", `repos/${repo}/git/refs/heads/${encodePath(branch.name)}`]);
  if (result.status === 0) return { outcome: "deleted" };
  return MISSING.test(result.stderr) ? { outcome: "gone" } : { outcome: "failed", stderr: result.stderr };
}

/** The reason's kind, so kept branches group by why they stay: the PR number and the counts are dropped. */
function kindOf(reason) {
  return reason
    .replace(/^open PR #\d+/, "open PR")
    .replace(/^pushed \d+h ago$/, "pushed inside the window")
    .replace(/^PR #\d+ (merged|closed unmerged) \d+ days ago$/, "PR $1, inside the window")
    .replace(/^PR #\d+/, "PR");
}

/** Prunes one repository. Returns the exit code: 0, or 1 when a delete failed for a reason other than a missing branch. */
export function run({ repo, dryRun = false, minAgeDays = 3, gh = ghCall, log = console.log, err = console.error, now = new Date() }) {
  if (!repo) throw new Error("REPO is not set (owner/name)");
  const defaultBranch = JSON.parse(ghOk(gh, ["api", `repos/${repo}`])).default_branch;
  const ctx = { defaultBranch, now: new Date(now).getTime(), minAgeDays };
  const before = listBranches(repo, gh);
  const { byHead, targets } = listPulls(repo, gh);
  const records = before.map((branch) => gather(repo, gh, branch, ctx, byHead.get(branch.name) ?? [], targets.get(branch.name) ?? null));
  const verdicts = decide(records, ctx);
  const doomed = verdicts.filter((entry) => entry.action === "delete");
  const kept = verdicts.filter((entry) => entry.action === "keep");

  log(`${repo}: default branch ${defaultBranch}`);
  log(`before: ${before.length} branches`);
  log(`${dryRun ? "would delete" : "deleting"} ${doomed.length} branches:`);
  let failed = 0;
  for (const branch of doomed) {
    const label = `${branch.name}: ${branch.reason}`;
    if (dryRun) {
      log(`would delete ${label}`);
      continue;
    }
    const result = removeBranch(repo, gh, branch);
    if (result.outcome === "deleted") log(`deleted ${label}`);
    else if (result.outcome === "gone") log(`already gone ${label}`);
    else if (result.outcome === "skipped") log(`skipped ${branch.name}: ${result.why}`);
    else {
      failed += 1;
      err(`could not delete ${label}: ${result.stderr.trim()}`);
    }
  }
  log(`kept ${kept.length}:`);
  for (const [kind, count] of [...countBy(kept.map((entry) => kindOf(entry.reason)))].sort((a, b) => b[1] - a[1])) {
    log(`  ${kind}: ${count}`);
  }
  if (dryRun) {
    log("dry run: nothing deleted");
    log(`would leave: ${before.length - doomed.length} branches`);
  } else {
    log(`after: ${listBranches(repo, gh).length} branches`);
  }
  return failed === 0 ? 0 : 1;
}

export function parseArgs(argv) {
  const options = { dryRun: false, minAgeDays: 3 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dry-run") options.dryRun = true;
    else if (argv[i] === "--min-age-days" && argv[i + 1] !== undefined) {
      const value = argv[++i];
      if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`--min-age-days takes a number of days, not ${value}`);
      options.minAgeDays = Number(value);
    } else throw new Error(`usage: prune.mjs [--dry-run] [--min-age-days <n>]  (unknown argument: ${argv[i]})`);
  }
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = run({ repo: process.env.REPO, ...parseArgs(process.argv.slice(2)) });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
