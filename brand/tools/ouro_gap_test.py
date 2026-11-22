"""Tests for ouro_gap.py: an open C passes, a closed ring fails, and brand/ouro.png passes.

    python3 -m unittest brand/tools/ouro_gap_test.py
"""
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ouro_gap  # noqa: E402


def curl(gap_degrees, size=256):
    """A thick ring of body, with a wedge of `gap_degrees` cut out at the top right (0 = closed)."""
    y, x = np.mgrid[:size, :size] - size / 2
    r = np.hypot(x, y)
    body = (r > size * 0.22) & (r < size * 0.42)
    angle = (np.degrees(np.arctan2(-y, x)) + 360) % 360  # 0 = right, 90 = up
    if gap_degrees:
        body &= ~((angle > 60) & (angle < 60 + gap_degrees))
    # A head blob at one end and a tail tip at the other, as on the reference sheet.
    head = np.hypot(x + size * 0.05, y + size * 0.36) < size * 0.12
    return body | head


class OuroGapTest(unittest.TestCase):
    def check_mask(self, body):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "mask.png"
            Image.fromarray((body * 255).astype(np.uint8)).save(path)
            return ouro_gap.check(path, mask=path)

    def test_open_c_passes(self):
        ok, message = self.check_mask(curl(35))
        self.assertTrue(ok, message)

    def test_closed_ring_with_head_and_tail_fails(self):
        ok, message = self.check_mask(curl(0))
        self.assertFalse(ok)
        self.assertIn("CLOSED", message)

    def test_a_pin_hole_is_not_a_ring(self):
        body = curl(35)
        body[40:42, 128:130] = False  # a two-pixel speck of background inside the body
        ok, message = self.check_mask(body)
        self.assertTrue(ok, message)

    def test_the_reference_sheet_is_an_open_c(self):
        ok, message = ouro_gap.check(ouro_gap.BRAND / "ouro.png")
        self.assertTrue(ok, message)

    def test_a_scene_without_alpha_needs_a_mask(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "scene.png"
            Image.new("RGB", (8, 8)).save(path)
            with self.assertRaises(ValueError):
                ouro_gap.check(path)


if __name__ == "__main__":
    unittest.main()
