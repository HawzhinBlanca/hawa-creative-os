import { PNG } from 'pngjs';

/**
 * ADR-258: how many lines a text frame's ink makes in a picture, for comparing the Studio render a design
 * was approved from with the PNG Canva exports. Canva sets text with its own metrics, so it can wrap a
 * title differently: a live Sorani design (task 68b98306, 2026-09-20) had a 3-line title in Studio and a
 * 2-line one in Canva, which moved the whole block. Letters were joined correctly in both.
 *
 * Rows of the frame's box (widened by half a line above and below, where Canva may have moved it) are
 * read for pixels near the frame's ink colour; runs of inked rows separated by less than a third of the
 * type size are one line (Arabic-script dots and marks sit that close to their letters), and a run
 * shorter than a third of the type size is not a line (a stray mark, a rule). Deterministic; no model.
 */
export interface InkLines {
  lines: number;
  /** Each line's top and bottom row in the picture. */
  bands: Array<[number, number]>;
}

export function countInkLines(picture: Buffer | Pick<PNG, 'width' | 'height' | 'data'>, box: { x: number; y: number; width: number; height: number },
  ink: string, fontPx: number): InkLines {
  // A decoded picture is recognised by its shape: two copies of pngjs (a package's dist and its source)
  // do not share a class, so `instanceof` would decode it again.
  const png = Buffer.isBuffer(picture) ? PNG.sync.read(picture) : picture;
  const hex = /^#?([0-9a-f]{6})$/i.exec(ink)?.[1];
  if (!hex) throw new Error(`Not an RGB colour: ${ink}`);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const size = Math.max(4, fontPx);
  const x0 = Math.max(0, Math.floor(box.x)), x1 = Math.min(png.width, Math.ceil(box.x + box.width));
  const y0 = Math.max(0, Math.floor(box.y - size / 2)), y1 = Math.min(png.height, Math.ceil(box.y + box.height + size / 2));
  if (x1 <= x0 || y1 <= y0) return { lines: 0, bands: [] };
  const need = Math.max(2, (x1 - x0) * 0.004);
  const inked: boolean[] = [];
  for (let y = y0; y < y1; y++) {
    let n = 0;
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      if (png.data[i + 3] > 128 && Math.abs(png.data[i] - r) + Math.abs(png.data[i + 1] - g) + Math.abs(png.data[i + 2] - b) < 90) n++;
    }
    inked.push(n >= need);
  }
  const runs: Array<[number, number]> = [];
  let start = -1;
  inked.forEach((on, i) => {
    if (on && start < 0) start = i;
    if (start >= 0 && (!on || i === inked.length - 1)) { runs.push([start + y0, (on ? i : i - 1) + y0]); start = -1; }
  });
  const joined: Array<[number, number]> = [];
  for (const run of runs) {
    const last = joined.at(-1);
    if (last && run[0] - last[1] <= Math.max(3, size * 0.3)) last[1] = run[1];
    else joined.push([run[0], run[1]]);
  }
  const bands = joined.filter(([top, bottom]) => bottom - top + 1 >= size * 0.35);
  return { lines: bands.length, bands };
}

/** A PNG decoded once, for counting several frames' lines in it. */
export function decodePicture(bytes: Buffer): PNG {
  return PNG.sync.read(bytes);
}
