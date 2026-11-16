#!/usr/bin/env node
// Turn off "Require approval for workflow runs" and "Require approval for workflows on automation pull requests" in
// Settings > Copilot > Cloud agent, for every unarchived repository in an organization or the ones named. GitHub has no
// API for these, so it drives the settings page as GITHUB_USER (default arimendelow) through browser.mjs.
//
//   node tools/github-browser/copilot-workflow-approval.mjs              # every ourostack repository
//   node tools/github-browser/copilot-workflow-approval.mjs desk ouroboros
//   ORG=other node tools/github-browser/copilot-workflow-approval.mjs --check   # report only
import { execFileSync } from "node:child_process";
import { openAs } from "./browser.mjs";

const org = process.env.ORG ?? "ourostack";
const check = process.argv.includes("--check");
const named = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const repos = named.length ? named : JSON.parse(execFileSync("gh", ["repo", "list", org, "--no-archived", "--limit", "200", "--json", "name"], { encoding: "utf8" })).map((r) => r.name);
const TOGGLES = ["sweagentd-workflow-approval-ui-enable-label", "sweagentd-automation-workflow-approval-label"];

const { page, close } = await openAs();
let failed = 0;
try {
  for (const name of repos) {
    const res = await page.goto(`https://github.com/${org}/${name}/settings/copilot/coding_agent`);
    if (!res || res.status() !== 200) { console.log(`${name}: no Copilot settings page (${res?.status()})`); continue; }
    const states = [];
    for (const id of TOGGLES) {
      const button = page.locator(`button[aria-labelledby~="${id}"]`).first();
      if (!(await button.count())) { states.push(`${id.split("-")[1]}: absent`); continue; }
      const on = (await button.getAttribute("aria-pressed")) === "true";
      if (on && !check) {
        await button.click();
        await page.waitForFunction((el) => el.getAttribute("aria-pressed") === "false", await button.elementHandle(), { timeout: 15000 }).catch(() => {});
      }
      const now = (await button.getAttribute("aria-pressed")) === "true";
      if (now && !check) failed++;
      states.push(`${id.includes("automation") ? "automation PRs" : "workflow runs"}: ${on ? "on" : "off"}${on !== now ? " -> off" : ""}`);
    }
    console.log(`${name}: ${states.join("; ")}`);
  }
} finally {
  await close();
}
process.exit(failed ? 1 : 0);
