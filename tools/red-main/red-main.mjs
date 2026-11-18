#!/usr/bin/env node
// Red main, measured and routed. "Main red for minutes, not days" (Desk Epoch 3, definition of done 1).
//
//   node tools/red-main/red-main.mjs                      # table of red minutes and time to green, last 7 days
//   node tools/red-main/red-main.mjs --days 30 --json
//   node tools/red-main/red-main.mjs --route              # who to wake for each repo that is red right now
//
// Measure: per repo, over a window, the minutes main spent red and the median time from a failure to the
// next all-green head, from the Actions run history of push runs on main. A commit is red when any of its
// runs failed (cancelled and skipped runs are not failures), green when all of its runs finished and none failed,
// and pending while any run is still going. An episode runs from the first red commit's failure to the finish of
// the next green commit; it is open until then and counts up to now.
//
// Route: owners.json maps each repo to the coordinator session that owns its flow, CI and gates. A red main wakes
// that owner with the failing run link; the tooling coordinator hears about it only for repos it owns, or as an
// escalation once a red main has lasted past ESCALATE_MIN.
//
// Needs GH_TOKEN (or `gh auth login`). Repos the token cannot read are reported as unreadable, never as green.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const ESCALATE_MIN = 60;
export const OWNERS = JSON.parse(readFileSync(new URL("./owners.json", import.meta.url), "utf8"));

const FAILED = new Set(["failure", "timed_out", "startup_failure", "action_required"]);
const PASSED = new Set(["success", "skipped", "neutral"]);

const ms = (t) => new Date(t).getTime();
const mins = (a, b) => Math.max(0, (b - a) / 60000);

// runs: workflow runs of push events on main. Returns commits oldest first:
// { sha, state: "red" | "green" | "pending", at (ms when the verdict was known), url (a failing run) }.
export function commitVerdicts(runs) {
  const bySha = new Map();
  for (const r of runs) {
    if (r.event !== "push") continue;
    if (!bySha.has(r.head_sha)) bySha.set(r.head_sha, []);
    bySha.get(r.head_sha).push(r);
  }
  const out = [];
  for (const [sha, rs] of bySha) {
    const live = rs.filter((r) => r.conclusion !== "cancelled" && r.conclusion !== "stale");
    const failed = live.filter((r) => FAILED.has(r.conclusion));
    const start = Math.min(...rs.map((r) => ms(r.run_started_at ?? r.created_at)));
    if (failed.length) {
      const first = failed.reduce((a, b) => (ms(a.updated_at) <= ms(b.updated_at) ? a : b));
      out.push({ sha, start, state: "red", at: ms(first.updated_at), url: first.html_url, name: first.name, runId: first.id, attempt: first.run_attempt ?? 1, conclusion: first.conclusion });
    } else if (live.some((r) => r.status !== "completed")) {
      out.push({ sha, start, state: "pending", at: start });
    } else if (live.length && live.every((r) => PASSED.has(r.conclusion))) {
      out.push({ sha, start, state: "green", at: Math.max(...live.map((r) => ms(r.updated_at))) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// Episodes of red: { from, to (null while open), url, name }. A red commit later fixed by a head that is green
// closes it; pending and no-run commits neither open nor close one.
export function episodes(commits) {
  const eps = [];
  let open = null;
  for (const c of commits) {
    if (c.state === "red" && !open) open = { from: c.at, to: null, url: c.url, name: c.name, sha: c.sha, runId: c.runId, attempt: c.attempt, conclusion: c.conclusion };
    else if (c.state === "green" && open) {
      eps.push({ ...open, to: Math.max(c.at, open.from) });
      open = null;
    }
  }
  if (open) eps.push(open);
  return eps;
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Red minutes inside [since, now], the median minutes to green of the episodes that closed in it, and the open one.
export function measure(runs, { since, now }) {
  const eps = episodes(commitVerdicts(runs));
  let redMinutes = 0;
  const closed = [];
  let open = null;
  for (const e of eps) {
    const to = e.to ?? now;
    if (to < since || e.from > now) continue;
    redMinutes += mins(Math.max(e.from, since), Math.min(to, now));
    if (e.to === null) open = e;
    else closed.push(mins(e.from, e.to));
  }
  const mid = median(closed);
  return {
    redMinutes: Math.round(redMinutes),
    windowMinutes: Math.round(mins(since, now)),
    episodes: closed.length + (open ? 1 : 0),
    medianToGreen: mid === null ? null : Math.round(mid),
    open: open && { since: open.from, minutes: Math.round(mins(open.from, now)), url: open.url, name: open.name },
  };
}

// openReds: { repo -> { since, url, name } } for repos red now. Returns who to wake, owners first.
export function route(openReds, { now, owners = OWNERS, escalateMin = ESCALATE_MIN } = {}) {
  const wakes = [];
  for (const [repo, red] of Object.entries(openReds)) {
    const owner = owners.repos[repo] ?? owners.fallback;
    const minutes = Math.round(mins(red.since, now));
    const link = red.url ? ` ${red.url}` : "";
    wakes.push({ repo, session: owner.session, who: owner.name, reason: "owner", minutes, message: `main is red in ${repo} (${red.name ?? "a check"}, ${minutes}m).${link}` });
    const tooling = owners.tooling;
    if (owner.session !== tooling.session && minutes >= escalateMin) {
      wakes.push({ repo, session: tooling.session, who: tooling.name, reason: "escalation", minutes, message: `main has been red in ${repo} for ${minutes}m (past ${escalateMin}m); owner ${owner.name} has not cleared it.${link}` });
    }
  }
  return wakes;
}

export function fmtMin(m) {
  if (m === null || m === undefined) return "-";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

export function table(rows) {
  const head = "| repo | red minutes | % red | episodes | median to green | red now |\n|---|---|---|---|---|---|";
  const lines = rows.map(({ repo, m, error }) => {
    if (error) return `| ${repo} | unreadable | | | | ${error} |`;
    const pct = m.windowMinutes ? ((100 * m.redMinutes) / m.windowMinutes).toFixed(1) : "0.0";
    const now = m.open ? `${fmtMin(m.open.minutes)} (${m.open.name ?? "check"}) ${m.open.url ?? ""}`.trim() : "-";
    return `| ${repo} | ${fmtMin(m.redMinutes)} | ${pct}% | ${m.episodes} | ${fmtMin(m.medianToGreen)} | ${now} |`;
  });
  return [head, ...lines].join("\n");
}

function token() {
  return process.env.GH_TOKEN ?? execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
}

async function ghGet(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers: { authorization: `Bearer ${token()}`, accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export async function fetchMainRuns(repo, since, get = ghGet) {
  const runs = [];
  const day = new Date(since).toISOString().slice(0, 10);
  for (let page = 1; page <= 30; page++) {
    const body = await get(`/repos/${repo}/actions/runs?branch=main&event=push&created=%3E%3D${day}&per_page=100&page=${page}`);
    runs.push(...body.workflow_runs);
    if (body.workflow_runs.length < 100) break;
  }
  return runs;
}

export async function main(argv = process.argv.slice(2), now = Date.now()) {
  const days = Number(argv[argv.indexOf("--days") + 1]) || 7;
  const since = now - days * 86400000;
  const rows = await Promise.all(
    Object.keys(OWNERS.repos).map(async (repo) => {
      try {
        return { repo, m: measure(await fetchMainRuns(repo, since), { since, now }) };
      } catch (err) {
        return { repo, error: err.message };
      }
    }),
  );
  if (argv.includes("--route")) {
    const reds = Object.fromEntries(rows.filter((r) => r.m?.open).map((r) => [r.repo, r.m.open]));
    const wakes = route(reds, { now });
    console.log(argv.includes("--json") ? JSON.stringify(wakes, null, 2) : wakes.map((w) => `${w.session} ${w.who}: ${w.message}`).join("\n") || "main is green everywhere readable");
  } else if (argv.includes("--json")) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log(`Main red time, last ${days} days\n\n${table(rows)}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
