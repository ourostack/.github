#!/usr/bin/env python3
"""Fail a light-transfer night whose sky has a hard straight seam the day does not explain, or a ringed moon.

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

It also fails a dark ring round a moon: a bright disc in open sky (above level 100, round, with sky
over 60% of the ring 1.2 to 3 radii out) whose radial profile, taken over sky pixels in 4 px rings,
dips within 160 px of the disc's edge and climbs back by 5 levels (and 12%) within 1.5 radii, below
the level just outside the disc, where the night header does not (a dip drawn into the header,
such as a dark prop near a lamp, is the art's, not the build's). ourostack's moon (#294) had one: 26 at 20 px out, back to 36 by
60 px out, about 9 levels under the glow beside it, because the light transfer undershoots just
outside a light far brighter than its surroundings and the night-light mask covered only the
moon itself. upscale.py now gives the transfer the night header's broad light around every night
light (light_falloff), so a rebuilt night has no ring.

Fix a finding with a soft-edged mask: feather every box pasted into a flat day, a night header or
a night-light mask, and remove a sun from the flat day and the night header together (its glow
and its clipped core, down to the sky around it), then rebuild the night with upscale.py and
derive.py. Needs Pillow, numpy and scipy. Exit 0 when clean, 1 when any night has a seam.
"""
import argparse
import contextlib
import fcntl
import json
import os
import sys
import tempfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import binary_closing, find_objects, gaussian_filter, label, maximum_filter, minimum_filter, uniform_filter, uniform_filter1d

BRAND = Path(__file__).resolve().parent.parent
STEP, LEVELS, SHARP, PLATEAU, DAY, GLOW, CUT, LIGHT, RUN = 0.12, 6, 2.0, 0.6, 0.33, 0.5, 0.25, 200, 40
GAPS, ALONG, OFFSET, SKY, GRAD = (3, 8, 16), 9, 16, 0.6, 6
DISC_LEVEL, RING_RISE = 100, 5
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


def discs(lum, sky, bright=DISC_LEVEL, ratio=2.5):
    """Bright round discs in open sky (a moon, a sun left in): (x, y, radius) in px.

    A disc is a blob brighter than `bright` and `ratio` times the sky's median, 150 to 60000 px, filling at least half
    its box and at most 2.2 times as long as wide, with sky over at least 60% of the ring 1.2 to 3 radii out."""
    lab, _ = label(lum > max(bright, ratio * float(np.median(lum[sky])) if sky.any() else bright))
    out = []
    for i, sl in enumerate(find_objects(lab), 1):
        comp = lab[sl] == i
        area, (h, w) = int(comp.sum()), comp.shape
        if not 150 <= area <= 60000 or comp.mean() < 0.5 or max(h, w) > 2.2 * min(h, w):
            continue
        yy, xx = np.nonzero(comp)
        cy, cx, r = yy.mean() + sl[0].start, xx.mean() + sl[1].start, float(np.sqrt(area / np.pi))
        y0, x0 = max(0, int(cy - 3 * r)), max(0, int(cx - 3 * r))
        y1, x1 = min(lum.shape[0], int(cy + 3 * r) + 1), min(lum.shape[1], int(cx + 3 * r) + 1)
        gy, gx = np.mgrid[y0:y1, x0:x1]
        d = np.hypot(gx - cx, gy - cy)
        # sky share of the whole ring; any part of it off the picture counts as not sky
        if sky[y0:y1, x0:x1][(d > 1.2 * r) & (d < 3 * r)].sum() >= 0.6 * np.pi * (9 - 1.44) * r * r:
            out.append((cx, cy, r))
    return out


def ring_dip(lum, sky, cx, cy, r, rise=RING_RISE, step=4, ref=None):
    """A dark ring round a disc: moving outward over sky pixels (4 px rings, out to 4 radii plus 1.5), the mean level
    dips within 160 px of the disc's edge and then climbs back by at least `rise` levels (and 12%) within 1.5 radii
    (48 to 96 px), staying below the level just outside the disc. Returns (radius of the dip, its level, the climb) or
    None. A sky that brightens slowly toward the horizon, or another lit thing further out, is not a ring; with `ref`
    (the night header, same size) neither is a dip the header has too, climbing back at least half as far: the build
    made no ring there."""
    span = min(max(1.5 * r, 48), 96)
    y0, x0 = max(0, int(cy - 6 * r - span)), max(0, int(cx - 6 * r - span))
    y1, x1 = min(lum.shape[0], int(cy + 6 * r + span) + 1), min(lum.shape[1], int(cx + 6 * r + span) + 1)
    gy, gx = np.mgrid[y0:y1, x0:x1]
    d, sk, lv = np.hypot(gx - cx, gy - cy), sky[y0:y1, x0:x1] & (lum[y0:y1, x0:x1] <= DISC_LEVEL), lum[y0:y1, x0:x1]
    radii = np.arange(r + 4, 4 * r + span, step)
    rings = [(d >= q) & (d < q + step) & sk for q in radii]
    prof = np.array([lv[m].mean() if m.sum() > 20 else np.nan for m in rings])
    rv = ref[y0:y1, x0:x1] if ref is not None else None
    if np.isnan(prof).all():
        return None
    glow = prof[~np.isnan(prof)][0]  # the level just outside the disc
    best = None
    for i, q in enumerate(radii):
        if np.isnan(prof[i]) or q > min(4 * r, r + 160):
            continue
        later = prof[(radii > q) & (radii <= q + span)]
        later = later[~np.isnan(later)]
        if (later.size and (up := later.max() - prof[i]) >= max(rise, 0.12 * prof[i]) and later.max() <= glow
                and (best is None or up > best[2])):
            if rv is not None:
                near = [j for j, q2 in enumerate(radii) if q < q2 <= q + span and rings[j].sum() > 20]
                if near and max(rv[rings[j]].mean() for j in near) - rv[rings[i]].mean() >= 0.5 * up:
                    continue
            best = (float(q), float(prof[i]), float(up))
    return best


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
    sky_all = np.asarray(Image.fromarray(sky).resize((w, h), Image.NEAREST).crop(band))  # with the moon: for rings
    lights_rel = crops.get(day, {}).get("nightLights")
    if lights_rel:  # night-only light sources (a moon, lamps) are meant to differ from the day
        m = np.asarray(Image.open(BRAND / lights_rel).convert("L").resize(base.size, Image.BILINEAR)) > 8
        sky &= ~maximum_filter(m, size=17)
    sky = np.asarray(Image.fromarray(sky).resize((w, h), Image.NEAREST).crop(band))
    d = rgb(Image.open(BRAND / f"scenes/{day}-3072.webp").convert("RGB").resize((w, h), Image.LANCZOS).crop(band))
    found = find(n, sky, d, **opts)
    lum = np.asarray(night_im.crop(band).convert("L"), np.float32)
    head = np.asarray(Image.open(BRAND / f"headers/{day}-dark.webp").convert("L").resize((w, h), Image.LANCZOS).crop(band), np.float32)
    for cx, cy, r in discs(lum, sky_all):
        dip = ring_dip(lum, sky_all, cx, cy, r, ref=head)
        if dip:
            found.append({"kind": "ring", "x": round(cx / w, 3), "y": round(cy / band[3], 3), "radius_px": round(r),
                          "dip_px": round(dip[0] - r), "level": round(dip[1]), "climb": round(dip[2], 1)})
    k = band[3] / h
    for f in found:  # back to whole-picture coordinates
        if f.get("kind") == "ring":
            f["y"] = round(f["y"] * k, 3)
        elif f["orientation"] == "vertical":
            f["y"] = [round(v * k, 3) for v in f["y"]]
        else:
            f["y"] = round(f["y"] * k, 3)
    return found


LOCK = Path(tempfile.gettempdir()) / "ourostack-sky-seams.lock"


@contextlib.contextmanager
def one_pool(path=LOCK, out=sys.stderr):
    """One pool per machine. Each run starts one worker per core at about 0.5 GB each; on 2026-11-19 four
    started at once on an 18-core Mac (76 processes, 38 GB), memory ran out, and every agent session on it
    stalled for 50 minutes. A second run waits here for the first and says so."""
    with open(path, "a+") as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            f.seek(0)
            print(f"sky_seams: waiting for another run on this machine to finish (pid {f.read().strip() or '?'})", file=out, flush=True)
            fcntl.flock(f, fcntl.LOCK_EX)
        f.seek(0)
        f.truncate()
        f.write(str(os.getpid()))
        f.flush()
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scenes", nargs="*", help="day scene names; default every nightFromDay or nightFromFlatDay scene")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--jobs", type=int, default=os.cpu_count(), help="scenes checked at once (default: one per core; one run at a time per machine)")
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
    for s in scenes:
        if not (BRAND / f"scenes/{s}-dark-3072.webp").exists():
            sys.exit(f"{s}: brand/scenes/{s}-dark-3072.webp is missing")
    # One scene per core (CI runs all of them on every pull request), and one pool per machine.
    with one_pool(), ProcessPoolExecutor(max(1, min(a.jobs, len(scenes)))) as pool:
        results = list(pool.map(check_scene, scenes, [crops] * len(scenes), [opts] * len(scenes)))
    report, bad = {}, 0
    for s, found in zip(scenes, results):
        report[s] = found
        bad += bool(found)
        if not a.json:
            print(f"{s}-dark: {'clean' if not found else f'{len(found)} seam(s)'}")
            for f in found:
                if f.get("kind") == "ring":
                    print(f"  ring: dark ring round the disc at ({f['x']}, {f['y']}), radius {f['radius_px']} px: "
                          f"{f['dip_px']} px out from its edge the sky falls to {f['level']} and climbs {f['climb']} levels back")
                    continue
                where = (f"x {f['x']}, y {f['y'][0]}-{f['y'][1]}" if f["orientation"] == "vertical"
                         else f"y {f['y']}, x {f['x'][0]}-{f['x'][1]}")
                print(f"  {f['orientation']} seam at {where} ({f['length_px']} px), {f['channel']} {f['levels'][0]} -> {f['levels'][1]}")
    if a.json:
        print(json.dumps(report, indent=1))
    elif bad:
        print(f"{bad} night(s) with a hard straight seam or a dark ring round a moon: fix the flat day, its night-light "
              f"mask or the night header with soft-edged masks and rebuild the night with upscale.py "
              f"(brand/tools/sky_seams.py explains the check)")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
