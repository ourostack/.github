import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { canonicalUrl } from "./canonical.mjs";

const RAW = "https://raw.githubusercontent.com/ourostack/.github/main/brand/";
const sha = (s) => createHash("sha256").update(s).digest("hex");

// A raw CDN right after a merge: the branch URL still answers with the previous bytes, a commit URL never does.
const cdn = (url, { merged, previous }) => (url.includes("/main/") ? previous : url.includes(`/${merged.sha}/`) ? merged.bytes : null);

// 11-17: the push of #236 audited main's URL minutes after merging and read the old flow-review bytes.
test("the commit under audit is read at its own URL, not through main's cached one", () => {
  const merged = { sha: "20db001", bytes: "new" };
  const want = sha("new");
  const fetchBytes = (ref) => cdn(canonicalUrl(RAW, "headers/flow-review.webp", ref), { merged, previous: "old" });
  assert.notEqual(sha(fetchBytes("")), want, "main's URL is the stale one in this scenario");
  assert.equal(sha(fetchBytes(merged.sha)), want);
});

test("with no commit the URL is main's", () => {
  assert.equal(canonicalUrl(RAW, "a.png", ""), RAW + "a.png");
  assert.equal(canonicalUrl(RAW, "a.png", "abc"), "https://raw.githubusercontent.com/ourostack/.github/abc/brand/a.png");
});
