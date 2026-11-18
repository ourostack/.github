#!/usr/bin/env python3
"""Make the 4x masters in brand/upscaled/ that derive.py cuts the large site widths from.

    python3 brand/tools/upscale.py                      # every scene in crops.json
    python3 brand/tools/upscale.py labs desk            # just these
    python3 brand/tools/upscale.py --reuse DIR          # take DIR/<scene>.png instead of running Real-ESRGAN
    python3 brand/tools/upscale.py --master labs=PATH@190 labs
                                                        # upscale the lossless 1536x1024 master at PATH,
                                                        # then cut the header's rows (from row 190) at 4x
    python3 brand/tools/upscale.py flow-review-dark     # a night built from its day's master (below)
    python3 brand/tools/upscale.py --reuse DIR labs-dark  # with DIR/labs-dark-flat.png: a nightFromFlatDay night

The headers are 1536 px wide, which is fewer pixels than a full-width hero has on
a 2x laptop or a 4K screen. Each scene is upscaled 4x with Real-ESRGAN
(realesrgan-x4plus, realesrgan-ncnn-vulkan) from the best source there is: the
lossless master when it is kept, otherwise the header itself. Nothing is
recomposed: the output must be exactly 4x the header, and, Lanczos-downsized
back to the header's size, match it with a luma SSIM (Gaussian, sigma 1.5) of at
least 0.95, or the scene is refused. The result is written as WebP q90 (a night
scene, <scene>-dark, as WebP q100: q90 drops more of the fine low-contrast detail
of a dark picture) with a provenance entry naming its source and that source's
sha256, the operation and the SSIM it passed. Then run derive.py.

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

A night whose day twin sets "nightFromFlatDay": "flat/<scene>.webp" is built the
same way from a flattened copy of the day instead: a committed WebP at header
size (with its own provenance entry) that is the day's drawing with its sun
pattern removed (beams, stripes, hard leaf and frame shadows). Its master is
Real-ESRGAN's 4x of that flat day given the night header's light and colour by
relight_transfer.py; wherever the flat day equals the day (every prop it kept
unflattened) the day's own 4x master is used instead, so the night shares the
day's exact upscaled detail there (two Real-ESRGAN runs differ in fine detail),
which also requires the day's master to be current. Use it for a night made by light transfer onto a flattened
day: nightFromDay would bring the day's sun pattern back into every night size,
and a separate Real-ESRGAN run on the dark night header invents detail the day
lacks. The flat day's own 4x is checked against it with the same SSIM floor,
and the master records the flat day as its second source (alsoFrom), so the
audit marks it stale when the flat day changes. The two options exclude each
other. A day with nightFromFlatDay may also set "nightLights": "flat/<scene>-lights.png",
a greyscale mask at header size over the night's small light sources (lit lamp
shades, glowing eyes): they are smaller than the transfer's window, so inside
the mask the night master takes the night header itself (Lanczos 4x, feathered).
Keep it tight around those sources and use it for nothing else. Around the mask,
within one transfer window and fading out by three, the master's broad light
(log, coarser than 4 px at 1536 wide) is the night header's too wherever the day
is featureless (light_falloff; a lit figure or prop keeps the day's shading):
the switch from the night header to the transfer at the mask's edge left a dark
ring round ourostack's moon (#294), whose flat day held a moon with a dark rim. With
"nightLightsMode": "ratio" the mask instead keeps the day's 4x master given the
night header's colour per pixel: the day master times the night header's
per-channel gain over the day header, upsampled and smoothed without
crossing the day master's edges (a guided filter, 9 px windows at 4x). A lit
shape keeps the day master's sharp outline instead of the night header's soft
Lanczos 4x, for a mask that covers a lit figure or a lit edge rather than a
point of light.

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

FLAT_NIGHT_APPROVAL = UPSCALE_APPROVAL.replace(
    "Upscaled 4x with Real-ESRGAN only; checked",
    "Real-ESRGAN's 4x of the day's flattened copy (its sun pattern removed) given only this night's light and "
    "colour, so the night has the day's shapes without the day's sunlight; checked")

NIGHT_APPROVAL = UPSCALE_APPROVAL.replace(
    "Upscaled 4x with Real-ESRGAN only; checked",
    "The day's 4x Real-ESRGAN master given only this night's light and colour, so the night has no texture "
    "the day lacks; checked")


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def master_encoder(scene: str) -> str:
    return "Pillow WebP quality 100 method 6" if scene.endswith("-dark") else "Pillow WebP quality 90 method 6"


def encode_master(scene: str, up: Image.Image) -> bytes:
    """A night's master is WebP q100: a fixed-quality encoder spends few bits on low-contrast detail in dark areas, and
    WebP q90 kept 88% of ax-trail-map-dark's belly-line depth, q100 94% (2026-11-17). Lossless keeps all of it but is
    about 9 MB a night against q100's 2 MB, and after derive.py's night AVIF encode the two land within measurement
    noise of each other. A day's master stays WebP q90, so day files keep their bytes."""
    buf = io.BytesIO()
    if scene.endswith("-dark"):
        up.save(buf, "WEBP", quality=100, method=6)
    else:
        up.save(buf, "WEBP", quality=90, method=6)
    return buf.getvalue()


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


LIGHTS_MODES = ("header", "ratio")
FALLOFF_SIGMA = 4  # light_falloff: the night header gives the light coarser than this, in px at 1536 wide
RATIO_RADIUS, RATIO_EPS = 4, 1e-4  # nightLightsMode "ratio": the gain's guided filter, 9 px windows at 4x


def guided(guide, src, r, eps):
    """He et al.'s guided filter: src smoothed in (2r+1)-px windows, but kept from crossing guide's edges."""
    from scipy.ndimage import uniform_filter
    box = lambda a: uniform_filter(a, 2 * r + 1, mode="reflect")
    mi, ms = box(guide), box(src)
    a = (box(guide * src) - mi * ms) / (box(guide * guide) - mi * mi + eps)
    return box(a) * guide + box(ms - a * mi)


def ratio_lit(day_up, day, night, r=RATIO_RADIUS, eps=RATIO_EPS):
    """The day's 4x master given the night header's colour: day_up times the night/day header gain per channel,
    upsampled to day_up's size and smoothed edge-aware (a guided filter on the day master's log luminance), so the
    outlines are the day master's and a lit shape's gain does not spill onto its darker surroundings (a Gaussian
    does: a halo band inside and outside the outline)."""
    e = 4.0
    gain = np.log((np.asarray(night, np.float32) + e) / (np.asarray(day, np.float32) + e))
    h, w = day_up.shape[:2]
    gain = np.stack([np.asarray(Image.fromarray(gain[..., c]).resize((w, h), Image.BILINEAR)) for c in range(3)], -1)
    guide = np.log(day_up.mean(2) + e)
    gain = np.stack([guided(guide, gain[..., c], r, eps) for c in range(3)], -1)
    return (day_up + e) * np.exp(gain) - e


def smooth_sky(day, size, grad=6):
    """Where the day (header size) is featureless, at `size`, soft: no channel changing faster than `grad` levels a pixel
    after a 1 px blur. A ring round a light shows in open sky; on a lit figure or a prop the day's own shading stays."""
    from scipy.ndimage import gaussian_filter
    a = gaussian_filter(np.asarray(day.convert("RGB"), np.float32), (1, 1, 0))
    g = np.maximum(np.abs(np.diff(a, axis=0, append=a[-1:])), np.abs(np.diff(a, axis=1, append=a[:, -1:]))).max(2)
    s = gaussian_filter((g < grad).astype(np.float32), 2)
    return np.asarray(Image.fromarray((s * 255).astype(np.uint8)).resize(size, Image.BILINEAR), np.float32) / 255


def light_falloff(up, header_up, mask, radius, sigma, where=1.0):
    """The transfer around night lights, given the night header's own broad light so it cannot undershoot.

    A light far brighter than its surroundings defeats the transfer's windowed contrast match: just outside it the
    output dips below the night header's glow and further out it bumps above it, so a feathered mask alone leaves a
    dark ring (2026-11-18: ourostack's moon, 9 levels below the glow 48-72 px out at 3072). Within `radius` px of the
    mask (one transfer window) the log light coarser than `sigma` px is the night header's, fading to the transfer's own
    by 3 `radius`, and only `where` (the day's featureless sky); finer detail stays the transfer's, so the day's shapes
    are kept."""
    from scipy.ndimage import distance_transform_edt, gaussian_filter
    d = distance_transform_edt(mask < 0.5)
    t = np.clip((d - radius) / (2 * radius), 0, 1)
    w = ((1 - t * t * (3 - 2 * t)) * where)[..., None]
    lu, lh = np.log(up + 1), np.log(header_up + 1)
    corr = np.stack([gaussian_filter(lh[..., c], sigma) - gaussian_filter(lu[..., c], sigma) for c in range(3)], -1)
    return np.exp(lu + w * corr) - 1


def night_from_day(scene):
    """The day twin of a night scene built from its day's master, or None."""
    day = scene.removesuffix("-dark")
    if day != scene and CROPS.get(day, {}).get("nightFromDay"):
        return day
    return None


def night_from_flat_day(scene):
    """(day, flat file under brand/) for a night built from its day's flattened copy, or None."""
    day = scene.removesuffix("-dark")
    flat = CROPS.get(day, {}).get("nightFromFlatDay") if day != scene else None
    return (day, flat) if flat else None


def is_built_night(scene):
    return night_from_day(scene) is not None or night_from_flat_day(scene) is not None


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
    for day in [s for s in scenes if CROPS.get(s, {}).get("nightFromDay") or CROPS.get(s, {}).get("nightFromFlatDay")]:
        night = f"{day}-dark"
        if (BRAND / f"headers/{night}.webp").exists() and night not in scenes:
            scenes.append(night)
    for day in [s for s in scenes if CROPS.get(s, {}).get("nightFromDay") and CROPS[s].get("nightFromFlatDay")]:
        sys.exit(f"{day}: crops.json sets both nightFromDay and nightFromFlatDay; a night is built one way")
    for day in sorted({s.removesuffix("-dark") for s in scenes if "nightLightsMode" in CROPS.get(s.removesuffix("-dark"), {})}):
        if CROPS[day]["nightLightsMode"] not in LIGHTS_MODES:
            sys.exit(f"{day}: crops.json nightLightsMode is {CROPS[day]['nightLightsMode']!r}; use one of {', '.join(LIGHTS_MODES)}")
        if not CROPS[day].get("nightLights"):
            sys.exit(f"{day}: crops.json sets nightLightsMode without nightLights")
    scenes.sort(key=is_built_night)
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
        flat = night_from_flat_day(scene)
        if flat:
            if scene in masters:
                sys.exit(f"{scene}: built from its day's flattened copy (nightFromFlatDay in crops.json); --master does not apply")
            day, flat_rel = flat
            if not (BRAND / flat_rel).exists():
                sys.exit(f"{scene}: crops.json names {flat_rel} as {day}'s flattened copy, but brand/{flat_rel} is missing")
            flat_bytes = (BRAND / flat_rel).read_bytes()
            if by_file.get(flat_rel, {}).get("sha256") != sha(flat_bytes):
                sys.exit(f"{scene}: brand/{flat_rel} has no matching provenance.json entry; record the flattened day (its source and how its sun pattern was removed) first")
            flat_im = Image.open(io.BytesIO(flat_bytes)).convert("RGB")
            if flat_im.size != header.size:
                sys.exit(f"{scene}: {flat_rel} is {flat_im.size}, not the header's {header.size}")
            flat_up = (Image.open(reuse / f"{scene}-flat.png").convert("RGB") if reuse and (reuse / f"{scene}-flat.png").exists()
                       else esrgan(flat_im, scratch))
            if flat_up.size != (flat_im.width * 4, flat_im.height * 4):
                sys.exit(f"{scene}: Real-ESRGAN gave {flat_up.size}, not 4x {flat_rel}")
            flat_score = luma_ssim(flat_im, flat_up.resize(flat_im.size, Image.LANCZOS))
            if flat_score < FLOOR:
                sys.exit(f"{scene}: the 4x of {flat_rel} has SSIM {flat_score:.4f} against it, under {FLOOR}")
            # where the flat day IS the day (every prop, figure and object kept unflattened), use the day's own 4x master,
            # so the night shares the day's exact upscaled detail there; Real-ESRGAN's 4x of the flat day fills only the
            # pixels whose sun pattern was removed
            day_rel, day_up_rel = f"headers/{day}.webp", f"upscaled/{day}.webp"
            day_bytes = (BRAND / day_rel).read_bytes()
            if by_file.get(day_up_rel, {}).get("derivedFrom", {}).get("sha256") != sha(day_bytes):
                sys.exit(f"{scene}: {day_up_rel} was not made from the current {day_rel}; run python3 brand/tools/upscale.py {day} first")
            day_up_bytes = (BRAND / day_up_rel).read_bytes()
            if sha(day_up_bytes) != by_file[day_up_rel]["sha256"]:
                sys.exit(f"{scene}: {day_up_rel} differs from its provenance entry; run python3 brand/tools/upscale.py {day} first")
            day_im = Image.open(io.BytesIO(day_bytes)).convert("RGB")
            from scipy.ndimage import binary_dilation, gaussian_filter
            changed = np.abs(np.asarray(flat_im, np.int16) - np.asarray(day_im, np.int16)).max(2) > 6
            changed = binary_dilation(changed, iterations=2).astype(np.float32)
            cm = gaussian_filter(np.asarray(Image.fromarray((changed * 255).astype(np.uint8)).resize(flat_up.size, Image.LANCZOS), np.float32) / 255, 3)[..., None]
            day_up = np.asarray(Image.open(io.BytesIO(day_up_bytes)).convert("RGB"), np.float32)
            base = Image.fromarray((day_up * (1 - cm) + np.asarray(flat_up, np.float32) * cm).round().clip(0, 255).astype(np.uint8))
            up = transfer(base, header)
            lights_rel = CROPS[day].get("nightLights")
            if lights_rel:
                # small night-only light sources (lit lamps, glowing eyes) are below the transfer's window, so inside this
                # mask the night master takes the night header itself (Lanczos 4x), feathered; nothing else does
                if not (BRAND / lights_rel).exists():
                    sys.exit(f"{scene}: crops.json names {lights_rel} as {day}'s night lights, but brand/{lights_rel} is missing")
                lights_bytes = (BRAND / lights_rel).read_bytes()
                if by_file.get(lights_rel, {}).get("sha256") != sha(lights_bytes):
                    sys.exit(f"{scene}: brand/{lights_rel} has no matching provenance.json entry")
                mask = Image.open(io.BytesIO(lights_bytes)).convert("L")
                if mask.size != header.size:
                    sys.exit(f"{scene}: {lights_rel} is {mask.size}, not the header's {header.size}")
                from scipy.ndimage import gaussian_filter
                m = gaussian_filter(np.asarray(mask.resize(up.size, Image.LANCZOS), np.float32) / 255, 4)[..., None]
                lights_mode = CROPS[day].get("nightLightsMode", "header")
                if lights_mode == "ratio":
                    if day_im.size != header.size:
                        sys.exit(f"{scene}: {day_rel} is {day_im.size}, not the night header's {header.size}")
                    lit = ratio_lit(day_up, day_im, header)
                else:
                    lit = np.asarray(header.resize(up.size, Image.LANCZOS), np.float32)  # header_up, below
                header_up = np.asarray(header.resize(up.size, Image.LANCZOS), np.float32)
                k = up.width / 1536
                around = light_falloff(np.asarray(up, np.float32), header_up, m[..., 0], RADIUS * k, FALLOFF_SIGMA * k,
                                       smooth_sky(day_im, up.size))
                up = Image.fromarray((around * (1 - m) + lit * m).round().clip(0, 255).astype(np.uint8))
            origin = None
            also = {"file": flat_rel, "sha256": sha(flat_bytes)}
            r = max(1, round(RADIUS * flat_up.width / 1536))
            op = (f"the day's 4x master {day_up_rel} (sha256 {sha(day_up_bytes)}) wherever the flattened copy {flat_rel} "
                  f"(sha256 {also['sha256']}) equals the day ({100 * (1 - changed.mean()):.1f}% of the header), and "
                  f"Real-ESRGAN ({MODEL}, realesrgan-ncnn-vulkan)'s 4x of {flat_rel} (SSIM {flat_score:.4f} against it) where "
                  f"its sun pattern was removed, given the light and colour of "
                  f"{header_rel} (sha256 {source['sha256']}) by brand/tools/relight_transfer.py (local mean and "
                  f"contrast of log colour in {2 * r + 1} px windows, radius {RADIUS} at 1536 px wide); every shape "
                  f"is the day master's or the flat day's, so each night size has the day's structure without its sun pattern "
                  f"(nightFromFlatDay in crops.json)"
                  + ((f"; inside the night-light mask {lights_rel} (lit shapes) it is the day's 4x master {day_up_rel} "
                      f"times the night header's per-channel gain over {day_rel}, upsampled and smoothed by a guided filter "
                      f"on the day master's log luminance ({2 * RATIO_RADIUS + 1} px windows at 4x), so lit outlines are "
                      f"the day master's (nightLightsMode ratio)"
                      if lights_mode == "ratio" else
                      f"; inside the night-light mask {lights_rel} (lit lamps, glowing eyes) it is the night header itself, "
                      f"Lanczos 4x")
                    + (f"; within {RADIUS} px (at 1536 wide) of that mask, fading out by {3 * RADIUS} px, its log light "
                       f"coarser than {FALLOFF_SIGMA} px is the night header's wherever the day is featureless (light_falloff), "
                       f"so the switch at the mask's edge leaves no ring in the sky" if lights_rel else "") if lights_rel else ""))
        elif day:
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
        data = encode_master(scene, up)
        rel = f"upscaled/{scene}.webp"
        (BRAND / rel).parent.mkdir(parents=True, exist_ok=True)
        (BRAND / rel).write_bytes(data)
        entry = {"file": rel, "derivedFrom": source}
        if origin:
            entry["derivedFrom"] = {**source, **origin}
        if also:
            entry["alsoFrom"] = also
        if flat and CROPS[flat[0]].get("nightLights"):
            entry["lightsFrom"] = {"file": lights_rel, "sha256": sha(lights_bytes)}
            if CROPS[flat[0]].get("nightLightsMode", "header") != "header":
                entry["lightsFrom"]["mode"] = CROPS[flat[0]]["nightLightsMode"]
        entry.update({
            "use": "4x master for site heroes wider than the 1536 px header",
            "operation": op,
            "checked": (f"Lanczos-downsized to {header.width}x{header.height}, it matches {header_rel} with a luma "
                        f"SSIM (Gaussian, sigma 1.5) of {score:.4f} (floor {FLOOR}); same crop, subject and aspect"),
            "upscaled": date.today().isoformat(),
            "encoder": master_encoder(scene),
            "approval": FLAT_NIGHT_APPROVAL if flat else NIGHT_APPROVAL if also else UPSCALE_APPROVAL,
            "width": up.width, "height": up.height, "bytes": len(data), "sha256": sha(data),
        })
        by_file[rel] = entry
        print(f"{scene}: {up.width}x{up.height}, SSIM {score:.4f}, {len(data) / 1e6:.2f} MB")
    PROVENANCE.write_text(json.dumps(list(by_file.values()), indent=1, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
