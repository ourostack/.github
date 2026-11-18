#!/usr/bin/env python3
"""Fail a light-transfer night whose sky has a hard straight seam the day does not explain.

    python3 brand/tools/sky_seams.py                 # every nightFromDay or nightFromFlatDay night in crops.json
    python3 brand/tools/sky_seams.py ouro-work ...   # just these scenes (day names)
    python3 brand/tools/sky_seams.py --json          # one JSON document per run

A night built by light transfer has the day's shapes under the night's light, and light varies
slowly, so a straight seam in its sky comes from how the night was built. Two kinds have shipped
or nearly shipped:

- a box pasted with a hard edge into the flat day, the night header or the night-light mask
  (2026-11-17, ourostack in #274, fixed in #294: its far ridge was repaired inside an
  unfeathered box ending at x 1450, a 25-level step in the flat day);
- a sun cut short: the flat day removed the sun's broad glare but kept, as detail, the clipped
  core's flat top and the hard corner where its glow begins, so the night shows a pale column
  with a straight side and a dark box beside it (2026-11-18: ouro-work in #286 and
  agent-workbench in #297; ouro-work's blue fell 107 to 60 in 40 px while luma moved 3
  levels, which is why every channel is checked).

What is checked: brand/scenes/<scene>-dark-3072.webp, in the top 60% of its rows, on the sky:
pixels of the day header joined to its top edge through smooth picture (no channel changing
faster than 6 levels a pixel after a 1 px blur), minus the night-light mask (a moon, lamps).
For each colour channel it takes the step in log(value + 16) across gaps of 3, 8 and 16 px, in
both directions, averaged over 9 px along the edge. A pixel is a seam candidate when, with sky
on both sides, the step is at least 0.12 (and 6 levels), at least twice the step 2 gaps to
either side, and the far sides differ the same way (a step, not a thin line); and either

- night-only: the day 3072 scene's own step anywhere within 8 px along and 2 px across, scaled
  to the night's local contrast (49 px windows), is under a third of the night's; or
- a sun cut short: on the step's bright side the day keeps rising toward a light (its next step
  out is at least half its own and that side reaches level 200) while the night's stops (its
  next step out is under a quarter of its own).

Candidates that run straight down a column or along a row for 40 px or more (2 px of wander,
4 px gaps closed) fail the scene; each is printed with its normalised position, the channel and
its levels either side, so it can be found in the picture. Calibrated 2026-11-18 on every shipped
night: it flags ouro-work and agent-workbench, and a headless look judged every other place an
earlier, looser version flagged to be drawn (ridges, cloud bands, a wall, planks, a mannequin's
head). It checks only the sky: ourostack's #274 seam was a 12 px tall cut across the far ridge,
below the sky, and it passes; outside the sky, night-lit lamps, windows and rims step where the
day does not, so a night-only test there flags drawn things. brand/tools/sky_seams_test.py keeps
a pasted box and a cut-short sun failing and drawn edges passing.

Fix a finding with a soft-edged mask: feather every box pasted into a flat day, a night header or
a night-light mask, and remove a sun from the flat day and the night header together (its glow
and its clipped core, down to the sky around it), then rebuild the night with upscale.py and
derive.py. Needs Pillow, numpy and scipy. Exit 0 when clean, 1 when any night has a seam.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import binary_closing, gaussian_filter, label, maximum_filter, minimum_filter, uniform_filter, uniform_filter1d

BRAND = Path(__file__).resolve().parent.parent
STEP, LEVELS, SHARP, PLATEAU, DAY, GLOW, CUT, LIGHT, RUN = 0.12, 6, 2.0, 0.6, 0.33, 0.5, 0.25, 200, 40
GAPS, ALONG, OFFSET, SKY, GRAD = (3, 8, 16), 9, 16, 0.6, 6
CHANNELS = "RGB"


def rgb(im):
    return np.log(np.asarray(im.convert("RGB"), np.float32) + OFFSET)


def sky_mask(im, grad=GRAD):
    """The sky of a day picture (header size): pixels joined to its top edge through smooth picture.

    Smooth means no channel changes faster than `grad` levels per pixel (after a 1 px blur), so a soft
    glow, a sky gradient or a sun rim's ramp stays sky while a drawn outline (a roof, a pole, a hill
    against the sky) ends it."""
    a = gaussian_filter(np.asarray(im.convert("RGB"), np.float32), (1, 1, 0))
    g = np.maximum(np.abs(np.diff(a, axis=0, append=a[-1:])), np.abs(np.diff(a, axis=1, append=a[:, -1:]))).max(2)
    smooth = (g < grad) | binary_closing(g < grad, structure=np.ones((3, 3), bool))
    lab, _ = label(smooth)
    top = np.unique(lab[0][lab[0] > 0])
    return np.isin(lab, top)


def steps(a, gap):
    """Step across columns (right mean minus left mean over gap px), smoothed ALONG px down each column."""
    s = uniform_filter1d(a, ALONG, axis=0)
    c = np.cumsum(np.pad(s, ((0, 0), (1, 0)) + ((0, 0),) * (a.ndim - 2)), axis=1)
    out = np.zeros_like(a)
    w = a.shape[1]
    x = np.arange(gap, w - gap)
    out[:, gap:w - gap] = ((c[:, x + gap + 1] - c[:, x + 1]) - (c[:, x + 1] - c[:, x - gap + 1])) / gap
    return out


def plateau(a, gap):
    """Mean over the 2 gap px beyond each side of the step's own window, right minus left."""
    s = uniform_filter1d(a, ALONG, axis=0)
    c = np.cumsum(np.pad(s, ((0, 0), (1, 0)) + ((0, 0),) * (a.ndim - 2)), axis=1)
    out = np.zeros_like(a)
    w = a.shape[1]
    x = np.arange(3 * gap, w - 3 * gap - 1)
    out[:, x] = ((c[:, x + 3 * gap + 1] - c[:, x + gap + 1]) - (c[:, x - gap + 1] - c[:, x - 3 * gap + 1])) / (2 * gap)
    return out


def local_std(a, size=49):
    m = uniform_filter(a, size=(size, size, 1))
    return np.sqrt(np.maximum(uniform_filter(a * a, size=(size, size, 1)) - m * m, 0))


def shift(a, d):
    out = np.zeros_like(a)
    if d > 0:
        out[:, d:] = a[:, :-d]
    else:
        out[:, :d] = a[:, -d:]
    return out


def runs_in(mask, minlen):
    """(column, start, end) for each vertical run of at least minlen px, gaps of up to 4 px closed."""
    m = binary_closing(mask, structure=np.ones((5, 1), bool)) | mask
    found = []
    for x in np.nonzero(m.sum(0) >= minlen)[0]:
        d = np.diff(np.r_[0, m[:, x].astype(np.int8), 0])
        for s, e in zip(np.nonzero(d == 1)[0], np.nonzero(d == -1)[0]):
            if e - s >= minlen:
                found.append((int(x), int(s), int(e)))
    return found


def find(night, sky, day=None, step=STEP, levels=LEVELS, sharp=SHARP, dayfrac=DAY, run=RUN):
    """Straight seams in a night (log RGB array) whose both sides lie in `sky` (bool array, same size)."""
    out = []
    for orient in ("vertical", "horizontal"):
        tr = (lambda a: a) if orient == "vertical" else (lambda a: a.swapaxes(0, 1))
        n, sk = tr(night), tr(sky)
        d = tr(day) if day is not None else None
        if d is not None:  # the transfer gives the night the day's shapes at the night's local contrast
            gain = np.clip(local_std(n) / np.maximum(local_std(d), 1e-3), 0.25, 8)
        h, w = n.shape[:2]
        lin = np.exp(n) - OFFSET
        cand = np.zeros(n.shape, bool)
        best = np.zeros(n.shape, np.float32)
        for gap in GAPS:
            sn, sl = steps(n, gap), steps(lin, gap)
            side = np.maximum(np.abs(shift(sn, 2 * gap)), np.abs(shift(sn, -2 * gap)))
            # a step, not a thin line: the far sides (gap+1 to 3 gap px out) differ the same way
            far = plateau(n, gap)
            both = minimum_filter(sk, size=(1, 6 * gap + 1))  # sky on both sides, out to the far samples
            c = ((np.abs(sn) >= step) & (np.abs(sl) >= levels) & (np.abs(sn) >= sharp * side)
                 & (far * np.sign(sn) >= PLATEAU * np.abs(sn)) & both[..., None])
            if d is not None:
                # fail an edge the day does not draw (a pasted box), or one the day draws only as part of a glow that
                # keeps rising toward a light source on its bright side, where the night stops flat (a sun cut short)
                sd = steps(d, gap)
                near_d = maximum_filter(np.abs(sd), size=(17, 5, 1))  # the day's edge anywhere close by
                nightonly = near_d * gain < dayfrac * np.abs(sn)
                sg = np.sign(sn)
                far_d = np.where(sn < 0, shift(sd, 2 * gap), shift(sd, -2 * gap)) * sg
                far_n = np.where(sn < 0, shift(sn, 2 * gap), shift(sn, -2 * gap)) * sg
                lit = np.where(sn < 0, shift(d, 3 * gap), shift(d, -3 * gap)) >= np.log(LIGHT + OFFSET)
                cut = (far_d >= GLOW * np.abs(sd)) & (far_n <= CUT * np.abs(sn)) & lit
                c &= nightonly | cut
            upd = c & (np.abs(sn) > np.abs(best))
            best[upd] = sn[upd]
            cand |= c
        for ci in range(3):
            for sign in (1, -1):
                m = cand[..., ci] & (np.sign(best[..., ci]) == sign)
                m = m | shift(m, 1) | shift(m, -1) | shift(m, 2) | shift(m, -2)  # a straight edge may wander by 2 px
                seen = []
                for x, s, en in sorted(runs_in(m, run), key=lambda r: r[1] - r[2]):
                    if any(abs(x - x2) <= 12 and s < e2 and s2 < en for x2, s2, e2 in seen):
                        continue
                    seen.append((x, s, en))
                    seg = best[s:en, x, ci]
                    st = float(np.median(np.abs(seg[seg != 0]))) if (seg != 0).any() else 0.0
                    lo = float(np.median(lin[s:en, max(0, x - 20):max(1, x - 4), ci]))
                    hi = float(np.median(lin[s:en, min(x + 5, w - 1):min(x + 21, w), ci]))
                    f = {"orientation": orient, "channel": CHANNELS[ci], "length_px": en - s, "log_step": round(st, 3),
                         "levels": [int(round(lo)), int(round(hi))]}
                    if orient == "vertical":
                        f.update(x=round(x / w, 3), y=[round(s / h, 3), round(en / h, 3)])
                    else:
                        f.update(y=round(x / w, 3), x=[round(s / h, 3), round(en / h, 3)])
                    out.append(f)
    return out


def check_scene(day, crops, opts):
    """Seams in the sky of brand/scenes/<day>-dark-3072.webp (the top `sky` share of its rows)."""
    opts = dict(opts)
    band_share = opts.pop("sky", SKY)
    grad = opts.pop("grad", GRAD)
    night_im = Image.open(BRAND / f"scenes/{day}-dark-3072.webp")
    w, h = night_im.size
    band = (0, 0, w, int(round(band_share * h)))
    n = rgb(night_im.crop(band))
    base = Image.open(BRAND / f"headers/{day}.webp")  # the day: a box pasted into the flat would hide its own edge
    sky = sky_mask(base, grad)
    lights_rel = crops.get(day, {}).get("nightLights")
    if lights_rel:  # night-only light sources (a moon, lamps) are meant to differ from the day
        m = np.asarray(Image.open(BRAND / lights_rel).convert("L").resize(base.size, Image.BILINEAR)) > 8
        sky &= ~maximum_filter(m, size=17)
    sky = np.asarray(Image.fromarray(sky).resize((w, h), Image.NEAREST).crop(band))
    d = rgb(Image.open(BRAND / f"scenes/{day}-3072.webp").convert("RGB").resize((w, h), Image.LANCZOS).crop(band))
    found = find(n, sky, d, **opts)
    k = band[3] / h
    for f in found:  # back to whole-picture coordinates
        if f["orientation"] == "vertical":
            f["y"] = [round(v * k, 3) for v in f["y"]]
        else:
            f["y"] = round(f["y"] * k, 3)
    return found


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scenes", nargs="*", help="day scene names; default every nightFromDay or nightFromFlatDay scene")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--step", type=float, default=STEP)
    ap.add_argument("--levels", type=float, default=LEVELS)
    ap.add_argument("--sky", type=float, default=SKY)
    ap.add_argument("--sharp", type=float, default=SHARP)
    ap.add_argument("--grad", type=float, default=GRAD)
    ap.add_argument("--day", type=float, default=DAY)
    ap.add_argument("--run", type=int, default=RUN)
    a = ap.parse_args()
    crops = json.loads((BRAND / "tools/crops.json").read_text())
    scenes = a.scenes or sorted(k for k, v in crops.items() if isinstance(v, dict) and (v.get("nightFromDay") or v.get("nightFromFlatDay")))
    opts = dict(step=a.step, levels=a.levels, sharp=a.sharp, dayfrac=a.day, run=a.run, sky=a.sky, grad=a.grad)
    report, bad = {}, 0
    for s in scenes:
        if not (BRAND / f"scenes/{s}-dark-3072.webp").exists():
            sys.exit(f"{s}: brand/scenes/{s}-dark-3072.webp is missing")
        found = check_scene(s, crops, opts)
        report[s] = found
        bad += bool(found)
        if not a.json:
            print(f"{s}-dark: {'clean' if not found else f'{len(found)} seam(s)'}")
            for f in found:
                where = (f"x {f['x']}, y {f['y'][0]}-{f['y'][1]}" if f["orientation"] == "vertical"
                         else f"y {f['y']}, x {f['x'][0]}-{f['x'][1]}")
                print(f"  {f['orientation']} seam at {where} ({f['length_px']} px), {f['channel']} {f['levels'][0]} -> {f['levels'][1]}")
    if a.json:
        print(json.dumps(report, indent=1))
    elif bad:
        print(f"{bad} night(s) with a hard straight seam: fix the flat day, its night-light mask or the night header "
              f"with soft-edged masks and rebuild the night (brand/tools/sky_seams.py explains the check)")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
