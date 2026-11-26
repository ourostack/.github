import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("./exit-after-flush.mjs", import.meta.url));
const run = (exit) => spawnSync("node", ["--input-type=module", "-e", `import { exitAfterFlush } from ${JSON.stringify(helper)}; process.stdout.write("x".repeat(300000)); ${exit}(3);`], { encoding: "utf8", maxBuffer: 1 << 26 });

// Plain process.exit can cut off a large piped stdout, which is why the helper exists; whether it does on a given run is a race, so
// only the helper's guarantee is tested (a test asserting the truncation failed on main when the pipe happened to drain, run 45788709087).
test("a large report is not truncated by exiting", () => {
  const r = run("exitAfterFlush");
  assert.equal(r.stdout.length, 300000);
  assert.equal(r.status, 3);
});
