import assert from "node:assert/strict";
import { test } from "node:test";
import { restoreAccount } from "./browser.mjs";

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
