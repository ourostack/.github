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
        day.resize((W * 4, H * 4), Image.LANCZOS).save(self.reuse / "x.png")
        self.write()

    def tearDown(self):
        shutil.rmtree(self.root)

    def write(self):
        (self.root / "brand/provenance.json").write_text(json.dumps(self.prov))
        (self.root / "brand/tools/crops.json").write_text(json.dumps(self.crops))

    def run_upscale(self, *scenes):
        if "x-dark" in scenes and "x" not in scenes and not (self.root / "brand/upscaled/x.webp").exists():
            subprocess.run([sys.executable, str(self.root / "brand/tools/upscale.py"), "--reuse", str(self.reuse), "x"], capture_output=True)
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
        self.assertNotIn("mode", entry["lightsFrom"])
        night = np.asarray(scene_images()[2].resize((W * 4, H * 4), Image.LANCZOS), float)
        master = np.asarray(Image.open(self.root / "brand/upscaled/x-dark.webp").convert("RGB"), float)
        inside = master[100:140, 540:580] - night[100:140, 540:580]
        self.assertLess(np.abs(inside).mean(), 2.0)

    def add_lights(self, mode=None):
        mask = np.zeros((H, W), np.uint8)
        mask[10:62, 40:150] = 255  # a lit figure, larger than a lamp
        data = webp(Image.fromarray(mask))
        (self.root / "brand/flat/x-lights.webp").write_bytes(data)
        self.prov.append({"file": "flat/x-lights.webp", "sha256": sha(data)})
        self.crops["x"]["nightLights"] = "flat/x-lights.webp"
        if mode:
            self.crops["x"]["nightLightsMode"] = mode
        self.write()

    def edge_scene(self):
        """Day and flat day: a hard vertical edge at x = 96, bright left (200), darker right (100). Night: the same 1x
        edge, the left dimmed to 40 and the right to 90 (very different gains on the two sides)."""
        d = np.zeros((H, W, 3), np.uint8); n = np.zeros((H, W, 3), np.uint8)
        d[:, :96], d[:, 96:], n[:, :96], n[:, 96:] = 200, 100, 40, 90
        files = {"headers/x.webp": webp(Image.fromarray(d)), "headers/x-dark.webp": webp(Image.fromarray(n)),
                 "flat/x.webp": webp(Image.fromarray(d))}
        for rel, data in files.items():
            (self.root / "brand" / rel).write_bytes(data)
        self.prov = [e for e in self.prov if e["file"] not in files] + [{"file": r, "sha256": sha(b)} for r, b in files.items()]
        for name in ("x.png", "x-dark-flat.png"):
            Image.fromarray(d).resize((W * 4, H * 4), Image.NEAREST).save(self.reuse / name)

    def test_ratio_lights_keep_the_day_masters_sharp_edge(self):
        self.edge_scene()
        self.add_lights("ratio")
        r = self.run_upscale("x", "x-dark")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        entry = next(e for e in json.loads((self.root / "brand/provenance.json").read_text()) if e["file"] == "upscaled/x-dark.webp")
        self.assertIn("nightLightsMode ratio", entry["operation"])
        self.assertEqual(entry["lightsFrom"]["mode"], "ratio")
        row = np.asarray(Image.open(self.root / "brand/upscaled/x-dark.webp").convert("L"), float)[144]
        # the day master's edge at x = 384 stays a hard step (the night header's Lanczos 4x spreads it over 4 px and
        # rings)...
        self.assertGreater(np.abs(np.diff(row[370:400])).max(), 0.4 * (90 - 40))
        # ...and neither side's gain spills onto the other (no halo band beside the edge, as a Gaussian-smoothed gain has)
        self.assertLess(np.abs(row[384 - 40:384 - 8] - 40).max(), 4)
        self.assertLess(np.abs(row[384 + 8:384 + 40] - 90).max(), 4)

    def test_default_lights_mode_is_unchanged(self):
        self.add_lights()
        r = self.run_upscale("x", "x-dark")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        default = (self.root / "brand/upscaled/x-dark.webp").read_bytes()
        self.crops["x"]["nightLightsMode"] = "header"
        (self.root / "brand/tools/crops.json").write_text(json.dumps(self.crops))
        r = self.run_upscale("x-dark")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual((self.root / "brand/upscaled/x-dark.webp").read_bytes(), default)
        # and inside the mask it is the night header's Lanczos 4x, as before
        night = np.asarray(scene_images()[2].resize((W * 4, H * 4), Image.LANCZOS), float)
        master = np.asarray(Image.open(self.root / "brand/upscaled/x-dark.webp").convert("RGB"), float)
        self.assertLess(np.abs(master[80:200, 200:560] - night[80:200, 200:560]).mean(), 2.0)

    def test_no_dark_ring_round_a_moon(self):
        # the flat day holds a moon with a dark rim round it (ourostack's did, #294) and the night-light mask covers only
        # the disc: where the master switches from the night header to the transfer of the flat day at the mask's edge,
        # the rim showed as a dark ring; light_falloff gives the transfer the night header's broad light there
        yy, xx = np.mgrid[0:H, 0:W]
        d = np.hypot(xx - 120, yy - 30)
        sky = np.full((H, W, 3), (150, 175, 215), float)
        flat = np.where((d < 4)[..., None], 255, sky - 90 * np.exp(-((d - 6) / 2) ** 2)[..., None]).clip(0, 255).astype(np.uint8)
        night = np.stack([10 + 0 * d, 25 + 0 * d, 60 + 0 * d], -1) + 25 * np.exp(-np.clip(d - 4, 0, None) / 2)[..., None]
        night = np.where((d < 4)[..., None], 235, night).clip(0, 255).astype(np.uint8)
        mask = ((d < 4.5) * 255).astype(np.uint8)
        files = {"headers/x.webp": webp(Image.fromarray(sky.astype(np.uint8))), "headers/x-dark.webp": webp(Image.fromarray(night)),
                 "flat/x.webp": webp(Image.fromarray(flat)), "flat/x-lights.webp": webp(Image.fromarray(mask))}
        for rel, data in files.items():
            (self.root / "brand" / rel).write_bytes(data)
        self.prov = [e for e in self.prov if e["file"] not in files] + [{"file": r, "sha256": sha(b)} for r, b in files.items()]
        self.crops["x"]["nightLights"] = "flat/x-lights.webp"
        self.write()
        Image.fromarray(sky.astype(np.uint8)).resize((W * 4, H * 4), Image.LANCZOS).save(self.reuse / "x.png")
        Image.fromarray(flat).resize((W * 4, H * 4), Image.LANCZOS).save(self.reuse / "x-dark-flat.png")
        r = self.run_upscale("x", "x-dark")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        master = np.asarray(Image.open(self.root / "brand/upscaled/x-dark.webp").convert("L"), float)
        head = np.asarray(Image.open(self.root / "brand/headers/x-dark.webp").convert("L").resize((W * 4, H * 4), Image.LANCZOS), float)
        gy, gx = np.mgrid[0:H * 4, 0:W * 4]
        d4 = np.hypot(gx - 480, gy - 120)
        for q in range(20, 60, 4):
            ring = (d4 >= q) & (d4 < q + 4)
            self.assertGreater(master[ring].mean(), head[ring].mean() - 3, f"dark ring {q} px out")

    def test_unknown_lights_mode_is_refused(self):
        self.add_lights("blend")
        r = self.run_upscale("x-dark")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("nightLightsMode", r.stdout + r.stderr)

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
