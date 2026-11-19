#!/usr/bin/env node
// The loop clock: how long a repository's changes take from PR opened to live, and how often its default branch is red.
// Step 0 of agents/eng-system.md: measure the loop before changing anything, and again after each step.
//
//   node tools/pr-clock/loop.mjs owner/repo [--days 7] [--env production] [--json]
//
// Needs GH_TOKEN (or a logged-in gh). It reads, with GraphQL only:
// - the PRs merged in the window: opened to merged;
// - the repository's deployments: a PR is live at the first successful deployment created at or after its merge
//   (deployments are assumed to ship the default branch's head, as Pages and most deploy jobs do). --env keeps one
//   environment. A repository with no deployments in the window says so; its loop then ends at merge;
// - the default branch's commits in the window: the share whose checks ended red (the commit's check rollup).
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
 * When each merged PR went live: the first successful deployment created at or after its merge, or null.
 * deployments: [{ createdAt, environment, liveAt }] where liveAt is its first SUCCESS status time (or null).
 */
export function liveTimes(pulls, deployments, environment = null) {
  const live = deployments
    .filter((deployment) => deployment.liveAt && (!environment || deployment.environment === environment))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return pulls.map((pull) => {
    const deployment = live.find((candidate) => Date.parse(candidate.createdAt) >= Date.parse(pull.mergedAt));
    return { ...pull, liveAt: deployment?.liveAt ?? null };
  });
}

/** The numbers for a window: medians and p90s in minutes, and the default branch's red share. */
export function summarize({ pulls, commits, hasDeployments }) {
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
  };
}

const fmt = (value) => (value === null ? "–" : value < 120 ? `${Math.round(value)} min` : `${(value / 60).toFixed(1)} h`);
const row = (label, stat) => `| ${label} | ${stat ? fmt(stat.median) : "no deployments"} | ${stat ? fmt(stat.p90) : "–"} | ${stat ? stat.n : "–"} |`;

/** The Markdown report. */
export function render(repo, days, numbers) {
  const share = numbers.mainRedShare === null ? "–" : `${Math.round(numbers.mainRedShare * 100)}% (${numbers.mainRed} of ${numbers.mainSettled} settled commits)`;
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
    pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { number createdAt mergedAt } } } }`;
  return pages((after) => {
    const { search } = graphql(query, { q: `repo:${repo} is:pr is:merged merged:>=${since.slice(0, 10)}`, ...cursor(after) });
    return { items: search.nodes.filter((pull) => pull.mergedAt && pull.mergedAt >= since), pageInfo: search.pageInfo };
  });
}

function readDeployments(owner, name, since) {
  const query = `query($owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) {
    deployments(first: 100, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) { pageInfo { hasNextPage endCursor }
      nodes { createdAt environment statuses(first: 10) { nodes { state createdAt } } } } } }`;
  const nodes = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { deployments } = graphql(query, { owner, name, ...cursor(after) }).repository;
    for (const node of deployments.nodes) {
      const success = node.statuses.nodes.filter((status) => status.state === "SUCCESS").map((status) => status.createdAt).sort()[0];
      nodes.push({ createdAt: node.createdAt, environment: node.environment, liveAt: success ?? null });
    }
    const oldest = deployments.nodes.at(-1)?.createdAt;
    if (!deployments.pageInfo.hasNextPage || (oldest && oldest < since)) break;
    after = deployments.pageInfo.endCursor;
  }
  return nodes;
}

function readCommits(owner, name, since) {
  const query = `query($owner: String!, $name: String!, $since: GitTimestamp!, $after: String) { repository(owner: $owner, name: $name) {
    defaultBranchRef { target { ... on Commit { history(first: 100, since: $since, after: $after) { pageInfo { hasNextPage endCursor }
      nodes { oid statusCheckRollup { state } } } } } } } }`;
  return pages((after) => {
    const { history } = graphql(query, { owner, name, since, ...cursor(after) }).repository.defaultBranchRef.target;
    return { items: history.nodes.map((commit) => ({ oid: commit.oid, state: commit.statusCheckRollup?.state ?? null })), pageInfo: history.pageInfo };
  });
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
  const hasDeployments = deployments.some((deployment) => deployment.createdAt >= since && deployment.liveAt);
  const numbers = summarize({ pulls: liveTimes(pulls.nodes, deployments, option("--env", null)), commits: commits.nodes, hasDeployments });
  if (pulls.capped || commits.capped) numbers.capped = true;
  console.log(argv.includes("--json") ? JSON.stringify({ repo, days, ...numbers }, null, 2) : render(repo, days, numbers));
  if (numbers.capped) console.error(`loop: read the first ${MAX_PAGES * 100} only; use fewer --days for the whole window`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
