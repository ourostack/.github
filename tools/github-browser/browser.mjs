// A headless Edge on its own persistent profile for one GitHub account, for the few GitHub settings that have no API.
// The profile is seeded once from a copy of the person's Edge sign-in files and never written back, and the tool blocks
// every sign-out, so nothing it does can sign the person out or switch the account their own browser uses. It never
// signs in and never types a password.
import { execFileSync, spawn } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const loginOf = async (page) => { await page.goto("https://github.com/", { waitUntil: "domcontentloaded" }); return page.evaluate(() => document.querySelector('meta[name="user-login"]')?.content ?? ""); };

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

// "Device Bound Sessions" holds the keys that GitHub and Entra bind their session cookies to; without it the copied
// cookies are dropped on first start and the copy reads signed out.
const SIGN_IN_FILES = ["Preferences", "Secure Preferences", "Cookies", "Login Data", "Web Data", "Device Bound Sessions"];

/** Where an Enterprise Managed User (login ending _<enterprise>) signs in through its identity provider, or undefined for any other account. */
export const ssoUrlFor = (user) => { const m = /_([a-z0-9][a-z0-9-]*)$/i.exec(user); return m ? `https://github.com/enterprises/${m[1].toLowerCase()}/sso` : undefined; };

/** Signs an enterprise account in through the identity provider's single sign-on, which the copied Edge profile answers without a person. Returns the login, or "" when it did not complete. */
export async function signInViaSso(page, user, { timeoutMs = 45000 } = {}) {
  const url = ssoUrlFor(user);
  if (!url) return "";
  await page.goto(url);
  const go = page.getByRole("button", { name: /continue/i }).first();
  if (!(await go.count())) return loginOf(page);
  await go.click();
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await page.waitForTimeout(1000);
    const here = new URL(page.url());
    if (here.hostname === "github.com" && !/\/sso\/?$/.test(here.pathname) && !/\/saml\//.test(here.pathname)) break;
  }
  return loginOf(page).catch(() => "");
}

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
 * Edge on macOS stores cookie values encrypted (v10) under a key in the keychain, and a newer Edge than the one that wrote
 * them (158 reading 157's) cannot read them and drops every one, so the copy reads signed out. Decrypting the copied
 * cookie file into plain values, which any version reads, keeps the copy signed in. Same approach as Desk's `mine` copy.
 */
export function keychainCookieKey({ platform = process.platform, run = execFileSync } = {}) {
  if (platform !== "darwin") return null;
  try {
    const secret = run("security", ["find-generic-password", "-w", "-s", "Microsoft Edge Safe Storage", "-a", "Microsoft Edge"], { timeout: 10000, stdio: ["ignore", "pipe", "ignore"] });
    return pbkdf2Sync(secret.toString("utf8").trim(), "saltysalt", 1003, 16, "sha1");
  } catch { return null; }
}

function decryptCookie(key, host, value) {
  if (!(value instanceof Uint8Array) || value.length < 19 || Buffer.from(value.subarray(0, 3)).toString("latin1") !== "v10") return null;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    let plain = Buffer.concat([decipher.update(Buffer.from(value.subarray(3))), decipher.final()]);
    if (plain.length >= 32 && plain.subarray(0, 32).equals(createHash("sha256").update(host).digest())) plain = plain.subarray(32);
    return plain.toString("utf8");
  } catch { return null; }
}

/** Rewrites the cookie database at `file` in place with plain values; a file that is not a cookie database is left as it was. */
export function transcodeCookies(file, key) {
  try {
    const db = new DatabaseSync(file);
    try {
      const rows = db.prepare("SELECT rowid AS id, host_key AS host, encrypted_value AS value FROM cookies WHERE length(encrypted_value) > 0").all();
      const update = db.prepare("UPDATE cookies SET value = ?, encrypted_value = x'' WHERE rowid = ?");
      db.exec("BEGIN");
      for (const row of rows) { const plain = decryptCookie(key, row.host, row.value); if (plain !== null) update.run(plain, row.id); }
      db.exec("COMMIT");
    } finally { db.close(); }
  } catch { /* leave the bytes as copied */ }
}

/**
 * Copies the person's sign-in files into `dest` once (a marker file records it) and returns whether it copied. The copy
 * only ever reads `source`; nothing runs the other way. It never replaces an existing copy: see reseedProfile.
 */
export function seedProfile({ source, dest, cookieKey = keychainCookieKey() }) {
  const marker = join(dest, ".seeded");
  if (resolve(source) === resolve(dest, "Default")) throw new Error("the seed source and the isolated profile are the same folder");
  if (existsSync(marker)) return false;
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(dest, "Default"), { recursive: true });
  copyFileSync(join(source, "..", "Local State"), join(dest, "Local State"));
  for (const f of SIGN_IN_FILES) if (existsSync(join(source, f))) copyFileSync(join(source, f), join(dest, "Default", f));
  if (cookieKey && existsSync(join(dest, "Default", "Cookies"))) transcodeCookies(join(dest, "Default", "Cookies"), cookieKey);
  writeFileSync(marker, `${new Date().toISOString()}\n`);
  return true;
}

/**
 * Makes a fresh copy of `source` beside `dest` for one run. Copied sessions are bound to the device and only the first
 * run on a copy reliably gets them back, so a signed-out profile is replaced by a new copy; the old profile stays
 * until promoteProfile swaps the new one in, which a run does only once it has signed in.
 */
export function stageProfile({ source, dest, cookieKey }) {
  const staging = `${dest}.reseed`;
  rmSync(staging, { recursive: true, force: true });
  seedProfile({ source, dest: staging, cookieKey });
  return staging;
}

/** Swaps the staged copy in for `dest` whole when `signedIn`, and otherwise discards it, leaving the profile that was there. Returns whether it swapped. */
export function promoteProfile({ staging, dest, signedIn }) {
  if (!signedIn) { rmSync(staging, { recursive: true, force: true }); return false; }
  const old = `${dest}.old`;
  rmSync(old, { recursive: true, force: true });
  const lock = join(dest, ".lock");
  const held = existsSync(lock) ? readFileSync(lock, "utf8") : undefined;
  if (existsSync(dest)) renameSync(dest, old);
  renameSync(staging, dest);
  if (held !== undefined) writeFileSync(lock, held);
  rmSync(old, { recursive: true, force: true });
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

const stopEdge = async ({ browser, proc }) => { await browser?.close().catch(() => {}); proc.kill(); await new Promise((r) => setTimeout(r, 1000)); };

/** Opens Edge on `user`'s own isolated profile (or on `via`'s, when that profile's switcher already lists `user`), copied from the person's Edge profile and never written back. A profile that reads signed out is replaced for the run by a fresh copy, which becomes the profile once it is signed in; a copy that is no better is discarded and the old profile kept. {page, close, relaunchHeadful}: `page` changes when relaunchHeadful() reopens the same profile in a visible window (GitHub's passkey prompt needs one). */
export async function openAs(user = process.env.GITHUB_USER ?? "arimendelow", { headful = false, via = user } = {}) {
  const profile = process.env.EDGE_PROFILE ?? join(homedir(), "Library/Application Support/Microsoft Edge/Default");
  const edge = process.env.EDGE_BIN ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
  const home = profileDirFor(via);
  // The lock comes first: a busy profile is reported as busy even where Playwright isn't installed.
  const unlock = lockProfile(home);
  let chromium;
  try {
    const require = createRequire(join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "/"));
    ({ chromium } = require("playwright"));
  } catch (e) { unlock(); throw e; }
  let dir = home;
  let staging;
  let browser; let proc;
  const session = { user, page: undefined, close: undefined, relaunchHeadful: undefined };
  let original = "";
  const stop = () => stopEdge({ browser, proc });
  const finish = async (signedIn) => {
    await stop().catch(() => {});
    if (staging) promoteProfile({ staging, dest: home, signedIn });
    unlock();
  };
  session.close = async () => {
    await restoreAccount(session.page, original).catch(() => {});
    await finish(true);
  };
  const newPage = async () => {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    await blockSignOut(context);
    return context.newPage();
  };
  const start = async (headfulNow) => {
    ({ browser, proc } = await launch({ chromium, edge, dir, headful: headfulNow }));
    if (!browser) { proc.kill(); throw Object.assign(new Error(`Edge did not start within ${startBudgetMs() / 1000} s; on a loaded machine set EDGE_START_SECONDS higher and rerun`), { exit: 3 }); }
    session.page = await newPage();
  };
  session.relaunchHeadful = async () => {
    // A visible window in front of Ari is for the morning sitting only (SIGNIN_LIVE=1); any other caller queues with `shepherd signin queue`.
    if (process.env.SIGNIN_LIVE !== "1") throw Object.assign(new Error("a visible sign-in window is for the morning sitting only: queue it with `shepherd signin queue --what ... --why ... --resume ...`, or set SIGNIN_LIVE=1 in the sitting"), { exit: 5, signinQueued: false });
    await stop();
    await start(true);
    await session.page.bringToFront().catch(() => {});
    // A window opened from a script stays behind the others on macOS until asked to come forward.
    try { execFileSync("osascript", ["-e", 'tell application "Microsoft Edge" to activate']); } catch {}
    return session.page;
  };
  const signIn = async () => {
    let who = await loginOf(session.page);
    original ||= who;
    // Another account may already be signed in alongside: GitHub's switcher lists it with a Select button.
    if (who !== user) who = await switchTo(session.page, user);
    if (who !== user) who = await signInViaSso(session.page, user).catch(() => "");
    return who;
  };
  const fresh = async () => {
    staging = stageProfile({ source: profile, dest: home });
    dir = staging;
    await start(headful);
    return signIn();
  };
  let who = "";
  try {
    if (process.env.GITHUB_BROWSER_RESEED) who = await fresh();
    else {
      seedProfile({ source: profile, dest: home });
      await start(headful);
      who = await signIn();
      if (who !== user) { await stop(); who = await fresh(); }
    }
  } catch (e) { await finish(false); throw e; }
  if (who !== user) {
    await finish(false);
    throw Object.assign(new Error(`${user} is not signed in in the isolated profile ${home}${who ? ` (it is signed in as ${who})` : ""}, and a fresh copy of ${profile} did not sign in either, so the profile was left as it was. Sign ${user} in once in that Edge profile (Add account on github.com, or open https://github.com/enterprises/<enterprise>/sso), then rerun.`), { exit: 3 });
  }
  return session;
}
