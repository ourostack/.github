// The two steps that need GitHub's sudo mode, in one browser session and one approval (a tap on GitHub Mobile, or a
// passkey in a visible Edge window): (a) create the ourostack org ruleset from ruleset.json, then delete the per-repo
// copies; (b) delete the archived repository ourostack/zz-trailer-proof (the API token lacks delete_repo).
// GitHub keeps sudo for a few hours, so the second step asks nothing more. Each step is skipped when already done, so a
// rerun after a missed approval picks up where it stopped. Waits up to 15 minutes for the approval, then closes cleanly (exit 4).
//   node tools/no-ai-trailer/batch-sudo-steps.mjs          # --dry stops before each final click
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openAs } from "../github-browser/browser.mjs";
import { awaitSudo } from "../github-browser/sudo.mjs";

const dry = process.argv.includes("--dry");
const file = fileURLToPath(new URL("./ruleset.json", import.meta.url));
const remove = fileURLToPath(new URL("./apply-repo-rulesets.sh", import.meta.url));
const gh = (...a) => execFileSync("gh", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const exists = (path) => { try { gh("api", path); return true; } catch (e) { if (/404/.test(String(e.stderr))) return false; throw e; } };
// The token has no admin:org, so listing org rulesets 404s; a repository's effective rules name each rule's source.
const orgHasRuleset = () => JSON.parse(gh("api", "repos/ourostack/.github/rules/branches/main")).some((r) => r.ruleset_source_type === "Organization");

// Runs the step, waits out a sudo prompt if one appears, and repeats it once if GitHub dropped it on the way through sudo.
async function step(s, what, action, done) {
  try { await action(s.page); } catch (e) { if (e.dry) return console.log(e.message); throw e; }
  await awaitSudo(s, { what, redo: action });
  if (await done(s.page)) return console.log(`done: ${what}`);
  await action(s.page);
  await awaitSudo(s, { what, redo: action });
  if (!(await done(s.page))) throw new Error(`Did not finish: ${what}`);
}

const createRuleset = async (page) => {
  await page.goto("https://github.com/organizations/ourostack/settings/rules");
  await page.locator("main button:has-text('New ruleset')").first().click();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator("text=Import a ruleset").first().click()]);
  await chooser.setFiles(file);
  await page.waitForURL(/imported_ruleset/);
  if (dry) throw Object.assign(new Error("dry run: stopped before Create"), { dry: true });
  await page.locator("main button:has-text('Create')").last().click();
};
const rulesetDone = (page) => page.waitForURL(/settings\/rules\/\d+/, { timeout: 30000 }).then(() => true, () => false);

const deleteRepo = async (page) => {
  await page.goto("https://github.com/ourostack/zz-trailer-proof/settings");
  await page.locator("button:has-text('Delete this repository')").first().click();
  for (const label of ["I want to delete this repository", "I have read and understand these effects"]) {
    const b = page.locator(`button:has-text("${label}")`).first();
    await b.waitFor({ timeout: 10000 });
    await b.click();
  }
  await page.locator("input[data-test-selector=repo-delete-proceed-confirmation]").first().fill("ourostack/zz-trailer-proof");
  if (dry) throw Object.assign(new Error("dry run: stopped before the final Delete"), { dry: true });
  await page.locator("dialog[open] button:has-text('Delete this repository'), [role=dialog] button:has-text('Delete this repository')").last().click();
};
const repoGone = async () => { await new Promise((r) => setTimeout(r, 3000)); return !exists("repos/ourostack/zz-trailer-proof"); };

const s = await openAs("arimendelow");
let code = 0;
try {
  if (!orgHasRuleset()) {
    await step(s, "create the ourostack org ruleset", createRuleset, rulesetDone);
    if (!dry) console.log("ruleset created:", s.page.url());
  } else console.log("org ruleset already exists");
  if (!dry) execFileSync("bash", [remove, "--remove"], { stdio: "inherit" });
  if (exists("repos/ourostack/zz-trailer-proof")) {
    await step(s, "delete the archived repository ourostack/zz-trailer-proof", deleteRepo, repoGone);
    if (!dry) console.log("zz-trailer-proof deleted");
  } else console.log("zz-trailer-proof already gone");
} catch (e) {
  console.error(e.message); code = e.exit ?? 1;
} finally { await s.close(); }
process.exit(code);
