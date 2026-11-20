#!/usr/bin/env python3
"""Tests for outline_parity.py on synthetic day and night pairs.

    python3 brand/tools/outline_parity_test.py -v
"""
import sys
import unittest
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import outline_parity as op  # noqa: E402

H, W = 360, 480
POLY = [[170, 300], [150, 190], [165, 120], [200, 80], [240, 80], [275, 120], [290, 190], [270, 300]]


def sky(level):
    y = np.linspace(0, 1, H)[:, None, None]
    base = np.array([level * 0.9, level, level * 1.2])[None, None, :]
    return np.clip(base * (1 + 0.15 * y) + np.zeros((H, W, 3)), 0, 255)


def figure_mask(dx=0, dy=0, eat=False, sigma=0.0):
    m = np.zeros((H, W), np.float32)
    cv2.fillPoly(m, [np.round(np.array(POLY) + [dx, dy]).astype(np.int32)], 1.0)
    if eat:  # the right shoulder and hood replaced by sky
        cv2.rectangle(m, (240, 60), (310, 170), 0.0, -1)
    if sigma:
        m = cv2.GaussianBlur(m, (0, 0), sigma)
    return m[..., None]


def picture(sky_level, fig_color, mask, noise=0.0, seed=0):
    rng = np.random.default_rng(seed)
    img = sky(sky_level) * (1 - mask) + np.array(fig_color, np.float32)[None, None, :] * mask
    img = img + rng.normal(0, noise, img.shape)
    return np.clip(np.round(img), 0, 255).astype(np.uint8)


def day():
    return picture(200, (60, 40, 30), figure_mask(), noise=2.0, seed=1)


FIG = {"name": "figure", "polygon": [[x + 3, y - 3] for x, y in POLY]}


class OutlineParity(unittest.TestCase):
    def check(self, night):
        return op.check_figure(day(), night, FIG)

    def test_identical_outline_passes(self):
        r = self.check(picture(30, (110, 100, 120), figure_mask(), noise=2.0, seed=2))
        self.assertEqual(r["fails"], [])
        self.assertLessEqual(r["shift"], op.SHIFT_MAX)

    def test_three_pixel_shift_fails(self):
        r = self.check(picture(30, (110, 100, 120), figure_mask(dy=3), noise=2.0, seed=2))
        self.assertTrue(any("outline moved" in f for f in r["fails"]), r["fails"])

    def test_eaten_shoulder_fails_and_names_it(self):
        r = self.check(picture(30, (110, 100, 120), figure_mask(eat=True), noise=2.0, seed=2))
        self.assertTrue(r["fails"])
        self.assertTrue(any("edge lost at (2" in f for f in r["fails"]), r["fails"])

    def test_figure_at_the_skys_value_fails(self):
        night = picture(30, (30, 27, 36), figure_mask(), noise=1.0, seed=2)
        r = self.check(night)
        self.assertTrue(any("edge lost" in f for f in r["fails"]), r["fails"])

    def test_antialiasing_and_noise_pass(self):
        r = self.check(picture(30, (110, 100, 120), figure_mask(sigma=0.8), noise=4.0, seed=3))
        self.assertEqual(r["fails"], [])

    def test_same_pixels_same_verdict(self):
        night = picture(30, (110, 100, 120), figure_mask(dx=1), noise=2.0, seed=2)
        a, b = self.check(night), self.check(night)
        self.assertEqual((a["shift"], a["min_edge"], a["fails"]), (b["shift"], b["min_edge"], b["fails"]))
        self.assertTrue((a["mask"] == b["mask"]).all())

    def test_a_day_that_already_blends_is_not_blamed_on_the_night(self):
        flat_day = picture(200, (200, 215, 245), figure_mask(), noise=1.0, seed=1)
        night = picture(30, (30, 27, 36), figure_mask(), noise=1.0, seed=2)
        r = op.check_figure(flat_day, night, FIG)
        self.assertFalse(any("edge lost" in f for f in r["fails"]), r["fails"])

    def test_a_short_run_of_shifted_edge_fails(self):
        m = figure_mask()
        m[140:180, 220:] = figure_mask(dx=-3.5)[140:180, 220:]  # the right edge, 40 px of it, 3.5 px inward
        r = self.check(picture(30, (110, 100, 120), m, noise=2.0, seed=2))
        self.assertTrue(any("edge moved" in f for f in r["fails"]), r["fails"])

    def test_a_short_run_of_shift_within_the_limit_passes(self):
        m = figure_mask()
        m[140:180, 220:] = figure_mask(dx=-1.5)[140:180, 220:]
        r = self.check(picture(30, (110, 100, 120), m, noise=2.0, seed=2))
        self.assertEqual(r["fails"], [])

    def test_a_rim_highlight_on_an_unmoved_edge_passes(self):
        m = figure_mask()
        inner = cv2.erode(m[..., 0], np.ones((5, 5), np.uint8))[..., None]
        rim = np.clip(m - inner, 0, 1)  # a 2 px bright rim just inside the edge, only at night
        night = picture(30, (110, 100, 120), m, noise=2.0, seed=2).astype(np.float32)
        night = np.clip(night + rim * np.array([90, 90, 90], np.float32), 0, 255).astype(np.uint8)
        r = self.check(night)
        self.assertEqual(r["fails"], [], r["fails"])


class GlassFigures(unittest.TestCase):
    """A frosted-glass figure's day edge is soft and close to the sky, too weak for the gradient locator."""

    GLASS = {**FIG, "glass": True}

    def pair(self, night_dx):
        day_img = picture(200, (175, 190, 225), figure_mask(sigma=2.5), noise=1.0, seed=1)
        night_img = picture(30, (60, 58, 80), figure_mask(dx=night_dx, sigma=2.5), noise=1.0, seed=2)
        return day_img, night_img

    def test_a_glass_figure_whose_night_is_not_moved_passes(self):
        r = op.check_figure(*self.pair(0), self.GLASS)
        self.assertEqual(r["fails"], [], r["fails"])

    def test_a_glass_figure_whose_night_shrinks_fails(self):
        day_img = picture(200, (175, 190, 225), figure_mask(sigma=2.5), noise=1.0, seed=1)
        shrunk = cv2.erode(figure_mask()[..., 0], np.ones((7, 7), np.uint8))  # 3 px inward all round
        night_img = picture(30, (60, 58, 80), cv2.GaussianBlur(shrunk, (0, 0), 2.5)[..., None], noise=1.0, seed=2)
        r = op.check_figure(day_img, night_img, self.GLASS)
        self.assertTrue(any("moved" in f for f in r["fails"]), r["fails"])


class RegionRule(unittest.TestCase):
    """A part of the figure that sinks into the sky fails unless a rim holds its edge."""

    def night(self, crown_offset=4, rim=0):
        m = figure_mask()
        img = picture(30, (110, 100, 120), m, noise=1.0, seed=2).astype(np.float32)
        crown = np.zeros((H, W, 1), np.float32)
        crown[:140] = m[:140]  # the head: the figure's top 60 px of height, painted at the sky's value
        img = img * (1 - crown) + (sky(30) + crown_offset) * crown
        if rim:
            inner = cv2.erode(m[..., 0], np.ones((5, 5), np.uint8))[..., None]
            img = img + np.clip(m - inner, 0, 1) * crown * rim
        return np.clip(np.round(img), 0, 255).astype(np.uint8)

    def regions(self, night, day_img=None):
        r = op.check_figure(day() if day_img is None else day_img, night, FIG)
        return [f for f in r["fails"] if f.startswith("region sinks into the sky")]

    def test_a_part_at_the_skys_value_with_no_rim_fails_and_names_the_region(self):
        found = self.regions(self.night())
        self.assertEqual(len(found), 1, found)
        self.assertRegex(found[0], r"region sinks into the sky at \(2\d\d,\d{2,3}\): \d+ px under 10 RGB from the sky with no rim .*day distance \d+")

    def test_the_same_part_held_by_a_rim_passes(self):
        for rim in (40, 90):
            self.assertEqual(self.regions(self.night(rim=rim)), [], rim)

    def test_a_part_a_little_apart_from_the_sky_passes(self):
        self.assertEqual(self.regions(self.night(crown_offset=22)), [])

    def test_a_day_that_already_blends_is_not_blamed(self):
        flat_day = picture(200, (200, 215, 245), figure_mask(), noise=1.0, seed=1)
        self.assertEqual(self.regions(self.night(), flat_day), [])

    def test_a_small_sunk_patch_passes(self):
        m = figure_mask()
        patch = np.zeros((H, W, 1), np.float32)
        patch[150:166, 190:230] = m[150:166, 190:230]
        img = picture(30, (110, 100, 120), m, noise=1.0, seed=2).astype(np.float32)
        img = np.clip(img * (1 - patch) + (sky(30) + 4) * patch, 0, 255).astype(np.uint8)
        self.assertEqual(self.regions(img), [])


def disc(radius, blur=0.0):
    m = np.zeros((H, W), np.float32)
    cv2.circle(m, (240, 180), radius, 1.0, -1, cv2.LINE_AA)
    return (cv2.GaussianBlur(m, (0, 0), blur) if blur else m)[..., None]


BALL = {"name": "ball", "polygon": [[240 + 14 * np.cos(a), 180 + 14 * np.sin(a)] for a in np.linspace(0, 6.28, 16, endpoint=False)], "band": 4}


class SmallParts(unittest.TestCase):
    def check(self, night_radius, blur=0.0):
        day_img = picture(200, (60, 160, 255), disc(10), noise=2.0, seed=1)
        night_img = picture(30, (50, 130, 200), disc(night_radius, blur), noise=2.0, seed=2)
        return op.check_figure(day_img, night_img, BALL)

    def test_same_size_ball_passes(self):
        self.assertEqual(self.check(10, 0.8)["fails"], [])

    def test_ball_one_pixel_smaller_passes(self):
        self.assertEqual(self.check(9, 0.8)["fails"], [])

    def test_ball_four_pixels_smaller_in_diameter_fails(self):
        r = self.check(8, 0.8)
        self.assertTrue(any("small part changed size" in f for f in r["fails"]), r["fails"])


if __name__ == "__main__":
    unittest.main()
