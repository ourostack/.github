// A surface that is stale only because a brand merge landed a moment ago is pending, not stale: the websites
// sync themselves (ouroboros-website's sync-brand.yml opens, checks and merges a pull request) and the Mac's
// scheduled browser job uploads social previews (GitHub has no API for them). Pending turns stale, so red,
// once the window since the brand merge has passed. A surface that is stale for any other reason is never pending.
// On a pull request the same lag is "after-merge" (afterMergeFor below), because only the merge can start the sync.

// Minutes after a brand merge that a surface may still be catching up. Sized from measurements (2026-11-18):
// ouroboros-website's sync pull requests took 3 to 17 minutes from opened to merged in 8 of 9 cases (median 4), and one
// took 96 because site-checks never started on it (fixed in ouroboros-website's sync-brand.yml, which now starts it by
// hand and retries rate limits), so 90 is five times the slow normal case. The social-preview runner uploads every 30
// minutes, so 240 covers eight of its runs. Shrinking either means a sync that retries once goes red.
export const WINDOWS = { website: 90, "github-social-preview": 240 };

// Problems that say "these bytes are not the brand's current bytes", which is what a sync not having run yet looks like.
export const isByteLag = (problem) => /\bis not brand\//.test(problem);

// mergedAt: when the newest brand art commit reached main (a Date, or null when unknown).
// id: the surface's id; autoSync: id prefixes in brand/surfaces.json whose sync runs by itself (a surface with no automatic sync is stale at once).
// live: true only for the audit of production on main; a pull request's or a build's audit (BRAND_REF, --origin) has no sync to wait for.
export function pendingFor({ id, autoSync, kind, problems, mergedAt, now = new Date(), live }) {
  const minutes = WINDOWS[kind];
  if (!autoSync?.some((prefix) => id?.startsWith(prefix))) return null;
  if (!live || minutes === undefined || !mergedAt || !problems.length) return null;
  const ageMinutes = (now - mergedAt) / 60000;
  if (ageMinutes < 0 || ageMinutes >= minutes) return null;
  if (!problems.every(isByteLag)) return null;
  return { ageMinutes: Math.floor(ageMinutes), minutes };
}

// A pull request's audit checks what the pull request can make true: its bytes, masters, derived files and gates. A surface
// that has an automatic sync and whose every problem is byte lag against the PR's own bytes can only catch up after the merge,
// so it is "after-merge" (listed, not failed); the post-merge audit (brand/tools/converge.mjs) files an issue if it never does.
// pr: true only for a pull request's audit (BRAND_REF set, no --origin).
export function afterMergeFor({ id, autoSync, kind, problems, pr }) {
  if (!pr || WINDOWS[kind] === undefined || !problems.length) return null;
  if (!autoSync?.some((prefix) => id?.startsWith(prefix))) return null;
  return problems.every(isByteLag) ? { minutes: WINDOWS[kind] } : null;
}

// How a repository is registered in brand/surfaces.json: its github-about, README and social-preview entries and any exclusion.
export function registrationOf(registry, name) {
  const has = (kind) => registry.surfaces.some((s) => s.kind === kind && s.repo?.split("/")[1] === name);
  return JSON.stringify([has("github-about"), has("github-readme"), has("github-social-preview"), name in (registry.excluded ?? {})]);
}

// A repository missing from brand/surfaces.json is a fact about the organization, not about any one pull request, so a pull
// request's audit must not go red for one it does not touch: it is "unregistered-pending" (listed, counted, exit 0) and the
// post-merge audit (brand/tools/converge.mjs) files the one issue for it. A pull request that changes how the repository is
// registered (its entries or its exclusion differ from the base it was built on) still fails on its own mistake.
// pr: true only for a pull request's audit (BRAND_REF set, no --origin). main: the PR's base registry (audit.mjs reads it at BRAND_BASE), or null when unreadable (then it fails).
export function unregisteredFor({ pr, registry, main, name }) {
  if (!pr || !main) return "unregistered";
  return registrationOf(registry, name) === registrationOf(main, name) ? "unregistered-pending" : "unregistered";
}
