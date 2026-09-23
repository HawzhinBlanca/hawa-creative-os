"""Person cut-outs for Hawa (ADR-032): the people in a client photo, with the background removed.

Pixel-faithful by construction. A matting model only decides how much of each pixel is the person
(alpha); every pixel it keeps whole is the photograph's own. Only the soft edge pixels, where the old
background shows through hair, get a foreground colour estimate so that background does not show on
the new one. Nothing is generated.

Each cut-out is checked before it is used (`gates`): a person is found and whole, the matte is not
hazy or in pieces, the head is not cut off by the photo's top edge. A cut-out that fails is not
placed; the caller falls back to the framed photo and says so.
"""
from __future__ import annotations

import hashlib
import io
import time
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
# A photo larger than this is worked on at this size: a poster places a person at most about the
# canvas height (1350-2400 px), and the matte is computed at 1024 anyway.
MAX_SIDE = 2400


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


@dataclass
class Gate:
    ok: bool
    value: Any
    limit: str
    # A failed hard gate stops the cut-out from being used; a soft one is only reported.
    hard: bool = True


@dataclass
class CutResult:
    png: bytes
    width: int
    height: int
    # Where the cut-out sits in the source photo (x, y, w, h), in source pixels.
    bbox: tuple[int, int, int, int]
    shadow_png: bytes
    shadow_width: int
    shadow_height: int
    # The shadow's top-left, in the cut-out's own pixel coordinates.
    shadow_x: int
    shadow_y: int
    faces: list[dict[str, Any]]
    gates: dict[str, Gate]
    passed: bool
    stats: dict[str, Any] = field(default_factory=dict)
    timings: dict[str, float] = field(default_factory=dict)


class UnreadablePhoto(ValueError):
    """A photo the service will not read; the server answers 400 with this message."""


def load_image(data: bytes) -> np.ndarray:
    """RGB uint8, upright (EXIF orientation applied), at most MAX_SIDE on its long side."""
    try:
        img = Image.open(io.BytesIO(data))
    except Image.DecompressionBombError as err:
        # Pillow refuses a picture of more than twice MAX_IMAGE_PIXELS (about 179 MP) before decoding
        # it, since a small file can unpack to gigabytes. That was answered 500, as if the service had
        # failed (2026-09-24); it is the photo that is refused.
        # Pillow's own words say how large and what the limit is ("Image size (400000000 pixels)
        # exceeds limit of 178956970 pixels"); the rest of its sentence is for developers.
        raise UnreadablePhoto(f'the photo is too large to cut out: {str(err).split(",")[0]}') from err
    img = ImageOps.exif_transpose(img)
    if img.mode.startswith('I;16') or img.mode == 'I':
        # 16-bit greyscale (a scanner, a RAW export). convert('RGB') clips every value above 255, so
        # such a photo came out almost white (2026-09-24): it is scaled to 8 bits first.
        img = Image.fromarray((np.clip(np.asarray(img, dtype=np.int64), 0, 65535) >> 8).astype(np.uint8))
    img = img.convert('RGB')
    if max(img.size) > MAX_SIDE:
        scale = MAX_SIDE / max(img.size)
        img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    return np.asarray(img)


def estimate_foreground(image: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Foreground colour at soft edges, by two-pass blur fusion (Forte & Pitié, "Approximate Fast
    Foreground Colour Estimation", ICIP 2021): the colours either side of the edge are estimated by
    alpha-weighted blurs and the old background's share is taken out of each edge pixel. Without it
    a bright original background leaves a light halo round the hair on a dark poster (measured on
    the 2026-09-23 request)."""
    img = image.astype(np.float32) / 255.0
    a = alpha[..., None]

    def once(F: np.ndarray, B: np.ndarray, r: int) -> tuple[np.ndarray, np.ndarray]:
        blurred_a = cv2.blur(alpha, (r, r))[..., None]
        blurred_F = cv2.blur(F * a, (r, r)) / (blurred_a + 1e-5)
        blurred_B = cv2.blur(B * (1 - a), (r, r)) / ((1 - blurred_a) + 1e-5)
        out = blurred_F + a * (img - a * blurred_F - (1 - a) * blurred_B)
        return np.clip(out, 0, 1), blurred_B

    F, B = once(img, img, 91)
    F, _ = once(F, B, 7)
    return F


class Cutter:
    """One loaded matting model and face detector. Not thread-safe: one cut at a time (the server
    serialises), because a single inference already takes about 8 GB at 1024 x 1024."""

    def __init__(self, model_path: str, face_model_path: str, model_sha256: str | None = None, threads: int = 4):
        if model_sha256:
            actual = sha256_file(model_path)
            if actual != model_sha256:
                raise RuntimeError(f'matting model {model_path} has sha256 {actual}, expected {model_sha256}')
        self.model_path = model_path
        self.model_sha256 = model_sha256 or sha256_file(model_path)
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        # Measured 2026-09-23: the default arena and memory pattern took peak memory from 8.4 GB to
        # over 12 GB for the same inference, with no gain in speed.
        so.enable_cpu_mem_arena = False
        so.enable_mem_pattern = False
        self.session = ort.InferenceSession(model_path, so, providers=['CPUExecutionProvider'])
        self.input_name = self.session.get_inputs()[0].name
        shape = self.session.get_inputs()[0].shape
        self.size = int(shape[2]) if isinstance(shape[2], int) else 1024
        self.face_model_path = face_model_path

    # --- stages -------------------------------------------------------------------------------

    def matte(self, image: np.ndarray) -> np.ndarray:
        h, w = image.shape[:2]
        x = cv2.resize(image, (self.size, self.size), interpolation=cv2.INTER_LINEAR).astype(np.float32) / 255.0
        x = ((x - MEAN) / STD).transpose(2, 0, 1)[None]
        out = self.session.run(None, {self.input_name: x})[0][0, 0]
        pred = 1.0 / (1.0 + np.exp(-out))
        pred = (pred - pred.min()) / max(float(pred.max() - pred.min()), 1e-6)
        return cv2.resize(pred.astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR)

    def faces(self, image: np.ndarray) -> list[dict[str, Any]]:
        h, w = image.shape[:2]
        scale = min(1.0, 1280 / max(h, w))
        small = cv2.resize(image, (round(w * scale), round(h * scale))) if scale < 1 else image
        det = cv2.FaceDetectorYN.create(self.face_model_path, '', (small.shape[1], small.shape[0]), 0.8, 0.3, 5000)
        _, found = det.detect(cv2.cvtColor(small, cv2.COLOR_RGB2BGR))
        faces = []
        for f in (found if found is not None else []):
            x, y, fw, fh = (float(v) / scale for v in f[:4])
            # Very small faces are people in the background, a crowd or a poster on the wall.
            if fh < 0.035 * h:
                continue
            faces.append({'x': round(x), 'y': round(y), 'width': round(fw), 'height': round(fh), 'score': round(float(f[14]), 3)})
        return faces

    def focus(self, data: bytes) -> dict[str, Any]:
        """Where the people are in a photo, for cropping it into a frame without cutting heads: the
        faces, and a focus point (0..1 of the photo) a little above the centre of all of them, so a
        crop keeps headroom. No faces: the upper third of a portrait, the centre of anything else.

        The point is in the upright photo. `orientation` is the photo's EXIF orientation (1 when it
        has none): a caller that crops the stored pixels must not use the point when it is not 1."""
        try:
            orientation = int(Image.open(io.BytesIO(data)).getexif().get(0x0112, 1) or 1)
        except Exception:
            orientation = 1
        image = load_image(data)
        h, w = image.shape[:2]
        faces = self.faces(image)
        if faces:
            x0 = min(f['x'] for f in faces)
            x1 = max(f['x'] + f['width'] for f in faces)
            y0 = min(f['y'] for f in faces)
            y1 = max(f['y'] + f['height'] for f in faces)
            fx, fy = (x0 + x1) / 2 / w, max(0.0, (y0 + y1) / 2 - 0.15 * (y1 - y0)) / h
        else:
            fx, fy = 0.5, (0.36 if h > w * 1.1 else 0.5)
        return {'width': w, 'height': h, 'orientation': orientation, 'faces': faces, 'focus': {'x': round(min(1.0, max(0.0, fx)), 4), 'y': round(min(1.0, max(0.0, fy)), 4)}}

    # --- the whole cut ------------------------------------------------------------------------

    def cut(self, data: bytes, expected_people: int | None = None) -> CutResult:
        t0 = time.time()
        image = load_image(data)
        h, w = image.shape[:2]
        t1 = time.time()
        alpha = self.matte(image)
        t2 = time.time()

        # Clean the matte: near-certain values snapped, specks away from the people dropped.
        alpha[alpha < 0.02] = 0.0
        alpha[alpha > 0.98] = 1.0
        solid = (alpha >= 0.5).astype(np.uint8)
        n, labels, cc_stats, _ = cv2.connectedComponentsWithStats(solid, connectivity=8)
        keep = np.zeros_like(solid)
        big_parts = 0
        for i in range(1, n):
            if cc_stats[i, cv2.CC_STAT_AREA] >= 0.002 * h * w:
                keep[labels == i] = 1
                if cc_stats[i, cv2.CC_STAT_AREA] >= 0.02 * max(int(solid.sum()), 1):
                    big_parts += 1
        near = cv2.dilate(keep, np.ones((15, 15), np.uint8)) if keep.any() else keep
        alpha = alpha * near.astype(np.float32)

        # Foreground colour only where the edge is soft; every whole pixel stays the photo's own.
        fg = estimate_foreground(image, alpha)
        soft = (alpha < 0.98)[..., None]
        rgb = np.where(soft, (fg * 255.0 + 0.5).astype(np.uint8), image)
        t3 = time.time()

        faces = self.faces(image)
        for f in faces:
            cx0, cy0 = f['x'] + 0.15 * f['width'], f['y'] + 0.15 * f['height']
            cx1, cy1 = f['x'] + 0.85 * f['width'], f['y'] + 0.85 * f['height']
            region = alpha[max(0, int(cy0)):max(0, int(cy1)), max(0, int(cx0)):max(0, int(cx1))]
            f['alpha'] = round(float(region.mean()), 3) if region.size else 0.0
        people = [f for f in faces if f['alpha'] >= 0.5]
        t4 = time.time()

        gates = self.gates(alpha, people, faces, big_parts, expected_people)
        passed = all(g.ok for g in gates.values() if g.hard)

        # Trimmed to the people, with a little room so the soft edge is not cut.
        ys, xs = np.nonzero(alpha > 0.02)
        if len(xs):
            pad = 2
            x0, x1 = max(0, int(xs.min()) - pad), min(w, int(xs.max()) + 1 + pad)
            y0, y1 = max(0, int(ys.min()) - pad), min(h, int(ys.max()) + 1 + pad)
        else:
            x0, y0, x1, y1 = 0, 0, w, h
        rgba = np.dstack([rgb, (alpha * 255.0 + 0.5).astype(np.uint8)])[y0:y1, x0:x1]
        png = encode_png(rgba)
        shadow, sx, sy = soft_shadow(rgba[..., 3])
        t5 = time.time()

        fg_frac = float((alpha >= 0.5).mean())
        return CutResult(
            png=png, width=x1 - x0, height=y1 - y0, bbox=(x0, y0, x1 - x0, y1 - y0),
            shadow_png=encode_png(shadow), shadow_width=shadow.shape[1], shadow_height=shadow.shape[0], shadow_x=sx, shadow_y=sy,
            faces=faces, gates=gates, passed=passed,
            stats={'source': [w, h], 'foreground': round(fg_frac, 4), 'people': len(people), 'parts': big_parts},
            timings={'decode': round(t1 - t0, 3), 'matte': round(t2 - t1, 3), 'refine': round(t3 - t2, 3), 'faces': round(t4 - t3, 3), 'encode': round(t5 - t4, 3)},
        )

    @staticmethod
    def gates(alpha: np.ndarray, people: list[dict[str, Any]], faces: list[dict[str, Any]], parts: int, expected: int | None) -> dict[str, Gate]:
        h, w = alpha.shape
        solid = alpha >= 0.5
        fg = float(solid.mean())
        soft = float(((alpha > 0.05) & (alpha < 0.95)).sum()) / max(float(solid.sum()), 1.0)
        top = float(solid[:3].any(axis=0).mean())
        side = max(float(solid[:, :3].any(axis=1).mean()), float(solid[:, -3:].any(axis=1).mean()))
        tallest = 0
        ys, _ = np.nonzero(solid)
        if len(ys):
            tallest = int(ys.max() - ys.min())
        g: dict[str, Gate] = {
            # A person is what is cut out: a face inside the cut-out, whole.
            'person_found': Gate(len(people) >= 1, len(people), '>= 1 face inside the cut-out'),
            'faces_whole': Gate(all(f['alpha'] >= 0.97 for f in people) if people else False, [f['alpha'] for f in people], 'every face >= 0.97 opaque'),
            'area': Gate(0.05 <= fg <= 0.85, round(fg, 3), '5%-85% of the photo'),
            # One piece per person, give or take a raised hand.
            'pieces': Gate(parts <= max(1, len(people)) + 1, parts, '<= people + 1 large pieces'),
            'haze': Gate(soft <= 0.12, round(soft, 3), 'soft edge <= 12% of the person'),
            # The photo's top edge cutting through a head leaves a flat head on the poster.
            'head_not_cut': Gate(top <= 0.02 and all(f['y'] > 0.01 * h for f in people), round(top, 3), 'top edge < 2% person, no face at the top edge'),
            'resolution': Gate(tallest >= 350, tallest, 'person >= 350 px tall'),
            # Soft: a person cut by the photo's side (an arm) is usable, but worth knowing.
            'sides': Gate(side <= 0.35, round(side, 3), 'person touches a side for <= 35% of it', hard=False),
        }
        if expected is not None:
            g['people_expected'] = Gate(len(people) == expected, len(people), f'== {expected}')
        # Faces left out of the cut-out: bystanders (fine) or a person the model missed (soft).
        g['faces_left_out'] = Gate(True, len(faces) - len(people), 'reported only', hard=False)
        return g


def encode_png(rgba: np.ndarray) -> bytes:
    ok, buf = cv2.imencode('.png', cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA), [cv2.IMWRITE_PNG_COMPRESSION, 6])
    if not ok:
        raise RuntimeError('PNG encoding failed')
    return buf.tobytes()


def soft_shadow(alpha: np.ndarray) -> tuple[np.ndarray, int, int]:
    """A soft ambient shadow the shape of the person, a little below and to the right: what makes a
    cut-out sit on its new background rather than float on it. Black at a low opacity, as its own
    image so the art director can move or delete it in Canva."""
    h, w = alpha.shape
    sigma = max(2.0, 0.025 * h)
    pad = int(3 * sigma)
    dx, dy = int(0.012 * h), int(0.012 * h)
    canvas = np.zeros((h + 2 * pad, w + 2 * pad), np.float32)
    canvas[pad:pad + h, pad:pad + w] = alpha.astype(np.float32) / 255.0
    blurred = cv2.GaussianBlur(canvas, (0, 0), sigma) * 0.35
    shadow = np.zeros((canvas.shape[0], canvas.shape[1], 4), np.uint8)
    shadow[..., 3] = (np.clip(blurred, 0, 1) * 255 + 0.5).astype(np.uint8)
    return shadow, -pad + dx, -pad + dy
