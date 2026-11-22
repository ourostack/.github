#!/usr/bin/env python3
"""Check that Ouro's body is an open C, not a closed ring: the body mask must enclose no hole.

    python3 brand/tools/ouro_gap.py brand/ouro.png               # a transparent mark: its alpha is the body
    python3 brand/tools/ouro_gap.py SCENE.png --mask BODY.png    # a scene: a greyscale mask of Ouro's body
    python3 brand/tools/ouro_gap.py --marks                      # every transparent Ouro mark listed below

Ouro is an open "C" curl: the head and the short tail tip are the two ends of one body, with a
visible gap between them where the body never meets itself (agents/art-one-universe.md). A closed
ring (a donut with a head and a tail tip growing out of it) is the defect reviewers kept passing,
because "one head, one tail tip" still counts out right (garden-line, 2026-11-16).

The test is topology, not taste. Take the body as a binary mask (alpha above half, or the mask
above half), close pin-holes of at most a few pixels, and fill every hole. Any filled region
larger than MIN_HOLE of the body's area is background the body wraps all the way round: the
body closed on itself, so the check fails. An open C has no such hole, because the background
inside the curl runs out through the gap.

What it can't do: find Ouro in a scene by itself. In the scenes he sits on green hedges, green
engines and green velvet, and scarves, trays and props cross his body, so no colour rule separates
his body from the picture; that would need a segmentation model, which makes the check neither
deterministic nor cheap. So scenes are checked by the blind hunt's trace step, and by this tool
only when a body mask is supplied (for example the one a fix was pasted through). Transparent
marks carry their own mask in their alpha and are checked in CI.

Exit 0 when every body is open, 1 when one is closed, 2 on bad input. Needs Pillow, numpy, scipy.
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

BRAND = Path(__file__).resolve().parents[1]
# Transparent pictures of Ouro whose alpha is his body alone.
MARKS = ["ouro.png"]
MIN_HOLE = 0.01  # a hole under 1% of the body's area is a pin-hole or a gap in the shading, not a ring


def body_from(image, mask=None):
    if mask is not None:
        return np.asarray(Image.open(mask).convert("L")) >= 128
    im = Image.open(image)
    if "A" not in im.getbands():
        raise ValueError(f"{image} has no alpha channel; pass --mask with Ouro's body")
    return np.asarray(im.getchannel("A")) >= 128


def holes(body):
    """Return (enclosed hole area, body area, number of holes) for a boolean body mask."""
    solid = ndimage.binary_closing(body, iterations=2)
    filled = ndimage.binary_fill_holes(solid)
    hole = filled & ~solid
    labels, n = ndimage.label(hole)
    area = int(solid.sum())
    sizes = ndimage.sum(hole, labels, range(1, n + 1)) if n else []
    big = [int(s) for s in sizes if s >= MIN_HOLE * area]
    return sum(big), area, len(big)


def check(image, mask=None):
    hole, area, n = holes(body_from(image, mask))
    if not area:
        return False, f"{image}: no body found in the mask"
    if n:
        return False, f"{image}: CLOSED: the body wraps all the way round {n} hole(s) of {hole} px ({hole / area:.0%} of the body); Ouro must be an open C with a gap between head and tail tip"
    return True, f"{image}: open: no enclosed hole; the inside of the curl runs out through the gap"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image", nargs="?")
    ap.add_argument("--mask")
    ap.add_argument("--marks", action="store_true", help="check every transparent Ouro mark in brand/")
    a = ap.parse_args()
    targets = [(BRAND / m, None) for m in MARKS] if a.marks else [(a.image, a.mask)] if a.image else []
    if not targets:
        ap.print_usage()
        return 2
    ok = True
    for image, mask in targets:
        try:
            good, message = check(image, mask)
        except (OSError, ValueError) as e:
            print(f"ouro_gap: {e}", file=sys.stderr)
            return 2
        print(message)
        ok &= good
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
