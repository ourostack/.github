import assert from "node:assert/strict";
import test from "node:test";
import { afterMergeFor, pendingFor, WINDOWS } from "./pending.mjs";

const now = new Date("2026-11-16T23:00:00Z");
const ago = (min) => new Date(now - min * 60000);
const ID = "site:ouroboros.bot";
const AUTO = ["site:ouroboros.bot", "site:ui.ouroboros.bot", "social:"];
const lag = ["/: og:image https://ouroboros.bot/brand/storybook/og/shepherd.jpg is not brand/og/shepherd.jpg (sha256 aaaaaaaaaaaa, want bbbbbbbbbbbb)"];

// 11-16: art merges #224, #227 and #228 each turned main red until the surfaces were synced by hand.
test("a website stale on bytes right after a brand merge is pending", () => {
  const p = pendingFor({ id: ID, autoSync: AUTO, kind: "website", problems: lag, mergedAt: ago(10), now, live: true });
  assert.deepEqual(p, { ageMinutes: 10, minutes: 90 });
});

test("the same staleness is real once the window has passed", () => {
  assert.equal(pendingFor({ id: ID, autoSync: AUTO, kind: "website", problems: lag, mergedAt: ago(91), now, live: true }), null);
  assert.equal(pendingFor({ id: ID, autoSync: AUTO, kind: "github-social-preview", problems: lag, mergedAt: ago(241), now, live: true }), null);
  assert.ok(pendingFor({ id: ID, autoSync: AUTO, kind: "github-social-preview", problems: lag, mergedAt: ago(200), now, live: true }));
});

test("a surface with no automatic sync is stale at once, and ui.ouroboros.bot has one", () => {
  assert.equal(pendingFor({ id: "site:other.example", autoSync: AUTO, kind: "website", problems: lag, mergedAt: ago(1), now, live: true }), null);
  assert.notEqual(pendingFor({ id: "site:ui.ouroboros.bot", autoSync: AUTO, kind: "website", problems: lag, mergedAt: ago(1), now, live: true }), null);
});

test("a problem that is not a byte difference is stale at once, even in the window", () => {
  const broken = [...lag, "/desk/: answered 404"];
  assert.equal(pendingFor({ id: ID, autoSync: AUTO, kind: "website", problems: broken, mergedAt: ago(1), now, live: true }), null);
  assert.equal(pendingFor({ id: ID, autoSync: AUTO, kind: "github-social-preview", problems: ["no custom social preview"], mergedAt: ago(1), now, live: true }), null);
});

test("a pull request's audit, a build's audit and kinds with no sync never wait", () => {
  assert.equal(pendingFor({ id: ID, autoSync: AUTO, kind: "website", problems: lag, mergedAt: ago(1), now, live: false }), null);
  assert.equal(pendingFor({ id: ID, autoSync: AUTO, kind: "github-readme", problems: lag, mergedAt: ago(1), now, live: true }), null);
  assert.equal(pendingFor({ id: ID, autoSync: AUTO, kind: "website", problems: lag, mergedAt: null, now, live: true }), null);
  assert.equal(pendingFor({ id: ID, autoSync: AUTO, kind: "website", problems: [], mergedAt: ago(1), now, live: true }), null);
});

test("the windows stay several times the measured sync times", () => {
  const slowNormalSyncMinutes = 17;
  const socialRunnerEveryMinutes = 30;
  assert.ok(WINDOWS.website >= 5 * slowNormalSyncMinutes);
  assert.ok(WINDOWS["github-social-preview"] >= 8 * socialRunnerEveryMinutes);
});

const pr = (o) => afterMergeFor({ id: ID, autoSync: AUTO, kind: "website", problems: lag, pr: true, ...o });

test("on a pull request, byte lag on a surface with an automatic sync is after-merge, for both kinds", () => {
  assert.deepEqual(pr({}), { minutes: 90 });
  assert.deepEqual(pr({ id: "social:housesitter", kind: "github-social-preview" }), { minutes: 240 });
});

test("on a pull request, anything the PR can make true stays stale", () => {
  assert.equal(pr({ problems: [...lag, "/desk/: answered 404"] }), null);
  assert.equal(pr({ kind: "github-social-preview", problems: ["no custom social preview"] }), null);
  assert.equal(pr({ id: "site:other.example" }), null);
  assert.equal(pr({ kind: "github-readme" }), null);
  assert.equal(pr({ problems: [] }), null);
});

test("outside a pull request nothing is after-merge, and the live main audit is unchanged", () => {
  assert.equal(pr({ pr: false }), null);
  assert.deepEqual(pendingFor({ id: ID, autoSync: AUTO, kind: "website", problems: lag, mergedAt: ago(10), now, live: true }), { ageMinutes: 10, minutes: 90 });
});
