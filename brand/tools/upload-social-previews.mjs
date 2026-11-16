#!/usr/bin/env node
// Upload each repository's social preview from brand/surfaces.json, through a signed-in browser.
// GitHub has no API for social previews, so this drives Settings > General > Social preview.
//
//   node brand/tools/upload-social-previews.mjs            # every stale social preview
//   node brand/tools/upload-social-previews.mjs desk ouroboros
//
// It never signs in and never types a password. Through tools/github-browser/browser.mjs it copies the sign-in files of the local
// Microsoft Edge profile (EDGE_PROFILE, default ~/Library/Application Support/Microsoft Edge/Default)
// into a scratch folder, opens Edge on that copy in the background, and stops with exit 3 if
// GITHUB_USER (default arimendelow) is neither signed in there nor in GitHub's account switcher: add it in
// that Edge profile once, then rerun. Needs `playwright` (npm i -g playwright) and Edge.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BRAND = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(readFileSync(join(BRAND, "surfaces.json"), "utf8"));
const user = process.env.GITHUB_USER ?? "arimendelow";
const wanted = process.argv.slice(2);


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

const { openAs } = await import("../../tools/github-browser/browser.mjs");
let code = 0;
let closeBrowser = async () => {};
try {
  const { page, close } = await openAs(user);
  closeBrowser = close;
  for (const s of jobs) {
    const file = join(BRAND, s.image);
    await page.goto(`https://github.com/${s.repo}/settings`);
    // GitHub's own id for the social preview input; the page also holds an unrelated feedback-form file input.
    const input = page.locator("#repo-image-file-input");
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
  await closeBrowser();
}
if (code) process.exit(code);
// Prove it with the audit.
try {
  execFileSync(process.execPath, [join(BRAND, "tools/audit.mjs"), "--format", "text", "--only", "social:"], { stdio: "inherit" });
} catch (err) {
  process.exit(err.status ?? 1);
}
