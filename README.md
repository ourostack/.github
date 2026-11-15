# Ouro anatomy sweep, 2026-11-15

Every image in ourostack/.github `brand/` that shows Ouro, light and dark, traced from the head round the curl to the tail tip against `brand/ouro.png`: one tube, one open "O" curl, open at the top right where the tail tip rises, belly on the inner curve only, one material, brand face.

- `masters/pair-<scene>.jpg`: Ouro from each scene's 4x master (or 3:1 native master), day beside night. `zoom-*`: closer looks.
- `crops/`: one crop per derived file (headers, upscaled, scenes, phone, og, social, icons, root marks), cut around Ouro's position mapped through the file's recorded crop box. `derived-trace.json` lists each file, Ouro's box in that file and whether the frame cuts him (`clipped`).
- `sheets/`: every framing of every scene side by side (header, phone 384 and 1536, og, social, scene 640 and 7680).
- `before-after/`: the two fixes.

## Result

- Scenes: 30 (59 light and dark headers), 1412 files traced.
- Failed: `workshop` and `workshop-dark` (closed ring with a separate tail from behind); fixed by the teaching guide's masters (ouroboros.bot hero v8, Ouro-only patch), derived to all 48 sizes here. `social/ouro-workbench-dark.jpg` cut Ouro's tail and body at the right edge; its crop centre moved (crops.json `wide` 760 to 868, night only).
- Everything else passes, including the root marks (`ouro.png`, butler, friends, shepherd, ouro-teams) and the app icons.
- Synced copies: ourostack/ouro-ui `site/public/brand/storybook/` (201 files) and ourostack/ouroboros-website `public/brand/storybook/` (909 files) are byte-identical to brand/; the website's own render marks and guide-hero crops pass. Its three retired flat SVG marks (`ouro-character`, `ouro-badge`, `ouro-silhouette`) draw a closed ouroboros ring, but no page uses them (`tests/brand-marks.test.mjs`).

| scene | light | dark |
|---|---|---|
| agent-workbench | pass | pass |
| apple-distribution-kit | pass | pass |
| ax-trail-map | pass | pass |
| butler | pass | pass |
| desk | pass | pass |
| factory | pass | pass |
| flow-review | pass | pass |
| friends | pass | pass |
| friends-relay | pass | pass |
| gatefold | pass | pass |
| glue-unstuck | pass | pass |
| homebrew-tap | pass | pass |
| housesitter | pass | pass |
| labs | pass | — |
| m365crawl | pass | pass |
| ouro-apps-site | pass | pass |
| ouro-hx | pass | pass |
| ouro-md | pass | pass |
| ouro-native-apple-app-shell | pass | pass |
| ouro-ui-apple | pass | pass |
| ouro-ui-core | pass | pass |
| ouro-work | pass | pass |
| ouro-workbench | pass | pass |
| ouroboros | pass | pass |
| ouroboros-skills | pass | pass |
| ouroboros-website | pass | pass |
| ourostack | pass | pass |
| playwright-focus-proof | pass | pass |
| shepherd | pass | pass |
| workshop | fixed | fixed |
