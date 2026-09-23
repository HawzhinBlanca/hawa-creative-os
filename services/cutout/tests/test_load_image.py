"""How load_image() reads photos that are not plain 8-bit RGB, and one too large to read at all
(bug hunt 2026-09-24). Model-free: runs anywhere the service's dependencies are installed."""
from __future__ import annotations

import io
import struct
import unittest
import zlib

import numpy as np
from PIL import Image

from hawa_cutout.core import UnreadablePhoto, load_image
from hawa_cutout.server import bad_picture


def encode(img: Image.Image, fmt: str, **kw) -> bytes:
    buf = io.BytesIO()
    img.save(buf, fmt, **kw)
    return buf.getvalue()


def png_header_only(width: int, height: int) -> bytes:
    """A PNG that declares a size and holds almost nothing: Pillow judges the size from the header."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)
    return (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 0, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(b'\x00' * 16))
        + chunk(b'IEND', b'')
    )


class LoadImageTest(unittest.TestCase):
    def test_a_16_bit_grey_photo_keeps_its_tones(self):
        # A gradient over the whole 0..65535 range, as a scanner or a RAW export writes it. It came out
        # almost white (mean 254.5): convert('RGB') clipped every value above 255.
        g16 = np.linspace(0, 65535, 800 * 600).reshape(600, 800).astype(np.uint16)
        img16 = Image.fromarray(g16)
        self.assertTrue(img16.mode.startswith('I'))
        wide = load_image(encode(img16, 'PNG'))
        narrow = load_image(encode(Image.fromarray((g16 >> 8).astype(np.uint8)), 'PNG'))
        self.assertEqual(wide.shape, (600, 800, 3))
        self.assertEqual(wide.dtype, np.uint8)
        self.assertLessEqual(int(np.abs(wide.astype(int) - narrow.astype(int)).max()), 1)
        self.assertAlmostEqual(float(wide.mean()), 127.5, delta=1.0)

    def test_cmyk_and_palette_photos_still_load(self):
        cmyk = load_image(encode(Image.new('CMYK', (800, 600), (0, 128, 255, 0)), 'JPEG'))
        self.assertEqual(cmyk.shape, (600, 800, 3))
        p = Image.new('RGBA', (800, 600), (0, 0, 0, 0))
        p.paste((220, 30, 30, 255), (300, 100, 500, 600))
        palette = load_image(encode(p.convert('P'), 'PNG', transparency=0))
        self.assertEqual(palette.shape, (600, 800, 3))

    def test_a_photo_too_large_to_decode_is_the_photos_fault(self):
        # 20000 x 20000 is 400 MP, over twice Pillow's bomb limit: it was answered 500, as a service failure.
        with self.assertRaises(UnreadablePhoto) as caught:
            load_image(png_header_only(20000, 20000))
        self.assertIn('too large', str(caught.exception))
        self.assertIn('400000000 pixels', str(caught.exception))
        self.assertTrue(bad_picture(caught.exception))

    def test_other_failures_stay_the_services(self):
        self.assertFalse(bad_picture(RuntimeError('onnxruntime: out of memory')))
        self.assertTrue(bad_picture(OSError('cannot identify image file <_io.BytesIO>')))


if __name__ == '__main__':
    unittest.main()
