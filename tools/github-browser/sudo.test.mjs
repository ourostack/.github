import assert from "node:assert/strict";
import { test } from "node:test";
import { awaitSudo, mobileNumber, pickSudoPath } from "./sudo.mjs";

// A page that shows "Confirm access" with the given offers until `grant()` is called.
const fakePage = ({ offers, number = "42", shown = true }) => {
  const p = {
    shown, clicked: [], brought: 0,
    grant() { p.shown = false; },
    locator(sel) {
      const has = sel.includes("Confirm access") ? p.shown : offers.some((o) => sel.includes(o));
      return {
        count: async () => (has ? 1 : 0),
        first: () => ({ click: async () => { p.clicked.push(sel); setTimeout(p.grant, 5); }, innerText: async () => `Open GitHub Mobile and enter this number: ${number}` }),
      };
    },
  };
  return p;
};
const fast = { pollMs: 2, probeMs: 20, waitMs: 500, log: () => {} };

test("offers GitHub Mobile first when GitHub lists it, even beside a passkey", async () => {
  assert.equal(await pickSudoPath(fakePage({ offers: ["GitHub Mobile", "passkey"] })), "mobile");
  assert.equal(await pickSudoPath(fakePage({ offers: ["passkey"] })), "passkey");
});

test("mobile path: taps Use GitHub Mobile, sends the number to Teams, opens no window", async () => {
  const page = fakePage({ offers: ["GitHub Mobile", "passkey"] });
  const said = [];
  let relaunched = 0;
  const session = { page, relaunchHeadful: async () => { relaunched++; return page; } };
  const path = await awaitSudo(session, { ...fast, what: "create the org ruleset", redo: async () => {}, notify: (t) => said.push(t) });
  assert.equal(path, "mobile");
  assert.equal(relaunched, 0);
  assert.equal(page.clicked.length, 1);
  assert.equal(said.length, 1);
  assert.match(said[0], /create the org ruleset/);
  assert.match(said[0], /42/);
});

test("passkey-only path: reopens Edge visibly, repeats the step there, then waits", async () => {
  const first = fakePage({ offers: ["passkey"] });
  const visible = fakePage({ offers: ["passkey"] });
  const said = [];
  const redone = [];
  const session = { page: first, relaunchHeadful: async () => { session.page = visible; setTimeout(visible.grant, 20); return visible; } };
  const path = await awaitSudo(session, { ...fast, what: "delete a repository", redo: async (p) => redone.push(p), notify: (t) => said.push(t) });
  assert.equal(path, "passkey");
  assert.deepEqual(redone, [visible]);
  assert.match(said[0], /passkey/);
  assert.equal(first.clicked.length, 0);
});

test("no prompt means nothing is sent", async () => {
  const page = fakePage({ offers: [], shown: false });
  const said = [];
  assert.equal(await awaitSudo({ page }, { ...fast, what: "x", notify: (t) => said.push(t) }), "none");
  assert.deepEqual(said, []);
});

test("times out with a clear error when nobody approves", async () => {
  const page = fakePage({ offers: ["passkey"] });
  const session = { page, relaunchHeadful: async () => page };
  await assert.rejects(awaitSudo(session, { ...fast, waitMs: 30, what: "x", redo: async () => {}, notify: () => {} }), (e) => e.sudoTimeout === true);
});

test("reads the number off the page", async () => {
  assert.equal(await mobileNumber(fakePage({ offers: [], number: "7" })), "7");
});
