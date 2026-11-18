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
// and pending while any run is still going. An episode runs from the first red commit's failure to the push of
// the next green commit (all its runs passed); it is open until then and counts up to now. The time from that
// push to its last run finishing is reported apart as waiting for runners (unverified), never as red.
//
// Route: owners.json maps each repo to the coordinator session that owns its flow, CI and gates. A red main wakes
// that owner with the failing run link; the tooling coordinator hears about it only for repos it owns, or as an
// escalation once a red main has lasted past ESCALATE_MIN.
//
// Infrastructure: a failed job that emits `::error title=infra::<reason>` (README.md), or a run whose only failures
// are GitHub 5xx or ETIMEDOUT errors in the job log, is infrastructure. It is counted apart from code red, opens no
// episode, wakes nobody and is never auto-reverted.
//
// Needs GH_TOKEN (or `gh auth login`). Repos the token cannot read are reported as unreadable, never as green.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const ESCALATE_MIN = 60;
export const OWNERS = JSON.parse(readFileSync(new URL("./owners.json", import.meta.url), "utf8"));

const FAILED = new Set(["failure", "timed_out", "startup_failure", "action_required"]);
const PASSED = new Set(["success", "skipped", "neutral"]);

const ms = (t) => new Date(t).getTime();
const mins = (a, b) => Math.max(0, (b - a) / 60000);

// A cancelled run with a newer push of the same workflow was cancelled by concurrency: not a failure at all.
// Any other cancel is the system's (a user's cancel leaves no trace in the API) and counts as infra.
const superseded = (r, runs) => runs.some((o) => o.name === r.name && o.event === "push" && o.head_sha !== r.head_sha && ms(o.created_at) > ms(r.created_at));
const infraOf = (r) => r.infra ?? (r.conclusion === "cancelled" ? "run cancelled by the system" : undefined);

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
    const live = rs.filter((r) => (r.conclusion !== "cancelled" || !superseded(r, runs)) && r.conclusion !== "stale");
    const failedAll = live.filter((r) => FAILED.has(r.conclusion) || r.conclusion === "cancelled");
    const failed = failedAll.filter((r) => !infraOf(r));
    const start = Math.min(...rs.map((r) => ms(r.run_started_at ?? r.created_at)));
    if (failed.length) {
      const first = failed.reduce((a, b) => (ms(a.updated_at) <= ms(b.updated_at) ? a : b));
      out.push({ sha, start, state: "red", at: ms(first.updated_at), url: first.html_url, name: first.name, runId: first.id, attempt: first.run_attempt ?? 1, conclusion: first.conclusion });
    } else if (live.some((r) => r.status !== "completed")) {
      out.push({ sha, start, state: "pending", at: start });
    } else if (failedAll.length) {
      const first = failedAll[0];
      out.push({ sha, start, state: "infra", at: ms(first.updated_at), url: first.html_url, name: first.name, reason: infraOf(first) });
    } else if (live.length && live.every((r) => PASSED.has(r.conclusion))) {
      out.push({ sha, start, state: "green", at: Math.max(...live.map((r) => ms(r.updated_at))) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// Infrastructure-only failures in the window: { sha, at, url, name, reason }. They never count as red.
export function infraFailures(runs, { since, now }) {
  return commitVerdicts(runs).filter((c) => c.state === "infra" && c.at >= since && c.at <= now).map(({ sha, at, url, name, reason }) => ({ sha, at, url, name, reason }));
}

// Episodes of red: { from, to (null while open), verifiedAt, url, name }. A red commit later fixed by a head whose
// runs all finished green closes it at that head's push time (its first run's start, never before the red began);
// verifiedAt is when its last run finished. A fix commit that then fails does not close it; pending and no-run commits neither open nor close one.
export function episodes(commits) {
  const eps = [];
  let open = null;
  for (const c of commits) {
    if (c.state === "red" && !open) open = { from: c.at, to: null, url: c.url, name: c.name, sha: c.sha, runId: c.runId, attempt: c.attempt, conclusion: c.conclusion };
    else if (c.state === "green" && open) {
      // Fixed when pushed; the time until its runs finished is waiting/unverified, not red.
      const to = Math.max(c.start, open.from);
      eps.push({ ...open, to, verifiedAt: Math.max(c.at, to) });
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
  let waitMinutes = 0;
  const closed = [];
  let open = null;
  for (const [i, e] of eps.entries()) {
    if (e.to !== null) {
      // A wait never overlaps the next red stretch, so the two columns never count a minute twice.
      const end = Math.min(e.verifiedAt, eps[i + 1]?.from ?? Infinity, now);
      if (end > Math.max(e.to, since)) waitMinutes += mins(Math.max(e.to, since), end);
    }
    const to = e.to ?? now;
    if (to < since || e.from > now) continue;
    redMinutes += mins(Math.max(e.from, since), Math.min(to, now));
    if (e.to === null) open = e;
    else closed.push(mins(e.from, e.to));
  }
  const mid = median(closed);
  const infra = infraFailures(runs, { since, now });
  return {
    infra: infra.length,
    infraRuns: infra,
    redMinutes: Math.round(redMinutes),
    waitMinutes: Math.round(waitMinutes),
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
  const head = "| repo | red minutes | % red | waiting for runners | % wait | episodes | median to green | red now | infra |\n|---|---|---|---|---|---|---|---|---|";
  const lines = rows.map(({ repo, m, error }) => {
    if (error) return `| ${repo} | unreadable | | | | | | ${error} | |`;
    const pct = m.windowMinutes ? ((100 * m.redMinutes) / m.windowMinutes).toFixed(1) : "0.0";
    const wpct = m.windowMinutes ? ((100 * (m.waitMinutes ?? 0)) / m.windowMinutes).toFixed(1) : "0.0";
    const now = m.open ? `${fmtMin(m.open.minutes)} (${m.open.name ?? "check"}) ${m.open.url ?? ""}`.trim() : "-";
    return `| ${repo} | ${fmtMin(m.redMinutes)} | ${pct}% | ${fmtMin(m.waitMinutes ?? 0)} | ${wpct}% | ${m.episodes} | ${fmtMin(m.medianToGreen)} | ${now} | ${m.infra ?? 0} |`;
  });
  return [head, ...lines].join("\n");
}

function token() {
  return process.env.GH_TOKEN ?? execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
}

// A GET that counts what it spends (`calls.total` against the hourly allowance; a 304 answer is free, `calls.notModified`) and,
// for run-list pages, sends If-None-Match from `cache.etags` (url -> { etag, body }) so an unchanged page costs nothing.
export function makeGet(cache = null, cap = Number(process.env.RED_MAIN_MAX_CALLS) || 1000) {
  const calls = { total: 0, notModified: 0 };
  const seen = new Set();
  async function get(path) {
    const tagged = cache && /\/actions\/runs\?/.test(path) ? ((cache.etags ??= {}), cache.etags[path]) : null;
    const headers = { authorization: `Bearer ${token()}`, accept: "application/vnd.github+json" };
    if (tagged) headers["if-none-match"] = tagged.etag;
    if (calls.total >= cap) throw new Error(`stopped at ${cap} API calls (RED_MAIN_MAX_CALLS) to protect the shared hourly allowance; run again later (the cache keeps what was read) or raise the cap`);
    calls.total++;
    const res = await fetch(`https://api.github.com${path}`, { headers });
    if (res.status === 304 && tagged) {
      calls.notModified++;
      seen.add(path);
      return tagged.body;
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (cache && /\/actions\/runs\?/.test(path) && res.headers.get("etag")) {
      // Only today's pages are worth keeping; completed days come from the day cache.
      cache.etags[path] = { etag: res.headers.get("etag"), body: { total_count: body.total_count, workflow_runs: body.workflow_runs.map(slimRun) } };
      seen.add(path);
    }
    return body;
  }
  get.calls = calls;
  get.prune = () => cache?.etags && Object.keys(cache.etags).forEach((k) => seen.has(k) || delete cache.etags[k]);
  return get;
}
const ghGet = makeGet();

// The fields measure, commitVerdicts and markInfra read.
const slimRun = (r) => ({ id: r.id, name: r.name, event: r.event, head_sha: r.head_sha, status: r.status, conclusion: r.conclusion, created_at: r.created_at, run_started_at: r.run_started_at, updated_at: r.updated_at, html_url: r.html_url, run_attempt: r.run_attempt });

const iso = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");

// The API returns at most 1000 runs per query, so read the window in `created` ranges and halve any range that
// reports more than 1000 until each fits.
export async function fetchRange(repo, from, to, get = ghGet) {
  const runs = new Map();
  const range = async (from, to) => {
    const q = `/repos/${repo}/actions/runs?branch=main&event=push&created=${encodeURIComponent(`${iso(from)}..${iso(to)}`)}&per_page=100`;
    const first = await get(`${q}&page=1`);
    if (first.total_count > 1000 && to - from >= 2000) {
      const mid = Math.floor((from + to) / 2000) * 1000;
      await range(from, mid);
      await range(mid + 1000, to);
      return;
    }
    let body = first;
    for (let page = 1; page <= 10; page++) {
      if (page > 1) body = await get(`${q}&page=${page}`);
      for (const r of body.workflow_runs) runs.set(r.id ?? `${r.head_sha}/${r.name}/${r.run_attempt}`, r);
      if (body.workflow_runs.length < 100) break;
    }
  };
  await range(from, to);
  return [...runs.values()];
}

const DAY = 86400000;
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

// The window's runs, read a UTC day at a time. A day that ended before `now` and whose runs had all finished is kept in
// `cache.days[repo]` and never read again; only uncached days and today are fetched (today through ETag'd pages).
export async function fetchMainRuns(repo, since, get = ghGet, now = Date.now(), cache = null) {
  if (!cache) return fetchRange(repo, since, now, get);
  const days = ((cache.days ??= {})[repo] ??= {});
  const runs = [];
  for (let start = Math.floor(since / DAY) * DAY; start <= now; start += DAY) {
    const key = dayKey(start);
    if (days[key]) {
      runs.push(...days[key]);
      continue;
    }
    // The range ends at the day's end even for today, so its URL (and ETag) is the same on every run.
    const got = await fetchRange(repo, start, start + DAY - 1000, get);
    runs.push(...got);
    if (start + DAY <= now && got.every((r) => r.status === "completed")) days[key] = got.map(slimRun);
  }
  for (const key of Object.keys(days)) if (key < dayKey(since)) delete days[key];
  return runs;
}

// A failed job's annotation titled "infra" says the job failed for infrastructure, not code.
// Text a lost or killed runner leaves in a job's log or annotations.
export const RUNNER_LOST = /runner has received a shutdown signal|lost communication with the server|hosted runner .* lost|job was not acquired by runner|the operation was canceled/i;
const INFRA_LOG = /\b50[0234] (Bad Gateway|Service Unavailable|Gateway Time-?out)\b|(GET|POST|PUT|PATCH|DELETE) \S+: 50[0234]\b|HTTP 50[0234]\b|ETIMEDOUT/i;
const infraText = (t) => String(t).slice(-200000).match(INFRA_LOG) ?? String(t).slice(-200000).match(RUNNER_LOST);

// A job that never got a runner or ran no step.
export const neverStarted = (j) => (Array.isArray(j.steps) && j.steps.length === 0) || j.runner_id === 0 || j.runner_id === null;

// Marks each failed run `infra` (the reason) when every failed job is an annotated or GitHub 5xx/ETIMEDOUT failure.
// A failure on a commit that comes while a red stretch is already open cannot change the measure (it neither opens nor
// closes one), so it is left unread: a long red costs the reads of its first commit, not of every commit in it.
export async function markInfra(repo, runs, get = ghGet, memo = null) {
  const bySha = new Map();
  for (const r of runs.filter((r) => r.event === "push")) bySha.set(r.head_sha, [...(bySha.get(r.head_sha) ?? []), r]);
  const commits = [...bySha.values()].sort((a, b) => Math.min(...a.map((r) => ms(r.run_started_at ?? r.created_at))) - Math.min(...b.map((r) => ms(r.run_started_at ?? r.created_at))));
  let open = false;
  for (const rs of commits) {
    const live = rs.filter((r) => (r.conclusion !== "cancelled" || !superseded(r, runs)) && r.conclusion !== "stale");
    const failed = live.filter((r) => FAILED.has(r.conclusion));
    if (failed.length) {
      if (open) continue;
      await classify(failed);
      open = failed.some((r) => !r.infra);
    } else if (live.length && live.every((r) => r.status === "completed" && PASSED.has(r.conclusion))) open = false;
  }
  return runs;

  async function classify(list) {
    await Promise.all(
    list
      .map(async (r) => {
        const known = memo?.[r.id];
        if (known !== undefined) {
          if (known) r.infra = known;
          return;
        }
        try {
          await (async () => {
          if (r.conclusion === "startup_failure") {
            r.infra = "startup_failure";
            return;
          }
          const { jobs } = await get(`/repos/${repo}/actions/runs/${r.id}/jobs?filter=latest&per_page=100`);
          const failed = jobs.filter((j) => j.conclusion === "failure" || j.conclusion === "startup_failure");
          if (!failed.length) return;
          const reasons = [];
          for (const j of failed) {
            if (neverStarted(j)) {
              reasons.push("job never started (no runner assigned)");
              continue;
            }
            const notes = await get(`/repos/${repo}/check-runs/${j.id}/annotations?per_page=100`);
            const list = Array.isArray(notes) ? notes : [];
            const tagged = list.find((n) => String(n.title ?? "").trim().toLowerCase() === "infra");
            if (tagged) {
              reasons.push(tagged.message || "infra");
              continue;
            }
            const lost = list.map((n) => infraText(n.message ?? "")).find(Boolean);
            if (lost) {
              reasons.push(lost[0]);
              continue;
            }
            const hit = infraText(await get(`/repos/${repo}/actions/jobs/${j.id}/logs`).catch(() => ""));
            if (!hit) return;
            reasons.push(hit[0]);
          }
          r.infra = reasons[0];
          })();
          if (memo && r.status === "completed") memo[r.id] = r.infra ?? "";
        } catch {
          // Unreadable annotations or logs leave the run counted as red.
        }
      }),
    );
  }
}

export const defaultCache = () => process.env.RED_MAIN_CACHE ?? join(homedir(), ".cache", "red-main.json");

export async function main(argv = process.argv.slice(2), now = Date.now()) {
  const days = Number(argv[argv.indexOf("--days") + 1]) || 7;
  const since = now - days * 86400000;
  const file = argv.includes("--no-cache") ? null : argv.includes("--cache") ? argv[argv.indexOf("--cache") + 1] : defaultCache();
  let cache = null;
  if (file) {
    try {
      cache = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      cache = {};
    }
  }
  const get = makeGet(cache);
  const rows = await Promise.all(
    Object.keys(OWNERS.repos).map(async (repo) => {
      try {
        const memo = cache ? ((cache.infra ??= {})[repo] ??= {}) : null;
        return { repo, m: measure(await markInfra(repo, await fetchMainRuns(repo, since, get, now, cache), get, memo), { since, now }) };
      } catch (err) {
        return { repo, error: err.message };
      }
    }),
  );
  if (cache) {
    get.prune();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(cache));
  }
  console.error(`red-main: ${get.calls.total} API calls (${get.calls.notModified} answered 304, free)${file ? `, cache ${file}` : ", no cache"}`);
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
