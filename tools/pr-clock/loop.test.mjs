import assert from "node:assert/strict";
import { test } from "node:test";
import { firstParents, liveTimes, percentile, render, summarize } from "./loop.mjs";

test("percentile is the nearest rank and ignores missing values", () => {
  assert.equal(percentile([5, 1, 3, null], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(percentile([], 50), null);
});

test("the default branch's line follows first parents only", () => {
  const nodes = [
    { oid: "m2", parent: "m1" },
    { oid: "b1", parent: "m0" },
    { oid: "m1", parent: "m0" },
    { oid: "m0", parent: "old" },
  ];
  assert.deepEqual(firstParents(nodes, "m2").map((commit) => commit.oid), ["m2", "m1", "m0"]);
});

test("a PR is live at the first successful deployment of its merge commit or a later one", () => {
  const line = [{ oid: "c3" }, { oid: "c2" }, { oid: "c1" }];
  const deployments = [
    // Created after c2 merged, but it ships c1: it doesn't make c2 live.
    { oid: "c1", environment: "github-pages", liveAt: "2026-11-19T10:05:00Z" },
    { oid: "c2", environment: "github-pages", liveAt: null },
    { oid: "c3", environment: "preview", liveAt: "2026-11-19T10:07:00Z" },
    { oid: "c3", environment: "github-pages", liveAt: "2026-11-19T10:12:00Z" },
    { oid: "branch", environment: "github-pages", liveAt: "2026-11-19T10:06:00Z" },
  ];
  const pulls = [{ createdAt: "2026-11-19T09:50:00Z", mergedAt: "2026-11-19T10:04:00Z", mergeOid: "c2" }];
  assert.equal(liveTimes(pulls, deployments, line)[0].liveAt, "2026-11-19T10:07:00Z");
  assert.equal(liveTimes(pulls, deployments, line, "github-pages")[0].liveAt, "2026-11-19T10:12:00Z");
  assert.equal(liveTimes([{ ...pulls[0], mergeOid: "c1" }], deployments, line, "github-pages")[0].liveAt, "2026-11-19T10:05:00Z");
  assert.equal(liveTimes([{ ...pulls[0], mergeOid: "elsewhere" }], deployments, line)[0].liveAt, null);
});

test("the summary times each stretch and counts red default-branch commits among settled ones", () => {
  const pulls = [
    { createdAt: "2026-11-19T10:00:00Z", mergedAt: "2026-11-19T10:10:00Z", liveAt: "2026-11-19T10:12:00Z" },
    { createdAt: "2026-11-19T11:00:00Z", mergedAt: "2026-11-19T11:30:00Z", liveAt: null },
  ];
  const commits = [{ state: "SUCCESS" }, { state: "FAILURE" }, { state: "ERROR" }, { state: "SUCCESS" }, { state: "PENDING" }, { state: null }];
  const numbers = summarize({ pulls, commits, hasDeployments: true });
  assert.deepEqual(numbers.openToMerge, { median: 10, p90: 30, n: 2 });
  assert.deepEqual(numbers.mergeToLive, { median: 2, p90: 2, n: 1 });
  assert.deepEqual(numbers.openToLive, { median: 12, p90: 12, n: 1 });
  assert.equal(numbers.mainRedShare, 0.5);
  assert.equal(numbers.mainSettled, 4);
  assert.equal(summarize({ pulls, commits, hasDeployments: false }).mergeToLive, null);
});

test("the report says when a repository has no deployments", () => {
  const numbers = summarize({ pulls: [{ createdAt: "2026-11-19T10:00:00Z", mergedAt: "2026-11-19T10:10:00Z" }], commits: [], hasDeployments: false });
  const text = render("o/r", 7, numbers);
  assert.match(text, /\| PR opened to merged \| 10 min \| 10 min \| 1 \|/);
  assert.match(text, /\| Merged to live \| no deployments \|/);
  assert.match(text, /Default branch red: –\./);
});
