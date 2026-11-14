#!/usr/bin/env python3
"""Cut the 1152 and 1536 px phone heroes for night scenes whose 384 and 768 px phone files were cut by hand.

    python3 brand/tools/derive_night_phone.py           # write the files and their provenance entries
    python3 brand/tools/derive_night_phone.py --check   # exit 1 if a file differs from provenance.json
    python3 brand/tools/derive_night_phone.py ourostack-dark   # just these scenes

The day scenes get these widths from derive.py. These night scenes are not in
crops.json: their 768 px phone crops were framed by hand (one stretches a strip
so Ouro clears the phone edge), and one has no 4x master in brand/. So each
large file here repeats the exact window of its scene's committed 768 px phone
file, recorded below, at the larger width. The window is cut from the scene's
4x master in brand/upscaled/ when there is one, otherwise from the header
itself; the playwright window is 1472 px of header wide, so its 1536 px file
is a 1.04x Lanczos resize. Nothing new is drawn. Encoders and approvals are
derive.py's.
"""
import io
import json
import sys

from PIL import Image, features

from derive import BRAND, DERIVED_APPROVAL, ENCODERS, PROVENANCE, UPSCALE_APPROVAL, encode, sha

WIDTHS = (1152, 1536)

# The window of each scene's committed phone/<scene>-768 file, in header pixels.
NIGHT = {
    "ouro-ui-core-dark": {"box": (700, 0, 1468, 576), "use": "phone hero (4:3)"},
    "ouro-ui-apple-dark": {"box": (328, 0, 1352, 576), "use": "phone hero (16:9)"},
    "ouro-hx-dark": {"box": (268, 0, 1292, 576), "use": "phone hero (16:9)"},
    "ouroboros-skills-dark": {"box": (120, 0, 1502, 576), "use": "phone hero (768:320)"},
    "ourostack-dark": {"box": (498, 0, 1522, 512), "use": "phone hero (2:1)"},
    # Right 46 px strip (x 1490-1536) stretched to 70 px, as the 768 px file was.
    "playwright-focus-proof-dark": {"box": (88, 0, 1560, 575), "use": "phone hero (2.56:1)", "strip": (1490, 70)},
}


def build(scenes=()):
    for scene, spec in NIGHT.items():
        if scenes and scene not in scenes:
            continue
        header_rel = f"headers/{scene}.webp"
        header_bytes = (BRAND / header_rel).read_bytes()
        header = Image.open(io.BytesIO(header_bytes)).convert("RGB")
        up_rel = f"upscaled/{scene}.webp"
        box = spec["box"]

        def stretched(im, k, what):
            """The source with its right strip stretched as the 768 px file's was, at k times header pixels."""
            if "strip" not in spec:
                return im, ""
            x, to = (v * k for v in spec["strip"])
            strip = im.crop((x, 0, im.width, im.height)).resize((to, im.height), Image.LANCZOS)
            out = Image.new("RGB", (x + to, im.height))
            out.paste(im.crop((0, 0, x, im.height)), (0, 0))
            out.paste(strip, (x, 0))
            return out, f"right {im.width - x} px strip of the {what} (x {x}\u2013{im.width}) stretched to {to} px so Ouro clears the phone edge, then "

        if (BRAND / up_rel).exists():
            up_bytes = (BRAND / up_rel).read_bytes()
            src = Image.open(io.BytesIO(up_bytes)).convert("RGB")
            k = src.width // header.width
            src, pre = stretched(src, k, "4x master")
            src_box = [v * k for v in box]
            window = src.crop(src_box)
            base = {"derivedFrom": {"file": up_rel, "sha256": sha(up_bytes)}, "approval": UPSCALE_APPROVAL}
            op = f"{pre}crop box {src_box} of the 4x master (the 768 px phone file's window {list(box)} at 4x)"
        else:
            src, pre = stretched(header, 1, "header")
            window = src.crop(box)
            base = {"derivedFrom": {"file": header_rel, "sha256": sha(header_bytes)}, "approval": DERIVED_APPROVAL}
            op = f"{pre}crop box {list(box)} of the header (no 4x master is in brand/)"
        for w in WIDTHS:
            h = round((box[3] - box[1]) * w / (box[2] - box[0]))
            im = window.resize((w, h), Image.LANCZOS)
            note = ""
            if w > window.width:
                note = f"; {w / window.width:.2f}x up, no new detail is drawn"
            for fmt in ("webp", "avif"):
                yield f"phone/{scene}-{w}.{fmt}", encode(im, fmt), {
                    **base, "use": spec["use"],
                    "operation": f"{op} then resize to {w}x{h} (Lanczos){note}",
                    "encoder": ENCODERS[fmt]}


def main():
    check = "--check" in sys.argv[1:]
    scenes = [a for a in sys.argv[1:] if a != "--check"]
    unknown = [s for s in scenes if s not in NIGHT]
    if unknown:
        sys.exit(f"not a night scene here: {', '.join(unknown)}")
    if not (features.check("webp") and features.check("avif")):
        sys.exit("Pillow needs WebP and AVIF support")
    prov = json.loads(PROVENANCE.read_text())
    by_file = {e["file"]: e for e in prov}
    bad = []
    n = 0
    for rel, data, entry in build(scenes):
        path = BRAND / rel
        if check:
            if not path.exists() or sha(path.read_bytes()) != by_file.get(rel, {}).get("sha256"):
                bad.append(rel)
            continue
        path.write_bytes(data)
        im = Image.open(io.BytesIO(data))
        by_file[rel] = {"file": rel, **{k: v for k, v in entry.items() if k != "approval"},
                        "approval": entry["approval"], "width": im.width, "height": im.height,
                        "bytes": len(data), "sha256": sha(data)}
        n += 1
    if check:
        if bad:
            print("differs from provenance.json:\n  " + "\n  ".join(bad))
            sys.exit(1)
        print("every night phone file matches provenance.json")
        return
    PROVENANCE.write_text(json.dumps(list(by_file.values()), indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {n} night phone files")


if __name__ == "__main__":
    main()
