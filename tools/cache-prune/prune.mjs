#!/usr/bin/env node
// Keeps a repository's Actions caches well under GitHub's 10 GB limit, and stops entries evicting each other.
// The decision is toDelete(); the CLI lists the caches with gh, deletes what toDelete() picks and prints the totals.
//
// The rule: a cache whose ref is not the default branch goes, since the default branch is what the workflows restore.
// On the default branch each family of keys keeps its newest entry (by created_at) and the rest go. A family is the
// key with its trailing content hashes removed (familyOf). Docker BuildKit's entries are never deleted, since their
// blobs are content-addressed and shared between images; a caller adds prefixes to skip with --skip or SKIP_PREFIXES.
//
// Usage (CI sets REPO and GH_TOKEN): node tools/cache-prune/prune.mjs [--dry-run] [--skip <prefix>]...
// --dry-run lists what would go and deletes nothing. The exit code is 1 when a delete fails for any reason but a 404
// (another run deleted it first), or when GitHub cannot be read, since nothing can then be decided.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// A trailing "-<16 or more hex>" segment is a content hash; a key with none is its own family.
const HASH = /-[0-9a-f]{16,}$/;
const RUN_NUMBER = /-\d+$/;
const BUILDKIT = [/^buildkit-blob-/, /^index-.+#\d+$/];
const PAGE_SIZE = 100;

/** The family of a cache key: the key without its trailing content hashes, then without a run number. */
export function familyOf(key) {
  let family = key;
  let hashes = 0;
  while (HASH.test(family)) {
    family = family.replace(HASH, "");
    hashes += 1;
  }
  if (hashes === 0 || family === "") return key;
  return family.replace(RUN_NUMBER, "");
}

const isSkipped = (key, skip) => BUILDKIT.some((pattern) => pattern.test(key)) || skip.some((prefix) => key.startsWith(prefix));

const time = (cache) => Date.parse(cache.createdAt) || 0;
const newestFirst = (a, b) => time(b) - time(a) || b.id - a.id;

/**
 * The caches to delete. Skipped keys are never returned. Any other cache from a ref that is not the default
 * branch is returned; on the default branch, each family keeps its newest cache and the rest are returned.
 */
export function toDelete(caches, { skip = [], defaultBranch } = {}) {
  if (!defaultBranch) throw new TypeError("toDelete needs the repository's defaultBranch");
  const defaultRef = `refs/heads/${defaultBranch}`;
  const prefixes = skip.filter(Boolean);
  const doomed = new Set();
  const families = new Map();
  for (const cache of caches) {
    if (isSkipped(cache.key, prefixes)) continue;
    if (cache.ref !== defaultRef) {
      doomed.add(cache);
      continue;
    }
    const family = familyOf(cache.key);
    if (!families.has(family)) families.set(family, []);
    families.get(family).push(cache);
  }
  for (const members of families.values()) {
    members.sort(newestFirst);
    for (const cache of members.slice(1)) doomed.add(cache);
  }
  return caches.filter((cache) => doomed.has(cache));
}

const formatBytes = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`);
const total = (caches) => caches.reduce((sum, cache) => sum + cache.sizeInBytes, 0);

function summarize(caches) {
  const families = new Map();
  for (const cache of caches) {
    const family = familyOf(cache.key);
    const entry = families.get(family) ?? { count: 0, bytes: 0 };
    entry.count += 1;
    entry.bytes += cache.sizeInBytes;
    families.set(family, entry);
  }
  return [...families].sort((a, b) => b[1].bytes - a[1].bytes);
}

/** Runs gh with the arguments; returns its status and output. */
export function ghCall(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 << 20 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function ghOk(gh, args) {
  const result = gh(args);
  if (result.status !== 0) throw new Error(`gh ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function listCaches(repo, gh) {
  const caches = [];
  for (let page = 1; ; page += 1) {
    const { actions_caches: batch = [] } = JSON.parse(ghOk(gh, ["api", `repos/${repo}/actions/caches?per_page=${PAGE_SIZE}&page=${page}`]));
    caches.push(...batch.map((cache) => ({ id: cache.id, key: cache.key, ref: cache.ref, sizeInBytes: cache.size_in_bytes, createdAt: cache.created_at })));
    if (batch.length < PAGE_SIZE) return caches;
  }
}

/** Prunes one repository. Returns the exit code: 0, or 1 when a delete failed for a reason other than a 404. */
export function run({ repo, dryRun = false, skip = [], gh = ghCall, log = console.log, err = console.error }) {
  if (!repo) throw new Error("REPO is not set (owner/name)");
  const defaultBranch = ghOk(gh, ["api", `repos/${repo}`, "--jq", ".default_branch"]).trim();
  const before = listCaches(repo, gh);
  const doomed = toDelete(before, { skip, defaultBranch });
  log(`${repo}: default branch ${defaultBranch}`);
  log(`before: ${before.length} caches, ${formatBytes(total(before))}`);
  log(`${dryRun ? "would delete" : "deleting"} ${doomed.length} caches, ${formatBytes(total(doomed))}, by family:`);
  for (const [family, { count, bytes }] of summarize(doomed)) log(`  ${family}: ${count} caches, ${formatBytes(bytes)}`);
  let failed = 0;
  for (const cache of doomed) {
    const label = `${cache.key} (${cache.ref}, ${formatBytes(cache.sizeInBytes)})`;
    if (dryRun) {
      log(`would delete ${label}`);
      continue;
    }
    const result = gh(["api", "-X", "DELETE", `repos/${repo}/actions/caches/${cache.id}`]);
    if (result.status === 0) log(`deleted ${label}`);
    else if (/HTTP 404/.test(result.stderr)) log(`already gone ${label}`);
    else {
      failed += 1;
      err(`could not delete ${label}: ${result.stderr.trim()}`);
    }
  }
  if (dryRun) {
    log("dry run: nothing deleted");
  } else {
    const after = listCaches(repo, gh);
    log(`after: ${after.length} caches, ${formatBytes(total(after))}`);
  }
  return failed === 0 ? 0 : 1;
}

function parseArgs(argv, env) {
  const options = { dryRun: false, skip: (env.SKIP_PREFIXES ?? "").split(/\s+/).filter(Boolean) };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dry-run") options.dryRun = true;
    else if (argv[i] === "--skip" && argv[i + 1] !== undefined) options.skip.push(argv[++i]);
    else throw new Error(`usage: prune.mjs [--dry-run] [--skip <prefix>]...  (unknown argument: ${argv[i]})`);
  }
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = run({ repo: process.env.REPO, ...parseArgs(process.argv.slice(2), process.env) });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
