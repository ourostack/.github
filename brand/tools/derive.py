#!/usr/bin/env python3
"""Derive every site and social asset from the storybook headers.

    python3 brand/tools/derive.py          # write the files and their provenance entries
    python3 brand/tools/derive.py --check  # exit 1 if a file differs from provenance.json

Nothing here draws anything new. Each file is an honest crop, resize or
recomposition of a header or a character mark already in brand/, so Ouro stays
exactly on-model. The crop centres live in brand/tools/crops.json. Each output
gets an entry in brand/provenance.json naming its source file and that file's
sha256, the exact operation, and its own sha256, so the audit can prove a
surface carries these bytes.

Needs Pillow with WebP and AVIF (Pillow 11.3 was used). Another Pillow or
libwebp/libaom build may encode different bytes; if so, commit the new files and
their new provenance together.
"""
import hashlib
import io
import json
import sys
from pathlib import Path

from PIL import Image, features

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / "brand"
PROVENANCE = BRAND / "provenance.json"
CROPS = json.loads((BRAND / "tools" / "crops.json").read_text())

APPROVAL = (
    "Ari made the storybook headers and asked us to build on them, 2026-11-06: "
    "\"you'll also see i made new brand assets for the github surfaces - let's "
    "build on those further and bring em to the site etc :)\""
)
DERIVED_APPROVAL = APPROVAL + " Derived by crop, resize or recomposition only; nothing new is drawn."

# The dawn sky from headers/ourostack.webp, sampled at its top edge and its horizon.
DAWN_TOP = (253, 214, 178)
DAWN_BOTTOM = (255, 236, 196)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def encode(im: Image.Image, fmt: str) -> bytes:
    buf = io.BytesIO()
    if fmt == "webp":
        im.save(buf, "WEBP", quality=82, method=6)
    elif fmt == "avif":
        im.save(buf, "AVIF", quality=60, speed=4)
    elif fmt == "jpg":
        im.save(buf, "JPEG", quality=88, optimize=True, progressive=False, subsampling=0)
    elif fmt == "png":
        im.save(buf, "PNG", optimize=True)
    else:
        raise ValueError(fmt)
    return buf.getvalue()


ENCODERS = {
    "webp": "Pillow WebP quality 82 method 6",
    "avif": "Pillow AVIF quality 60 speed 4",
    "jpg": "Pillow JPEG quality 88, 4:4:4, optimized",
    "png": "Pillow PNG optimized",
}


def crop_centre(im: Image.Image, width: int, centre: int) -> tuple:
    left = max(0, min(im.width - width, round(centre - width / 2)))
    return (left, 0, left + width, im.height)


def build():
    """Yield (relative path, bytes, provenance entry without sha) for every derived file."""
    for scene in sorted(CROPS):
        if scene.startswith("_"):
            continue
        src_rel = f"headers/{scene}.webp"
        src_bytes = (BRAND / src_rel).read_bytes()
        src = Image.open(io.BytesIO(src_bytes)).convert("RGB")
        base = {"derivedFrom": {"file": src_rel, "sha256": sha(src_bytes)}}
        c = CROPS[scene]

        # Responsive widths of the whole scene, for site heroes.
        for w in (640, 960, 1536):
            h = round(src.height * w / src.width)
            im = src if w == src.width else src.resize((w, h), Image.LANCZOS)
            for fmt in ("webp", "avif"):
                if fmt == "webp" and w == src.width:
                    continue  # the header itself is the 1536 WebP
                op = "whole scene" if w == src.width else f"whole scene resized to {w}x{h} (Lanczos)"
                yield f"scenes/{scene}-{w}.{fmt}", encode(im, fmt), {
                    **base, "use": "site hero, responsive width", "operation": op, "encoder": ENCODERS[fmt]}

        # Phone hero: a 4:3 window around the subject, at 1x and 2x. A scene whose
        # story is wider than 4:3 (two characters far apart) sets phoneAspect.
        aw, ah = c.get("phoneAspect", [4, 3])
        box = crop_centre(src, round(src.height * aw / ah), c["phone"])
        phone = src.crop(box)
        for w in (384, 768):
            h = round(phone.height * w / phone.width)
            im = phone.resize((w, h), Image.LANCZOS)
            for fmt in ("webp", "avif"):
                yield f"phone/{scene}-{w}.{fmt}", encode(im, fmt), {
                    **base, "use": f"phone hero ({aw}:{ah})",
                    "operation": f"crop box {list(box)} then resize to {w}x{h} (Lanczos)",
                    "encoder": ENCODERS[fmt]}

        # GitHub social preview, 1280x640.
        box = crop_centre(src, round(src.height * 2), c["wide"])
        im = src.crop(box).resize((1280, 640), Image.LANCZOS)
        yield f"social/{scene}.jpg", encode(im, "jpg"), {
            **base, "use": "GitHub social preview (1280x640)",
            "operation": f"crop box {list(box)} then resize to 1280x640 (Lanczos)", "encoder": ENCODERS["jpg"]}

        # Open Graph / Twitter card, 1200x630.
        box = crop_centre(src, round(src.height * 1200 / 630), c["wide"])
        im = src.crop(box).resize((1200, 630), Image.LANCZOS)
        yield f"og/{scene}.jpg", encode(im, "jpg"), {
            **base, "use": "Open Graph and Twitter card (1200x630)",
            "operation": f"crop box {list(box)} then resize to 1200x630 (Lanczos)", "encoder": ENCODERS["jpg"]}

    # Touch and app-manifest icons: the approved rich render on the dawn sky.
    for mark in ("ouro", "ouro-hx"):
        src_rel = f"{mark}.png"
        src_bytes = (BRAND / src_rel).read_bytes()
        render = Image.open(io.BytesIO(src_bytes)).convert("RGBA")
        for size in (180, 192, 512):
            bg = Image.new("RGB", (size, size))
            for y in range(size):
                t = y / max(1, size - 1)
                row = tuple(round(DAWN_TOP[i] + (DAWN_BOTTOM[i] - DAWN_TOP[i]) * t) for i in range(3))
                bg.paste(row, (0, y, size, y + 1))
            inner = round(size * 0.84)
            mark_im = render.resize((inner, inner), Image.LANCZOS)
            off = (size - inner) // 2
            bg.paste(mark_im, (off, off), mark_im)
            yield f"icons/{mark}-{size}.png", encode(bg, "png"), {
                "derivedFrom": {"file": src_rel, "sha256": sha(src_bytes)},
                "use": "apple-touch-icon (180) and web app manifest icons (192, 512)",
                "operation": f"render resized to {inner}x{inner} (Lanczos), centred on a {size}x{size} vertical dawn gradient {DAWN_TOP}->{DAWN_BOTTOM}",
                "encoder": ENCODERS["png"]}


def main():
    check = "--check" in sys.argv
    if not (features.check("webp") and features.check("avif")):
        sys.exit("Pillow needs WebP and AVIF support")
    prov = json.loads(PROVENANCE.read_text())
    by_file = {e["file"]: e for e in prov}
    bad = []
    for rel, data, entry in build():
        digest = sha(data)
        path = BRAND / rel
        if check:
            have = path.read_bytes() if path.exists() else b""
            if sha(have) != by_file.get(rel, {}).get("sha256"):
                bad.append(rel)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        im = Image.open(io.BytesIO(data))
        by_file[rel] = {"file": rel, **entry, "approval": DERIVED_APPROVAL,
                        "width": im.width, "height": im.height, "bytes": len(data), "sha256": digest}
    if check:
        if bad:
            print("differs from provenance.json:\n  " + "\n  ".join(bad))
            sys.exit(1)
        print("every derived file matches provenance.json")
        return
    for e in by_file.values():
        if e["file"].startswith("headers/"):
            e["approval"] = APPROVAL
    PROVENANCE.write_text(json.dumps(list(by_file.values()), indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {sum(1 for f in by_file if '/' in f and not f.startswith('headers/'))} derived files")


if __name__ == "__main__":
    main()
