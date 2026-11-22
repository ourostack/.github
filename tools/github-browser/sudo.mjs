// GitHub's sudo mode ("Confirm access") before a sensitive step. Nobody is guaranteed to be watching a headless Edge, and Ari
// is never prompted live outside the morning sitting: the step is queued with `shepherd signin queue` (one batch message each
// morning) and the call throws `signinQueued` so the flow carries on with other work and is rerun after the sitting. With
// SIGNIN_LIVE=1 (the sitting itself) the prompt is live: GitHub Mobile first (a push to their phone, no window needed; the
// number GitHub shows goes to the terminal and to Ari), then a passkey in a visible, frontmost Edge window. Granted sudo
// lasts a few hours for that browser session, so one approval covers every step that follows. When a personal agent is configured, a
// personal account's live line goes to it over A2A (falling back to Teams, saying so); a work account's line always goes to Teams.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { ssoUrlFor } from "./browser.mjs";

const CHAT = process.env.SUDO_TEAMS_CHAT ?? "19:e1ac21e4-c653-4dab-848f-2d8edb449c6b_7f3cdd24-4dd3-4278-81f4-cad2711c4b31@unq.gbl.spaces";

/**
 * The personal agent: { card, name, identityFile } from SUDO_PERSONAL_CARD, SUDO_PERSONAL_NAME and SUDO_A2A_IDENTITY_FILE, else from the
 * `personal` block of Shepherd's signin.json (the same agent the morning batch uses). Null when no card is set: every line goes to Teams.
 */
export function personalAgent(env = process.env, read = (f) => readFileSync(f, "utf8")) {
  let p = {};
  try { p = JSON.parse(read(env.SHEPHERD_SIGNIN_CONFIG ?? join(homedir(), ".config", "shepherd", "signin.json"))).personal ?? {}; } catch {}
  const pick = (a, b) => (typeof a === "string" && a.trim() ? a.trim() : typeof b === "string" && b.trim() ? b.trim() : null);
  const card = pick(env.SUDO_PERSONAL_CARD, p.card);
  return card ? { card, name: pick(env.SUDO_PERSONAL_NAME, p.name) ?? "The personal agent", identityFile: pick(env.SUDO_A2A_IDENTITY_FILE, p.identityFile) } : null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const onSudoPage = async (page) => (await page.locator("text=Confirm access >> visible=true").count()) > 0;

/** "mobile" when GitHub offers GitHub Mobile, else "passkey". */
export async function pickSudoPath(page) {
  return (await page.locator("sudo-credential-options[github-mobile-available=true]").count()) ? "mobile" : "passkey";
}

const MOBILE_BUTTON = "button[data-action*=showGitHubMobile] >> visible=true";

/** The number GitHub Mobile shows, or "" while the page has none (GitHub sometimes asks for a plain Approve). */
export async function mobileNumber(page) {
  const text = await page.locator('[data-target$="githubMobileChallengeValue"]').first().textContent({ timeout: 1000 }).catch(() => "");
  return (text ?? "").trim();
}

/** One line to Ari's Teams chat with Ouroboros through WorkIQ; a failure is reported, never thrown. */
export function teamsLine(text, run = execFileSync) {
  try {
    run("workiq", ["create", "-u", `/me/chats/${CHAT}/messages`, "-b", JSON.stringify({ body: { contentType: "text", content: text } })], { stdio: "ignore", timeout: 60000 });
    return true;
  } catch (e) { console.error(`Teams message failed: ${e.message}`); return false; }
}

/** A work account is an Enterprise Managed User (login ending _<enterprise>) or one listed in SUDO_WORK_ACCOUNTS (comma separated); every other account is personal. */
export const isWorkAccount = (user, env = process.env) =>
  !!ssoUrlFor(user) || (env.SUDO_WORK_ACCOUNTS ?? "").split(",").map((a) => a.trim().toLowerCase()).filter(Boolean).includes(String(user).toLowerCase());

const isoDay = (t) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
const clock = (t) => `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;

/** The live line as ONE item in the personal agent's intake format, deduped per account per day. */
export function sudoIntake({ account, line, waitMs = 15 * 60_000, now = new Date(), host = hostname() }) {
  return [
    `from: the GitHub browser tool on ${host}, signed in as ${account}`,
    "urgency: now",
    `ask: ${line}`,
    "why only Ari: GitHub's sudo mode needs Ari's own approval (GitHub Mobile or a passkey); no agent can give it.",
    "steps:",
    `1. ${line}`,
    "2. Nothing else: the waiting step carries on by itself once GitHub sees the approval.",
    `deadline: ${clock(new Date(now.getTime() + waitMs))} local today; after that the step times out and is rerun later.`,
    `dedupe key: github-sudo-${account}-${isoDay(now)}`,
  ].join("\n");
}

/**
 * Sends `text` to the personal agent with `ouro a2a message` (sealed and signed with this machine's A2A identity), which waits for the
 * agent's reply. Resolves true when sent, false on a definite non-delivery (no connection, a refusal); never throws. A timeout counts as
 * sent: the agent may still be answering, and a fallback would put the same prompt in the work chat too.
 */
// The Ouro CLI: on PATH, else where its installer puts it (a launchd job's PATH is short).
const ouroBin = () => { const own = join(homedir(), ".ouro-cli", "bin", "ouro"); return (process.env.PATH ?? "").split(":").some((d) => d && existsSync(join(d, "ouro"))) || !existsSync(own) ? "ouro" : own; };

export function a2aLine(text, agent, run = execFile, bin = ouroBin()) {
  return new Promise((resolve) => {
    const args = ["a2a", "message", "--to", agent.card, "--text", text, "--json", "--why", "GitHub sudo is waiting on Ari, who asked that personal prompts reach him only through his personal agent"];
    if (agent.identityFile) args.push("--identity-file", agent.identityFile);
    run(bin, args, { timeout: 60000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      let reply = null;
      try { reply = JSON.parse(String(stdout ?? "").trim().split("\n").pop()); } catch {}
      const failed = reply?.ok === false ? (reply.reason ?? "refused") : err && !err.killed ? (String(stderr ?? "").trim().split("\n").pop() || err.message) : null;
      if (failed) console.error(`${agent.name} message failed: ${failed}`);
      resolve(!failed);
    });
  });
}

/**
 * Routes the live line: with a personal agent configured, a personal account's goes to it, and to Teams (saying so) when it can't be
 * reached; a work account's, or any line with no personal agent, goes to Teams. Resolves "personal", "fallback" or "work".
 * Only the account decides: a personal account doing sudo on a work organization counts as personal.
 */
export async function routeLine({ account, line, waitMs }, { agent = personalAgent(), personal = a2aLine, teams = teamsLine, now = new Date() } = {}) {
  if (!agent || isWorkAccount(account)) { teams(line); return "work"; }
  if (await personal(sudoIntake({ account, line, waitMs, now }), agent)) return "personal";
  teams(`${agent.name} unreachable, so this came here. ${line}`);
  return "fallback";
}

/** Queues the sign-in for the morning batch; a failure is reported, never thrown. The account is named so the batch can tell work from personal. */
export function queueSignin({ what, resume, account }, run = execFileSync) {
  const whose = account ? ` (${isWorkAccount(account) ? "work GitHub account" : "GitHub account"} ${account})` : "";
  try {
    run("shepherd", ["signin", "queue", "--tool", "github-browser", "--what", "GitHub sudo (Confirm access)", "--why", `GitHub is waiting for approval to ${what}${whose}`, "--resume", resume], { stdio: "ignore", timeout: 60000 });
    return true;
  } catch (e) { console.error(`Could not queue the sign-in: ${e.message}`); return false; }
}

/**
 * Call right after a step that may hit "Confirm access". Returns "none" when there was no prompt, else the path that
 * granted it ("mobile" or "passkey"). `redo(page)` repeats the step on a new page (the passkey path reopens Edge visibly).
 * `what` is the waiting step, in words, for the live line; `account` is the GitHub login the session is signed in as, which picks
 * where the line goes (see routeLine).
 */
export async function awaitSudo(session, { what, redo, account = session.user ?? process.env.GITHUB_USER ?? "arimendelow", resume = process.argv.map((a) => JSON.stringify(a)).join(" "), live = process.env.SIGNIN_LIVE === "1", queue = queueSignin, waitMs = 15 * 60_000, notify = (line) => routeLine({ account, line, waitMs }), probeMs = 10_000, pollMs = 1000, log = console.log } = {}) {
  let page = session.page;
  let seen = false;
  for (let t = 0; t <= probeMs && !seen; t += pollMs) { seen = await onSudoPage(page); if (!seen) await sleep(pollMs); }
  if (!seen) return "none";
  if (!live) {
    queue({ what, resume, account });
    throw Object.assign(new Error(`GitHub needs approval to ${what}: queued for the morning (shepherd signin); rerun after it is done`), { exit: 5, signinQueued: true });
  }
  const path = await pickSudoPath(page);
  let line;
  if (path === "mobile") {
    await page.locator(MOBILE_BUTTON).first().click();
    let n = "";
    for (let i = 0; i < 8 && !n; i++) { n = await mobileNumber(page); if (!n) await sleep(pollMs); }
    line = `GitHub is waiting for your approval to ${what}: tap Approve on your phone (GitHub Mobile)${n ? ` and pick ${n}` : ""}.`;
  } else {
    page = await session.relaunchHeadful();
    await redo(page);
    line = `GitHub is waiting for your approval to ${what}: use your passkey in the Edge window that just opened.`;
  }
  log(line);
  // Not awaited here: the approval can land while the message is still on its way. It is awaited before returning, so a caller that
  // exits right after never cuts off the send or its Teams fallback.
  const sending = Promise.resolve(notify(line)).catch((e) => console.error(`Could not send the line: ${e.message}`));
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    if (!(await onSudoPage(page))) { await sending; return path; }
    await sleep(pollMs);
  }
  await sending;
  throw Object.assign(new Error(`No approval within ${waitMs / 60000} minutes for: ${what}`), { exit: 4, sudoTimeout: true });
}
