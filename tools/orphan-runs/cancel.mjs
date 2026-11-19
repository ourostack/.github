#!/usr/bin/env node
// Cancels this repository's merge_group runs whose group commit is no longer a merge-queue entry. A reformed queue
// leaves the old groups' runs going, and they hold runners (macOS ones above all) that the live groups wait for.
// It runs with the repository's own GITHUB_TOKEN (actions: write), so no personal token is involved.
// Usage: GH_TOKEN=... GITHUB_REPOSITORY=owner/name node cancel.mjs [--dry-run]
import { execFileSync } from "node:child_process";

const QUERY = `query($o:String!,$n:String!){repository(owner:$o,name:$n){mergeQueue{entries(first:100){nodes{headCommit{oid}}}}}}`;

// A run is live while some queue entry's group commit is its head. A queue with no entries proves nothing about
// groups being gone, so it leaves every run alone.
export function orphanRuns(runs, liveShas) {
  const live = new Set(liveShas.filter(Boolean));
  if (live.size === 0) return [];
  return runs.filter((r) => r.head_branch?.startsWith("gh-readonly-queue/") && !live.has(r.head_sha));
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

export function run({ repo, dryRun = false, call = gh, log = console.log }) {
  const [owner, name] = repo.split("/");
  const q = JSON.parse(call(["api", "graphql", "-f", `query=${QUERY}`, "-f", `o=${owner}`, "-f", `n=${name}`]));
  const nodes = q.data?.repository?.mergeQueue?.entries?.nodes ?? [];
  const live = nodes.map((n) => n.headCommit?.oid);
  const runs = ["queued", "in_progress"].flatMap(
    (s) => JSON.parse(call(["api", `repos/${repo}/actions/runs?event=merge_group&status=${s}&per_page=100`])).workflow_runs ?? [],
  );
  let cancelled = 0;
  let failed = 0;
  for (const r of orphanRuns(runs, live)) {
    const what = `${repo} run ${r.id} (${r.name}) for ${r.head_branch}`;
    if (dryRun) {
      log(`would cancel ${what}: its merge group is gone`);
      continue;
    }
    try {
      call(["api", "-X", "POST", `repos/${repo}/actions/runs/${r.id}/cancel`]);
      cancelled++;
      log(`cancelled ${what}: its merge group is gone`);
    } catch (err) {
      failed++;
      log(`::error title=cancel failed::${what}: ${String(err.stderr ?? err.message).trim().split("\n")[0]}`);
    }
  }
  log(`${cancelled} orphaned merge-group run${cancelled === 1 ? "" : "s"} cancelled.`);
  return { cancelled, failed };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY is not set");
  if (run({ repo, dryRun: process.argv.includes("--dry-run") }).failed > 0) process.exitCode = 1;
}
