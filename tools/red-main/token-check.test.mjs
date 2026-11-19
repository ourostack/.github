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
