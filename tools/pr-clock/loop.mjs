#!/usr/bin/env node
// The loop clock: how long a repository's changes take from PR opened to live, and how often its default branch is red.
// Step 0 of agents/eng-system.md: measure the loop before changing anything, and again after each step.
//
//   node tools/pr-clock/loop.mjs owner/repo [--days 7] [--env production] [--json]
//
// Needs GH_TOKEN (or a logged-in gh). It reads, with GraphQL only:
// - the PRs merged in the window: opened to merged;
// - the repository's deployments: a PR is live when the first successful deployment of its merge commit, or of a later
//   commit on the default branch, says so. --env keeps one environment. A repository with no deployments in the window
//   says so; its loop then ends at merge;
// - the default branch's first-parent commits in the window: the share of the time it was red, from a red commit to the
//   next green one (a flaky job that the next commit passes costs minutes, a real break costs until its fix), and the
//   share of commits whose checks ended red (the commit's check rollup).
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DAY_MS = 86_400_000;
const MAX_PAGES = 10;

/** The p-th percentile (0 to 100) of numbers, nearest rank; null for none. */
export function percentile(values, p) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const minutes = (from, to) => (Date.parse(to) - Date.parse(from)) / 60_000;

/**
 * The default branch's first-parent line, newest first, from history nodes `{ oid, parent, state }` (`parent` is the first
 * parent's oid). Following first parents leaves out the commits of merged branches.
 */
export function firstParents(nodes, head) {
  const byOid = new Map(nodes.map((node) => [node.oid, node]));
  const line = [];
  for (let oid = head; byOid.has(oid); oid = byOid.get(oid).parent) line.push(byOid.get(oid));
  return line;
}

/**
 * When each merged PR went live: the earliest success of a deployment whose commit is the PR's merge commit or a later
 * commit on the default branch; null when there is none yet. pulls: [{ createdAt, mergedAt, mergeOid }];
 * deployments: [{ oid, environment, liveAt }] (liveAt is its first SUCCESS status, or null); line: the first-parent
 * line, newest first.
 */
export function liveTimes(pulls, deployments, line, environment = null) {
  const position = new Map(line.map((commit, index) => [commit.oid, index]));
  const live = deployments.filter((deployment) => deployment.liveAt && position.has(deployment.oid) && (!environment || deployment.environment === environment));
  return pulls.map((pull) => {
    const merged = position.get(pull.mergeOid);
    const times = merged === undefined ? [] : live.filter((deployment) => position.get(deployment.oid) <= merged).map((deployment) => deployment.liveAt).sort();
    return { ...pull, liveAt: times[0] ?? null };
  });
}

/**
 * The default branch's red stretches: each runs from a red commit to the next green one, and one still open runs to `now`.
 * line: the first-parent line, newest first, with `state` and `at` (committed time). Returns the stretches in minutes.
 */
export function redStretches(line, now = Date.now()) {
  const stretches = [];
  let since = null;
  for (const commit of [...line].reverse()) {
    if ((commit.state === "FAILURE" || commit.state === "ERROR") && since === null) since = Date.parse(commit.at);
    else if (commit.state === "SUCCESS" && since !== null) {
      stretches.push((Date.parse(commit.at) - since) / 60_000);
      since = null;
    }
  }
  if (since !== null) stretches.push((now - since) / 60_000);
  return stretches;
}

/** The numbers for a window: medians and p90s in minutes, and the default branch's red share. */
export function summarize({ pulls, commits, hasDeployments, windowMinutes = null, now = Date.now() }) {
  const stat = (values) => ({ median: percentile(values, 50), p90: percentile(values, 90), n: values.length });
  const live = pulls.filter((pull) => pull.liveAt);
  const settled = commits.filter((commit) => ["SUCCESS", "FAILURE", "ERROR"].includes(commit.state));
  const red = settled.filter((commit) => commit.state !== "SUCCESS").length;
  return {
    merged: pulls.length,
    openToMerge: stat(pulls.map((pull) => minutes(pull.createdAt, pull.mergedAt))),
    mergeToLive: hasDeployments ? stat(live.map((pull) => minutes(pull.mergedAt, pull.liveAt))) : null,
    openToLive: hasDeployments ? stat(live.map((pull) => minutes(pull.createdAt, pull.liveAt))) : null,
    mainCommits: commits.length,
    mainRedShare: settled.length ? red / settled.length : null,
    mainRed: red,
    mainSettled: settled.length,
    mainRedTime: windowMinutes ? Math.min(1, redStretches(commits, now).reduce((sum, value) => sum + value, 0) / windowMinutes) : null,
    mainRedStretch: percentile(redStretches(commits, now), 50),
  };
}

const fmt = (value) => (value === null ? "–" : value < 120 ? `${Math.round(value)} min` : `${(value / 60).toFixed(1)} h`);
const row = (label, stat) => `| ${label} | ${stat ? fmt(stat.median) : "no deployments"} | ${stat ? fmt(stat.p90) : "–"} | ${stat ? stat.n : "–"} |`;

/** The Markdown report. */
export function render(repo, days, numbers) {
  const commits = numbers.mainRedShare === null ? "–" : `${Math.round(numbers.mainRedShare * 100)}% of settled commits (${numbers.mainRed} of ${numbers.mainSettled})`;
  const time = numbers.mainRedTime === null || numbers.mainRedTime === undefined ? "" : `${Math.round(numbers.mainRedTime * 100)}% of the time${numbers.mainRedStretch === null ? "" : ` (median stretch ${fmt(numbers.mainRedStretch)})`}; `;
  const share = `${time}${commits}`;
  return [
    `## The loop for ${repo}, last ${days} days`,
    "",
    "| Stretch | Median | p90 | PRs |",
    "|---|---|---|---|",
    row("PR opened to merged", numbers.openToMerge),
    row("Merged to live", numbers.mergeToLive),
    row("PR opened to live", numbers.openToLive),
    "",
    `Default branch red: ${share}. ${numbers.merged} PRs merged.`,
    ...(numbers.topRedChecks?.length
      ? ["", `What turned it red (the newest ${numbers.redChecksRead} red commits): ${numbers.topRedChecks.map(([check, count]) => `${check} (${count})`).join(", ")}. Fix the most frequent first: a flaky check is red time with no break behind it.`]
      : []),
  ].join("\n");
}

function graphql(query, variables) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).data;
}

function pages(read) {
  const nodes = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { items, pageInfo } = read(after);
    nodes.push(...items);
    if (!pageInfo.hasNextPage) return { nodes, capped: false };
    after = pageInfo.endCursor;
  }
  return { nodes, capped: true };
}

const cursor = (after) => (after ? { after } : {});

function readPulls(repo, since) {
  const query = `query($q: String!, $after: String) { search(query: $q, type: ISSUE, first: 100, after: $after) {
    issueCount pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { number createdAt mergedAt mergeCommit { oid } } } } }`;
  let total = 0;
  const read = pages((after) => {
    const { search } = graphql(query, { q: `repo:${repo} is:pr is:merged merged:>=${since.slice(0, 10)}`, ...cursor(after) });
    total = search.issueCount;
    const items = search.nodes.map((pull) => ({ createdAt: pull.createdAt, mergedAt: pull.mergedAt, mergeOid: pull.mergeCommit?.oid ?? null }));
    return { items, pageInfo: search.pageInfo };
  });
  // Search answers at most 1,000 results, and says it has no next page once it stops.
  return { nodes: read.nodes.filter((pull) => pull.mergedAt && pull.mergedAt >= since), capped: read.capped || total > read.nodes.length };
}

function readDeployments(owner, name, since) {
  const query = `query($owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) {
    deployments(first: 100, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) { pageInfo { hasNextPage endCursor }
      nodes { createdAt commitOid environment statuses(first: 10) { nodes { state createdAt } } } } } }`;
  const nodes = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { deployments } = graphql(query, { owner, name, ...cursor(after) }).repository;
    for (const node of deployments.nodes) {
      const success = node.statuses.nodes.filter((status) => status.state === "SUCCESS").map((status) => status.createdAt).sort()[0];
      nodes.push({ createdAt: node.createdAt, oid: node.commitOid, environment: node.environment, liveAt: success ?? null });
    }
    const oldest = deployments.nodes.at(-1)?.createdAt;
    if (!deployments.pageInfo.hasNextPage || (oldest && oldest < since)) return { nodes, capped: false };
    after = deployments.pageInfo.endCursor;
  }
  return { nodes, capped: true };
}

function readCommits(owner, name, since) {
  const query = `query($owner: String!, $name: String!, $since: GitTimestamp!, $after: String) { repository(owner: $owner, name: $name) {
    defaultBranchRef { target { ... on Commit { oid history(first: 100, since: $since, after: $after) { pageInfo { hasNextPage endCursor }
      nodes { oid committedDate parents(first: 1) { nodes { oid } } statusCheckRollup { state } } } } } } } }`;
  let head = null;
  const read = pages((after) => {
    const { target } = graphql(query, { owner, name, since, ...cursor(after) }).repository.defaultBranchRef;
    head = target.oid;
    const items = target.history.nodes.map((commit) => ({ oid: commit.oid, at: commit.committedDate, parent: commit.parents.nodes[0]?.oid ?? null, state: commit.statusCheckRollup?.state ?? null }));
    return { items, pageInfo: target.history.pageInfo };
  });
  return { line: firstParents(read.nodes, head), capped: read.capped };
}

/** The checks that failed most often on red commits, as [name, count] pairs, most first. failures: one list of names per commit. */
export function topRedChecks(failures, limit = 5) {
  const counts = new Map();
  for (const names of failures) for (const name of new Set(names)) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}

const RED = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ERROR"]);

/** Which checks failed on each of the newest `limit` red commits, ten commits to a query. */
function readRedChecks(owner, name, line, limit = 50) {
  const red = line.filter((commit) => commit.state === "FAILURE" || commit.state === "ERROR").slice(0, limit);
  const failures = [];
  for (let start = 0; start < red.length; start += 10) {
    const batch = red.slice(start, start + 10);
    const fields = batch.map((commit, index) => `c${index}: object(oid: "${commit.oid}") { ... on Commit { statusCheckRollup { contexts(first: 100) {
      nodes { ... on CheckRun { name conclusion } ... on StatusContext { context state } } } } } }`).join("\n");
    const repository = graphql(`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`, { owner, name }).repository;
    for (const index of batch.keys()) {
      const contexts = repository[`c${index}`]?.statusCheckRollup?.contexts.nodes ?? [];
      failures.push(contexts.filter((check) => RED.has(check.conclusion ?? check.state)).map((check) => check.name ?? check.context));
    }
  }
  return { failures, read: red.length };
}

function main(argv) {
  const repo = argv.find((arg) => /^[\w.-]+\/[\w.-]+$/.test(arg));
  const option = (flag, fallback) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : fallback);
  if (!repo) {
    console.error("usage: node tools/pr-clock/loop.mjs owner/repo [--days 7] [--env <environment>] [--json]");
    return 2;
  }
  const days = Number(option("--days", "7"));
  const since = new Date(Date.now() - days * DAY_MS).toISOString();
  const [owner, name] = repo.split("/");
  const pulls = readPulls(repo, since);
  const deployments = readDeployments(owner, name, since);
  const commits = readCommits(owner, name, since);
  const hasDeployments = deployments.nodes.some((deployment) => deployment.createdAt >= since && deployment.liveAt);
  const numbers = summarize({ pulls: liveTimes(pulls.nodes, deployments.nodes, commits.line, option("--env", null)), commits: commits.line, hasDeployments, windowMinutes: days * 24 * 60 });
  if (pulls.capped || commits.capped || deployments.capped) numbers.capped = true;
  const redChecks = readRedChecks(owner, name, commits.line);
  numbers.topRedChecks = topRedChecks(redChecks.failures);
  numbers.redChecksRead = redChecks.read;
  console.log(argv.includes("--json") ? JSON.stringify({ repo, days, ...numbers }, null, 2) : render(repo, days, numbers));
  if (numbers.capped) console.error(`loop: read the first ${MAX_PAGES * 100} only; use fewer --days for the whole window`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
