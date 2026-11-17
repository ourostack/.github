// Creates the ourostack org ruleset (ruleset.json) through the web UI's import, as arimendelow.
// GitHub asks for sudo mode on Create (passkey or GitHub Mobile), so one person approves the prompt while this runs.
//   node tools/no-ai-trailer/create-org-ruleset.mjs
// Afterwards delete the per-repo copies: tools/no-ai-trailer/apply-repo-rulesets.sh --remove
import { openAs } from "../github-browser/browser.mjs";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("./ruleset.json", import.meta.url));
let s;
for (let i = 0; i < 6 && !s; i++) { try { s = await openAs("arimendelow"); } catch (e) { if (i === 5) throw e; } }
const { page } = s;
let ok = false;
try {
  await page.goto("https://github.com/organizations/ourostack/settings/rules");
  await page.locator("main button:has-text('New ruleset')").first().click();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator("text=Import a ruleset").first().click()]);
  await chooser.setFiles(file);
  await page.waitForURL(/imported_ruleset/);
  await page.locator("main button:has-text('Create')").last().click();
  console.log("Approve the GitHub sudo prompt (passkey or GitHub Mobile); waiting up to 5 minutes.");
  await page.waitForURL(/settings\/rules\/\d+/, { timeout: 300000 });
  ok = true;
  console.log("created:", page.url());
} finally { await s.close(); }
process.exit(ok ? 0 : 1);
