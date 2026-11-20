import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockSignOut, isSignOut, lockProfile, profileDirFor, restoreAccount, seedProfile, startBudgetMs, switchTo, openAs } from "./browser.mjs";

// A page whose GitHub is signed in as `active`, with a switcher that lists `saved`.
const fakePage = (active, saved) => ({
  switched: [],
  goto(url) { this.url = url; },
  evaluate() { return active; },
  waitForLoadState() {},
  locator(sel) {
    const user = sel.match(/Select (.+)"/)[1];
    return { count: async () => (saved.includes(user) ? 1 : 0), first: () => ({ click: async () => { active = user; this.switched.push(user); } }) };
  },
});

test("switches back to the account that was active when the scratch copy opened", async () => {
  const page = fakePage("arimendelow", ["arimendelow", "arimendelow_microsoft"]);
  await restoreAccount(page, "arimendelow_microsoft");
  assert.deepEqual(page.switched, ["arimendelow_microsoft"]);
});

test("does nothing when that account is already active, or none was signed in", async () => {
  const page = fakePage("arimendelow_microsoft", ["arimendelow", "arimendelow_microsoft"]);
  await restoreAccount(page, "arimendelow_microsoft");
  await restoreAccount(page, "");
  assert.deepEqual(page.switched, []);
});

test("waits 60 s for Edge by default, and EDGE_START_SECONDS sets a longer wait", () => {
  assert.equal(startBudgetMs({}), 60_000);
  assert.equal(startBudgetMs({ EDGE_START_SECONDS: "60" }), 60_000);
  assert.equal(startBudgetMs({ EDGE_START_SECONDS: "nonsense" }), 60_000);
  assert.equal(startBudgetMs({ EDGE_START_SECONDS: "0" }), 60_000);
});

// The person's Edge profile, as files on disk, and a hash of everything in it.
const makeSource = () => {
  const root = mkdtempSync(join(tmpdir(), "gb-source-"));
  mkdirSync(join(root, "Default"));
  writeFileSync(join(root, "Local State"), "state");
  for (const f of ["Preferences", "Cookies", "Login Data"]) writeFileSync(join(root, "Default", f), `${f} of the person`);
  return join(root, "Default");
};
const hashTree = (dir) => createHash("sha256").update(readdirSync(dir, { recursive: true }).sort().map((f) => { try { return `${f}=${readFileSync(join(dir, f))}`; } catch { return f; } }).join("\n")).digest("hex");

test("a run as one account and a sign-out leave the person's profile untouched", async () => {
  const source = makeSource();
  const before = hashTree(join(source, ".."));
  const dest = join(mkdtempSync(join(tmpdir(), "gb-home-")), "profiles", "arimendelow");
  assert.equal(seedProfile({ source, dest }), true);
  // Everything the tool does happens in the copy: a switch and a sign-out rewrite its cookies.
  const page = fakePage("arimendelow_microsoft", ["arimendelow", "arimendelow_microsoft"]);
  await switchTo(page, "arimendelow");
  writeFileSync(join(dest, "Default", "Cookies"), "switched, then signed out");
  assert.equal(hashTree(join(source, "..")), before);
  assert.equal(readFileSync(join(source, "Cookies"), "utf8"), "Cookies of the person");
});

test("a seeded profile is kept: the second open does not copy again, so it never reads or rewrites the source", () => {
  const source = makeSource();
  const dest = join(mkdtempSync(join(tmpdir(), "gb-home-")), "p");
  seedProfile({ source, dest });
  writeFileSync(join(dest, "Default", "Cookies"), "this account's own");
  writeFileSync(join(source, "Cookies"), "changed in Edge since");
  assert.equal(seedProfile({ source, dest }), false);
  assert.equal(readFileSync(join(dest, "Default", "Cookies"), "utf8"), "this account's own");
  assert.equal(seedProfile({ source, dest, reseed: true }), true);
  assert.equal(readFileSync(join(dest, "Default", "Cookies"), "utf8"), "changed in Edge since");
});

test("refuses to use the person's own profile as the isolated one", () => {
  const source = makeSource();
  assert.throws(() => seedProfile({ source, dest: join(source, "..") }), /same folder/);
  assert.ok(existsSync(join(source, "Cookies")));
});

test("each account gets its own folder, outside the Edge profile", () => {
  const env = { GITHUB_BROWSER_HOME: "/x" };
  assert.equal(profileDirFor("a", env), "/x/profiles/a");
  assert.notEqual(profileDirFor("a", env), profileDirFor("b", env));
  assert.match(profileDirFor("a", {}), /\.local\/state\/github-browser\/profiles\/a$/);
});

test("sign-out requests are recognised and refused; ordinary pages are not", async () => {
  assert.ok(isSignOut("https://github.com/logout", "POST"));
  assert.ok(isSignOut("https://github.com/logout/"));
  assert.ok(isSignOut("https://github.com/sessions/logout"));
  assert.ok(!isSignOut("https://github.com/switch_account"));
  assert.ok(!isSignOut("https://github.com/ourostack/.github/settings"));
  let match, handler;
  await blockSignOut({ route: async (m, h) => { match = m; handler = h; } });
  assert.equal(match(new URL("https://github.com/logout")), true);
  assert.equal(match(new URL("https://github.com/")), false);
  let reason;
  handler({ abort: (r) => { reason = r; } });
  assert.equal(reason, "blockedbyclient");
});

test("one run per profile at a time; a dead run's lock is cleared", () => {
  const dest = mkdtempSync(join(tmpdir(), "gb-lock-"));
  const release = lockProfile(dest);
  assert.throws(() => lockProfile(dest), /another github-browser run/);
  release();
  writeFileSync(join(dest, ".lock"), "999999");
  const again = lockProfile(dest, { alive: () => false });
  again();
  assert.ok(!existsSync(join(dest, ".lock")));
});

test("openAs(user, {via}) uses the via profile's folder, so it fails on that profile's lock rather than user's own", async () => {
  const home = mkdtempSync(join(tmpdir(), "gb-via-"));
  const env = process.env.GITHUB_BROWSER_HOME;
  process.env.GITHUB_BROWSER_HOME = home;
  try {
    mkdirSync(join(home, "profiles", "a"), { recursive: true });
    writeFileSync(join(home, "profiles", "a", ".lock"), String(process.pid));
    await assert.rejects(openAs("b", { via: "a" }), (e) => e.exit === 3 && e.message.includes(join(home, "profiles", "a")));
  } finally {
    if (env === undefined) delete process.env.GITHUB_BROWSER_HOME; else process.env.GITHUB_BROWSER_HOME = env;
  }
});
