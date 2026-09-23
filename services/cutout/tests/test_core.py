"""Cut-out engine checks (ADR-032). The model-free tests replace the matting network with a known
alpha, so they run anywhere; the model test runs when the pinned model file is present."""
from __future__ import annotations

import io
import os
import unittest

import cv2
import numpy as np
from PIL import Image

from hawa_cutout.core import Cutter, estimate_foreground, soft_shadow

MODELS = os.environ.get('HAWA_MODELS_DIR', os.path.expanduser('~/.hawa/models'))
PORTRAIT = os.path.join(MODELS, 'BiRefNet-portrait-epoch_150.onnx')
FACES = os.path.join(MODELS, 'face_detection_yunet_2023mar.onnx')


def jpeg(rgb: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, 'PNG')
    return buf.getvalue()


def synthetic(h: int = 800, w: int = 600) -> tuple[np.ndarray, np.ndarray]:
    """A light grey backdrop with a dark 'person' (an ellipse head on a trapezoid body) whose left
    edge is a soft ramp, as hair against a bright background is."""
    img = np.full((h, w, 3), 230, np.uint8)
    alpha = np.zeros((h, w), np.float32)
    cv2.ellipse(alpha, (w // 2, int(h * 0.3)), (int(w * 0.14), int(h * 0.12)), 0, 0, 360, 1.0, -1)
    body = np.array([[int(w * 0.2), h], [int(w * 0.35), int(h * 0.45)], [int(w * 0.65), int(h * 0.45)], [int(w * 0.8), h]], np.int32)
    cv2.fillPoly(alpha, [body], 1.0)
    alpha = cv2.GaussianBlur(alpha, (0, 0), 3)
    person = np.array([60, 40, 30], np.float32)
    mixed = alpha[..., None] * person + (1 - alpha[..., None]) * img.astype(np.float32)
    return mixed.astype(np.uint8), alpha


class FakeCutter(Cutter):
    """The engine with the network replaced by a known matte and a known face."""

    def __init__(self, alpha: np.ndarray, faces: list[dict] | None = None):  # noqa: D401 - no model
        self._alpha = alpha
        self._faces = faces
        self.model_path, self.model_sha256 = 'fake.onnx', '0' * 64

    def matte(self, image: np.ndarray) -> np.ndarray:
        return cv2.resize(self._alpha, (image.shape[1], image.shape[0]))

    def faces(self, image: np.ndarray) -> list[dict]:
        h, w = image.shape[:2]
        return [dict(f) for f in self._faces] if self._faces is not None else [{'x': int(w * 0.4), 'y': int(h * 0.22), 'width': int(w * 0.2), 'height': int(h * 0.16), 'score': 0.95}]


class CutoutEngineTest(unittest.TestCase):
    def test_every_whole_pixel_is_the_photos_own(self):
        img, alpha = synthetic()
        r = FakeCutter(alpha).cut(jpeg(img))
        out = np.asarray(Image.open(io.BytesIO(r.png)).convert('RGBA'))
        x, y, w, h = r.bbox
        src = img[y:y + h, x:x + w]
        whole = out[..., 3] == 255
        self.assertGreater(int(whole.sum()), 1000)
        self.assertTrue(np.array_equal(out[..., :3][whole], src[whole]), 'an opaque pixel differs from the photo')

    def test_soft_edges_lose_the_old_background(self):
        img, alpha = synthetic()
        fg = estimate_foreground(img, alpha)
        band = (alpha > 0.2) & (alpha < 0.8)
        # The person is dark (about 0.2); the backdrop is light (0.9). Mixed edge pixels come back
        # much closer to the person than the raw pixels are.
        raw = img.astype(np.float32)[band].mean() / 255
        est = fg[band].mean()
        self.assertLess(est, raw - 0.15)

    def test_a_clean_person_passes_and_is_trimmed_with_a_shadow(self):
        img, alpha = synthetic()
        r = FakeCutter(alpha).cut(jpeg(img))
        self.assertTrue(r.passed, {k: (g.ok, g.value) for k, g in r.gates.items()})
        self.assertLess(r.width, 600)
        self.assertEqual(r.stats['people'], 1)
        self.assertGreater(r.shadow_width, r.width)
        self.assertLess(r.shadow_x, 0)

    def test_no_face_in_the_cutout_fails(self):
        img, alpha = synthetic()
        r = FakeCutter(alpha, faces=[]).cut(jpeg(img))
        self.assertFalse(r.passed)
        self.assertFalse(r.gates['person_found'].ok)

    def test_a_head_cut_by_the_top_edge_fails(self):
        img, alpha = synthetic()
        alpha[:40] = 1.0  # the person runs off the top of the photo
        r = FakeCutter(alpha).cut(jpeg(img))
        self.assertFalse(r.gates['head_not_cut'].ok)
        self.assertFalse(r.passed)

    def test_specks_away_from_the_person_are_dropped(self):
        img, alpha = synthetic()
        alpha[20:26, 20:26] = 1.0  # a speck far from the person
        r = FakeCutter(alpha).cut(jpeg(img))
        self.assertGreater(r.bbox[0], 30)

    def test_expected_people_is_checked(self):
        img, alpha = synthetic()
        r = FakeCutter(alpha).cut(jpeg(img), expected_people=2)
        self.assertFalse(r.gates['people_expected'].ok)
        self.assertFalse(r.passed)

    def test_focus_sits_just_above_the_faces(self):
        img, alpha = synthetic()
        f = FakeCutter(alpha).focus(jpeg(img))
        # The fake face is at x 0.4-0.6, y 0.22-0.38 of the photo.
        self.assertAlmostEqual(f['focus']['x'], 0.5, places=2)
        self.assertLess(f['focus']['y'], 0.30)
        self.assertGreater(f['focus']['y'], 0.2)
        no_face = FakeCutter(alpha, faces=[]).focus(jpeg(img))
        self.assertEqual(no_face['focus'], {'x': 0.5, 'y': 0.36})
        self.assertEqual(f['orientation'], 1)

    def test_focus_reports_a_rotated_photo(self):
        alpha = np.zeros((200, 150), np.float32)
        img = Image.fromarray(np.full((200, 150, 3), 128, np.uint8))
        exif = Image.Exif()
        exif[0x0112] = 6
        buf = io.BytesIO()
        img.save(buf, 'JPEG', exif=exif.tobytes())
        f = FakeCutter(alpha, faces=[]).focus(buf.getvalue())
        self.assertEqual(f['orientation'], 6)
        self.assertEqual((f['width'], f['height']), (200, 150))

    def test_shadow_is_soft_and_offset(self):
        a = np.zeros((200, 100), np.uint8)
        a[20:200, 20:80] = 255
        shadow, sx, sy = soft_shadow(a)
        self.assertEqual(shadow.dtype, np.uint8)
        self.assertLessEqual(int(shadow[..., 3].max()), 90)
        self.assertTrue(sx < 0 and sy < 0)

    @unittest.skipUnless(os.path.exists(PORTRAIT) and os.path.exists(FACES), 'pinned model files not present')
    def test_the_model_cuts_out_a_person_drawn_on_a_backdrop(self):
        img, _ = synthetic()
        r = Cutter(PORTRAIT, FACES).cut(jpeg(img))
        out = np.asarray(Image.open(io.BytesIO(r.png)).convert('RGBA'))
        self.assertGreater(out.shape[0], 100)
        self.assertIn('matte', r.timings)


if __name__ == '__main__':
    unittest.main()
