import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, parseArgs, run, screen } from "../prune.mjs";

const DAY = 86_400_000;
const NOW = new Date("2026-11-18T12:00:00Z");
const DEFAULT = "main";
const REPO = "owner/name";
const ago = (days) => new Date(NOW.getTime() - days * DAY).toISOString();
const sha = (letter) => letter.repeat(40);

/** A branch record as decide() takes it. */
const branch = (overrides = {}) => ({
  name: "topic", sha: sha("a"), protected: false, rulesDeletion: false, aheadBy: 3, lastPushAt: ago(10), headCommitAt: ago(10), prs: [], targetOf: null, ...overrides,
});
/** A pull request as decide() takes it: from this repository, with its head sha and close time. */
const pull = (overrides = {}) => ({ number: 1, state: "closed", merged: false, closedAt: ago(4), headSha: sha("a"), ...overrides });
/** The action and reason decide() gives one branch. */
const outcome = (overrides) => {
  const [entry] = decide([branch(overrides)], { defaultBranch: DEFAULT, now: NOW });
  return [entry.action, entry.reason];
};

test("decide keeps the default branch, whatever its state", () => {
  assert.deepEqual(outcome({ name: "main", aheadBy: 0, lastPushAt: ago(30) }), ["keep", "default branch"]);
});

test("decide keeps a protected branch, and one a ruleset forbids deleting", () => {
  assert.deepEqual(outcome({ protected: true, aheadBy: 0 }), ["keep", "protected"]);
  assert.deepEqual(outcome({ rulesDeletion: true, aheadBy: 0 }), ["keep", "a ruleset forbids deleting"]);
});

test("decide keeps release and system branch names, and not a name that only starts like one", () => {
  for (const name of ["release/1.2", "releases/2", "hotfix/login", "v1.3.0", "gh-readonly-queue/main/pr-1", "gh-pages"]) {
    assert.deepEqual(outcome({ name, aheadBy: 0 }), ["keep", "release or system branch"], name);
  }
  for (const name of ["released-notes", "releasebot", "vendor/x"]) {
    assert.deepEqual(outcome({ name, aheadBy: 0 }), ["delete", "fully merged into main"], name);
  }
});

test("decide keeps a branch with an open PR, even one merged into the default branch", () => {
  const open = pull({ number: 7, state: "open", closedAt: null });
  assert.deepEqual(outcome({ aheadBy: 0, prs: [open] }), ["keep", "open PR #7"]);
});

test("decide keeps the base of an open PR, so a delete never closes that PR", () => {
  assert.deepEqual(outcome({ aheadBy: 0, targetOf: 8 }), ["keep", "open PR #8 targets it"]);
  assert.equal(screen(branch({ targetOf: 8 }), { defaultBranch: DEFAULT }).reason, "open PR #8 targets it");
});

test("decide keeps a branch pushed to in the last 3 days, even when fully merged", () => {
  assert.deepEqual(outcome({ aheadBy: 0, lastPushAt: ago(2) }), ["keep", "pushed 48h ago"]);
});

test("decide reads the tip's commit date when there is no push, and keeps a branch with no time at all", () => {
  assert.deepEqual(outcome({ lastPushAt: null, headCommitAt: ago(1) }), ["keep", "pushed 24h ago"]);
  assert.deepEqual(outcome({ lastPushAt: null, headCommitAt: null }), ["keep", "no push time known"]);
});

test("decide deletes a branch fully merged into the default branch", () => {
  assert.deepEqual(outcome({ aheadBy: 0 }), ["delete", "fully merged into main"]);
});

test("decide deletes a branch whose PR was closed unmerged 4 days ago and is unchanged since", () => {
  assert.deepEqual(outcome({ prs: [pull({ closedAt: ago(4) })] }), ["delete", "PR #1 closed unmerged 4 days ago, unchanged since"]);
});

test("decide keeps a branch whose PR was closed unmerged 2 days ago", () => {
  assert.deepEqual(outcome({ prs: [pull({ closedAt: ago(2) })] }), ["keep", "PR #1 closed unmerged 2 days ago"]);
});

test("decide keeps a branch closed unmerged 5 days ago whose head has moved on", () => {
  assert.deepEqual(outcome({ prs: [pull({ closedAt: ago(5), headSha: sha("b") })] }), ["keep", "PR #1 closed unmerged, branch changed since"]);
});

test("decide deletes a branch its PR squash-merged days ago and nothing changed since, and keeps one changed or merged inside the window", () => {
  assert.deepEqual(outcome({ prs: [pull({ merged: true, closedAt: ago(20) })] }), ["delete", "PR #1 merged 20 days ago, unchanged since"]);
  assert.deepEqual(outcome({ prs: [pull({ merged: true, closedAt: ago(20), headSha: "other" })] }), ["keep", "PR #1 merged, branch changed since"]);
  assert.deepEqual(outcome({ prs: [pull({ merged: true, closedAt: ago(2) })] }), ["keep", "PR #1 merged 2 days ago"]);
});

test("decide keeps a branch with no PR that is not merged, pushed inside the 14-day stale window", () => {
  assert.deepEqual(outcome({ prs: [], lastPushAt: ago(10) }), ["keep", "no PR, not merged, pushed 10 days ago"]);
  assert.deepEqual(outcome({ prs: [], lastPushAt: ago(13.9) }), ["keep", "no PR, not merged, pushed 13 days ago"]);
});

test("decide deletes a branch with no PR that is not merged once its last push is 14 days old, reading the tip's date when there is no push", () => {
  assert.deepEqual(outcome({ prs: [], lastPushAt: ago(14) }), ["delete", "no PR, not merged, last pushed 14 days ago"]);
  assert.deepEqual(outcome({ prs: [], lastPushAt: null, headCommitAt: ago(40) }), ["delete", "no PR, not merged, last pushed 40 days ago"]);
  const [entry] = decide([branch({ prs: [], lastPushAt: ago(20) })], { defaultBranch: DEFAULT, now: NOW, staleDays: 30 });
  assert.deepEqual([entry.action, entry.reason], ["keep", "no PR, not merged, pushed 20 days ago"]);
});

test("decide keeps a rescue/ branch with no PR however old, and still judges one with a PR by its PR", () => {
  assert.deepEqual(outcome({ name: "rescue/old-work", prs: [], lastPushAt: ago(90) }), ["keep", "rescue branch, no PR: a person decides"]);
  assert.deepEqual(outcome({ name: "rescue/old-work", aheadBy: 0, lastPushAt: ago(90) }), ["delete", "fully merged into main"]);
  assert.deepEqual(outcome({ name: "rescue/old-work", prs: [pull()] }), ["delete", "PR #1 closed unmerged 4 days ago, unchanged since"]);
});

test("decide judges the most recent PR by close date, not by list order", () => {
  const older = pull({ number: 1, merged: true, closedAt: ago(30) });
  const newer = pull({ number: 2, closedAt: ago(4) });
  assert.deepEqual(outcome({ prs: [newer, older] }), ["delete", "PR #2 closed unmerged 4 days ago, unchanged since"]);
});

test("parseArgs reads --dry-run, --min-age-days and --stale-days, and rejects a value that is not a number of days", () => {
  assert.deepEqual(parseArgs(["--dry-run", "--min-age-days", "5"]), { dryRun: true, minAgeDays: 5, staleDays: 14 });
  assert.deepEqual(parseArgs(["--stale-days", "30"]), { dryRun: false, minAgeDays: 3, staleDays: 30 });
  assert.deepEqual(parseArgs([]), { dryRun: false, minAgeDays: 3, staleDays: 14 });
  assert.throws(() => parseArgs(["--min-age-days", "-1"]), /--min-age-days takes a number of days/);
  assert.throws(() => parseArgs(["--min-age-days", "soon"]), /takes a number of days/);
  assert.throws(() => parseArgs(["--stale-days", "later"]), /--stale-days takes a number of days/);
  assert.throws(() => parseArgs(["--stale-days", "2"]), /must be at least --min-age-days/);
});

const topic = (name, letter, extra = {}) => ({
  name, sha: sha(letter), protected: false, aheadBy: 3, lastPush: ago(10), commitDate: ago(10), rules: [], ...extra,
});
/** A pull request as the pulls API returns it. */
const rawPull = ({ number, ref, headSha, state = "closed", merged = false, closedAt = ago(4), repo = REPO, base = DEFAULT }) => ({
  number, state, merged_at: merged ? closedAt : null, closed_at: state === "closed" ? closedAt : null,
  base: { ref: base }, head: { ref, sha: headSha, repo: { full_name: repo } },
});
const ok = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
const NOT_FOUND = { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };

/**
 * A fake gh over one repository. Each branch answers its endpoints: its last push, its tip's commit date, its ahead
 * count and rules, and optionally a tip that moved, a delete error, or an open PR that appears only on a head lookup.
 */
function fakeGithub({ branches = [], pulls = [], defaultBranch = DEFAULT } = {}) {
  const live = new Map(branches.map((entry) => [entry.name, entry]));
  const calls = [];
  const bySha = (value) => branches.find((entry) => entry.sha === value);
  const page = (items, url) => {
    const size = Number(url.searchParams.get("per_page") ?? 30);
    const number = Number(url.searchParams.get("page") ?? 1);
    return items.slice((number - 1) * size, number * size);
  };
  const gh = (args) => {
    calls.push(args);
    const path = args.find((arg) => arg.startsWith("repos/"));
    const url = new URL(`https://api.github.test/${path}`);
    const rest = url.pathname.slice(`/repos/${REPO}`.length);
    const nameAfter = (prefix) => rest.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
    if (args.includes("DELETE")) {
      const entry = live.get(nameAfter("/git/refs/heads/"));
      if (!entry) return NOT_FOUND;
      if (entry.deleteError) return { status: 1, stdout: "", stderr: entry.deleteError };
      live.delete(entry.name);
      return { status: 0, stdout: "", stderr: "" };
    }
    if (rest === "") return ok({ default_branch: defaultBranch });
    if (rest === "/branches") {
      return ok(page([...live.values()].map((entry) => ({ name: entry.name, commit: { sha: entry.sha }, protected: entry.protected })), url));
    }
    if (rest.startsWith("/branches/")) {
      const entry = live.get(nameAfter("/branches/"));
      return entry ? ok({ name: entry.name, commit: { sha: entry.movedTo ?? entry.sha }, protected: entry.protected }) : NOT_FOUND;
    }
    if (rest === "/pulls") {
      const state = url.searchParams.get("state") ?? "open";
      const head = url.searchParams.get("head")?.split(":")[1];
      const late = head ? branches.filter((entry) => entry.latePr).map((entry) => entry.latePr) : [];
      const matching = [...pulls, ...late].filter((entry) => (state === "all" || entry.state === state) && (head === undefined || entry.head.ref === head));
      return ok(page(matching, url));
    }
    if (rest.startsWith("/rules/branches/")) {
      const entry = live.get(nameAfter("/rules/branches/"));
      return entry ? ok(entry.rules) : NOT_FOUND;
    }
    if (rest === "/activity") {
      const entry = live.get(url.searchParams.get("ref").replace(/^refs\/heads\//, ""));
      return ok(entry?.lastPush ? [{ timestamp: entry.lastPush }] : []);
    }
    if (rest.startsWith("/commits/")) {
      const entry = bySha(rest.slice("/commits/".length));
      return ok({ sha: entry?.sha, commit: { committer: { date: entry?.commitDate ?? null } } });
    }
    if (rest.startsWith("/compare/")) {
      const entry = bySha(rest.slice("/compare/".length).split("...")[1]);
      if (entry?.unrelated) return { status: 1, stdout: "", stderr: `gh: No common ancestor between ${defaultBranch} and ${entry.sha}. (HTTP 404)` };
      return ok({ ahead_by: entry?.aheadBy ?? 0, behind_by: 0, status: "ahead" });
    }
    return { status: 1, stdout: "", stderr: `gh: unexpected ${path} (HTTP 500)` };
  };
  return { gh, calls };
}

const deletes = (calls) => calls.filter((args) => args.includes("DELETE")).map((args) => args.at(-1));
const logger = () => {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
};

const board = () => [
  topic("main", "1", { aheadBy: 0 }),
  topic("merged-old", "m", { aheadBy: 0, lastPush: ago(10) }),
  topic("open-pr", "o"),
  topic("fresh", "f", { aheadBy: 0, lastPush: ago(1) }),
  topic("unmerged", "u", { aheadBy: 4, lastPush: ago(10) }),
  topic("ruled", "r", { aheadBy: 0, rules: [{ type: "deletion" }] }),
  topic("stacked", "t", { aheadBy: 0 }),
];
const boardPulls = [
  rawPull({ number: 7, ref: "open-pr", headSha: sha("o"), state: "open", closedAt: null }),
  rawPull({ number: 9, ref: "stacked-child", headSha: sha("c"), state: "open", closedAt: null, base: "stacked" }),
];

test("run in dry-run lists what it would delete, counts what it would leave, and deletes nothing", () => {
  const { gh, calls } = fakeGithub({ branches: board(), pulls: boardPulls });
  const { lines, log } = logger();
  const errors = [];
  const code = run({ repo: REPO, dryRun: true, gh, log, err: (line) => errors.push(line), now: NOW });
  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(deletes(calls), []);
  assert.ok(lines.includes("owner/name: default branch main"));
  assert.ok(lines.includes("before: 7 branches"));
  assert.ok(lines.includes("would delete merged-old: fully merged into main"));
  assert.ok(lines.includes("kept 6:"));
  for (const kept of ["  default branch: 1", "  open PR: 1", "  open PR targets it: 1", "  pushed inside the window: 1", "  no PR, not merged: 1", "  a ruleset forbids deleting: 1"]) {
    assert.ok(lines.includes(kept), kept);
  }
  assert.ok(lines.includes("dry run: nothing deleted"));
  assert.ok(lines.includes("would leave: 6 branches"));
});

test("run deletes the branches the rule picks, checks each one first, and lists the branches again", () => {
  const abandoned = topic("fix/abandoned", "b", { aheadBy: 3, lastPush: ago(9) });
  const pulls = [...boardPulls, rawPull({ number: 8, ref: "fix/abandoned", headSha: sha("b"), closedAt: ago(4) })];
  const { gh, calls } = fakeGithub({ branches: [...board(), abandoned], pulls });
  const { lines, log } = logger();
  const errors = [];
  assert.equal(run({ repo: REPO, gh, log, err: (line) => errors.push(line), now: NOW }), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(deletes(calls), [`repos/${REPO}/git/refs/heads/merged-old`, `repos/${REPO}/git/refs/heads/fix/abandoned`]);
  assert.ok(lines.includes("deleted merged-old: fully merged into main"));
  assert.ok(lines.includes("deleted fix/abandoned: PR #8 closed unmerged 4 days ago, unchanged since"));
  assert.ok(lines.includes("before: 8 branches"));
  assert.ok(lines.includes("after: 6 branches"));
  assert.ok(!lines.includes("dry run: nothing deleted"));
});

test("run deletes a no-PR branch left 14 days, keeps a rescue/ one, and groups the kept by kind", () => {
  const branches = [topic("main", "1", { aheadBy: 0 }), topic("stale", "s", { lastPush: ago(20) }), topic("rescue/saved", "r", { lastPush: ago(60) }), topic("young", "y", { lastPush: ago(10) })];
  const { gh, calls } = fakeGithub({ branches });
  const { lines, log } = logger();
  assert.equal(run({ repo: REPO, gh, log, err: () => assert.fail("no error expected"), now: NOW }), 0);
  assert.deepEqual(deletes(calls), [`repos/${REPO}/git/refs/heads/stale`]);
  assert.ok(lines.includes("deleted stale: no PR, not merged, last pushed 20 days ago"));
  assert.ok(lines.includes("  rescue branch, no PR: a person decides: 1"));
  assert.ok(lines.includes("  no PR, not merged: 1"));
});

test("run treats a delete that 404s or 422s as done, and exits 1 for any other failure", () => {
  const { gh } = fakeGithub({
    branches: [
      topic("main", "1", { aheadBy: 0 }),
      topic("gone-404", "g", { aheadBy: 0, deleteError: "gh: Not Found (HTTP 404)" }),
      topic("gone-422", "h", { aheadBy: 0, deleteError: "gh: Reference does not exist (HTTP 422)" }),
      topic("gone-422-bare", "k", { aheadBy: 0, deleteError: "gh: Unprocessable Entity (HTTP 422)" }),
      topic("refused", "r", { aheadBy: 0, deleteError: "gh: Forbidden (HTTP 403)" }),
    ],
  });
  const { lines, log } = logger();
  const errors = [];
  assert.equal(run({ repo: REPO, gh, log, err: (line) => errors.push(line), now: NOW }), 1);
  assert.ok(lines.includes("already gone gone-404: fully merged into main"));
  assert.ok(lines.includes("already gone gone-422: fully merged into main"));
  assert.ok(lines.includes("already gone gone-422-bare: fully merged into main"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /could not delete refused: .*Forbidden/);
});

test("run skips a branch whose tip moved after the listing, and deletes nothing for it", () => {
  const { gh, calls } = fakeGithub({ branches: [topic("moved-tip", "m", { aheadBy: 0, movedTo: sha("c") })] });
  const { lines, log } = logger();
  assert.equal(run({ repo: REPO, gh, log, err: () => assert.fail("no error expected"), now: NOW }), 0);
  assert.deepEqual(deletes(calls), []);
  assert.ok(lines.includes("skipped moved-tip: its tip moved since the listing"));
});

test("run skips a branch that gained an open PR after the listing", () => {
  const late = rawPull({ number: 9, ref: "late-pr", headSha: sha("l"), state: "open", closedAt: null });
  const { gh, calls } = fakeGithub({ branches: [topic("late-pr", "l", { aheadBy: 0, latePr: late })] });
  const { lines, log } = logger();
  assert.equal(run({ repo: REPO, gh, log, err: () => assert.fail("no error expected"), now: NOW }), 0);
  assert.deepEqual(deletes(calls), []);
  assert.ok(lines.includes("skipped late-pr: an open PR appeared since the listing"));
});

test("run ignores a pull request from a fork, so a branch with only a fork's PR is kept", () => {
  const fork = rawPull({ number: 5, ref: "topic", headSha: sha("t"), repo: "someone/name" });
  const { gh, calls } = fakeGithub({ branches: [topic("topic", "t", { aheadBy: 2 })], pulls: [fork] });
  const { lines, log } = logger();
  assert.equal(run({ repo: REPO, gh, log, err: () => assert.fail("no error expected"), now: NOW }), 0);
  assert.deepEqual(deletes(calls), []);
  assert.ok(lines.includes("  no PR, not merged: 1"));
});

test("run keeps a branch with no common history with the default branch, and goes on to the rest", () => {
  const { gh, calls } = fakeGithub({ branches: [topic("orphan", "q", { aheadBy: 0, unrelated: true }), topic("merged-old", "m", { aheadBy: 0 })] });
  const { lines, log } = logger();
  assert.equal(run({ repo: REPO, gh, log, err: () => assert.fail("no error expected"), now: NOW }), 0);
  assert.deepEqual(deletes(calls), [`repos/${REPO}/git/refs/heads/merged-old`]);
  assert.ok(lines.includes("  no PR, not merged: 1"));
});

test("run pages through the branches until a short page", () => {
  const many = Array.from({ length: 250 }, (_, index) => topic(`topic-${index}`, "a", { sha: index.toString(16).padStart(40, "0"), aheadBy: 4 }));
  const { gh, calls } = fakeGithub({ branches: many });
  const { lines, log } = logger();
  run({ repo: REPO, dryRun: true, gh, log, now: NOW });
  const listed = calls.filter((args) => args[1]?.includes("/branches?per_page")).map((args) => args[1].match(/[?&]page=(\d+)/)[1]);
  assert.deepEqual(listed, ["1", "2", "3"]);
  assert.ok(lines.includes("before: 250 branches"));
});

test("run stops with an error when GitHub cannot be read", () => {
  assert.throws(() => run({ repo: REPO, gh: () => NOT_FOUND, log: () => {}, now: NOW }), /gh api repos\/owner\/name failed/);
});

test("run refuses to start without a repository", () => {
  assert.throws(() => run({ repo: "", gh: () => assert.fail("gh must not run") }), /REPO is not set/);
});
