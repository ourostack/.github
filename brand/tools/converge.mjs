#!/usr/bin/env node
// Post-merge convergence. A pull request's audit leaves website and social-preview byte lag as "after-merge", because only
// the merge starts their sync (brand/tools/pending.mjs). This runs the live audit on main and keeps one issue honest:
// a surface that is stale (past its pending window, or stale for any other reason) opens "Brand surfaces have not converged",
// or comments on it when the set of stale surfaces changed; a green audit closes it. The brand-audit workflow's
// converge job runs it on every push to main and every 30 minutes. The audit job itself stays read-only.
//
//   GH_TOKEN=... node brand/tools/converge.mjs [--dry-run]

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TITLE = "Brand surfaces have not converged";
export const LABEL = "brand-convergence";
const MARK = /<!-- brand-converge: ([0-9a-f]{12}) -->/g;

export const keyOf = (staleIds) => createHash("sha256").update([...new Set(staleIds)].sort().join("\n")).digest("hex").slice(0, 12);

// staleIds: ids the live audit calls stale or unregistered. issue: the open issue, or null; lastKey: the key in its
// newest comment (or its body). One comment per distinct set of stale surfaces, so a lingering set stays quiet.
export function decide({ staleIds, issue, lastKey }) {
  if (!staleIds.length) return issue ? { action: "close" } : { action: "none" };
  const key = keyOf(staleIds);
  if (!issue) return { action: "open", key };
  return lastKey === key ? { action: "none" } : { action: "comment", key };
}

export function render(items, key) {
  const lines = items.map((i) => `- \`${i.id}\`: ${i.problems?.[0] ?? "stale"}${i.problems?.length > 1 ? ` (+${i.problems.length - 1} more)` : ""}`);
  return `These surfaces are still stale on main, past the time their automatic sync is allowed (the audit run: ${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY ?? "ourostack/.github"}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}).\n\n${lines.join("\n")}\n\nRun \`node brand/tools/audit.mjs --format text\` for each fix. This issue closes itself when the audit is green.\n\n<!-- brand-converge: ${key} -->`;
}

async function gh(path, { method = "GET", body, token } = {}) {
  const res = await fetch(`https://api.github.com${path}`, { method, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

const lastMarker = (text) => [...(text ?? "").matchAll(MARK)].map((m) => m[1]).pop();

async function main() {
  const token = process.env.GH_TOKEN;
  const dry = process.argv.includes("--dry-run");
  const repo = process.env.GITHUB_REPOSITORY ?? "ourostack/.github";
  if (!token) {
    console.error("Set GH_TOKEN.");
    process.exit(3);
  }
  const audit = join(dirname(fileURLToPath(import.meta.url)), "audit.mjs");
  const ran = spawnSync("node", [audit, "--format", "json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, BRAND_REF: "" } });
  let report;
  try {
    report = JSON.parse(ran.stdout);
  } catch {
    console.error(`audit gave no report (exit ${ran.status}): ${ran.stderr.slice(0, 300)}`);
    process.exit(3);
  }
  // A surface that could not be checked says nothing about convergence: change nothing.
  if (report.summary.unchecked) {
    console.error("some surfaces could not be checked; leaving the issue as it is");
    return;
  }
  const items = report.items.filter((i) => i.status === "stale" || i.status === "unregistered");
  const found = await gh(`/repos/${repo}/issues?labels=${LABEL}&state=open&per_page=10`, { token });
  const issue = found.find((i) => !i.pull_request) ?? null;
  let lastKey;
  if (issue) {
    const comments = await gh(`/repos/${repo}/issues/${issue.number}/comments?per_page=100`, { token });
    lastKey = lastMarker(comments.map((c) => c.body).join("\n")) ?? lastMarker(issue.body);
  }
  const d = decide({ staleIds: items.map((i) => i.id), issue, lastKey });
  console.error(`${items.length} stale surfaces: ${d.action}`);
  if (dry || d.action === "none") return;
  if (d.action === "open") {
    // GitHub silently drops a label that does not exist yet, so make sure it does.
    await gh(`/repos/${repo}/labels`, { method: "POST", token, body: { name: LABEL, color: "d93f0b", description: "A brand surface did not converge after a merge" } }).catch(() => {});
    const made = await gh(`/repos/${repo}/issues`, { method: "POST", token, body: { title: TITLE, body: render(items, d.key), labels: [LABEL] } });
    console.error(made.html_url);
  } else if (d.action === "comment") {
    await gh(`/repos/${repo}/issues/${issue.number}/comments`, { method: "POST", token, body: { body: render(items, d.key) } });
  } else {
    await gh(`/repos/${repo}/issues/${issue.number}/comments`, { method: "POST", token, body: { body: "The brand audit is green: every surface carries the brand. Closing." } });
    await gh(`/repos/${repo}/issues/${issue.number}`, { method: "PATCH", token, body: { state: "closed", state_reason: "completed" } });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
