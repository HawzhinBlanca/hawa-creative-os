import { PNG } from 'pngjs';

/**
 * Deterministic stand-ins for client photos (ADR-170 tests): no client photo is committed. Each is
 * a PNG with a calm, bright upper part (a wall or sky) and a busy lower part (a scene), drawn from a
 * seeded generator so every run has the same bytes.
 */
export function syntheticPhoto(width: number, height: number, seed: number, tone: [number, number, number] = [180, 150, 110]): Buffer {
  const png = new PNG({ width, height });
  let s = seed * 9301 + 49297;
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const calm = y < height * 0.4;
      const n = calm ? 0 : Math.floor(rnd() * 120) - 60;
      const stripe = calm ? 0 : ((Math.floor(x / 9) + Math.floor(y / 13)) % 2) * 40;
      png.data[i] = Math.max(0, Math.min(255, (calm ? 236 : tone[0]) + n + stripe));
      png.data[i + 1] = Math.max(0, Math.min(255, (calm ? 238 : tone[1]) + n));
      png.data[i + 2] = Math.max(0, Math.min(255, (calm ? 242 : tone[2]) + n - stripe));
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** A flat colour PNG. */
export function flatPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = rgb[0];
    png.data[i * 4 + 1] = rgb[1];
    png.data[i * 4 + 2] = rgb[2];
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** The RGB of one pixel of a PNG. */
export function pixelAt(pngBytes: Buffer, x: number, y: number): [number, number, number] {
  const png = PNG.sync.read(pngBytes);
  const i = (Math.round(y) * png.width + Math.round(x)) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
}
