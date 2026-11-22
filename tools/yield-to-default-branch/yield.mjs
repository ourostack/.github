#!/usr/bin/env node
// Pull-request fan-out yields to the default branch: waits while a default-branch run (push to the default branch,
// merge_group, release) in a busy repository has a job queued without a runner. It may delay, never skip or fail:
// any API error, 403 or 429 proceeds at once, and the cap proceeds too.
// Usage: GH_TOKEN=... GITHUB_REPOSITORY=owner/name [YIELD_REPOS="a,b"] [YIELD_CAP_MINUTES=20] node yield.mjs
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export const DEFAULT_REPOS = ["ouroboros", "ouro-ui", "desk", ".github", "ouroboros-website"];
const MIN_QUEUED_AGE_MS = 30_000;

export function repoList(own, owner, names) {
  const full = names.map((n) => (n.includes("/") ? n : `${owner}/${n}`));
  return [...new Set([own, ...full])];
}

// Returns the jobs that make a pull request wait, [] when it may go. Throws on any API failure; the caller treats
// a throw as "go".
export function waitingOn({ repos, call, now = Date.now() }) {
  const found = [];
  for (const repo of repos) {
    const def = call(`repos/${repo}`).default_branch;
    const runs = [
      ...(call(`repos/${repo}/actions/runs?status=queued&per_page=100`).workflow_runs ?? []),
      ...(call(`repos/${repo}/actions/runs?status=in_progress&per_page=100`).workflow_runs ?? []),
    ].filter((r) => r.event === "merge_group" || r.event === "release" || (r.event === "push" && r.head_branch === def));
    for (const r of runs) {
      const jobs = call(`repos/${repo}/actions/runs/${r.id}/jobs?filter=latest&per_page=100`).jobs ?? [];
      for (const j of jobs) {
        if (j.status === "queued" && now - Date.parse(j.created_at) >= MIN_QUEUED_AGE_MS) {
          found.push({ repo, run: r.id, job: j.name, event: r.event, since: j.created_at });
        }
      }
    }
  }
  return found;
}

export async function run({
  repo,
  repos = DEFAULT_REPOS,
  capMs = 20 * 60_000,
  pollMs = 60_000,
  call,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  clock = Date.now,
  log = console.log,
}) {
  const list = repoList(repo, repo.split("/")[0], repos);
  const start = clock();
  let polls = 0;
  for (;;) {
    let found;
    try {
      found = waitingOn({ repos: list, call, now: clock() });
    } catch (err) {
      log(`Go: the API said "${String(err.message).split("\n")[0]}", so nothing waits.`);
      return { outcome: "api-error", waitedMs: clock() - start, polls };
    }
    const waited = clock() - start;
    if (found.length === 0) {
      log(polls === 0 ? "Go: no default-branch job is waiting for a runner." : `Go: the default branch's queue cleared after ${Math.round(waited / 1000)}s.`);
      return { outcome: "clear", waitedMs: waited, polls };
    }
    const top = found.slice(0, 5).map((f) => `${f.repo} run ${f.run} "${f.job}" (${f.event}, queued since ${f.since})`);
    log(`Waiting ${Math.round(waited / 1000)}s: ${found.length} default-branch job(s) have no runner yet: ${top.join("; ")}`);
    if (waited + pollMs > capMs) {
      log(`Go: the ${Math.round(capMs / 60000)} minute cap is reached, so the pull request proceeds.`);
      return { outcome: "cap", waitedMs: waited, polls };
    }
    polls++;
    await sleep(pollMs);
  }
}

function gh(path) {
  try {
    return JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
  } catch (err) {
    throw new Error(String(err.stderr ?? err.message).trim() || "gh api failed");
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY is not set");
  const repos = (process.env.YIELD_REPOS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const lines = [];
  const log = (m) => (console.log(m), lines.push(m));
  const result = await run({
    repo,
    repos: repos.length ? repos : DEFAULT_REPOS,
    capMs: Number(process.env.YIELD_CAP_MINUTES || 20) * 60_000,
    call: gh,
    log,
  });
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Yield to the default branch: ${result.outcome}\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`);
  }
}
