import assert from "node:assert/strict";
import { test } from "node:test";
import { qualifies, run, setTransport } from "./rerun-main-flakes.mjs";

const now = Date.parse("2026-11-20T12:00:00Z");
const base = { event: "push", head_branch: "main", conclusion: "failure", run_attempt: 1, updated_at: "2026-11-20T11:30:00Z" };

test("only a first-attempt failed push to the default branch qualifies", () => {
  assert.ok(qualifies(base, "main", now));
  assert.ok(!qualifies({ ...base, run_attempt: 2 }, "main", now), "a second failure stays red");
  assert.ok(!qualifies({ ...base, conclusion: "cancelled" }, "main", now));
  assert.ok(!qualifies({ ...base, event: "pull_request" }, "main", now));
  assert.ok(!qualifies({ ...base, head_branch: "x" }, "main", now));
  assert.ok(!qualifies({ ...base, updated_at: "2026-11-20T09:00:00Z" }, "main", now), "too old");
});

test("re-runs the newest failed run per workflow once, and skips archived repos and forks", () => {
  const posts = [];
  setTransport((path, method) => {
    if (path.startsWith("orgs/")) {
      return [
        { full_name: "o/a", default_branch: "main" },
        { full_name: "o/old", default_branch: "main", archived: true },
        { full_name: "o/fork", default_branch: "main", fork: true },
      ];
    }
    if (method === "POST") return posts.push(path), {};
    return { workflow_runs: [
      { ...base, id: 2, workflow_id: 7, name: "ci", head_sha: "abcdef123456" },
      { ...base, id: 1, workflow_id: 7, name: "ci", head_sha: "0000000000" },
    ] };
  });
  const done = run({ log: () => {}, now });
  assert.deepEqual(posts, ["repos/o/a/actions/runs/2/rerun-failed-jobs"]);
  assert.deepEqual(done, ["o/a#2"]);
  const dry = run({ dryRun: true, log: () => {}, now });
  assert.deepEqual(dry, ["o/a#2"]);
  assert.equal(posts.length, 1, "a dry run posts nothing");
  setTransport(null);
});
