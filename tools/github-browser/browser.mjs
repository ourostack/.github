// A headless Edge on its own persistent profile for one GitHub account, for the few GitHub settings that have no API.
// The profile is seeded once from a copy of the person's Edge sign-in files and never written back, and the tool blocks
// every sign-out, so nothing it does can sign the person out or switch the account their own browser uses. It never
// signs in and never types a password.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const loginOf = async (page) => { await page.goto("https://github.com/"); return page.evaluate(() => document.querySelector('meta[name="user-login"]')?.content ?? ""); };

// Switching accounts is server-side state that every browser holding the session's cookies shares: while another
// account is active, a private Pages site answers 401 to the person's own account. openAs keeps its profile per account
// and close() switches back to the account that was active when the run started.
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

const SIGN_IN_FILES = ["Preferences", "Secure Preferences", "Cookies", "Login Data", "Web Data"];

/** Where `user`'s own profile lives: a folder per account, outside the person's Edge profile. */
export const profileDirFor = (user, env = process.env) => join(env.GITHUB_BROWSER_HOME ?? join(homedir(), ".local/state/github-browser"), "profiles", user);

/** True for a request that would end a GitHub session. GitHub sign-outs are server-side and reach every browser holding those cookies. */
export const isSignOut = (url, method = "GET") => {
  const { hostname, pathname } = new URL(url);
  return (hostname === "github.com" || hostname.endsWith(".github.com")) && /^\/(logout|sessions\/(logout|sign_out))\/?$/.test(pathname) && method !== "OPTIONS";
};

/** Refuses every sign-out request made in `context`. */
export const blockSignOut = (context) => context.route((url) => { try { return isSignOut(url.href); } catch { return false; } }, (route) => route.abort("blockedbyclient"));

/**
 * Copies the person's sign-in files into `dest` once (a marker file records it) and returns whether it copied. The copy
 * only ever reads `source`; nothing runs the other way. `reseed` replaces an existing copy.
 */
export function seedProfile({ source, dest, reseed = false }) {
  const marker = join(dest, ".seeded");
  if (resolve(source) === resolve(dest, "Default")) throw new Error("the seed source and the isolated profile are the same folder");
  if (existsSync(marker) && !reseed) return false;
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(dest, "Default"), { recursive: true });
  copyFileSync(join(source, "..", "Local State"), join(dest, "Local State"));
  for (const f of SIGN_IN_FILES) if (existsSync(join(source, f))) copyFileSync(join(source, f), join(dest, "Default", f));
  writeFileSync(marker, `${new Date().toISOString()}\n`);
  return true;
}

/** One run per profile at a time: Edge locks its profile folder. Returns a release function. */
export function lockProfile(dest, { alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } } } = {}) {
  const file = join(dest, ".lock");
  mkdirSync(dest, { recursive: true });
  for (let tries = 0; ; tries++) {
    try { writeFileSync(file, String(process.pid), { flag: "wx" }); break; }
    catch (e) {
      if (e.code !== "EEXIST" || tries) throw e;
      const pid = Number(readFileSync(file, "utf8"));
      if (alive(pid)) throw Object.assign(new Error(`another github-browser run (pid ${pid}) is using ${dest}`), { exit: 3 });
      rmSync(file, { force: true });
    }
  }
  return () => rmSync(file, { force: true });
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

/** Opens Edge on `user`'s own isolated profile (or on `via`'s, when that profile's switcher already lists `user`: one signed-in profile can serve every account it holds) (seeded once from the person's Edge profile, never written back). {page, close, relaunchHeadful}: `page` changes when relaunchHeadful() reopens the same profile in a visible window (GitHub's passkey prompt needs one). */
export async function openAs(user = process.env.GITHUB_USER ?? "arimendelow", { headful = false, via = user } = {}) {
  const require = createRequire(join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "/"));
  const { chromium } = require("playwright");
  const profile = process.env.EDGE_PROFILE ?? join(homedir(), "Library/Application Support/Microsoft Edge/Default");
  const edge = process.env.EDGE_BIN ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
  const dir = profileDirFor(via);
  const unlock = lockProfile(dir);
  try { seedProfile({ source: profile, dest: dir, reseed: Boolean(process.env.GITHUB_BROWSER_RESEED) }); } catch (e) { unlock(); throw e; }
  let { browser, proc } = await launch({ chromium, edge, dir, headful });
  const session = { page: undefined, close: undefined, relaunchHeadful: undefined };
  let original = "";
  const stop = async () => { await browser?.close().catch(() => {}); proc.kill(); await new Promise((r) => setTimeout(r, 1000)); };
  session.close = async () => {
    await restoreAccount(session.page, original).catch(() => {});
    await stop();
    unlock();
  };
  const newPage = async () => {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    await blockSignOut(context);
    return context.newPage();
  };
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
    throw Object.assign(new Error(`github.com is ${who ? `signed in as ${who}` : "not signed in"} in ${profile}, and ${user} is not in its account switcher; add ${user} to ${profile} once (Add account), then rerun with GITHUB_BROWSER_RESEED=1.`), { exit: 3 });
  }
  return session;
}
