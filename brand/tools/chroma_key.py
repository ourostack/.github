"""Keys a creature painted alone on flat #00FF00 into a trimmed RGBA PNG, for art that moves over a painted scene.

    python3 brand/tools/chroma_key.py raw.png out.png              # key, unmix the edges, trim
    python3 brand/tools/chroma_key.py raw.png out.png --cool       # a blue creature: no green left in it at all
    python3 brand/tools/chroma_key.py raw.png out.png --with lit.png out-lit.png   # a pair, trimmed to one box
    python3 brand/tools/chroma_key.py raw.png out.png --mirror     # turned to face the other way
    python3 brand/tools/chroma_key.py raw.png out.png --magenta    # painted on #FF00FF instead, for a green creature

Image generation can't paint transparency (asked for it, it paints a checkerboard), so a sprite is painted on key
green and keyed here. Alpha ramps from the subject (no green spill) to the key (full spill), so fins and tentacles
keep their soft edges; an edge pixel's key share is taken back out of its colour, then what green is left is clamped
to its red or blue. A pair (a ship and the same ship lit, made by an edit "in exactly the same place") is trimmed to
the union of both boxes, so the two stack pixel for pixel. Every stage sprite's provenance names this file.
"""
import sys

import numpy as np
from PIL import Image

LOW, HIGH = 0.08, 0.40
PAD = 8


def key(path, cool=False, magenta=False):
    im = np.asarray(Image.open(path).convert("RGB")).astype(np.float32) / 255
    if magenta:
        spill = np.minimum(im[..., 0], im[..., 2]) - im[..., 1]
    else:
        spill = im[..., 1] - np.maximum(im[..., 0], im[..., 2])
    alpha = np.clip(1 - (spill - LOW) / (HIGH - LOW), 0, 1)
    a = np.maximum(alpha, 1e-3)[..., None]
    k = np.array([1.0, 0.0, 1.0] if magenta else [0.0, 1.0, 0.0], np.float32)
    rgb = np.clip((im - (1 - a) * k) / a, 0, 1)
    if magenta:
        excess = np.maximum(np.minimum(rgb[..., 0], rgb[..., 2]) - rgb[..., 1], 0)
        rgb[..., 0] -= excess
        rgb[..., 2] -= excess
    else:
        rgb[..., 1] = np.minimum(rgb[..., 1], np.maximum(rgb[..., 0], rgb[..., 2]))
    if cool:
        rgb[..., 1] = np.minimum(rgb[..., 1], rgb[..., 2] * 0.88)
    rgba = np.concatenate([rgb, alpha[..., None]], -1)
    return Image.fromarray((rgba * 255).round().astype(np.uint8))


def box(img):
    x0, y0, x1, y1 = img.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    return max(0, x0 - PAD), max(0, y0 - PAD), min(img.width, x1 + PAD), min(img.height, y1 + PAD)


def main(args):
    cool, mirror, magenta = "--cool" in args, "--mirror" in args, "--magenta" in args
    args = [a for a in args if a not in ("--cool", "--mirror", "--magenta")]
    pairs = [(args[0], args[1])]
    if "--with" in args:
        i = args.index("--with")
        pairs.append((args[i + 1], args[i + 2]))
    keyed = [(key(src, cool, magenta), out) for src, out in pairs]
    boxes = [box(img) for img, _ in keyed]
    union = (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))
    for img, out in keyed:
        img = img.crop(union)
        (img.transpose(Image.FLIP_LEFT_RIGHT) if mirror else img).save(out)
        print(out, union)


if __name__ == "__main__":
    main(sys.argv[1:])
