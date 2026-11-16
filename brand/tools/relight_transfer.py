#!/usr/bin/env python3
"""Give a day picture a night's light and colour while keeping every shape of the day.

    python3 brand/tools/relight_transfer.py DAY NIGHT OUT [--radius 24]

upscale.py uses it to build the 4x master of a night scene whose day twin sets
"nightFromDay" in crops.json: the day's 4x master takes the light and colour of
the night header, so every size cut from the night master has the day master's
exact structure. Real-ESRGAN run on the day and the night separately invents
different fine texture and glyph-like specks in each; this keeps them identical.

Light multiplies, so the work is done on log(channel + 0.02). In each window of
(2R+1)^2 px the day's log channel is given the night's local mean and local
contrast, out_c = a_c * (day_c - mean_day_c) + mean_night_c with
a_c = min(std_night_c / std_day_c, max_gain), and a and the offsets are box-smoothed
so they vary only slowly. Every edge, prop and outline in the output comes from
the day; the night gives only its colour grade, darkness, local contrast, glows
and gradients. A night may be smaller than the day if it has the same aspect
ratio: it is Lanczos-resized up first, which is safe because only its light is used.

The radius is in pixels at 1536 px wide and scales with the day's width (96 at
6144). 24 is the default: on flow-review and ouro-ui-core it left no parity
flags at 3072 px, where 8 and 4 let the night header's softer structure back in.

The algorithm is the art handoff's hdr/tools/relight_transfer.py (ouro-art-handoff),
which made the shipped nights from a generated relight; its --keep-mask and
--light-match options are not carried over. The box filter here is scipy's
uniform_filter with mode "reflect", the same border as OpenCV's BORDER_REFLECT
used there.

Needs Pillow, numpy and scipy.
"""
import argparse

import numpy as np
from PIL import Image
from scipy.ndimage import uniform_filter

DELTA = 0.02
RADIUS = 24
EPS = 1e-3
MAX_GAIN = 2.0


def _box(a, r):
    return uniform_filter(a, size=2 * r + 1, mode="reflect")


def _contrast_match(day, night, r, eps, max_gain):
    out = np.empty_like(night)
    for c in range(3):
        i, q = day[..., c], night[..., c]
        mi, mq = _box(i, r), _box(q, r)
        vi = np.maximum(_box(i * i, r) - mi * mi, 0)
        vq = np.maximum(_box(q * q, r) - mq * mq, 0)
        a = np.minimum(np.sqrt((vq + eps) / (vi + eps)), max_gain)
        b = mq - a * mi
        out[..., c] = _box(a, r) * i + _box(b, r)
    return out


def transfer(day: Image.Image, night: Image.Image, radius=RADIUS, eps=EPS, max_gain=MAX_GAIN) -> Image.Image:
    """The day's structure under the night's light and colour, at the day's size."""
    day, night = day.convert("RGB"), night.convert("RGB")
    if night.size != day.size:
        if abs((day.width / day.height) / (night.width / night.height) - 1) > 0.01:
            raise ValueError(f"night {night.width}x{night.height} is not in the day's frame {day.width}x{day.height}")
        night = night.resize(day.size, Image.LANCZOS)
    d = np.asarray(day, np.float32) / 255
    n = np.asarray(night, np.float32) / 255
    r = max(1, round(radius * day.width / 1536))
    out = np.exp(_contrast_match(np.log(d + DELTA), np.log(n + DELTA), r, eps, max_gain)) - DELTA
    return Image.fromarray(np.clip(out * 255 + 0.5, 0, 255).astype(np.uint8))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("day")
    ap.add_argument("night")
    ap.add_argument("out")
    ap.add_argument("--radius", type=int, default=RADIUS)
    ap.add_argument("--eps", type=float, default=EPS)
    ap.add_argument("--max-gain", type=float, default=MAX_GAIN)
    a = ap.parse_args()
    transfer(Image.open(a.day), Image.open(a.night), a.radius, a.eps, a.max_gain).save(a.out)


if __name__ == "__main__":
    main()
