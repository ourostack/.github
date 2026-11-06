#!/usr/bin/env node
// Upload each repository's social preview from brand/surfaces.json, through a signed-in browser.
// GitHub has no API for social previews, so this drives Settings > General > Social preview.
//
//   node brand/tools/upload-social-previews.mjs            # every stale social preview
//   node brand/tools/upload-social-previews.mjs desk ouroboros
//
// It never signs in and never types a password. It copies the sign-in files of the local
// Microsoft Edge profile (EDGE_PROFILE, default ~/Library/Application Support/Microsoft Edge/Default)
// into a scratch folder, opens Edge on that copy in the background, and stops with exit 3 if
// github.com is not signed in there as GITHUB_USER (default arimendelow): sign in to GitHub in
// that Edge profile once, then rerun. Needs `playwright` (npm i -g playwright) and Edge.

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BRAND = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(readFileSync(join(BRAND, "surfaces.json"), "utf8"));
const user = process.env.GITHUB_USER ?? "arimendelow";
const profile = process.env.EDGE_PROFILE ?? join(homedir(), "Library/Application Support/Microsoft Edge/Default");
const edge = process.env.EDGE_BIN ?? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const wanted = process.argv.slice(2);

const require = createRequire(join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "/"));
const { chromium } = require("playwright");

// Which previews are stale, from the audit itself.
let auditOut;
try {
  auditOut = execFileSync(process.execPath, [join(BRAND, "tools/audit.mjs"), "--format", "json", "--only", "social:"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
} catch (err) {
  auditOut = err.stdout; // exit 1 just means something is stale
}
const audit = JSON.parse(auditOut || "{}");
const stale = new Set((audit.items ?? []).filter((i) => i.status !== "current").map((i) => i.id));
const jobs = registry.surfaces.filter(
  (s) => s.kind === "github-social-preview" && (wanted.length ? wanted.includes(s.repo.split("/")[1]) : stale.has(s.id)),
);
if (!jobs.length) {
  console.log("Every social preview is current.");
  process.exit(0);
}

// A private copy of the profile's sign-in files (a few MB), never the profile itself.
const dir = mkdtempSync(join(tmpdir(), "brand-social-"));
mkdirSync(join(dir, "Default"));
copyFileSync(join(profile, "..", "Local State"), join(dir, "Local State"));
for (const f of ["Preferences", "Secure Preferences", "Cookies", "Login Data", "Web Data"])
  if (existsSync(join(profile, f))) copyFileSync(join(profile, f), join(dir, "Default", f));
const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(edge, [`--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check", "--headless=new"], { stdio: "ignore" });
let browser;
for (let i = 0; i < 40 && !browser; i++) {
  await new Promise((r) => setTimeout(r, 250));
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined);
}
let code = 0;
try {
  if (!browser) throw Object.assign(new Error("Edge did not start"), { exit: 3 });
  const page = await (browser.contexts()[0] ?? (await browser.newContext())).newPage();
  await page.goto("https://github.com/");
  const login = await page.evaluate(() => document.querySelector('meta[name="user-login"]')?.content ?? "");
  if (login !== user)
    throw Object.assign(new Error(`github.com is ${login ? `signed in as ${login}` : "not signed in"} in ${profile}; sign in there as ${user} once, then rerun.`), { exit: 3 });
  for (const s of jobs) {
    const file = join(BRAND, s.image);
    await page.goto(`https://github.com/${s.repo}/settings`);
    const section = page.locator("div, section").filter({ has: page.getByRole("heading", { name: "Social preview" }) }).last();
    const input = section.locator('input[type="file"]').first();
    await input.setInputFiles(file);
    // GitHub uploads on change and swaps the preview image in place.
    await page.waitForResponse((r) => /repository-images|upload/.test(r.url()) && r.request().method() !== "GET", { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2500);
    console.log(`uploaded ${s.image} to ${s.repo}`);
  }
} catch (err) {
  console.error(err.message);
  code = err.exit ?? 1;
} finally {
  await browser?.close().catch(() => {});
  proc.kill();
  // Leave no copy of sign-in files behind: move the scratch profile to the Trash.
  try {
    renameSync(dir, join(homedir(), ".Trash", `brand-social-${Date.now()}`));
  } catch {}
}
if (code) process.exit(code);
// Prove it with the audit.
try {
  execFileSync(process.execPath, [join(BRAND, "tools/audit.mjs"), "--format", "text", "--only", "social:"], { stdio: "inherit" });
} catch (err) {
  process.exit(err.status ?? 1);
}
