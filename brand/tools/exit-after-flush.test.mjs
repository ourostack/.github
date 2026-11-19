import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("./exit-after-flush.mjs", import.meta.url));
const run = (exit) => spawnSync("node", ["--input-type=module", "-e", `import { exitAfterFlush } from ${JSON.stringify(helper)}; process.stdout.write("x".repeat(300000)); ${exit}(3);`], { encoding: "utf8", maxBuffer: 1 << 26 });

test("a large report is not truncated by exiting", () => {
  const r = run("exitAfterFlush");
  assert.equal(r.stdout.length, 300000);
  assert.equal(r.status, 3);
});

test("plain process.exit truncates the same output (why the helper exists)", () => {
  assert.ok(run("process.exit").stdout.length < 300000);
});
