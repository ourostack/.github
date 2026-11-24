import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fetchWithRetry } from "./fetch-retry.mjs";

async function server(statuses) {
  let n = 0;
  const s = http.createServer((req, res) => { const code = statuses[Math.min(n++, statuses.length - 1)]; res.writeHead(code, { "content-type": "image/avif" }); res.end(code === 200 ? "ok" : ""); });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${s.address().port}/x.avif`, calls: () => n, close: () => s.close() };
}
const fast = { sleep: async () => {} };

test("a CDN edge's transient 500 is retried until the asset answers", async () => {
  const s = await server([500, 500, 200]);
  const res = await fetchWithRetry(s.url, {}, fast);
  s.close();
  assert.equal(res.status, 200);
  assert.equal(s.calls(), 3);
});

test("a 500 that persists is reported after the last attempt", async () => {
  const s = await server([500]);
  const res = await fetchWithRetry(s.url, {}, fast);
  s.close();
  assert.equal(res.status, 500);
  assert.equal(s.calls(), 4);
});

test("a 404 is not retried", async () => {
  const s = await server([404]);
  const res = await fetchWithRetry(s.url, {}, fast);
  s.close();
  assert.equal(res.status, 404);
  assert.equal(s.calls(), 1);
});
