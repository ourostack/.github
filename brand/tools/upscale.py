#!/usr/bin/env python3
"""Make the 4x masters in brand/upscaled/ that derive.py cuts the large site widths from.

    python3 brand/tools/upscale.py                      # every scene in crops.json
    python3 brand/tools/upscale.py labs desk            # just these
    python3 brand/tools/upscale.py --reuse DIR          # take DIR/<scene>.png instead of running Real-ESRGAN
    python3 brand/tools/upscale.py --master labs=PATH@190 labs
                                                        # upscale the lossless 1536x1024 master at PATH,
                                                        # then cut the header's rows (from row 190) at 4x
    python3 brand/tools/upscale.py flow-review-dark     # a night built from its day's master (below)

The headers are 1536 px wide, which is fewer pixels than a full-width hero has on
a 2x laptop or a 4K screen. Each scene is upscaled 4x with Real-ESRGAN
(realesrgan-x4plus, realesrgan-ncnn-vulkan) from the best source there is: the
lossless master when it is kept, otherwise the header itself. Nothing is
recomposed: the output must be exactly 4x the header, and, Lanczos-downsized
back to the header's size, match it with a luma SSIM (Gaussian, sigma 1.5) of at
least 0.95, or the scene is refused. The result is written as WebP q90 with a
provenance entry naming its source and that source's sha256, the operation and
the SSIM it passed. Then run derive.py.

A night scene (<scene>-dark) whose day twin sets "nightFromDay": true in
crops.json is not upscaled on its own. Real-ESRGAN invents fine texture and
glyph-like specks differently in a day and its night, so two separate upscales
stop matching at the sizes cut from them even when the headers match. Instead
its master is the day's committed 4x master given the night header's light and
colour by relight_transfer.py, so every night size has the day's exact
structure. Set it for a night made by light transfer of its day (the night
header is the day's drawing under new light); a night drawn on its own keeps
its own upscale. Upscaling such a day rebuilds its night master after it, and
a night whose day master was made from an older day header is refused until
the day is upscaled again.

Real-ESRGAN on a GPU does not give the same bytes twice, so the committed WebP is
the record; rerunning makes a new one with a new sha256.

Needs Pillow, numpy, scipy and scikit-image, and Real-ESRGAN at $REALESRGAN or
~/.local/share/realesrgan/realesrgan-ncnn-vulkan (models beside it).
"""
import hashlib
import io
import json
import os
import subprocess
import sys
from datetime import date
from pathlib import Path

import numpy as np
from PIL import Image
from skimage.metrics import structural_similarity

from relight_transfer import RADIUS, transfer

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / "brand"
PROVENANCE = BRAND / "provenance.json"
CROPS = json.loads((BRAND / "tools" / "crops.json").read_text())
ESRGAN = Path(os.environ.get("REALESRGAN", Path.home() / ".local/share/realesrgan/realesrgan-ncnn-vulkan"))
MODEL = "realesrgan-x4plus"
FLOOR = 0.95

UPSCALE_APPROVAL = (
    "Ari asked for every undersized piece of art on ouroboros.bot and the Ouro UI site to be "
    "AI-upscaled, 2026-11-12 (relayed in the art-upscale brief): \"upscale all the art, and make it "
    "impossible to use too-small imagery\". Upscaled 4x with Real-ESRGAN only; checked to keep the "
    "same crop, subject and aspect as its source."
)

NIGHT_APPROVAL = UPSCALE_APPROVAL.replace(
    "Upscaled 4x with Real-ESRGAN only; checked",
    "The day's 4x Real-ESRGAN master given only this night's light and colour, so the night has no texture "
    "the day lacks; checked")


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def luma_ssim(a: Image.Image, b: Image.Image) -> float:
    return float(structural_similarity(
        np.asarray(a.convert("L")), np.asarray(b.convert("L")), data_range=255,
        gaussian_weights=True, sigma=1.5, use_sample_covariance=False))


def esrgan(src: Image.Image, scratch: Path) -> Image.Image:
    scratch.mkdir(parents=True, exist_ok=True)
    inp, out = scratch / "in.png", scratch / "out.png"
    src.save(inp)
    subprocess.run([str(ESRGAN), "-i", str(inp), "-o", str(out), "-n", MODEL,
                    "-m", str(ESRGAN.parent / "models"), "-f", "png"], check=True, capture_output=True)
    return Image.open(out).convert("RGB")


def night_from_day(scene):
    """The day twin of a night scene built from its day's master, or None."""
    day = scene.removesuffix("-dark")
    if day != scene and CROPS.get(day, {}).get("nightFromDay"):
        return day
    return None


def main():
    args = sys.argv[1:]
    reuse, masters, scenes = None, {}, []
    while args:
        a = args.pop(0)
        if a == "--reuse":
            reuse = Path(args.pop(0))
        elif a == "--master":
            name, spec = args.pop(0).split("=", 1)
            path, top = spec.rsplit("@", 1)
            masters[name] = (Path(path), int(top))
        else:
            scenes.append(a)
    scenes = scenes or sorted(k for k in CROPS if not k.startswith("_"))
    for day in [s for s in scenes if CROPS.get(s, {}).get("nightFromDay")]:
        night = f"{day}-dark"
        if (BRAND / f"headers/{night}.webp").exists() and night not in scenes:
            scenes.append(night)
    scenes.sort(key=lambda s: night_from_day(s) is not None)
    prov = json.loads(PROVENANCE.read_text())
    by_file = {e["file"]: e for e in prov}
    scratch = ROOT / ".upscale-scratch"
    for scene in scenes:
        header_rel = f"headers/{scene}.webp"
        header_bytes = (BRAND / header_rel).read_bytes()
        header = Image.open(io.BytesIO(header_bytes)).convert("RGB")
        source = {"file": header_rel, "sha256": sha(header_bytes)}
        also = None
        day = night_from_day(scene)
        if day:
            if scene in masters:
                sys.exit(f"{scene}: built from the day's master (nightFromDay in crops.json); --master does not apply")
            day_rel, day_up_rel = f"headers/{day}.webp", f"upscaled/{day}.webp"
            day_sha = sha((BRAND / day_rel).read_bytes())
            if by_file.get(day_up_rel, {}).get("derivedFrom", {}).get("sha256") != day_sha:
                sys.exit(f"{scene}: {day_up_rel} was not made from the current {day_rel}; run python3 brand/tools/upscale.py {day} first")
            day_up_bytes = (BRAND / day_up_rel).read_bytes()
            if sha(day_up_bytes) != by_file[day_up_rel]["sha256"]:
                sys.exit(f"{scene}: {day_up_rel} differs from its provenance entry; run python3 brand/tools/upscale.py {day} first")
            day_up = Image.open(io.BytesIO(day_up_bytes)).convert("RGB")
            up = transfer(day_up, header)
            origin = None
            also = {"file": day_up_rel, "sha256": sha(day_up_bytes)}
            r = max(1, round(RADIUS * day_up.width / 1536))
            op = (f"the day's 4x master {day_up_rel} (sha256 {also['sha256']}) given the light and colour of "
                  f"{header_rel} (sha256 {source['sha256']}) by brand/tools/relight_transfer.py (local mean and "
                  f"contrast of log colour in {2 * r + 1} px windows, radius {RADIUS} at 1536 px wide); every shape "
                  f"is the day master's, so each night size has the day's exact structure (nightFromDay in crops.json)")
        elif scene in masters:
            path, top = masters[scene]
            master_bytes = path.read_bytes()
            master = Image.open(io.BytesIO(master_bytes)).convert("RGB")
            box = (0, top, header.width, top + header.height)
            gen = by_file[header_rel].get("generation", [{}])[0]
            if gen.get("master_sha256") and gen["master_sha256"] != sha(master_bytes):
                sys.exit(f"{scene}: {path} is not the master provenance.json names for {header_rel}")
            up_full = Image.open(reuse / f"{scene}-master-4x.png").convert("RGB") if reuse and (reuse / f"{scene}-master-4x.png").exists() else esrgan(master, scratch)
            if up_full.size != (master.width * 4, master.height * 4):
                sys.exit(f"{scene}: Real-ESRGAN gave {up_full.size}, not 4x the master")
            up = up_full.crop(tuple(v * 4 for v in box))
            origin = {"master": gen.get("master", path.stem), "master_sha256": sha(master_bytes), "crop": list(box)}
            op = (f"upscaled 4x with Real-ESRGAN ({MODEL}, realesrgan-ncnn-vulkan) from the lossless "
                  f"{master.width}x{master.height} master {origin['master']} (sha256 {origin['master_sha256']}), "
                  f"then cut to the header's box {list(box)} at 4x {[v * 4 for v in box]}")
        else:
            up = Image.open(reuse / f"{scene}.png").convert("RGB") if reuse else esrgan(header, scratch)
            origin = None
            op = (f"upscaled 4x with Real-ESRGAN ({MODEL}, realesrgan-ncnn-vulkan) from {header_rel} "
                  f"(sha256 {source['sha256']}); the header is the best source kept, its lossless master is not")
        if up.size != (header.width * 4, header.height * 4):
            sys.exit(f"{scene}: upscale is {up.size}, not 4x the header {header.size}")
        score = luma_ssim(header, up.resize(header.size, Image.LANCZOS))
        if score < FLOOR:
            sys.exit(f"{scene}: SSIM {score:.4f} against {header_rel} is under {FLOOR}; not the same picture")
        buf = io.BytesIO()
        up.save(buf, "WEBP", quality=90, method=6)
        data = buf.getvalue()
        rel = f"upscaled/{scene}.webp"
        (BRAND / rel).parent.mkdir(parents=True, exist_ok=True)
        (BRAND / rel).write_bytes(data)
        entry = {"file": rel, "derivedFrom": source}
        if origin:
            entry["derivedFrom"] = {**source, **origin}
        if also:
            entry["alsoFrom"] = also
        entry.update({
            "use": "4x master for site heroes wider than the 1536 px header",
            "operation": op,
            "checked": (f"Lanczos-downsized to {header.width}x{header.height}, it matches {header_rel} with a luma "
                        f"SSIM (Gaussian, sigma 1.5) of {score:.4f} (floor {FLOOR}); same crop, subject and aspect"),
            "upscaled": date.today().isoformat(),
            "encoder": "Pillow WebP quality 90 method 6",
            "approval": NIGHT_APPROVAL if also else UPSCALE_APPROVAL,
            "width": up.width, "height": up.height, "bytes": len(data), "sha256": sha(data),
        })
        by_file[rel] = entry
        print(f"{scene}: {up.width}x{up.height}, SSIM {score:.4f}, {len(data) / 1e6:.2f} MB")
    PROVENANCE.write_text(json.dumps(list(by_file.values()), indent=1, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
