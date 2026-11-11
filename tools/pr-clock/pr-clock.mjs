#!/usr/bin/env node
// The PR clock: every open pull request in our orgs that has been open past 30 minutes,
// with what is holding it and who most likely owns it, and every repository whose default
// branch is red at its latest commit (a red main holds every PR behind it). The rule and what to do about each
// blocker: agents/prs-merge-within-30-minutes.md.
//
//   node tools/pr-clock/pr-clock.mjs                 # print the issue body
//   node tools/pr-clock/pr-clock.mjs --json          # print the late PRs as JSON
//   node tools/pr-clock/pr-clock.mjs --update-issue  # write the pinned issue in $GITHUB_REPOSITORY
//
// Needs GH_TOKEN. The workflow's own token reads every public repository; a GitHub App token
// (see .github/workflows/pr-clock.yml) also covers private ones.

import { pathToFileURL } from "node:url";
import { readSeats, seatLine } from "./seat-guard.mjs";

export const LIMIT_MIN = 30;
export const SOON_MIN = 20;
export const OWNERS = (process.env.PR_CLOCK_OWNERS ?? "ourostack spoonjoy arimendelow").split(/\s+/).filter(Boolean);
export const RULE_URL = "https://github.com/ourostack/.github/blob/main/agents/prs-merge-within-30-minutes.md";
export const TITLE = "PRs past 30 minutes";
const LABEL = "pr-clock";
const ARI = "arimendelow";

const RED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);

export function minutesBetween(a, b) {
  return Math.max(0, Math.floor((new Date(b) - new Date(a)) / 60000));
}

export function fmtAge(min) {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ${String(min % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function checks(pr) {
  const nodes = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  return nodes.map((n) =>
    n.__typename === "StatusContext"
      ? { name: n.context, done: n.state !== "PENDING" && n.state !== "EXPECTED", red: RED.has(n.state), queued: false, since: n.createdAt }
      : { name: n.name, done: n.status === "COMPLETED", red: n.status === "COMPLETED" && RED.has(n.conclusion), queued: n.status === "QUEUED" || n.status === "WAITING" || n.status === "PENDING", since: n.startedAt },
  );
}

function namesOf(list, max = 2) {
  const names = [...new Set(list.map((c) => c.name))];
  const shown = names.slice(0, max).map((n) => `\`${n.replace(/`/g, "'")}\``).join(", ");
  return names.length > max ? `${shown} +${names.length - max}` : shown;
}

// What is holding the PR, as { kind, text }. kind drives the icon and the sort.
export function blocker(pr, now) {
  const all = checks(pr);
  const red = all.filter((c) => c.red);
  const pending = all.filter((c) => !c.done);
  const waitingOnAri =
    (pr.reviewRequests?.nodes ?? []).some((r) => r.requestedReviewer?.login === ARI) ||
    (pr.labels?.nodes ?? []).some((l) => /\b(ari|operator|needs[- ]human|hold)\b/i.test(l.name));
  const oldest = (list) => fmtAge(minutesBetween(list.map((c) => c.since).filter(Boolean).sort()[0] ?? now, now));

  const q = pr.mergeQueueEntry;
  if (q) {
    if (q.state === "UNMERGEABLE") return { kind: "red", text: `failing in the merge queue${red.length ? `: ${namesOf(red)}` : ""}` };
    return { kind: "queue", text: `in the merge queue (#${q.position ?? "?"}) for ${fmtAge(minutesBetween(q.enqueuedAt, now))}` };
  }
  if (pr.isDraft) return { kind: "draft", text: "draft: mark ready, or close with a reason" };
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") return { kind: "conflict", text: "conflicts with its base: rebase" };
  if (waitingOnAri) return { kind: "ari", text: "waiting on Ari" };
  const advisory = red.length ? ` (advisory red: ${namesOf(red, 1)})` : "";
  // UNSTABLE: the required checks pass but another is red or still running. Wait for a running one.
  if (pr.mergeStateStatus === "UNSTABLE" && pending.length)
    return { kind: "pending", text: `required checks green; ${namesOf(pending, 1)} still running for ${oldest(pending)}` };
  switch (pr.mergeStateStatus) {
    case "CLEAN":
    case "HAS_HOOKS":
    case "UNSTABLE":
      return {
        kind: "green",
        text: pr.autoMergeRequest ? `green, and auto-merge has not fired: merge it${advisory}` : `green: merge now${advisory}`,
      };
    case "BEHIND":
      return { kind: "behind", text: "behind its base: update the branch" };
  }
  if (red.length) return { kind: "red", text: `red: ${namesOf(red)}` };
  if (pending.length) {
    const queued = pending.filter((c) => c.queued);
    if (queued.length === pending.length) return { kind: "pending", text: `waiting for a runner: ${namesOf(queued, 1)} for ${oldest(queued)}` };
    return { kind: "pending", text: `checks running: ${namesOf(pending, 1)} for ${oldest(pending)}` };
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { kind: "review", text: "changes requested" };
  if (pr.reviewDecision === "REVIEW_REQUIRED") return { kind: "review", text: "waiting for a required review" };
  if (pr.mergeStateStatus === "UNKNOWN" || !pr.mergeStateStatus) return { kind: "pending", text: "checks done; GitHub is still computing mergeability" };
  return { kind: "blocked", text: "blocked by a branch rule: check the PR's merge box" };
}

// Who most likely owns the PR. Agents open PRs as arimendelow, so the author alone says little.
export function owner(pr) {
  const message = pr.commits?.nodes?.[0]?.commit?.message ?? "";
  const task = /^Desk-Task:\s*(\S+)/m.exec(`${pr.body ?? ""}\n${message}`)?.[1];
  if (task) return `desk \`${task}\``;
  const assignees = (pr.assignees?.nodes ?? []).map((a) => a.login).filter((l) => l !== ARI);
  if (assignees.length) return assignees.map((l) => `\`${l}\``).join(", ");
  const author = pr.author?.login ?? "ghost";
  if (author !== ARI) return author.endsWith("[bot]") || /^(dependabot|renovate)/.test(author) ? author.replace(/\[bot\]$/, "") : `\`${author}\``;
  const branch = pr.headRefName ?? "?";
  return `branch \`${branch.length > 36 ? `${branch.slice(0, 35)}…` : branch}\``;
}

const ICON = { red: "🔴", conflict: "🟠", behind: "🟠", pending: "🟡", queue: "🟣", ari: "🙋", green: "🟢", review: "🔵", draft: "⚪", blocked: "⚫" };
const ORDER = ["green", "red", "conflict", "behind", "ari", "review", "blocked", "queue", "pending", "draft"];

// A PR that could merge itself when green but was published without auto-merge is a finding of
// its own. Repositories where GitHub offers no auto-merge (private, free plan) are exempt.
export function autoMergeOff(pr) {
  return !pr.isDraft && !pr.mergeQueueEntry && !pr.autoMergeRequest && pr.repository?.autoMergeAllowed !== false;
}

export function late(prs, now) {
  return prs
    .map((pr) => ({ pr, age: minutesBetween(pr.createdAt, now) }))
    .filter((x) => x.age >= LIMIT_MIN)
    .map((x) => ({ ...x, block: blocker(x.pr, now), owner: owner(x.pr), autoOff: autoMergeOff(x.pr) }))
    .sort((a, b) => ORDER.indexOf(a.block.kind) - ORDER.indexOf(b.block.kind) || b.age - a.age);
}

// Default branches whose latest commit is red. Each `main` is
// { repository: { nameWithOwner, isPrivate }, name, commit: { oid, committedDate, message, statusCheckRollup } }.
export function redMains(mains, now) {
  return mains
    .filter((m) => RED.has(m.commit?.statusCheckRollup?.state))
    .map((m) => {
      const red = checks({ commits: { nodes: [{ commit: m.commit }] } }).filter((c) => c.red);
      const task = /^Desk-Task:\s*(\S+)/m.exec(m.commit.message ?? "")?.[1];
      return {
        main: m,
        age: minutesBetween(m.commit.committedDate, now),
        text: red.length ? `red: ${namesOf(red)}` : "red",
        owner: task ? `desk \`${task}\`` : "its AGENTS.md (CI)",
      };
    })
    .sort((a, b) => b.age - a.age);
}

const CLOCKS = ["🕛", "🕐", "🕑", "🕒", "🕓", "🕔", "🕕", "🕖", "🕗", "🕘", "🕙", "🕚"];

export function render(allPrs, now, seats, allMains = []) {
  // This issue is public: a private repository's PR is counted, never named.
  const prs = allPrs.filter((pr) => !pr.repository?.isPrivate);
  const hidden = late(allPrs.filter((pr) => pr.repository?.isPrivate), now).length;
  const rows = late(prs, now);
  const soon = prs.map((pr) => minutesBetween(pr.createdAt, now)).filter((m) => m >= SOON_MIN && m < LIMIT_MIN).length;
  const stamp = new Date(now).toISOString().replace(/\.\d+Z$/, "Z").replace("T", " ");
  const face = CLOCKS[new Date(now).getUTCHours() % 12];
  const out = [];
  // The one-paid-seat guard rides along: agents/one-paid-seat.md.
  if (seats) out.push(seatLine(seats), "");
  const reds = redMains(allMains.filter((m) => !m.repository?.isPrivate), now);
  const hiddenReds = redMains(allMains.filter((m) => m.repository?.isPrivate), now).length;
  if (reds.length) {
    out.push(`## 🔴 ${reds.length} red main branch${reds.length === 1 ? "" : "es"}`, "", "A red default branch holds every PR behind it. Its owner fixes it, or reverts, before their next PR.", "");
    out.push("| Red for | Repository | Latest commit | Likely owner |", "| --: | --- | --- | --- |");
    for (const r of reds) {
      const repo = r.main.repository.nameWithOwner;
      out.push(`| ${fmtAge(r.age)} | [${repo}](https://github.com/${repo}) \`${r.main.name}\` | [${r.main.commit.oid.slice(0, 7)}](https://github.com/${repo}/commit/${r.main.commit.oid}) ${r.text} | ${r.owner} |`);
    }
    out.push("");
  }
  if (hiddenReds) out.push(`🔒 ${hiddenReds} red main branch${hiddenReds === 1 ? "" : "es"} in private repositories, not named here.`, "");
  if (!rows.length && hidden) {
    out.push(`## 🔒 Only private repositories have late PRs`);
  } else if (!rows.length && (reds.length || hiddenReds)) {
    out.push(`## No PRs past 30 minutes`);
  } else if (!rows.length) {
    out.push(`## 🟢 All clear`, "");
    const oldest = prs.length ? fmtAge(Math.max(...prs.map((pr) => minutesBetween(pr.createdAt, now)))) : null;
    out.push(
      prs.length
        ? `Every open PR is under 30 minutes old. ${prs.length} open, the oldest at ${oldest}${soon ? `; ${soon} will pass 30 minutes soon` : ""}.`
        : "No open PRs anywhere. The queue is a clean desk.",
    );
  } else {
    const counts = {};
    for (const r of rows) counts[r.block.kind] = (counts[r.block.kind] ?? 0) + 1;
    const off = rows.filter((r) => r.autoOff).length;
    const summary = [...ORDER.filter((k) => counts[k]).map((k) => `${ICON[k]} ${counts[k]} ${k}`), ...(off ? [`⏸️ ${off} without auto-merge`] : [])].join(" · ");
    out.push(`## ${rows.length} PR${rows.length === 1 ? "" : "s"} past 30 minutes`, "", summary, "");
    out.push("| Open | PR | What's holding it | Likely owner |", "| --: | --- | --- | --- |");
    for (const r of rows) {
      const title = r.pr.title.replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 60);
      out.push(`| ${fmtAge(r.age)} | [${r.pr.repository.nameWithOwner}#${r.pr.number}](${r.pr.url}) ${title} | ${ICON[r.block.kind]} ${r.block.text}${r.autoOff ? " · ⏸️ auto-merge off" : ""} | ${r.owner} |`);
    }
    if (soon) out.push("", `${soon} more will pass 30 minutes within 10 minutes.`);
  }
  if (hidden) out.push("", `🔒 ${hidden} late PR${hidden === 1 ? "" : "s"} in private repositories, not named here.`);
  out.push(
    "",
    `<sub>${face} Checked ${stamp} UTC across ${OWNERS.join(", ")}. The clock runs every 10 minutes: if this time is over 30 minutes old, the clock itself is late, so run \`gh workflow run pr-clock.yml -R ourostack/.github\`. 🟢 merge it · ⏸️ publish with \`gh ouro-pr\` so green means merged · 🔴 fix the cause, issue before any rerun · 🟠 rebase · ⚪ close with a reason or finish. 30 minutes is the outer alarm, not the goal: faster is always better. [The rule](${RULE_URL})</sub>`,
  );
  const total = rows.length + hidden;
  const redCount = reds.length + hiddenReds;
  const redNote = redCount ? ` · ${redCount} red main` : "";
  return { title: total ? `${TITLE}: ${total}${redNote}` : redCount ? `${TITLE}: none${redNote}` : `${TITLE}: all clear`, body: out.join("\n"), rows, reds };
}

// ---- GitHub I/O ----

// PR fields, read per repository. (GitHub's search API returns nothing outside the workflow
// token's own repository, so the clock lists repositories and reads each one instead.)
const PR_FIELDS = `number title url createdAt isDraft body headRefName author{login} repository{nameWithOwner autoMergeAllowed isPrivate}
mergeable mergeStateStatus reviewDecision autoMergeRequest{enabledAt} mergeQueueEntry{state position enqueuedAt}
assignees(first:5){nodes{login}} labels(first:10){nodes{name}}
reviewRequests(first:10){nodes{requestedReviewer{... on User{login}}}}
commits(last:1){nodes{commit{message statusCheckRollup{contexts(first:100){nodes{__typename
... on CheckRun{name status conclusion startedAt} ... on StatusContext{context state createdAt}}}}}}}`;

async function gh(path, { method = "GET", body, token = process.env.GH_TOKEN } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  // A partial GraphQL error (one PR it could not read) still leaves the rest worth reporting.
  if (json.errors && json.data) console.error(`partial: ${JSON.stringify(json.errors).slice(0, 500)}`);
  else if (!res.ok || json.errors) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json.errors ?? json.message)}`);
  return json;
}

// Every repository the token can see under each owner that might hold an open PR.
export async function listRepos(owners = OWNERS) {
  const repos = [];
  for (const owner of owners) {
    const base = owner === ARI ? `/users/${owner}/repos?type=owner` : `/orgs/${owner}/repos?type=all`;
    for (let page = 1; ; page++) {
      const batch = await gh(`${base}&per_page=100&page=${page}`);
      repos.push(...batch.filter((r) => !r.archived && r.open_issues_count > 0).map((r) => r.full_name));
      if (batch.length < 100) break;
    }
  }
  return repos;
}

const MAIN_FIELDS = `nameWithOwner isPrivate defaultBranchRef{name target{... on Commit{oid committedDate message
statusCheckRollup{state contexts(first:100){nodes{__typename
... on CheckRun{name status conclusion startedAt} ... on StatusContext{context state createdAt}}}}}}}`;

export async function fetchOpenPrs() {
  return (await fetchState()).prs;
}

// The open PRs and each repository's default branch, read in the same queries.
export async function fetchState() {
  const repos = await listRepos();
  // An empty list means the token could not read the owners, never that all is clear.
  if (!repos.length) throw new Error(`no repositories readable under ${OWNERS.join(", ")}`);
  const prs = [];
  const mains = [];
  const unread = [];
  for (let i = 0; i < repos.length; i += 8) {
    const chunk = repos.slice(i, i + 8);
    const query = `query{${chunk
      .map((full, j) => {
        const [owner, name] = full.split("/");
        return `r${j}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){${MAIN_FIELDS} pullRequests(states:OPEN,first:50,orderBy:{field:CREATED_AT,direction:ASC}){totalCount nodes{${PR_FIELDS}}}}`;
      })
      .join(" ")}}`;
    const { data } = await gh("/graphql", { method: "POST", body: { query } });
    chunk.forEach((full, j) => {
      const repo = data?.[`r${j}`];
      const conn = repo?.pullRequests;
      if (!conn) return unread.push(full);
      const head = repo.defaultBranchRef;
      if (head?.target?.oid) mains.push({ repository: { nameWithOwner: repo.nameWithOwner, isPrivate: repo.isPrivate }, name: head.name, commit: head.target });
      if (conn.totalCount > conn.nodes.length) console.error(`${full}: showing the oldest ${conn.nodes.length} of ${conn.totalCount} open PRs`);
      prs.push(...conn.nodes.filter((n) => n?.number));
    });
  }
  // A repository it cannot read could hold a late PR: fail loudly rather than say all clear.
  if (unread.length) throw new Error(`could not read ${unread.length} of ${repos.length} repositories: ${unread.join(", ")}`);
  console.error(`read ${repos.length} repositories with open issues or PRs, ${prs.length} open PRs, ${mains.length} default branches`);
  return { prs, mains };
}

async function updateIssue({ title, body }) {
  const repo = process.env.GITHUB_REPOSITORY ?? "ourostack/.github";
  const token = process.env.ISSUE_TOKEN ?? process.env.GH_TOKEN;
  // GitHub silently drops a label that does not exist yet, so make sure it does.
  await gh(`/repos/${repo}/labels`, { method: "POST", body: { name: LABEL, color: "1f883d", description: "The PR clock: PRs open past 30 minutes" }, token }).catch((err) => {
    if (!/: 422 /.test(err.message)) console.error(`could not make the ${LABEL} label: ${err.message}`);
  });
  const found = await gh(`/repos/${repo}/issues?labels=${LABEL}&state=open&per_page=10`, { token });
  const issue = found.find((i) => !i.pull_request);
  if (issue) {
    if (issue.title === title && issue.body === body) return issue.html_url;
    await gh(`/repos/${repo}/issues/${issue.number}`, { method: "PATCH", body: { title, body }, token });
    return issue.html_url;
  }
  const made = await gh(`/repos/${repo}/issues`, { method: "POST", body: { title, body, labels: [LABEL] }, token });
  return made.html_url;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.GH_TOKEN) {
    console.error("Set GH_TOKEN.");
    process.exit(3);
  }
  const now = new Date().toISOString();
  const { prs, mains } = await fetchState();
  const seats = await readSeats((path) => gh(path, { token: process.env.SEAT_TOKEN || process.env.GH_TOKEN }));
  console.error(seatLine(seats));
  const view = render(prs, now, seats, mains);
  if (process.argv.includes("--json"))
    console.log(JSON.stringify({
      prs: view.rows.map((r) => ({ pr: r.pr.url, age: r.age, blocker: r.block, owner: r.owner })),
      redMains: view.reds.map((r) => ({ repository: r.main.repository.nameWithOwner, commit: r.main.commit.oid, age: r.age, red: r.text, owner: r.owner })),
    }, null, 2));
  else if (process.argv.includes("--update-issue")) {
    const url = await updateIssue(view);
    console.log(`${view.title}\n${url}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${view.body}\n`);
    }
  } else console.log(`# ${view.title}\n\n${view.body}`);
}
