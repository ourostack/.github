#!/usr/bin/env node
// Re-runs the failed jobs, once, of every ourostack default-branch push run that failed on its first attempt.
//
// Why: a lockfile-only update (an Ouro UI release pin) cannot break code, yet main went red after one because a
// timing test or a browser test flaked in a main-only run. A real break fails the same job again on attempt 2 and
// stays red (and visible to tools/red-main); a flake passes and main is green within minutes instead of waiting for
// the next push. Attempt 1 only: a second failure is never re-run here.
//
//   node tools/rerun-main-flakes/rerun-main-flakes.mjs             # re-run what qualifies
//   node tools/rerun-main-flakes/rerun-main-flakes.mjs --dry-run   # only say what it would do
//
// Needs GH_TOKEN with actions:write on the repositories.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const ORG = process.env.RERUN_ORG ?? "ourostack";
export const MAX_AGE_MS = 90 * 60 * 1000;
// A run is a candidate only on its first attempt, from a push to the default branch, and failed (a cancelled run is
// somebody's decision, and a timed-out one is left to its owner).
export function qualifies(run, defaultBranch, now = Date.now()) {
  return (
    run.event === "push" &&
    run.head_branch === defaultBranch &&
    run.conclusion === "failure" &&
    run.run_attempt === 1 &&
    now - Date.parse(run.updated_at) <= MAX_AGE_MS
  );
}

let transport = null;
export function setTransport(fn) {
  transport = fn;
}

function api(path, method = "GET") {
  if (transport) return transport(path, method);
  const out = execFileSync("gh", ["api", "-X", method, path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : {};
}

export function run({ dryRun = false, log = console.log, now = Date.now() } = {}) {
  const done = [];
  const repos = api(`orgs/${ORG}/repos?per_page=100&type=all`).filter((r) => !r.archived && !r.fork);
  for (const repo of repos) {
    let runs;
    try {
      runs = api(`repos/${repo.full_name}/actions/runs?branch=${encodeURIComponent(repo.default_branch)}&event=push&status=failure&per_page=20`).workflow_runs ?? [];
    } catch (err) {
      log(`skipped ${repo.full_name}: ${String(err.stderr ?? err.message).trim().split("\n")[0]}`);
      continue;
    }
    // Only the newest failed run per workflow: an older one was superseded by a later push.
    const newest = new Map();
    for (const r of runs) if (!newest.has(r.workflow_id)) newest.set(r.workflow_id, r);
    for (const r of newest.values()) {
      if (!qualifies(r, repo.default_branch, now)) continue;
      if (dryRun) {
        log(`would re-run failed jobs of ${repo.full_name} ${r.name} ${r.id}`);
      } else {
        try {
          api(`repos/${repo.full_name}/actions/runs/${r.id}/rerun-failed-jobs`, "POST");
          log(`re-ran failed jobs of ${repo.full_name} ${r.name} ${r.id} (${r.head_sha.slice(0, 8)})`);
        } catch (err) {
          log(`could not re-run ${repo.full_name} ${r.id}: ${String(err.stderr ?? err.message).trim().split("\n")[0]}`);
          continue;
        }
      }
      done.push(`${repo.full_name}#${r.id}`);
    }
  }
  return done;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const done = run({ dryRun: process.argv.includes("--dry-run") });
  console.log(`${done.length} run(s) ${process.argv.includes("--dry-run") ? "would be " : ""}re-run`);
}
