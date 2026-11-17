// A headless Edge on a scratch copy of the local profile's sign-in files, switched to one GitHub account through
// GitHub's own account switcher. For the few GitHub settings that have no API. It never signs in and never types a
// password; the scratch copy goes to the Trash when it closes, and the person's own browser is never touched.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const loginOf = async (page) => { await page.goto("https://github.com/"); return page.evaluate(() => document.querySelector('meta[name="user-login"]')?.content ?? ""); };

// Switching accounts is server-side state shared by every copy of the profile, not just this scratch copy: while another
// account is active, a private Pages site answers 401 to the person's own account everywhere. So callers switch back.
export async function switchTo(page, user) {
  await page.goto("https://github.com/switch_account");
  const select = page.locator(`input[type=submit][aria-label="Select ${user}"]`);
  if (await select.count()) { await select.first().click(); await page.waitForLoadState("load"); }
  return loginOf(page);
}

export async function restoreAccount(page, original) {
  if (!page || !original) return;
  if ((await loginOf(page).catch(() => original)) !== original) await switchTo(page, original).catch(() => {});
}

/** How long to wait for Edge's debugging port: EDGE_START_SECONDS (default 60). Edge's start waits on a loaded machine; a ready one answers in about a second, so a long budget costs nothing. */
export function startBudgetMs(env = process.env) {
  const s = Number(env.EDGE_START_SECONDS);
  return (Number.isFinite(s) && s > 0 ? s : 60) * 1000;
}

// One attempt, polled every 100 ms: starting over (a fresh Edge) throws away the startup already paid for.
async function launch({ chromium, edge, dir, headful }) {
  const port = 9300 + Math.floor(Math.random() * 500);
  const args = [`--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check", ...(headful ? [] : ["--headless=new"])];
  const proc = spawn(edge, args, { stdio: "ignore" });
  let exited = false;
  proc.on("exit", () => { exited = true; });
  const end = Date.now() + startBudgetMs();
  while (Date.now() < end && !exited) {
    const up = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok, () => false);
    if (up) { const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined); if (browser) return { browser, proc }; }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  return { proc };
}

/** Opens Edge on a scratch copy of the profile as `user`. {page, close, relaunchHeadful}: `page` changes when relaunchHeadful() reopens the same scratch copy in a visible window (GitHub's passkey prompt needs one). */
export async function openAs(user = process.env.GITHUB_USER ?? "arimendelow", { headful = false } = {}) {
  const require = createRequire(join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "/"));
  const { chromium } = require("playwright");
  const profile = process.env.EDGE_PROFILE ?? join(homedir(), "Library/Application Support/Microsoft Edge/Default");
  const edge = process.env.EDGE_BIN ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
  const dir = mkdtempSync(join(tmpdir(), "github-browser-"));
  mkdirSync(join(dir, "Default"));
  copyFileSync(join(profile, "..", "Local State"), join(dir, "Local State"));
  for (const f of ["Preferences", "Secure Preferences", "Cookies", "Login Data", "Web Data"])
    if (existsSync(join(profile, f))) copyFileSync(join(profile, f), join(dir, "Default", f));
  let { browser, proc } = await launch({ chromium, edge, dir, headful });
  const session = { page: undefined, close: undefined, relaunchHeadful: undefined };
  let original = "";
  const stop = async () => { await browser?.close().catch(() => {}); proc.kill(); await new Promise((r) => setTimeout(r, 1000)); };
  session.close = async () => {
    await restoreAccount(session.page, original).catch(() => {});
    await stop();
    try { renameSync(dir, join(homedir(), ".Trash", `github-browser-${Date.now()}`)); } catch {}
  };
  const newPage = async () => (browser.contexts()[0] ?? (await browser.newContext())).newPage();
  session.relaunchHeadful = async () => {
    await stop();
    ({ browser, proc } = await launch({ chromium, edge, dir, headful: true }));
    if (!browser) throw Object.assign(new Error("Edge did not reopen in a visible window"), { exit: 3 });
    session.page = await newPage();
    await session.page.bringToFront().catch(() => {});
    // A window opened from a script stays behind the others on macOS until asked to come forward.
    try { execFileSync("osascript", ["-e", 'tell application "Microsoft Edge" to activate']); } catch {}
    return session.page;
  };
  if (!browser) { await session.close(); throw Object.assign(new Error(`Edge did not start within ${startBudgetMs() / 1000} s; on a loaded machine set EDGE_START_SECONDS higher and rerun`), { exit: 3 }); }
  session.page = await newPage();
  let who = await loginOf(session.page);
  original = who;
  // Another account may already be signed in alongside: GitHub's switcher lists it with a Select button.
  if (who !== user) who = await switchTo(session.page, user);
  if (who !== user) {
    await session.close();
    throw Object.assign(new Error(`github.com is ${who ? `signed in as ${who}` : "not signed in"} in ${profile}, and ${user} is not in its account switcher; add ${user} there once (Add account), then rerun.`), { exit: 3 });
  }
  return session;
}
