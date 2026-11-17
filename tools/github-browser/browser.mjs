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

/** How long to wait for Edge's debugging port: EDGE_START_SECONDS (default 10). A heavily loaded machine needs longer. */
export function startBudgetMs(env = process.env) {
  const s = Number(env.EDGE_START_SECONDS);
  return (Number.isFinite(s) && s > 0 ? s : 10) * 1000;
}

export async function openAs(user = process.env.GITHUB_USER ?? "arimendelow") {
  const require = createRequire(join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "/"));
  const { chromium } = require("playwright");
  const profile = process.env.EDGE_PROFILE ?? join(homedir(), "Library/Application Support/Microsoft Edge/Default");
  const edge = process.env.EDGE_BIN ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
  const dir = mkdtempSync(join(tmpdir(), "github-browser-"));
  mkdirSync(join(dir, "Default"));
  copyFileSync(join(profile, "..", "Local State"), join(dir, "Local State"));
  for (const f of ["Preferences", "Secure Preferences", "Cookies", "Login Data", "Web Data"])
    if (existsSync(join(profile, f))) copyFileSync(join(profile, f), join(dir, "Default", f));
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(edge, [`--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check", "--headless=new"], { stdio: "ignore" });
  let browser;
  for (let i = 0; i < startBudgetMs() / 250 && !browser; i++) {
    await new Promise((r) => setTimeout(r, 250));
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined);
  }
  let page;
  let original = "";
  const close = async () => {
    await restoreAccount(page, original);
    await browser?.close().catch(() => {});
    proc.kill();
    await new Promise((r) => setTimeout(r, 1000));
    try { renameSync(dir, join(homedir(), ".Trash", `github-browser-${Date.now()}`)); } catch {}
  };
  if (!browser) { await close(); throw Object.assign(new Error(`Edge did not start within ${startBudgetMs() / 1000} s; on a loaded machine set EDGE_START_SECONDS higher and rerun`), { exit: 3 }); }
  page = await (browser.contexts()[0] ?? (await browser.newContext())).newPage();
  let who = await loginOf(page);
  original = who;
  // Another account may already be signed in alongside: GitHub's switcher lists it with a Select button.
  if (who !== user) who = await switchTo(page, user);
  if (who !== user) {
    await close();
    throw Object.assign(new Error(`github.com is ${who ? `signed in as ${who}` : "not signed in"} in ${profile}, and ${user} is not in its account switcher; add ${user} there once (Add account), then rerun.`), { exit: 3 });
  }
  return { page, close };
}
