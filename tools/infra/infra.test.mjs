import assert from "node:assert/strict";
import { test } from "node:test";
import { InfraError, exitInfra, isTransient } from "./infra.mjs";

test("isTransient recognises GitHub's transient failures only", () => {
  assert.ok(isTransient(504, {}));
  assert.ok(isTransient(200, { errors: [{ message: "Something went wrong while executing your query" }] }));
  assert.ok(isTransient(403, { message: "You have exceeded a secondary rate limit" }));
  assert.ok(!isTransient(200, { errors: [{ message: "Field 'x' doesn't exist" }] }));
  assert.ok(!isTransient(404, { message: "Not Found" }));
});

test("exitInfra prints the annotation red-main reads, with the request id", () => {
  const lines = [];
  let code;
  exitInfra(new InfraError("boom", "E840:1:2"), { log: (l) => lines.push(l), exit: (c) => (code = c) });
  assert.equal(lines[0], "::error title=infra::boom (GitHub request id E840:1:2)");
  assert.equal(code, 1);
});
