#!/usr/bin/env python3
"""Tests for upscale.py's nightFromFlatDay path: python3 brand/tools/upscale_test.py

Each test copies upscale.py and relight_transfer.py into a scratch brand/ tree with a tiny synthetic scene and runs
upscale.py with --reuse (no Real-ESRGAN), so it needs only Pillow, numpy, scipy and scikit-image."""
import hashlib
import io
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

TOOLS = Path(__file__).resolve().parent
W, H = 192, 72


def webp(im):
    buf = io.BytesIO()
    im.save(buf, "WEBP", lossless=True)
    return buf.getvalue()


def sha(b):
    return hashlib.sha256(b).hexdigest()


def scene_images():
    """A day with hard sun stripes, its flattened copy, and a dark night lit by one lamp."""
    y, x = np.mgrid[0:H, 0:W]
    base = np.stack([120 + 60 * np.sin(x / 9.0), 110 + 50 * np.cos(y / 7.0), 100 + 40 * np.sin((x + y) / 11.0)], -1)
    flat = base.clip(0, 255).astype(np.uint8)
    stripes = (((x - y) % 8) < 3)[..., None]  # hard window-grid sun stripes, finer than the transfer window
    day = np.where(stripes, (base * 1.7).clip(0, 255), base).astype(np.uint8)
    lamp = np.exp(-((x - 140) ** 2 + (y - 30) ** 2) / 800.0)[..., None]
    night = (base * (0.18 + 0.8 * lamp) * np.array([0.8, 0.85, 1.1])).clip(0, 255).astype(np.uint8)
    return Image.fromarray(day), Image.fromarray(flat), Image.fromarray(night)


class NightFromFlatDay(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        brand = self.root / "brand"
        (brand / "tools").mkdir(parents=True)
        for f in ("upscale.py", "relight_transfer.py"):
            shutil.copy(TOOLS / f, brand / "tools" / f)
        day, flat, night = scene_images()
        files = {"headers/x.webp": webp(day), "headers/x-dark.webp": webp(night), "flat/x.webp": webp(flat)}
        for rel, data in files.items():
            (brand / rel).parent.mkdir(parents=True, exist_ok=True)
            (brand / rel).write_bytes(data)
        self.flat_sha = sha(files["flat/x.webp"])
        self.prov = [{"file": rel, "sha256": sha(data)} for rel, data in files.items()]
        self.crops = {"x": {"wide": 96, "phone": 96, "nightFromFlatDay": "flat/x.webp"}}
        self.reuse = self.root / "reuse"
        self.reuse.mkdir()
        flat.resize((W * 4, H * 4), Image.LANCZOS).save(self.reuse / "x-dark-flat.png")
        self.write()

    def tearDown(self):
        shutil.rmtree(self.root)

    def write(self):
        (self.root / "brand/provenance.json").write_text(json.dumps(self.prov))
        (self.root / "brand/tools/crops.json").write_text(json.dumps(self.crops))

    def run_upscale(self, *scenes):
        return subprocess.run([sys.executable, str(self.root / "brand/tools/upscale.py"), "--reuse", str(self.reuse), *scenes],
                              capture_output=True, text=True)

    def test_night_master_is_the_flat_day_under_night_light(self):
        r = self.run_upscale("x-dark")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        entry = next(e for e in json.loads((self.root / "brand/provenance.json").read_text()) if e["file"] == "upscaled/x-dark.webp")
        self.assertEqual(entry["alsoFrom"], {"file": "flat/x.webp", "sha256": self.flat_sha})
        self.assertIn("nightFromFlatDay", entry["operation"])
        self.assertIn("flattened copy", entry["approval"])
        # the master is the flat day's 4x under the night's light, not the striped day's: the sun stripe stays gone
        sys.path.insert(0, str(TOOLS))
        from relight_transfer import transfer
        day, flat, night = scene_images()
        master = np.asarray(Image.open(self.root / "brand/upscaled/x-dark.webp").convert("RGB"), float)
        from_flat = np.asarray(transfer(flat.resize((W * 4, H * 4), Image.LANCZOS), night), float)
        from_day = np.asarray(transfer(day.resize((W * 4, H * 4), Image.LANCZOS), night), float)
        self.assertLess(np.abs(master - from_flat).mean(), 1.0)
        self.assertGreater(np.abs(master - from_day).mean(), 3 * np.abs(master - from_flat).mean())

    def test_night_lights_keep_the_night_headers_own_light_sources(self):
        mask = np.zeros((H, W), np.uint8)
        mask[20:40, 130:150] = 255  # the lamp
        data = webp(Image.fromarray(mask))
        (self.root / "brand/flat/x-lights.webp").write_bytes(data)
        self.prov.append({"file": "flat/x-lights.webp", "sha256": sha(data)})
        self.crops["x"]["nightLights"] = "flat/x-lights.webp"
        self.write()
        r = self.run_upscale("x-dark")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        entry = next(e for e in json.loads((self.root / "brand/provenance.json").read_text()) if e["file"] == "upscaled/x-dark.webp")
        self.assertEqual(entry["lightsFrom"]["file"], "flat/x-lights.webp")
        night = np.asarray(scene_images()[2].resize((W * 4, H * 4), Image.LANCZOS), float)
        master = np.asarray(Image.open(self.root / "brand/upscaled/x-dark.webp").convert("RGB"), float)
        inside = master[100:140, 540:580] - night[100:140, 540:580]
        self.assertLess(np.abs(inside).mean(), 2.0)

    def test_flat_day_without_matching_provenance_is_refused(self):
        self.prov = [e for e in self.prov if e["file"] != "flat/x.webp"] + [{"file": "flat/x.webp", "sha256": "0" * 64}]
        self.write()
        r = self.run_upscale("x-dark")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("provenance", r.stdout + r.stderr)

    def test_both_night_options_are_refused(self):
        self.crops["x"]["nightFromDay"] = True
        self.write()
        r = self.run_upscale("x")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("both nightFromDay and nightFromFlatDay", r.stdout + r.stderr)

    def test_flat_day_must_be_header_size(self):
        (self.root / "brand/flat/x.webp").write_bytes(webp(scene_images()[1].resize((W // 2, H // 2))))
        self.prov = [e if e["file"] != "flat/x.webp" else {"file": "flat/x.webp", "sha256": sha((self.root / "brand/flat/x.webp").read_bytes())} for e in self.prov]
        self.write()
        r = self.run_upscale("x-dark")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("not the header's", r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()
