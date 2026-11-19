"""Cuts the home page porthole's served files from the stage masters in brand/stage/, and records them.

    python3 brand/tools/stage.py          # write each served size and its provenance entry
    python3 brand/tools/stage.py --check  # exit 1 if a served file differs from what this would write

The porthole on ui.ouroboros.bot (site/src/voyage/stage/) is a painted sea the size of a small window: five band
backdrops it cross-fades as the ship dives, and creatures and the Nautilus herself as sprites that swim, scatter and
dive over them. Each master here is a whole painting, or a sprite keyed off key green by brand/tools/chroma_key.py;
its provenance entry holds the prompt chain. The site serves the small files cut below, about one and a half pixels
per unit of the porthole's 480-unit drawing, so they are sharp on a phone held close and cost little.
"""
import hashlib
import io
import json
import sys
from pathlib import Path

from PIL import Image

BRAND = Path(__file__).resolve().parent.parent
PROVENANCE = BRAND / "provenance.json"
APPROVAL = (
    "Ari, 2026-11-17, on the Nautilus pages of ui.ouroboros.bot: \"make it match the other art (like the hero etc)!!!\" and "
    "\"NOT storybook universe - that's the OLD one\"; then on the home page: \"these ballast tanks and porthole (etc) need to "
    "be brought up to speed too\". Derived by resize only; nothing new is drawn."
)
# master: the widths the site serves.
SIZES = {
    "stage/bg-sunlit.webp": [480, 720],
    "stage/bg-sunlit-dark.webp": [480, 720],
    "stage/bg-twilight.webp": [480, 720],
    "stage/bg-twilight-dark.webp": [480, 720],
    "stage/bg-midnight.webp": [480, 720],
    "stage/nautilus.webp": [660],
    "stage/nautilus-lit.webp": [660],
    "stage/ray.webp": [256],
    "stage/anglerfish.webp": [160],
    "stage/octopus.webp": [112],
    "stage/sardine.webp": [72],
    "stage/lanternfish.webp": [56],
    "stage/jellyfish.webp": [64],
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def cut(master, width):
    src = Image.open(BRAND / master)
    height = round(src.height * width / src.width)
    out = src.resize((width, height), Image.LANCZOS)
    buf = io.BytesIO()
    # Sprites keep their alpha whole (alpha_quality 100), so a fin's soft edge isn't stepped.
    out.save(buf, "WEBP", quality=82, method=6, alpha_quality=100)
    return buf.getvalue(), width, height


def entries():
    for master, widths in SIZES.items():
        master_sha = sha((BRAND / master).read_bytes())
        for width in widths:
            data, w, h = cut(master, width)
            file = master.replace(".webp", f"-{width}.webp")
            yield file, data, {
                "file": file,
                "derivedFrom": {"file": master, "sha256": master_sha},
                "use": "ui.ouroboros.bot home page porthole (site/src/voyage/stage/)",
                "operation": f"resized to {w}x{h} (Lanczos)",
                "encoder": "Pillow WebP quality 82 method 6, alpha quality 100",
                "approval": APPROVAL,
                "width": w,
                "height": h,
                "bytes": len(data),
                "sha256": sha(data),
            }


def main(args):
    prov = json.loads(PROVENANCE.read_text())
    by_file = {e["file"]: e for e in prov}
    bad = []
    for file, data, entry in entries():
        if "--check" in args:
            on_disk = (BRAND / file).read_bytes() if (BRAND / file).exists() else b""
            if on_disk != data or by_file.get(file) != entry:
                bad.append(file)
            continue
        (BRAND / file).write_bytes(data)
        by_file[file] = entry
    if "--check" in args:
        if bad:
            print("differs from provenance.json (python3 brand/tools/stage.py):\n  " + "\n  ".join(bad))
            sys.exit(1)
        print("every stage file matches provenance.json")
        return
    PROVENANCE.write_text(json.dumps(list(by_file.values()), indent=1, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main(sys.argv[1:])
