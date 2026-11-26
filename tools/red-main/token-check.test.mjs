import assert from "node:assert/strict";
import { test } from "node:test";
import { check } from "./token-check.mjs";

test("reports write access and warns where the token cannot revert or cannot read", async () => {
  const get = async (p) => {
    if (p.endsWith("/ok")) return { permissions: { pull: true, push: true } };
    if (p.endsWith("/ro")) return { permissions: { pull: true, push: false } };
    throw new Error("HTTP 404");
  };
  const out = await check(["o/ok", "o/ro", "o/gone"], get);
  assert.equal(out[0], "o/ok: read yes, write (contents and pull requests) yes");
  assert.match(out[1], /^o\/ro: read yes, write .* no$/);
  assert.match(out[2], /^::warning::o\/ro: .*no write access/);
  assert.match(out[3], /^::warning::o\/gone: .*cannot read/);
  assert.equal(out.length, 4);
});

test("a token that may push by account but is refused at the ref door is reported as no write", async () => {
  const get = async () => ({ permissions: { pull: true, push: true } });
  const out = await check(["o/a", "o/b"], get, async (r) => r === "o/a");
  assert.match(out[0], /^o\/a: .* yes$/);
  assert.match(out[1], /^o\/b: .* no$/);
  assert.match(out[2], /^::warning::o\/b: .*no write access/);
});

test("a write probe that loses its connection warns and goes on to the next repository", async () => {
  const get = async () => ({ permissions: { pull: true, push: true } });
  const probe = async (r) => { if (r === "o/a") throw Object.assign(new TypeError("fetch failed"), { cause: new Error("other side closed") }); return true; };
  const out = await check(["o/a", "o/b"], get, probe);
  assert.match(out[0], /^::warning::o\/a: could not tell whether the token may write \(other side closed\)/);
  assert.equal(out[1], "o/b: read yes, write (contents and pull requests) yes");
  assert.equal(out.length, 2);
});
