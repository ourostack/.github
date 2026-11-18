#!/usr/bin/env python3
"""Tests for sky_seams.py: python3 brand/tools/sky_seams_test.py

Synthetic day and night skies, so it needs only Pillow, numpy and scipy."""
import unittest
from pathlib import Path
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sky_seams as S  # noqa: E402

W, H = 480, 200
y, x = np.mgrid[0:H, 0:W].astype(np.float32)


def day_sky():
    """A day sky (blue at the top, paler down) over a drawn ridge at y = 150."""
    sky = np.stack([140 + 0.3 * y, 165 + 0.2 * y, 200 - 0.1 * y], -1)
    ridge = (y > 150 + 6 * np.sin(x / 40))[..., None]
    return np.where(ridge, np.array([90, 120, 80]), sky).clip(0, 255)


def night_of(day, gain=1.6, scale=(0.12, 0.16, 0.30)):
    """Light-transfer-like night: the day's log shapes at more contrast, much darker and bluer."""
    lg = np.log(day + 16)
    return (np.exp((lg - lg.mean((0, 1))) * gain + np.log(np.array(scale) * day.mean((0, 1)) + 16)) - 16).clip(0, 255)


def seams(day, night, sky=None):
    sky = np.ones((H, W), bool) if sky is None else sky
    return S.find(S.rgb(Image.fromarray(night.round().astype(np.uint8))), sky[: H],
                  S.rgb(Image.fromarray(day.round().astype(np.uint8))))


class SkySeams(unittest.TestCase):
    def test_a_clean_light_transfer_has_no_seam(self):
        day = day_sky()
        self.assertEqual(seams(day, night_of(day)), [])

    def test_a_drawn_edge_lit_harder_at_night_is_not_a_seam(self):
        day = day_sky()
        day[40:120, 100:110] = [200, 200, 200]  # a pale pole against the sky, in both
        night = night_of(day, gain=2.4)
        self.assertEqual(seams(day, night), [])

    def test_an_unfeathered_box_in_the_flat_day_fails(self):
        day = day_sky()
        night = night_of(day)
        night[30:130, 200:330] += 9  # a repaired strip pasted into the night's source with a hard box
        found = seams(day, night)
        self.assertTrue(any(f["orientation"] == "vertical" and abs(f["x"] - 330 / W) < 0.01 for f in found), found)
        self.assertTrue(any(f["orientation"] == "horizontal" and abs(f["y"] - 30 / H) < 0.02 for f in found), found)

    def test_a_sun_glow_cut_flat_fails(self):
        # the day's glow rises toward a clipped sun on the left, with a corner at x = 360 where its outer ramp begins;
        # the flattened night keeps that corner and outer ramp but stops flat on the sun's side (ouro-work, #286)
        rows = (y > 20) & (y < 140)
        inner = np.clip((360 - x) / 40, 0, 1)  # rises leftward from the corner to the clipped core
        outer = np.clip((400 - x) / 40, 0, 1) * (x >= 360)
        glow = np.where(x < 360, 0.55 + 0.45 * inner, 0.55 * outer) * rows
        day = (day_sky() + glow[..., None] * np.array([100, 80, 60])).clip(0, 255)
        flat_glow = np.where(x < 360, 1.0, outer) * rows * (x > 300)
        night = (night_of(day_sky()) + flat_glow[..., None] * np.array([20, 35, 50])).clip(0, 255)
        found = seams(day, night)
        self.assertTrue(any(f["orientation"] == "vertical" and abs(f["x"] - 360 / W) < 0.03 for f in found), found)

    def test_only_the_sky_is_checked(self):
        day = day_sky()
        night = night_of(day)
        night[30:130, 200:330] += 9
        sky = np.zeros((H, W), bool)  # no sky at all: an interior
        self.assertEqual(seams(day, night, sky), [])

    def test_the_sky_mask_stops_at_a_drawn_outline(self):
        day = day_sky()
        sky = S.sky_mask(Image.fromarray(day.round().astype(np.uint8)))
        self.assertTrue(sky[:140].all())
        self.assertFalse(sky[160:].any())


class Rings(unittest.TestCase):
    def moon(self, ring):
        """A night sky with a moon (radius 18 px) and a glow that fades into a sky brightening toward the horizon; with
        `ring`, the sky dips 9 levels about 20 px out from the moon's edge, as ourostack's did (#294)."""
        d = np.hypot(x - 240, y - 80)
        lum = 30 + 25 * np.exp(-np.clip(d - 18, 0, None) / 8) + 0.05 * y
        if ring:
            lum -= 9 * np.exp(-((d - 38) / 8) ** 2)
        lum = np.where(d < 18, 200.0, lum)
        return lum.astype(np.float32), np.ones((H, W), bool)

    def test_a_moon_with_a_smooth_glow_has_no_ring(self):
        lum, sky = self.moon(False)
        (cx, cy, r), = S.discs(lum, sky)
        self.assertIsNone(S.ring_dip(lum, sky, cx, cy, r))

    def test_a_dark_ring_round_a_moon_fails(self):
        lum, sky = self.moon(True)
        (cx, cy, r), = S.discs(lum, sky)
        self.assertIsNotNone(S.ring_dip(lum, sky, cx, cy, r))

    def test_a_dip_the_night_header_draws_too_is_not_the_builds_ring(self):
        lum, sky = self.moon(True)
        (cx, cy, r), = S.discs(lum, sky)
        self.assertIsNone(S.ring_dip(lum, sky, cx, cy, r, ref=lum))
        self.assertIsNotNone(S.ring_dip(lum, sky, cx, cy, r, ref=self.moon(False)[0]))

    def test_a_lit_thing_out_of_the_sky_is_not_a_moon(self):
        lum, _ = self.moon(True)
        self.assertEqual(S.discs(lum, np.zeros((H, W), bool)), [])


if __name__ == "__main__":
    unittest.main()
