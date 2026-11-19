import { test } from "node:test";
import assert from "node:assert/strict";
import { orphanRuns, run } from "./cancel.mjs";

const q = (...oids) => JSON.stringify({ data: { repository: { mergeQueue: { entries: { nodes: oids.map((oid) => ({ headCommit: { oid } })) } } } } });
const mk = (id, sha, branch = "gh-readonly-queue/main/pr-1-x") => ({ id, name: "App", head_sha: sha, head_branch: branch });

test("orphanRuns keeps live groups and non-queue runs, and leaves all alone when the queue is empty", () => {
  const runs = [mk(1, "live"), mk(2, "gone"), mk(3, "gone", "main")];
  assert.deepEqual(orphanRuns(runs, ["live"]).map((r) => r.id), [2]);
  assert.deepEqual(orphanRuns(runs, []), []);
});

test("run cancels only the orphans, and a dry run cancels nothing", () => {
  const posts = [];
  const call = (args) => {
    if (args[1] === "graphql") return q("live");
    if (args.includes("POST")) return posts.push(args.at(-1)), "{}";
    return JSON.stringify({ workflow_runs: args[1].includes("status=queued") ? [mk(1, "live"), mk(2, "gone")] : [mk(3, "gone2")] });
  };
  const logs = [];
  assert.deepEqual(run({ repo: "o/r", call, log: (m) => logs.push(m), dryRun: true }), { cancelled: 0, failed: 0 });
  assert.equal(posts.length, 0);
  assert.deepEqual(run({ repo: "o/r", call, log() {} }), { cancelled: 2, failed: 0 });
  assert.deepEqual(posts, ["repos/o/r/actions/runs/2/cancel", "repos/o/r/actions/runs/3/cancel"]);
});

test("a failed cancel is counted and reported as an error", () => {
  const logs = [];
  const call = (args) => {
    if (args[1] === "graphql") return q("live");
    if (args.includes("POST")) throw Object.assign(new Error("x"), { stderr: "HTTP 403" });
    return JSON.stringify({ workflow_runs: [mk(2, "gone")] });
  };
  assert.equal(run({ repo: "o/r", call, log: (m) => logs.push(m) }).failed, 2);
  assert.match(logs[0], /^::error/);
});
