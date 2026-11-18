import assert from "node:assert/strict";
import { test } from "node:test";
import { familyOf, run, toDelete } from "../prune.mjs";

const hash = (digit) => digit.repeat(64);
const DEFAULT = "main";
const main = "refs/heads/main";
const pull = "refs/pull/42/merge";
const queue = "refs/heads/gh-readonly-queue/main/pr-9";
let nextId = 1;
const cache = (key, ref, createdAt = "2026-11-10T00:00:00Z", sizeInBytes = 1000) => ({ id: nextId++, key, ref, sizeInBytes, createdAt });
const prune = (caches, skip = []) => toDelete(caches, { skip, defaultBranch: DEFAULT });
const keys = (caches) => caches.map((entry) => entry.key);

test("familyOf strips trailing content hashes, one or several", () => {
  assert.equal(familyOf(`node-cache-Linux-x64-npm-${hash("0")}`), "node-cache-Linux-x64-npm");
  assert.equal(familyOf(`install-npm-ouro-nova-${hash("0")}`), "install-npm-ouro-nova");
  assert.equal(familyOf(`install-app-pw1.65.0-ouro-nova-${hash("1")}-${hash("2")}`), "install-app-pw1.65.0-ouro-nova");
});

test("familyOf reads a run number after the hashes, and keeps a key with no hash as its own family", () => {
  assert.equal(familyOf(`build-7-${hash("3")}`), "build");
  assert.equal(familyOf("install-npm-ouro-nova"), "install-npm-ouro-nova");
  assert.equal(familyOf("build-7"), "build-7");
  assert.equal(familyOf("x-0123456789abcde"), "x-0123456789abcde", "15 hex digits is not a hash");
});

test("toDelete deletes every cache from a ref that is not the default branch", () => {
  const prs = [
    cache(`install-app-pw1.65.0-shadcn-nova-${hash("1")}-${hash("2")}`, pull),
    cache(`install-npm-ouro-nova-${hash("3")}`, queue),
    cache("node-cache-Linux-x64-pnpm-" + hash("4"), pull),
  ];
  assert.deepEqual(keys(prune(prs)), keys(prs));
});

test("toDelete keeps the newest cache of each family on the default branch, by created_at and not list order", () => {
  const oldest = cache(`install-npm-ouro-nova-${hash("1")}`, main, "2026-11-10T00:00:00Z");
  const newest = cache(`install-npm-ouro-nova-${hash("2")}`, main, "2026-11-18T00:00:00Z");
  const middle = cache(`install-npm-ouro-nova-${hash("3")}`, main, "2026-11-14T00:00:00Z");
  const otherPreset = cache(`install-npm-ouro-vega-${hash("4")}`, main, "2026-11-01T00:00:00Z");
  assert.deepEqual(prune([newest, oldest, otherPreset, middle]), [oldest, middle]);
});

test("toDelete leaves a BuildKit cache alone on any ref, and does not count it in a family", () => {
  const blob = (digest) => cache(`buildkit-blob-1-sha256:${digest}`, pull);
  const index = cache("index-app-1-abc123#0", pull);
  const onMain = cache("index-app-1-abc123#1", main, "2026-11-18T00:00:00Z");
  const blobs = [blob("a".repeat(64)), blob("b".repeat(64))];
  assert.deepEqual(prune([...blobs, index, onMain]), []);
});

test("toDelete keeps a key that starts with a caller's skip prefix, on any ref", () => {
  const stryker = cache(`stryker-42-${"d".repeat(16)}-${"c".repeat(40)}`, pull);
  const other = cache(`install-npm-ouro-nova-${hash("e")}`, pull);
  assert.deepEqual(keys(prune([stryker, other], ["stryker-"])), [other.key]);
});

test("toDelete ignores an empty skip prefix, which would match every key", () => {
  const pr = cache(`install-npm-ouro-nova-${hash("1")}`, pull);
  assert.deepEqual(prune([pr], [""]), [pr]);
});

test("toDelete collapses exact duplicates of a key with no hash, and keeps distinct ones", () => {
  const first = cache("something-else", main, "2026-01-01T00:00:00Z");
  const second = cache("something-else", main, "2026-02-01T00:00:00Z");
  const distinct = cache("another-key", main, "2026-01-01T00:00:00Z");
  assert.deepEqual(prune([first, second, distinct]), [first]);
});

test("toDelete needs the default branch", () => {
  assert.throws(() => toDelete([]), TypeError);
});

/** A fake gh: a live list of caches, the default branch, and the ids whose delete answers with an error. */
function fakeGh(caches, { defaultBranch = DEFAULT, failures = {} } = {}) {
  const live = new Map(caches.map((entry) => [entry.id, entry]));
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args.includes("--jq")) return { status: 0, stdout: `${defaultBranch}\n`, stderr: "" };
    if (args.includes("DELETE")) {
      const id = Number(args.at(-1).split("/").pop());
      if (failures[id]) return { status: 1, stdout: "", stderr: failures[id] };
      live.delete(id);
      return { status: 0, stdout: "", stderr: "" };
    }
    const page = Number(new URL(`https://x/${args[1]}`).searchParams.get("page"));
    const size = 100;
    const batch = [...live.values()].slice((page - 1) * size, page * size);
    const actions_caches = batch.map((entry) => ({ id: entry.id, key: entry.key, ref: entry.ref, size_in_bytes: entry.sizeInBytes, created_at: entry.createdAt }));
    return { status: 0, stdout: JSON.stringify({ total_count: live.size, actions_caches }), stderr: "" };
  };
  return { gh, calls, live };
}

const deletes = (calls) => calls.filter((args) => args.includes("DELETE"));

test("run in dry-run prints what it would delete and never sends a DELETE", () => {
  const pr = cache(`install-npm-ouro-nova-${hash("1")}`, pull, "2026-11-10T00:00:00Z", 2_000_000);
  const { gh, calls } = fakeGh([pr]);
  const lines = [];
  const code = run({ repo: "owner/name", dryRun: true, gh, log: (line) => lines.push(line), err: () => assert.fail("no error expected") });
  assert.equal(code, 0);
  assert.equal(deletes(calls).length, 0);
  assert.ok(lines.includes("would delete 1 caches, 2.0 MB, by family:"));
  assert.ok(lines.includes(`would delete ${pr.key} (${pull}, 2.0 MB)`));
  assert.ok(lines.includes("  install-npm-ouro-nova: 1 caches, 2.0 MB"));
  assert.ok(lines.includes("dry run: nothing deleted"));
});

test("run deletes what toDelete picks, then lists the caches again", () => {
  const pr = cache(`install-npm-ouro-nova-${hash("1")}`, pull);
  const kept = cache(`install-npm-ouro-nova-${hash("2")}`, main, "2026-11-18T00:00:00Z");
  const { gh, calls, live } = fakeGh([pr, kept]);
  const lines = [];
  assert.equal(run({ repo: "owner/name", gh, log: (line) => lines.push(line) }), 0);
  assert.deepEqual(deletes(calls).map((args) => args.at(-1)), [`repos/owner/name/actions/caches/${pr.id}`]);
  assert.deepEqual([...live.keys()], [kept.id]);
  assert.ok(lines.some((line) => line.startsWith("after: 1 caches")));
});

test("run pages through the caches until a short page", () => {
  const caches = Array.from({ length: 250 }, (_, index) => cache(`key-${index}-${hash("1")}`, main, "2026-11-18T00:00:00Z"));
  const { gh, calls } = fakeGh(caches);
  run({ repo: "owner/name", dryRun: true, gh, log: () => {} });
  const listed = calls.filter((args) => args[1]?.includes("/actions/caches?")).map((args) => args[1].match(/[?&]page=(\d+)/)[1]);
  assert.deepEqual(listed, ["1", "2", "3"]);
});

test("run treats a delete that 404s as done, and exits 1 for any other failure", () => {
  const gone = cache(`install-npm-ouro-nova-${hash("1")}`, pull);
  const refused = cache(`install-npm-ouro-vega-${hash("2")}`, pull);
  const { gh } = fakeGh([gone, refused], { failures: { [gone.id]: "gh: Not Found (HTTP 404)", [refused.id]: "gh: Forbidden (HTTP 403)" } });
  const errors = [];
  const lines = [];
  const code = run({ repo: "owner/name", gh, log: (line) => lines.push(line), err: (line) => errors.push(line) });
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.startsWith(`already gone ${gone.key}`)));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /could not delete .*Forbidden/);
});

test("run passes the caller's skip prefixes through", () => {
  const stryker = cache(`stryker-42-${"e".repeat(16)}`, pull);
  const { gh, calls } = fakeGh([stryker]);
  run({ repo: "owner/name", skip: ["stryker-"], gh, log: () => {} });
  assert.equal(deletes(calls).length, 0);
});

test("run refuses to start without a repository", () => {
  assert.throws(() => run({ repo: "", gh: () => assert.fail("gh must not run") }), /REPO is not set/);
});
