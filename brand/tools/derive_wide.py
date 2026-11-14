#!/usr/bin/env python3
"""Cut the site widths wider than the header again from each named scene's 4x master.

    python3 brand/tools/derive_wide.py gatefold-dark ouro-ui-core-dark   # write the files and their provenance entries

For scenes whose wide files (scenes/<scene>-2304 and up) were cut from something
smaller than the master (the 1536 px header) or from a master that is not in brand/,
such as night scenes, which are not in crops.json. It cuts again exactly the wide
widths and formats each scene already has, the same way derive.py cuts a day scene:
the master resized with Lanczos, encoded with derive.py's encoders. Run upscale.py
first for a scene with no master.
"""
import io
import json
import re
import sys

from PIL import Image, features

from derive import BRAND, PROVENANCE, UPSCALE_APPROVAL, ENCODERS, encode, sha


def build(scenes):
    for scene in scenes:
        header = Image.open(BRAND / f"headers/{scene}.webp")
        up_rel = f"upscaled/{scene}.webp"
        if not (BRAND / up_rel).exists():
            sys.exit(f"{scene}: no {up_rel}; run python3 brand/tools/upscale.py {scene} first")
        up_bytes = (BRAND / up_rel).read_bytes()
        up = Image.open(io.BytesIO(up_bytes)).convert("RGB")
        base = {"derivedFrom": {"file": up_rel, "sha256": sha(up_bytes)}, "approval": UPSCALE_APPROVAL}
        wide = sorted(
            (int(m[1]), m[2])
            for f in (BRAND / "scenes").iterdir()
            if (m := re.fullmatch(rf"{re.escape(scene)}-(\d+)\.(avif|webp)", f.name)) and int(m[1]) > header.width
        )
        if not wide:
            sys.exit(f"{scene}: no scenes/{scene}-<width> file wider than its header")
        for w, fmt in wide:
            h = round(header.height * w / header.width)
            op = f"4x master resized to {w}x{h} (Lanczos)"
            if w > up.width:
                op += f", {w / up.width:g}x up from the {up.width} px master; no new detail is drawn"
            yield f"scenes/{scene}-{w}.{fmt}", encode(up.resize((w, h), Image.LANCZOS), fmt), {
                **base, "use": "site hero, responsive width", "operation": op, "encoder": ENCODERS[fmt]}


def main():
    scenes = sys.argv[1:]
    if not scenes:
        sys.exit("name the scenes, for example: python3 brand/tools/derive_wide.py gatefold-dark")
    if not (features.check("webp") and features.check("avif")):
        sys.exit("Pillow needs WebP and AVIF support")
    by_file = {e["file"]: e for e in json.loads(PROVENANCE.read_text())}
    n = 0
    for rel, data, entry in build(scenes):
        (BRAND / rel).write_bytes(data)
        im = Image.open(io.BytesIO(data))
        by_file[rel] = {"file": rel, **{k: v for k, v in entry.items() if k != "approval"},
                        "approval": entry["approval"], "width": im.width, "height": im.height,
                        "bytes": len(data), "sha256": sha(data)}
        n += 1
    PROVENANCE.write_text(json.dumps(list(by_file.values()), indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {n} wide files")


if __name__ == "__main__":
    main()
