import assert from "node:assert/strict";
import { test } from "node:test";
import { a2aLine, awaitSudo, isWorkAccount, mobileNumber, personalAgent, pickSudoPath, queueSignin, routeLine } from "./sudo.mjs";

// A page that shows "Confirm access" with the given offers until `grant()` is called.
const fakePage = ({ offers, number = "42", shown = true }) => {
  const p = {
    shown, clicked: [], brought: 0,
    grant() { p.shown = false; },
    locator(sel) {
      const has = sel.includes("Confirm access") ? p.shown : sel.includes("github-mobile-available") ? offers.includes("mobile") : false;
      return {
        count: async () => (has ? 1 : 0),
        first: () => ({ click: async () => { p.clicked.push(sel); setTimeout(p.grant, 5); }, textContent: async () => ` ${number} ` }),
      };
    },
  };
  return p;
};
const fast = { pollMs: 2, probeMs: 20, waitMs: 500, log: () => {}, live: true };

test("offers GitHub Mobile first when GitHub lists it, even beside a passkey", async () => {
  assert.equal(await pickSudoPath(fakePage({ offers: ["mobile", "passkey"] })), "mobile");
  assert.equal(await pickSudoPath(fakePage({ offers: ["passkey"] })), "passkey");
});

test("mobile path: taps Use GitHub Mobile, sends the number to Teams, opens no window", async () => {
  const page = fakePage({ offers: ["mobile", "passkey"] });
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

test("outside the morning sitting the prompt is queued, nothing is shown or sent, and the flow is told", async () => {
  const page = fakePage({ offers: ["mobile", "passkey"] });
  const queued = [];
  const said = [];
  let relaunched = 0;
  const session = { page, relaunchHeadful: async () => { relaunched++; return page; } };
  await assert.rejects(
    awaitSudo(session, { ...fast, live: false, account: "someone", what: "delete a repository", resume: "node run.mjs", queue: (i) => queued.push(i), notify: (t) => said.push(t) }),
    (e) => e.signinQueued === true && e.exit === 5,
  );
  assert.deepEqual(queued, [{ what: "delete a repository", resume: "node run.mjs", account: "someone" }]);
  assert.deepEqual(said, []);
  assert.equal(relaunched + page.clicked.length, 0);
});

const NOW = new Date(2026, 10, 22, 9, 0);

test("an Enterprise Managed User or a listed account is work; every other account is personal", () => {
  assert.equal(isWorkAccount("someone_corp", {}), true);
  assert.equal(isWorkAccount("someone", {}), false);
  assert.equal(isWorkAccount("some-org", {}), false);
  assert.equal(isWorkAccount("Someone", { SUDO_WORK_ACCOUNTS: "other, someone" }), true);
});

const AGENT = { card: "http://127.0.0.1:1/card", name: "Pip", identityFile: null };

test("the personal agent comes from the environment, else from the morning batch's signin.json, else there is none", () => {
  const file = (json) => () => JSON.stringify(json);
  assert.deepEqual(personalAgent({}, file({ personal: { card: "http://a/card", name: "Pip", identityFile: "/k.json" } })), { card: "http://a/card", name: "Pip", identityFile: "/k.json" });
  assert.deepEqual(personalAgent({ SUDO_PERSONAL_CARD: "http://b/card", SUDO_A2A_IDENTITY_FILE: "/e.json" }, file({ personal: { card: "http://a/card" } })), { card: "http://b/card", name: "The personal agent", identityFile: "/e.json" });
  assert.equal(personalAgent({}, () => { throw new Error("ENOENT"); }), null);
  assert.equal(personalAgent({}, file({ hour: 8 })), null);
});

test("a personal account's live line goes to the personal agent as one intake item, deduped per account per day", async () => {
  const sent = [];
  const teams = [];
  const r = await routeLine({ account: "someone", line: "tap Approve on your phone", waitMs: 15 * 60_000 }, { agent: AGENT, personal: async (t, a) => { sent.push([t, a]); return true; }, teams: (t) => teams.push(t), now: NOW });
  assert.equal(r, "personal");
  assert.deepEqual(teams, []);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1], AGENT);
  for (const line of [/^from: the GitHub browser tool on .+, signed in as someone$/m, /^urgency: now$/m, /^ask: tap Approve on your phone$/m, /^why only Ari: /m, /^steps:$/m, /^deadline: 09:15 local today/m, /^dedupe key: github-sudo-someone-2026-11-22$/m]) assert.match(sent[0][0], line);
});

test("an unreachable personal agent falls back to Teams and says so; a work account, or no personal agent, goes to Teams only", async () => {
  const teams = [];
  let tried = 0;
  assert.equal(await routeLine({ account: "someone", line: "use your passkey" }, { agent: AGENT, personal: async () => { tried++; return false; }, teams: (t) => teams.push(t), now: NOW }), "fallback");
  assert.deepEqual(teams, ["Pip unreachable, so this came here. use your passkey"]);
  assert.equal(await routeLine({ account: "someone_corp", line: "a" }, { agent: AGENT, personal: async () => { tried++; return true; }, teams: (t) => teams.push(t), now: NOW }), "work");
  assert.equal(await routeLine({ account: "someone", line: "b" }, { agent: null, personal: async () => { tried++; return true; }, teams: (t) => teams.push(t), now: NOW }), "work");
  assert.equal(tried, 1);
  assert.deepEqual(teams.slice(1), ["a", "b"]);
});

test("a2aLine runs ouro a2a message with the card, --json and --why; a refusal or no connection is not sent, a timeout is", async () => {
  const calls = [];
  const quiet = console.error;
  console.error = () => {};
  const fake = (out) => (cmd, args, opts, cb) => { calls.push([cmd, args]); out(cb); };
  try {
    assert.equal(await a2aLine("hi", AGENT, fake((cb) => cb(null, '{"peerName":"pip","text":"ok"}\n', "")), "ouro"), true);
    assert.equal(calls[0][0], "ouro");
    assert.deepEqual(calls[0][1].slice(0, 7), ["a2a", "message", "--to", "http://127.0.0.1:1/card", "--text", "hi", "--json"]);
    assert.equal(calls[0][1][7], "--why");
    assert.ok(!calls[0][1].includes("--identity-file"));
    await a2aLine("hi", { ...AGENT, identityFile: "/k.json" }, fake((cb) => cb(null, "{}", "")));
    assert.deepEqual(calls[1][1].slice(-2), ["--identity-file", "/k.json"]);
    assert.equal(await a2aLine("hi", AGENT, fake((cb) => cb(new Error("exit 1"), '{"ok":false,"reason":"not-a-friend"}', ""))), false);
    assert.equal(await a2aLine("hi", AGENT, fake((cb) => cb(new Error("exit 1"), "", "fetch failed"))), false);
    assert.equal(await a2aLine("hi", AGENT, fake((cb) => cb(Object.assign(new Error("timed out"), { killed: true }), "", ""))), true);
  } finally { console.error = quiet; }
});

test("the queued item names the account, so the morning batch can tell work from personal", () => {
  const calls = [];
  queueSignin({ what: "rename it", resume: "node r.mjs", account: "someone_corp" }, (cmd, args) => calls.push(args));
  queueSignin({ what: "rename it", resume: "node r.mjs", account: "someone" }, (cmd, args) => calls.push(args));
  assert.match(calls[0][calls[0].indexOf("--why") + 1], /\(work GitHub account someone_corp\)$/);
  assert.match(calls[1][calls[1].indexOf("--why") + 1], /\(GitHub account someone\)$/);
});

test("awaitSudo waits for the line to finish sending before it returns", async () => {
  const page = fakePage({ offers: ["mobile"] });
  let finished = false;
  const notify = () => new Promise((r) => setTimeout(() => { finished = true; r(); }, 60));
  assert.equal(await awaitSudo({ page, relaunchHeadful: async () => page }, { ...fast, what: "x", redo: async () => {}, notify }), "mobile");
  assert.equal(finished, true);
});
