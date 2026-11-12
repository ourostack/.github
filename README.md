<p align="center">
  <img src="https://raw.githubusercontent.com/ourostack/.github/main/brand/headers/ourostack.webp" alt="Ouro and its friends at dawn in Ouro's world" width="100%">
</p>

# Ourostack GitHub profile

This repository holds the [organization profile](profile/README.md) and shared GitHub brand images.

The rich renders are the primary marks. Use one-colour silhouettes only for tiny placements and outline needs.

- `brand/ouro.png`: approved Ouro rich render, with its background removed.
- `brand/desk.png`: approved empty wooden Desk render, with its background removed.
- `brand/ouro-hx.png`: approved Ouro HX render: a human uses an interface while an agent builds it.
- `brand/ouro-md.png`: the existing native icon from `ourostack/ouro-md/Resources/AppIcon.png`, unchanged.
- `brand/shepherd.png`: Ouro Shepherd render, Ouro with a shepherd's staff, accepted for current use.
- `brand/friends.png`: Friends render, Ouro with two people and two robots; Friends and Friends Relay share it.
- `brand/factory.png`: Factory render, a warm ochre factory.
- `brand/headers/`: full-width scene headers for the organization profile and each repository README, all set in one storybook world at dawn: Ouro on its glowing trail with each product. `ourostack.webp` is the profile hero; each other file is named after its product or repository. Ari made them on 2026-11-06 and asked us to build on them.
- `brand/upscaled/`: each header upscaled 4x (6144 px wide) with Real-ESRGAN by `brand/tools/upscale.py`, from the lossless master where one is kept and otherwise from the header. Each is checked to be the same picture (luma SSIM at least 0.95 against its header) and is the source for site heroes wider than 1536 px. Ari asked for every undersized piece of art to be upscaled on 2026-11-12.
- `brand/scenes/`, `brand/phone/`, `brand/og/`, `brand/social/`, `brand/icons/`: every header again as responsive site heroes (AVIF and WebP, 640 to 7680 px wide; widths above 1536 come from `brand/upscaled/`), phone crops (4:3, or wider where two characters stand far apart), 1200x630 Open Graph cards, 1280x640 GitHub social previews, and touch icons, all cut by `brand/tools/derive.py` with nothing new drawn.
- `brand/provenance.json`: source, approval scope and copied-byte hashes; for each header, the prompt, reference images and model that drew it; for each derived file, its source and the exact crop.

## Every surface, every time

A branding update is done only when every surface carries it. [`brand/surfaces.json`](brand/surfaces.json) lists them all (the profile, every README and social preview, npm pages, and every page of ouroboros.bot, Ouro MD's download page included, and ui.ouroboros.bot), and one command checks them:

```sh
node brand/tools/audit.mjs --format text
```

It names each stale surface and how to fix it. Add a new surface to the registry when you make it. [AGENTS.md](AGENTS.md) has the whole routine.

Ouro UI is the parent, and its site, ui.ouroboros.bot, is named Ouro UI, in two halves: Ouro HX (human experience) and Ouro AX (agent experience). The site wears the Ouro HX render and mark; no approved Ouro AX mark is claimed here.
