# AGENTS.md

This repository holds the ourostack organization profile, the canonical brand (the storybook world at dawn, Ouro on its glowing trail, and each product's character in its own scene; everything another surface shows comes from `brand/`), and the shared agent guidance that ourostack, spoonjoy and arimendelow repositories point to.

## Shared agent guidance for every repository

Each rule lives in [`agents/`](agents/), and each repository's AGENTS.md links to it.

- **[Every PR merges within 30 minutes](agents/prs-merge-within-30-minutes.md).** Finish, review and validate on the branch, then publish with `gh ouro-pr` so auto-merge is on and green means merged. Question every check that isn't in CI. The [PR clock](agents/prs-merge-within-30-minutes.md#the-pr-clock) pins an issue here listing every PR open past 30 minutes and what is holding it.

## The rule: a branding update reaches every surface

A branding update (a new or redrawn header, mark, crop, card or icon) is done only when every surface in [`brand/surfaces.json`](brand/surfaces.json) carries it and the audit is green. Merging the art here is the start, not the end.

1. **Change the art here first.** Put the file in `brand/` and record it in `brand/provenance.json`: its source, the prompt chain and references (for anything drawn) or the exact crop and encoder (for anything derived), and its sha256. Derived files come from `python3 brand/tools/derive.py`; never hand-edit them. Keep Ouro on-model: one head, one tail, the "O" curl, the same face.
2. **Find every surface.** `brand/surfaces.json` lists them: the organization profile, the Ouro Labs enterprise's README and avatar (github.com/enterprises/ouro), every repository README and social preview, npm package pages, and every page of ouroboros.bot (Ouro MD's download page included, at /ouro-md/download/) and ui.ouroboros.bot (favicons, touch icons, Open Graph and Twitter cards, heroes).
3. **Bring it to each one** through that surface's own route (below).
4. **Run the audit** and fix what it names:

   ```sh
   node brand/tools/audit.mjs --format text
   ```

   It exits 0 when every surface is current, 1 when any is stale or a repository is missing from the registry, and 3 when it cannot check (set `GH_TOKEN`). Every problem line comes with a `fix:`. `--format json` gives one document for agents; `--only site:` limits it to ids with that prefix. The same audit runs here on every push, pull request and each morning (`.github/workflows/brand-audit.yml`).

   A website's own CI can audit a pull request's build before it ships: serve the build, then run `node brand/tools/audit.mjs --only site:<host> --origin http://127.0.0.1:<port>` from a checkout of this repository. `--origin` reads the site's pages, sitemap and same-site URLs from that host instead of the registered origin, and needs `--only` to name exactly one registered website.

**A new surface goes into the registry in the same change that creates it.** A new repository gets a README header and a social preview entry (draw its scene with the prompt chain in `provenance.json`); a new site or page gets a `website` entry or a sitemap the audit already walks. The audit fails on any ourostack repository that is neither registered nor excluded with a reason.

## How each kind of surface takes the brand

| Kind | Where it lives | How to update it |
| --- | --- | --- |
| `github-readme` | the top of each repository's README (the profile: `profile/README.md` here) | A small README-only PR in that repository whose first lines are the header block below; merge when green. |
| `github-social-preview` | repository Settings > General > Social preview | GitHub has no API for this. `node brand/tools/upload-social-previews.mjs` uploads every stale one through a background copy of the local Edge profile; it needs github.com signed in there once and stops with exit 3 if not. |
| `github-avatar` | the Ouro Labs enterprise profile picture, https://github.com/enterprises/ouro/settings/profile | Upload the mark there (Profile picture > Upload new picture), then set `servedSha256` in `surfaces.json` to the sha256 of the avatar URL. GitHub re-encodes uploads to 460x460, so the audit compares that re-encode, not `brand/` bytes. |
| `github-enterprise-readme` | the README on https://github.com/enterprises/ouro | Edit it there (README > Edit); its first lines are the header block below. It is not in a repository, and only a token with `read:enterprise` can read it, so CI lists it as `manual`; run the audit locally after `gh auth refresh -s read:enterprise` to check it. |
| `npm-readme` | the package page on npmjs.com | Ships with the package's next release; the audit shows it as waiting until then. |
| `website` | ouroboros.bot (ourostack/ouroboros-website), ui.ouroboros.bot (ourostack/ouro-ui `site/`) | Copy each file byte-for-byte to `/brand/storybook/<same path>` on the site (no re-encoding), reference it from the page, deploy through the repository's CI. |

README header block (use the scene's own alt text, written for someone who can't see it):

```html
<!-- ourostack:brand:start -->
<p align="center">
  <a href="https://github.com/ourostack"><img src="https://raw.githubusercontent.com/ourostack/.github/main/brand/headers/<scene>.webp" alt="<what the scene shows>" width="100%"></a>
</p>
<!-- ourostack:brand:end -->
```

A site page carries the brand when:

- its hero is a `<picture data-brand-scene="<scene>">` with `scenes/<scene>-{640,960,1536}` (AVIF, then WebP) and `phone/<scene>-{384,768}` for narrow screens (4:3 by default; a scene with `phoneAspect` in `brand/tools/crops.json` is wider, so size the phone hero from the file's own width and height and never crop it again with `object-fit`), eager and `fetchpriority="high"`; scenes below the fold are lazy;
- `rel=icon` serves `icons/ouro.svg` (or `icons/ouro-hx.svg` on Ouro HX pages) and `rel=apple-touch-icon` serves `icons/<mark>-180.png`;
- `og:image` and `twitter:image` are the same 1200x630 card: `og/<scene>.jpg` itself, or a card the site composes on it at build time (the registry says which).

## What is not a brand surface

App icons (Ouro MD's icon, the Apple apps') are product identity and do not change with a brand update. Forks keep their upstream README and identity. `surfaces.json` lists every exclusion with its reason.

## Git

- Commit email: `16390116+arimendelow@users.noreply.github.com`.
- No AI attribution in commits, pull requests or files.
