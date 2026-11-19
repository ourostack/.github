import assert from "node:assert/strict";
import { test } from "node:test";
import { RULESET, cleanBody, messageFor, needsRearm, needsUpdate, readyWithoutAutoMerge, isUnmergeable, withRetry, processPrs, setTransport } from "./rearm-merges.mjs";

const green = { commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] } };

test("cleanBody drops AI and bot credit lines and keeps the rest", () => {
  const body = [
    "Fixes the thing.",
    "",
    "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>",
    "Co-authored-by: copilot-swe-agent[bot] <198982749+Copilot@users.noreply.github.com>",
    "Assisted-by: Claude",
    "Co-authored-by: Ari Mendelow <16390116+arimendelow@users.noreply.github.com>",
    "Desk-Task: a/b",
  ].join("\r\n");
  const out = cleanBody(body);
  assert.equal(out, "Fixes the thing.\n\nCo-authored-by: Ari Mendelow <16390116+arimendelow@users.noreply.github.com>\nDesk-Task: a/b");
  assert.ok(!RULESET.test(out));
});

test("cleanBody tolerates an empty body and collapses the gap a removed line leaves", () => {
  assert.equal(cleanBody(null), "");
  assert.equal(cleanBody("a\n\nCo-authored-by: Copilot <x>\n\nb"), "a\n\nb");
});

test("messageFor names the PR number in the headline", () => {
  assert.deepEqual(messageFor({ title: "Do it", number: 21, body: "x" }), { headline: "Do it (#21)", body: "x" });
});

test("needsRearm is true only for auto-merge on the default message", () => {
  assert.equal(needsRearm({ autoMergeRequest: null }), false);
  assert.equal(needsRearm({ autoMergeRequest: { commitHeadline: null } }), true);
  assert.equal(needsRearm({ autoMergeRequest: { commitHeadline: "Do it (#1)" } }), false);
});

test("readyWithoutAutoMerge needs green checks, no auto-merge, no review hold", () => {
  assert.equal(readyWithoutAutoMerge({ ...green, mergeStateStatus: "BLOCKED" }), true);
  assert.equal(readyWithoutAutoMerge({ ...green, mergeStateStatus: "CLEAN" }), true);
  assert.equal(readyWithoutAutoMerge({ ...green, mergeStateStatus: "DIRTY" }), false);
  assert.equal(readyWithoutAutoMerge({ ...green, mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }), false);
  assert.equal(readyWithoutAutoMerge({ ...green, mergeStateStatus: "BLOCKED", autoMergeRequest: {} }), false);
  assert.equal(readyWithoutAutoMerge({ ...green, mergeStateStatus: "BLOCKED", isDraft: true }), false);
  assert.equal(readyWithoutAutoMerge({ commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] }, mergeStateStatus: "BLOCKED" }), false);
});

test("isUnmergeable detects conflicting or unmergeable state", () => {
  assert.equal(isUnmergeable({ mergeable: "CONFLICTING", mergeStateStatus: "CLEAN" }), true);
  assert.equal(isUnmergeable({ mergeable: "MERGEABLE", mergeStateStatus: "CONFLICTING" }), true);
  assert.equal(isUnmergeable({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }), false);
  assert.equal(isUnmergeable({ mergeable: "UNKNOWN", mergeStateStatus: "CLEAN" }), false);
});

test("needsUpdate is true only for an armed PR that is behind its base", () => {
  assert.equal(needsUpdate({ autoMergeRequest: { mergeMethod: "SQUASH" }, mergeStateStatus: "BEHIND" }), true);
  assert.equal(needsUpdate({ autoMergeRequest: null, mergeStateStatus: "BEHIND" }), false);
  assert.equal(needsUpdate({ autoMergeRequest: { mergeMethod: "SQUASH" }, mergeStateStatus: "BLOCKED" }), false);
});

test("withRetry retries a GitHub 5xx with backoff and then succeeds", () => {
  const waits = [];
  let calls = 0;
  const out = withRetry(() => { if (++calls < 3) throw Object.assign(new Error("failed"), { stderr: "gh: HTTP 502" }); return "ok"; }, { delays: [1, 2, 3], sleep: (ms) => waits.push(ms), log: () => {} });
  assert.equal(out, "ok");
  assert.deepEqual(waits, [1, 2]);
});

test("withRetry gives up after the last delay and never retries a non-5xx error", () => {
  let calls = 0;
  assert.throws(() => withRetry(() => { calls++; throw Object.assign(new Error("x"), { stderr: "gh: HTTP 503" }); }, { delays: [1, 1], sleep: () => {}, log: () => {} }), /x/);
  assert.equal(calls, 3);
  calls = 0;
  assert.throws(() => withRetry(() => { calls++; throw Object.assign(new Error("x"), { stderr: "gh: HTTP 403" }); }, { delays: [1, 1], sleep: () => {}, log: () => {} }));
  assert.equal(calls, 1);
});

const racing = {
  id: "PR_1", number: 103, title: "T", body: "", mergeStateStatus: "CLEAN",
  repository: { nameWithOwner: "o/r" },
  autoMergeRequest: { mergeMethod: "SQUASH", commitHeadline: null },
};

function withTransport(reread) {
  setTransport((query) => {
    if (query.includes("disablePullRequestAutoMerge")) {
      throw Object.assign(new Error("x"), { stderr: "Can't disable auto-merge for this pull request." });
    }
    return reread;
  });
}

test("a write that lost a race with a merge counts as done", () => {
  withTransport({ node: { state: "MERGED", autoMergeRequest: null } });
  try {
    assert.equal(processPrs([racing], new Set()).failed, 0);
  } finally {
    setTransport(null);
  }
});

test("a write that fails and persists on re-read fails the job", () => {
  withTransport({ node: { state: "OPEN", autoMergeRequest: { commitHeadline: null } } });
  try {
    assert.equal(processPrs([racing], new Set()).failed, 1);
  } finally {
    setTransport(null);
  }
});

test("withRetry treats a GraphQL 'Something went wrong' and a secondary rate limit as transient", () => {
  for (const stderr of ["Something went wrong while executing your query. E840:1:2", "You have exceeded a secondary rate limit"]) {
    let calls = 0;
    assert.equal(withRetry(() => { if (++calls < 2) throw Object.assign(new Error("failed"), { stderr }); return "ok"; }, { delays: [1], sleep: () => {}, log: () => {} }), "ok");
  }
});

import { stuckReason, failedChecks, processQueue } from "./rearm-merges.mjs";

const failing = { commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] } };
const T0 = Date.parse("2026-11-19T15:00:00Z");
const entry = (over = {}, pr = {}) => ({ id: "E1", repo: "o/r", base: "main", state: "QUEUED", enqueuedAt: "2026-11-19T15:00:00Z", pullRequest: { id: "P1", number: 7, title: "T", mergeable: "MERGEABLE", ...pr }, ...over });

test("failedChecks reports a failing rollup", () => {
  assert.deepEqual(failedChecks(failing), ["required checks"]);
  assert.deepEqual(failedChecks(green), []);
});

test("stuckReason: unmergeable and conflicting leave at once, failed checks after 10 minutes", () => {
  assert.equal(stuckReason(entry({ state: "UNMERGEABLE" }), T0), "unmergeable");
  assert.equal(stuckReason(entry({}, { mergeable: "CONFLICTING" }), T0), "conflict");
  assert.equal(stuckReason(entry({}, failing), T0 + 9 * 60000), null);
  assert.equal(stuckReason(entry({}, failing), T0 + 11 * 60000), "failed-checks");
  assert.equal(stuckReason(entry({ state: "UNMERGEABLE" }, failing), T0), "failed-checks");
  assert.equal(stuckReason(entry(), T0 + 3600000), null);
});

test("processQueue dequeues, comments on a conflict once, and updates and re-arms a stale base", () => {
  const calls = [];
  setTransport((q, v) => {
    calls.push([q.match(/dequeuePullRequest|updatePullRequestBranch|enablePullRequestAutoMerge|addComment|comments\(/)?.[0], v.id]);
    if (/comments\(/.test(q)) return { node: { comments: { nodes: [] } } };
    return {};
  });
  const logs = [];
  const r = processQueue([entry({}, { mergeable: "CONFLICTING" }), entry({ state: "UNMERGEABLE" }, { id: "P2", number: 8 }), entry()], { now: T0, log: (m) => logs.push(m) });
  setTransport(null);
  assert.equal(r.dequeued, 2);
  assert.deepEqual(calls.map((c) => c[0]), ["dequeuePullRequest", "comments(", "addComment", "dequeuePullRequest", "updatePullRequestBranch", "enablePullRequestAutoMerge"]);
});

test("processQueue dry run changes nothing", () => {
  setTransport(() => assert.fail("no writes in a dry run"));
  const r = processQueue([entry({ state: "UNMERGEABLE" })], { dryRun: true, log: () => {} });
  setTransport(null);
  assert.equal(r.dequeued, 0);
});
