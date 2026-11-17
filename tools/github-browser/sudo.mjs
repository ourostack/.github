// GitHub's sudo mode ("Confirm access") before a sensitive step. Nobody is guaranteed to be watching a headless Edge, so
// the prompt has to reach the person: GitHub Mobile first (a push to their phone, no window needed; the number GitHub
// shows goes to the terminal and to Teams), then a passkey in a visible, frontmost Edge window. Granted sudo lasts a few
// hours for that browser session, so one approval covers every step that follows.
import { execFileSync } from "node:child_process";

const CHAT = process.env.SUDO_TEAMS_CHAT ?? "19:e1ac21e4-c653-4dab-848f-2d8edb449c6b_7f3cdd24-4dd3-4278-81f4-cad2711c4b31@unq.gbl.spaces";
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

/**
 * Call right after a step that may hit "Confirm access". Returns "none" when there was no prompt, else the path that
 * granted it ("mobile" or "passkey"). `redo(page)` repeats the step on a new page (the passkey path reopens Edge visibly).
 * `what` is the waiting step, in words, for the Teams line.
 */
export async function awaitSudo(session, { what, redo, notify = teamsLine, waitMs = 15 * 60_000, probeMs = 10_000, pollMs = 1000, log = console.log } = {}) {
  let page = session.page;
  let seen = false;
  for (let t = 0; t <= probeMs && !seen; t += pollMs) { seen = await onSudoPage(page); if (!seen) await sleep(pollMs); }
  if (!seen) return "none";
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
  notify(line);
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    if (!(await onSudoPage(page))) return path;
    await sleep(pollMs);
  }
  throw Object.assign(new Error(`No approval within ${waitMs / 60000} minutes for: ${what}`), { exit: 4, sudoTimeout: true });
}
