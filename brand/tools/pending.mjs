// A surface that is stale only because a brand merge landed a moment ago is pending, not stale: the websites
// sync themselves (ouroboros-website's sync-brand.yml opens, checks and merges a pull request) and the Mac's
// scheduled browser job uploads social previews (GitHub has no API for them). Pending turns stale, so red,
// once the window since the brand merge has passed. A surface that is stale for any other reason is never pending.

// Minutes after a brand merge that a surface may still be catching up.
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
