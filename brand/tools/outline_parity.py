#!/usr/bin/env python3
"""Fail a night whose figures do not keep their day's outline, or whose figures sink into the sky.

    python3 brand/tools/outline_parity.py                  # every scene with a brand/figures/<scene>.json and a night
    python3 brand/tools/outline_parity.py workshop ...     # just these scenes (day names)
    python3 brand/tools/outline_parity.py --scenes DIR     # read <scene>-3072.webp and <scene>-dark-3072.webp from DIR
    python3 brand/tools/outline_parity.py --overlay DIR    # also write DIR/<scene>-{day,night}.png, each figure's snapped edge drawn on it
    python3 brand/tools/outline_parity.py --json           # one JSON document per run

A night made from its day has the day's figures: the same outline under other light. Two things have
shipped or nearly shipped wrong, and each needed a person with a 10x look to catch it (2026-11-18,
playwright-focus-proof's re-set): a glass figure's hood and shoulder replaced by sky (the night was
(10,28,74) where the day was (254,241,197), and the top edge sat 25 to 34 px lower), and a blue robot whose
dome and antenna ball fell to the sky's value (24 against 28 to 31; (0,25,67) against (9,26,61)).

The registry, brand/figures/<scene>.json, names each figure (a person, a robot, Ouro, a prop) and gives a
polygon in the pixels of the day 3072 scene, brand/scenes/<scene>-3072.webp. One polygon serves day and
night, because the night keeps the day's geometry. The polygon only has to lie within `band` px (default 6)
of the real edge; the tool finds the edge itself. Format (also the "format" key at the top of each file):

    {"scene": "<scene>",
     "figures": [{"name": "robot", "kind": "robot",
                  "polygon": [[x, y], ...],     # 3 or more corners, 3072-scale pixels of the day scene
                  "seeds": [[x, y], ...],       # optional: points known to be inside the figure
                  "band": 6}]}                  # optional: how far the real edge may sit from the polygon, in px

What is checked, for every figure of a scene that has a night:

- Edge shift. The polygon is snapped to the real edge in the DAY (GrabCut, OpenCV, run on the figure's
  neighbourhood, 5 fixed iterations, no randomness). Every 3 px along that outline the night's edge is
  looked for along the outward normal: its profile (gradient of log colour) is matched against the day's, and a
  night ridge that sits on the day's edge wins. The 99th percentile of the shifts must be 2 px or less.
  Whole-mask diffing was tried first and rejected: on the shipped nights, mask noise alone moves the boundary
  by 2 to 6 px, so it could not tell a real shift from a good night.
- Edge position, run rule. The 99th percentile above dilutes a short run of shift over a long outline, and match()
  settles a point on a night ridge that sits on the day's edge and reaches only 3 px. So a second reading, locate(),
  takes every 3 px the shift (to a fraction of a pixel, within SEARCH = 8 px either side) at which the whole night
  profile best matches the day's, with no override by a ridge that happens to sit on the day's edge. Points whose
  day edge is weaker than EDGE_LOC (glass, haze) say nothing about position. After a 3-point median, any unbroken
  run of RUN_SHIFT = 24 px or more beyond SHIFT_MAX fails. A person's hood edge 3.5 px inward along 40 px passes
  the 99th percentile on a long outline but fails here.
- Small parts, size rule. A closed part of a figure that holds a 4 px disc and is under 40 px across (an antenna
  ball, an eye disc) is measured on its own: the radius of the strongest gradient ridge along 72 rays from its
  centre, day and night, median. Its diameter in the night may differ from the day's by 2 px or 10%, whichever is
  more. A night ball that keeps its glow's core and loses its disc is 3 to 5 px smaller by this measure.
- Edge lost. Where the day has an edge, the night must keep at least 25% of its strength.
- Sunk into the sky. Along the outline, the mean colour of a strip 6 to 14 px inside the figure (2 to 6 px
  for thin parts such as antennas) and of a strip 2 to 10 px outside (the adjacent sky or background) are
  compared in the night, as a distance in RGB (0 to 441). Wherever they differed by 40 or more in the day,
  the night's must be N = 8 or more. A run of 24 px or more below N fails.
  Reported: the smallest contrast, and for a failing run its coordinates and both colours.

Calibration is in the pull request that added this file (every shipped night and the playwright re-set
that failed). A scene that fails is fixed in the night (restore the figure's outline and its value against
the sky), never by loosening these numbers. Needs Pillow, numpy, scipy and opencv-python-headless.
Exit 0 when clean, 1 when any figure fails, 2 when a registry file is unusable.
"""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, gaussian_filter, map_coordinates, median_filter

BRAND = Path(__file__).resolve().parent.parent
SHIFT_MAX = 2.0        # px: the 99th percentile of the edge's shift, day to night
SHIFT_PCT = 99
KEEP_MIN = 0.25        # an edge is lost when the night keeps less than this share of the day's edge strength
N = 8                  # levels (RGB distance, 0 to 441): figure and adjacent sky must differ by at least this in the night
DAY_MIN = 40           # ... wherever they differed by this much in the day
RUN = 24               # px of outline: the length of unbroken sunk edge that fails
DEEP = (6, 14)         # px inside the edge: the strip that stands for the figure (a rim line at the very edge is not the figure)
OUT = (2, 10)          # px outside the edge: the strip that stands for the adjacent sky
PEAK = 0.4            # a night ridge counts as an edge when it is this share of the night's strongest ridge in reach
EDGE_MIN = 0.05        # log-gradient per px: weaker day edges say nothing
BAND = 6               # px: default slack between the polygon and the real edge
ITERS = 5
STEP = 3               # px between contour points
REACH = 10.0          # px of profile read either side of the day's edge: how far an edge may have moved and still be found
WIN = 4.0              # px either side of the edge: the part of the profile that is matched
PRIOR = 0.02           # match score lost per px of shift: of two equal matches the nearer one wins
CORR_MIN = 0.5         # an edge is lost when no shift makes the night's profile resemble the day's this much
NEAR = 3.0            # px either side of the contour where the day's own edge is looked for
SEARCH = 8.0           # px either side of the day's edge: how far the night's strongest ridge is looked for (the edge-position check)
LOCAL = 3              # contour points per median in the edge-position check (6 px of outline): short enough that a 30 px run is not diluted
EDGE_LOC = 0.12        # log-gradient per px: a day edge weaker than this (glass, haze) has no position to hold to a pixel
RUN_SHIFT = 24         # px of outline: the length of unbroken shift beyond SHIFT_MAX that fails
PART_D = 40.0          # px: a closed part of a figure with an equivalent diameter below this is a small part (antenna ball, eye disc)
PART_OPEN = 4          # px: radius of the disc a small part has to hold, so that a stalk or a rim line is not one
PART_TOL = 2.0         # px: a small part's diameter may differ from the day's by this much, or by PART_REL of it, whichever is more
PART_REL = 0.10
SMOOTH = 9             # contour points (27 px of outline) per median
PAD = 24               # px of picture kept round the polygon


def load(path):
    return np.asarray(Image.open(path).convert("RGB"))


def polygon_mask(shape, polygon):
    m = np.zeros(shape, np.uint8)
    cv2.fillPoly(m, [np.round(np.asarray(polygon, np.float64)).astype(np.int32)], 1)
    return m.astype(bool)


def window(shape, polygon, seeds, band):
    xs = [p[0] for p in polygon] + [p[0] for p in seeds]
    ys = [p[1] for p in polygon] + [p[1] for p in seeds]
    m = int(band) + PAD
    x0, x1 = max(int(min(xs)) - m, 0), min(int(max(xs)) + m + 1, shape[1])
    y0, y1 = max(int(min(ys)) - m, 0), min(int(max(ys)) + m + 1, shape[0])
    return y0, y1, x0, x1


def snap(img, polygon, seeds=(), band=BAND):
    """The figure's mask in `img` (an H x W x 3 uint8 picture): the polygon snapped to the real edge."""
    y0, y1, x0, x1 = window(img.shape[:2], polygon, seeds, band)
    crop = np.ascontiguousarray(img[y0:y1, x0:x1][..., ::-1])
    shifted = [[p[0] - x0, p[1] - y0] for p in polygon]
    poly = polygon_mask(crop.shape[:2], shifted)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * int(band) + 1, 2 * int(band) + 1))
    inner = cv2.erode(poly.astype(np.uint8), k, borderType=cv2.BORDER_CONSTANT, borderValue=0).astype(bool)
    outer = cv2.dilate(poly.astype(np.uint8), k).astype(bool)
    gc = np.full(crop.shape[:2], cv2.GC_BGD, np.uint8)
    gc[outer] = cv2.GC_PR_BGD
    gc[poly] = cv2.GC_PR_FGD
    gc[inner] = cv2.GC_FGD
    for sx, sy in seeds:
        cv2.circle(gc, (int(round(sx - x0)), int(round(sy - y0))), 2, cv2.GC_FGD, -1)
    if not (gc == cv2.GC_FGD).any():  # a figure thinner than the band: trust the polygon's centre line
        gc[distance_transform_edt(poly) >= max(distance_transform_edt(poly).max() * 0.5, 1)] = cv2.GC_FGD
    cv2.setRNGSeed(0)
    cv2.grabCut(crop, gc, None, np.zeros((1, 65)), np.zeros((1, 65)), ITERS, cv2.GC_INIT_WITH_MASK)
    fg = (gc == cv2.GC_FGD) | (gc == cv2.GC_PR_FGD)
    n, lab = cv2.connectedComponents(fg.astype(np.uint8), connectivity=4)
    keep = np.unique(lab[(gc == cv2.GC_FGD) & fg])
    fg = np.isin(lab, keep[keep > 0])
    out = np.zeros(img.shape[:2], bool)
    out[y0:y1, x0:x1] = fg
    return out


def log_gradient(img):
    """Edge strength of a picture in the log domain, so a darker night with the same shapes has the same edges."""
    a = gaussian_filter(np.log(img.astype(np.float32) + 16), (1.0, 1.0, 0))
    gy, gx = np.gradient(a, axis=(0, 1))
    return np.sqrt((gx ** 2 + gy ** 2).sum(2))


def contour_points(mask):
    """Points every STEP px along the mask's outer contours, with the outward unit normal at each."""
    cs, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    pts, nrm, ids = [], [], []
    for j, c in enumerate(cs):
        c = c[:, 0, :].astype(np.float32)
        n = len(c)
        if n < 8:
            continue
        k = min(5, n // 4)
        for i in range(0, n, STEP):
            t = c[(i + k) % n] - c[(i - k) % n]
            length = float(np.hypot(*t))
            if length == 0:
                continue
            v = np.array([t[1], -t[0]]) / length
            q = c[i] + 3 * v
            xi, yi = int(round(q[0])), int(round(q[1]))
            if 0 <= yi < mask.shape[0] and 0 <= xi < mask.shape[1] and mask[yi, xi]:
                v = -v
            pts.append(c[i])
            nrm.append(v)
            ids.append(j)
    return np.array(pts), np.array(nrm), np.array(ids)


def profiles(grad, pts, nrm):
    t = np.arange(-REACH, REACH + 0.25, 0.5)
    x = pts[:, 0:1] + nrm[:, 0:1] * t[None]
    y = pts[:, 1:2] + nrm[:, 1:2] * t[None]
    return map_coordinates(grad, [y, x], order=1, mode="nearest")


def smooth(v, ids, size=SMOOTH):
    """Running median of v along each contour (ids says which contour a point is on)."""
    out = np.array(v, float)
    for j in np.unique(ids):
        k = np.nonzero(ids == j)[0]
        out[k] = median_filter(out[k], min(size, len(k) if len(k) % 2 else len(k) - 1) or 1, mode="wrap")
    return out


def peaks(row, floor):
    """Indices of the local maxima of a profile that reach `floor`."""
    mid = row[1:-1]
    return np.nonzero((mid > row[:-2]) & (mid >= row[2:]) & (mid >= floor))[0] + 1


def match(day_img, night_img, mask):
    """For each contour point of the day's figure: where its edge went in the night, how well, how much of it is left.

    The shift is the one at which the night's edge profile best matches the day's (normalised correlation of
    the profile within WIN px of the edge, preferring the smaller shift). A night that has a ridge of its own
    on the day's edge, at least PEAK of its strongest ridge in reach, has not moved the edge, whatever
    neighbouring edge it also shows; that settles the point at that ridge.
    """
    pts, nrm, ids = contour_points(mask)
    if len(pts) == 0:
        return None
    pd, pn = profiles(log_gradient(day_img), pts, nrm), profiles(log_gradient(night_img), pts, nrm)
    c, w, near = pd.shape[1] // 2, int(WIN * 2), int(NEAR * 2)
    shift = np.zeros(len(pts))
    corr = np.full(len(pts), -1.0)
    day_edge = np.zeros(len(pts))
    night_edge = np.zeros(len(pts))
    reach = int(REACH * 2) - w - near
    for i in range(len(pts)):
        td = c - near + int(np.argmax(pd[i, c - near:c + near + 1]))
        ref = pd[i, td - w:td + w + 1]
        r = ref - ref.mean()
        score = -9.0
        for s in range(-reach, reach + 1):
            q = pn[i, td - w + s:td + w + 1 + s]
            q = q - q.mean()
            d = np.linalg.norm(r) * np.linalg.norm(q)
            cc = float(r @ q / d) if d > 1e-9 else 0.0
            if cc - PRIOR * abs(s) / 2.0 > score:
                score, corr[i], shift[i] = cc - PRIOR * abs(s) / 2.0, cc, s / 2.0
        day_edge[i] = pd[i, td]
        found = peaks(pn[i], PEAK * pn[i].max())
        if len(found):
            tn = found[np.argmin(np.abs(found - td))]
            if abs(tn - td) <= 2:
                shift[i], corr[i] = (tn - td) / 2.0, 1.0
        night_edge[i] = pn[i, td + int(round(shift[i] * 2)) - 1:td + int(round(shift[i] * 2)) + 2].max()
    return {"pts": pts, "nrm": nrm, "ids": ids, "shift": shift, "corr": corr, "day_edge": day_edge, "night_edge": night_edge}


def ridge(row, lo, hi):
    """Sub-pixel position (index) and height of the strongest local maximum of a profile between lo and hi, or None."""
    best = None
    for i in range(max(lo, 1), min(hi, len(row) - 2) + 1):
        if row[i] > row[i - 1] and row[i] >= row[i + 1] and (best is None or row[i] > row[best]):
            best = i
    if best is None:
        return None
    a, b, c = row[best - 1], row[best], row[best + 1]
    den = a - 2 * b + c
    return best + (0.5 * (a - c) / den if den < -1e-9 else 0.0), float(b)


def locate(day_img, night_img, mask):
    """Where the figure's edge went, to a fraction of a pixel, at each contour point: the shift (along the outward
    normal, SEARCH px either side) at which the night's gradient profile best matches the day's, refined by a
    parabola through the best score and its neighbours. Unlike match(), a night ridge that sits on the day's edge
    does not settle the point: the whole profile has to line up. nan where nothing in reach resembles the day's edge.
    """
    pts, nrm, ids = contour_points(mask)
    if len(pts) == 0:
        return None
    t = np.arange(-(SEARCH + WIN + NEAR) - 1, SEARCH + WIN + NEAR + 1.01, 0.5)
    gd, gn = log_gradient(day_img), log_gradient(night_img)

    def prof(g):
        x = pts[:, 0:1] + nrm[:, 0:1] * t[None]
        y = pts[:, 1:2] + nrm[:, 1:2] * t[None]
        return map_coordinates(g, [y, x], order=1, mode="nearest")

    pd, pn = prof(gd), prof(gn)
    c, w, near, reach = len(t) // 2, int(WIN * 2), int(NEAR * 2), int(SEARCH * 2)
    sh = np.full(len(pts), np.nan)
    for i in range(len(pts)):
        td = c - near + int(np.argmax(pd[i, c - near:c + near + 1]))
        if pd[i, td] < EDGE_LOC:
            continue
        r = pd[i, td - w:td + w + 1]
        r = r - r.mean()
        sc = np.full(2 * reach + 1, -9.0)
        for k, s_ in enumerate(range(-reach, reach + 1)):
            q = pn[i, td - w + s_:td + w + 1 + s_]
            q = q - q.mean()
            d = np.linalg.norm(r) * np.linalg.norm(q)
            sc[k] = float(r @ q / d) if d > 1e-9 else 0.0
        k = int(np.argmax(sc))
        if sc[k] < CORR_MIN:
            continue
        off = 0.0
        if 0 < k < len(sc) - 1:
            den = sc[k - 1] - 2 * sc[k] + sc[k + 1]
            off = 0.5 * (sc[k - 1] - sc[k + 1]) / den if den < -1e-9 else 0.0
        sh[i] = (k - reach + off) / 2.0
    return {"pts": pts, "nrm": nrm, "ids": ids, "shift": sh}


def local_median(v, ids, size=LOCAL):
    """Running median of v along each contour, over the points that have a value (nan stays nan)."""
    out = np.full(len(v), np.nan)
    for j in np.unique(ids):
        k = np.nonzero(ids == j)[0]
        for a, i in enumerate(k):
            w = v[k[[(a + o) % len(k) for o in range(-(size // 2), size // 2 + 1)]]]
            w = w[~np.isnan(w)]
            if len(w) > size // 2:
                out[i] = np.median(w)
    return out


def small_parts(mask):
    """Closed parts of the figure that are small (an antenna ball, an eye disc): masks of the parts that hold a disc
    of PART_OPEN px and whose area is that of a disc narrower than PART_D px. A stalk or a rim line holds no such disc."""
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * PART_OPEN + 1, 2 * PART_OPEN + 1))
    core = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_OPEN, k)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(core, connectivity=8)
    parts = []
    for j in range(1, n):
        part = cv2.dilate((lab == j).astype(np.uint8), k).astype(bool) & mask
        d = 2 * np.sqrt(part.sum() / np.pi)
        if d < PART_D:
            parts.append((part, float(d)))
    return parts


def radius(grad, cx, cy, lo, hi):
    """Median over 72 rays from (cx, cy) of the radius of the strongest gradient ridge between lo and hi px (sub-pixel)."""
    r = np.arange(lo, hi + 0.01, 0.25)
    out = []
    for a in np.linspace(0, 2 * np.pi, 72, endpoint=False):
        row = map_coordinates(grad, [cy + r * np.sin(a), cx + r * np.cos(a)], order=1, mode="nearest")
        g = ridge(row, 1, len(row) - 2)
        if g is not None and g[1] >= EDGE_MIN:
            out.append(lo + g[0] * 0.25)
    return float(np.median(out)) if len(out) >= 36 else None


def part_checks(day_img, night_img, mask):
    """Each small part's size in the night against the day's: the radius of its edge's strongest ridge along rays from its centre."""
    out = []
    gd, gn = log_gradient(day_img), log_gradient(night_img)
    for part, d in small_parts(mask):
        cy, cx = (float(v) for v in np.argwhere(part).mean(0))
        rd = radius(gd, cx, cy, 0.5 * d / 2, 1.5 * d / 2)
        rn = radius(gn, cx, cy, 0.5 * d / 2, 1.5 * d / 2)
        if rd is None or rn is None:
            continue
        out.append((int(cx), int(cy), 2 * rd, 2 * (rd - rn), max(PART_TOL, PART_REL * 2 * rd)))
    return out


def strip_mean(img, pts, nrm, a, b):
    """Mean colour of the picture over the strip from a to b px along each point's outward normal."""
    t = np.arange(a, b + 0.01, 0.5)
    x = pts[:, 0:1] + nrm[:, 0:1] * t[None]
    y = pts[:, 1:2] + nrm[:, 1:2] * t[None]
    return np.stack([map_coordinates(img[..., c].astype(np.float32), [y, x], order=1, mode="nearest").mean(1) for c in range(3)], 1)


def contrast(img, pts, nrm, thin):
    """Distance in RGB between the figure's strip and the adjacent sky's, at each contour point."""
    inside, outside = ((2, 6), (2, 6)) if thin else (DEEP, OUT)
    a = strip_mean(img, pts, nrm, -inside[1], -inside[0])
    b = strip_mean(img, pts, nrm, outside[0], outside[1])
    return np.linalg.norm(a - b, axis=1), a, b


def runs_of(flag):
    idx = np.nonzero(flag)[0]
    return np.split(idx, np.nonzero(np.diff(idx) > 1)[0] + 1) if len(idx) else []


def check_figure(day_img, night_img, fig):
    poly, seeds, band = fig["polygon"], fig.get("seeds", []), fig.get("band", BAND)
    md = snap(day_img, poly, seeds, band)
    m = match(day_img, night_img, md)
    fails = []
    if m is None:
        return {"name": fig["name"], "shift": float("inf"), "worst": None, "min_edge": None, "min_contrast": None, "min_at": None, "points": 0,
                "fails": ["no figure found at the polygon in the day"], "mask": md}
    strong = m["day_edge"] >= EDGE_MIN
    ratio = m["night_edge"] / np.maximum(m["day_edge"], 1e-6)
    lost = strong & ((m["corr"] < CORR_MIN) | (ratio < KEEP_MIN))
    lost_s = smooth(lost, m["ids"]).astype(bool)
    moved = smooth(m["shift"], m["ids"])
    ok = strong & ~lost_s
    p99 = float(np.percentile(np.abs(moved[ok]), SHIFT_PCT)) if ok.any() else 0.0
    wi = int(np.argmax(np.where(ok, np.abs(moved), -1)))
    worst = (int(m["pts"][wi][0]), int(m["pts"][wi][1]), float(moved[wi]))
    if p99 > SHIFT_MAX:
        fails.append("outline moved %.1f px (limit %g); worst at (%d,%d), %.1f px along the outward normal" % ((p99, SHIFT_MAX) + worst))
    for run in runs_of(lost_s):
        i = int(run[np.argmin(ratio[run])])
        x, y = (int(v) for v in m["pts"][i])
        fails.append("edge lost at (%d,%d), %d px of outline: the night keeps %.0f%% of the day's edge; night %s, day %s" % (
            x, y, len(run) * STEP, 100 * ratio[i], tuple(night_img[y, x].tolist()), tuple(day_img[y, x].tolist())))
    loc = locate(day_img, night_img, md)
    if loc is not None:
        near_s = local_median(loc["shift"], loc["ids"])
        far = np.nan_to_num(np.abs(near_s), nan=0.0) > SHIFT_MAX
        for run in runs_of(far):
            if len(run) * STEP < RUN_SHIFT:
                continue
            i = int(run[np.argmax(np.abs(near_s[run]))])
            x, y = (int(v) for v in loc["pts"][i])
            sig = float(np.median(near_s[run]))
            fails.append("edge moved %.1f px (limit %g) along %d px of outline at (%d,%d); median %.1f px along the outward normal" % (
                abs(near_s[i]), SHIFT_MAX, len(run) * STEP, x, y, sig))
        for x, y, d, change, tol in part_checks(day_img, night_img, md):
            if abs(change) > tol:
                fails.append("small part changed size at (%d,%d): diameter %.1f px in the day, %.1f px %s in the night (limit %.1f px)" % (
                    x, y, d, abs(change), "smaller" if change > 0 else "larger", tol))
    thin = band <= 3
    cd, _, _ = contrast(day_img, m["pts"], m["nrm"], thin)
    cn, fn, sn = contrast(night_img, m["pts"], m["nrm"], thin)
    cd, cn = smooth(cd, m["ids"]), smooth(cn, m["ids"])
    seen = cd >= DAY_MIN
    sunk = seen & (cn < N)
    for run in runs_of(sunk):
        if len(run) * STEP < RUN and len(run) < len(m["pts"]) / 2:
            continue
        i = int(run[np.argmin(cn[run])])
        x, y = (int(v) for v in m["pts"][i])
        fails.append("figure sunk into the sky at (%d,%d), %d px of outline: night %s against sky %s, %.1f levels apart (limit %g); day %.0f apart" % (
            x, y, len(run) * STEP, tuple(int(v) for v in np.round(fn[i])), tuple(int(v) for v in np.round(sn[i])), cn[i], N, cd[i]))
    min_contrast = float(cn[seen].min()) if seen.any() else None
    kept = smooth(ratio, m["ids"])
    low = int(np.argmin(np.where(strong, kept, np.inf)))
    return {"name": fig["name"], "shift": p99, "worst": worst, "min_edge": float(kept[low]) if strong.any() else None, "min_contrast": min_contrast,
            "min_at": (int(m["pts"][low][0]), int(m["pts"][low][1])), "points": int(len(m["pts"])), "fails": fails, "mask": md}


def load_registry(path):
    try:
        reg = json.loads(Path(path).read_text())
        for f in reg["figures"]:
            assert f["name"] and len(f["polygon"]) >= 3 and all(len(p) == 2 for p in f["polygon"])
        return reg
    except Exception as e:  # noqa: BLE001
        raise SystemExit("outline_parity: %s is not a usable figure registry (%s)" % (path, e))


def draw(img, results):
    out = np.ascontiguousarray(img[..., ::-1].copy())
    for r in results:
        cs, _ = cv2.findContours(r["mask"].astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        cv2.drawContours(out, cs, -1, (0, 255, 0) if not r["fails"] else (0, 0, 255), 1)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("scenes", nargs="*")
    ap.add_argument("--scenes-dir", "--scenes", dest="dir", default=str(BRAND / "scenes"))
    ap.add_argument("--figures", default=str(BRAND / "figures"))
    ap.add_argument("--overlay")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    names = a.scenes or sorted(p.stem for p in Path(a.figures).glob("*.json"))
    rows, failed = [], False
    for s in names:
        reg = load_registry(Path(a.figures) / (s + ".json"))
        dp, np_ = Path(a.dir) / (s + "-3072.webp"), Path(a.dir) / (s + "-dark-3072.webp")
        if not dp.exists() or not np_.exists():
            print("outline_parity: %s has no night or no day 3072 scene; skipped" % s)
            continue
        day, night = load(dp), load(np_)
        res = [check_figure(day, night, f) for f in reg["figures"]]
        for r in res:
            rows.append((s, r))
            failed |= bool(r["fails"])
        if a.overlay:
            Path(a.overlay).mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(Path(a.overlay) / (s + "-day.png")), draw(day, res))
            cv2.imwrite(str(Path(a.overlay) / (s + "-night.png")), draw(night, res))
    if a.json:
        print(json.dumps([{k: v for k, v in r.items() if k != "mask"} | {"scene": s} for s, r in rows], indent=1))
    else:
        print("%-26s %-24s %8s %10s %12s  %s" % ("scene", "figure", "shift px", "edge kept", "contrast", "verdict"))
        for s, r in rows:
            ek = "-" if r["min_edge"] is None else "%.2f" % r["min_edge"]
            mc = "-" if r["min_contrast"] is None else "%.1f" % r["min_contrast"]
            print("%-26s %-24s %8.2f %10s %12s  %s" % (s, r["name"], r["shift"], ek, mc, "FAIL" if r["fails"] else "ok"))
        for s, r in rows:
            for f in r["fails"]:
                print("FAIL %s / %s: %s" % (s, r["name"], f))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
