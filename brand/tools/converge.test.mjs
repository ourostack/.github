import assert from "node:assert/strict";
import test from "node:test";
import { decide, keyOf } from "./converge.mjs";

const issue = { number: 7 };
const A = ["site:ouroboros.bot", "social:housesitter"];

test("stale surfaces and no open issue opens one", () => {
  assert.deepEqual(decide({ staleIds: A, issue: null }), { action: "open", key: keyOf(A) });
});

test("an open issue gets a comment only when the stale set changed", () => {
  assert.deepEqual(decide({ staleIds: A, issue, lastKey: keyOf(A) }), { action: "none" });
  assert.deepEqual(decide({ staleIds: [...A].reverse(), issue, lastKey: keyOf(A) }), { action: "none" });
  assert.deepEqual(decide({ staleIds: A.slice(0, 1), issue, lastKey: keyOf(A) }), { action: "comment", key: keyOf(A.slice(0, 1)) });
  assert.equal(decide({ staleIds: A, issue, lastKey: undefined }).action, "comment");
});

test("a green audit closes the open issue and does nothing without one", () => {
  assert.deepEqual(decide({ staleIds: [], issue }), { action: "close" });
  assert.deepEqual(decide({ staleIds: [], issue: null }), { action: "none" });
});
