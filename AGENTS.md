# AGENTS.md

This repository holds the ourostack organization profile, the canonical brand (the storybook world at dawn, Ouro on its glowing trail, and each product's character in its own scene; everything another surface shows comes from `brand/`), and the shared agent guidance that ourostack, spoonjoy and arimendelow repositories point to.

## Shared agent guidance for every repository

Each rule lives in [`agents/`](agents/), and each repository's AGENTS.md links to it.

- **[Every PR merges within 30 minutes](agents/prs-merge-within-30-minutes.md).** Finish, review and validate on the branch, then publish with `gh ouro-pr` so auto-merge is on and green means merged. Question every check that isn't in CI. The [PR clock](agents/prs-merge-within-30-minutes.md#the-pr-clock) pins an issue here listing every PR open past 30 minutes and what is holding it.
- **[One paid seat, ever](agents/one-paid-seat.md).** arimendelow is the only org member and the only paid seat. Contributors are outside collaborators on public repositories or send PRs from forks; nobody is ever made an org member or given a private repository. Agents act as Ari or through a GitHub App. The seat guard on the PR clock issue goes red on a second seat.
- **[App Store submission: sign-in that passes App Review](agents/app-store-submission.md).** An app with a third-party login shows Sign in with Apple first, on every platform (Guideline 4.8). Run `apple-distribution-kit review login-services` in the app's CI, and check the signed build's entitlements, account deletion and the review notes before submitting.

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

   A website's own CI can audit a pull request's build before it ships: serve the build, then run `node brand/tools/audit.mjs --only site:<host> --origin http://127.0.0.1:<port>` from a checkout of this repository. `--origin` reads the site's pages, sitemap and same-site URLs from that host instead of the registered origin, and needs `--only` to name exactly one registered website. Add `--dist <build dir>` to also hash every file the build ships under the site's brand folder, so a copied file that no page links to is checked too.

**A new surface goes into the registry in the same change that creates it.** A new repository gets a README header and a social preview entry (draw its scene with the prompt chain in `provenance.json`); a new site or page gets a `website` entry or a sitemap the audit already walks. The audit fails on any ourostack repository that is neither registered nor excluded with a reason.

## How each kind of surface takes the brand

| Kind | Where it lives | How to update it |
| --- | --- | --- |
| `github-readme` | the top of each repository's README (the profile: `profile/README.md` here) | A small README-only PR in that repository whose first lines are the header block below; merge when green. |
| `github-org-profile` | the org page header (display name, description, URL) and its six pins | A signed-in owner sets them at https://github.com/organizations/ourostack/settings/profile and with Customize pins on https://github.com/ourostack; the audit compares both with `surfaces.json`. |
| `github-about` | every repository's About sidebar and its `family` custom property | `gh api -X PATCH repos/ourostack/<repo>` for the description and homepage, `gh api -X PUT repos/ourostack/<repo>/topics` for topics, and the org's custom properties page for `family`. The description is one plain sentence that matches the README's first line; topics include `ourostack` (and `labs` for labs, whose description starts with "Labs"). |
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

## Families

Every repository belongs to one product family, recorded as the org custom property `family` and as its `about:<repo>` entry in `surfaces.json`: `home` (this profile and the sites), `ouroboros` (the agent harness and what it needs), `desk`, `ouro-ui`, `apps`, `tools`, and `labs` (forks and experiments: tried in the open, not supported). A new repository gets its family in the same change that registers it, and a line in the matching section of `profile/README.md`. Labs repositories also carry the `labs` topic, so [one search](https://github.com/search?q=org%3Aourostack+topic%3Alabs+fork%3Atrue&type=repositories) lists them all.

## What is not a brand surface

App icons (Ouro MD's icon, the Apple apps') are product identity and do not change with a brand update. A fork whose default branch mirrors upstream (playwright) keeps upstream's README; its About line says why we fork it. A fork with its own default branch (cmux) gets our README and the labs header. `surfaces.json` lists every exclusion with its reason.

## Git

- Commit email: `16390116+arimendelow@users.noreply.github.com`.
- No AI attribution in commits, pull requests or files.
