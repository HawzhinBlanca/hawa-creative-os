import { PNG } from 'pngjs';
import { imageFileExtension, sniffImageType } from './image-type.js';
import { svgToPngAsync } from './render-layout-v2.js';

/**
 * ADR-258: whether every picture of the editable source (the photos and the official logo) is still in
 * the design Canva exports. Canva re-encodes and downsamples pictures and turns a `p:pic` into an
 * image-filled shape (observed on the delivered task 5edca743: 4 source pictures, 1.93 MB, came back as
 * 6 image-filled shapes over 5 media parts, 0.91 MB), so neither bytes nor element names can be compared.
 * Each picture is drawn at 9×8 by the renderer's own rsvg-convert and compared by its difference hash;
 * transparency is compared from the same drawing. No image library is added. Deterministic for the same
 * bytes and rasteriser.
 */

export interface ImageFingerprint {
  /** 64-bit difference hash of the luminance, as 16 hex digits. */
  dhash: string;
  /** Share of the 9×8 drawing that is transparent (alpha under 250). */
  transparentShare: number;
  type: string;
  bytes: number;
}

export interface MediaPart { name: string; bytes: Uint8Array }

export interface ImageMatch {
  source: string;
  exported: string | null;
  distance: number | null;
  /** The source picture was transparent somewhere and the exported one is not. */
  transparencyLost: boolean;
}

export interface ImageFidelityResult {
  /** Every source picture has an exported picture within MATCH_DISTANCE. */
  pass: boolean;
  sourceImages: number;
  exportedImages: number;
  matched: number;
  missing: string[];
  transparencyLost: string[];
  /** Exported media bytes / source media bytes: under 1 means Canva re-encoded or downsampled. */
  byteRatio: number | null;
  matches: ImageMatch[];
  /** Pictures that could not be read, by name; they are not counted as matched. */
  unreadable: string[];
}

/** Hamming distance (of 64 bits) under which an exported picture is the same picture re-encoded. */
export const MATCH_DISTANCE = 10;
const W = 9, H = 8;

export async function imageFingerprint(bytes: Uint8Array, options: { rsvgConvertPath?: string } = {}): Promise<ImageFingerprint> {
  const buffer = Buffer.from(bytes);
  const type = sniffImageType(buffer);
  if (!type) throw new Error('IMAGE_UNREADABLE: the picture type could not be read');
  const file = `picture.${imageFileExtension(type)}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}"><image xlink:href="${file}" width="${W}" height="${H}" preserveAspectRatio="none"/></svg>`;
  const png = PNG.sync.read(await svgToPngAsync(svg, W, H, options.rsvgConvertPath ? { rsvgConvertPath: options.rsvgConvertPath } : undefined, { [file]: buffer }));
  // Transparent pixels are read over white, so a logo's shape is hashed as it is seen.
  const lum = (x: number, y: number) => {
    const i = (y * W + x) * 4, a = png.data[i + 3] / 255;
    const over = (c: number) => c * a + 255 * (1 - a);
    return 0.2126 * over(png.data[i]) + 0.7152 * over(png.data[i + 1]) + 0.0722 * over(png.data[i + 2]);
  };
  let hash = 0n, transparent = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) if (lum(x, y) > lum(x + 1, y)) hash |= 1n << BigInt(y * 8 + x);
    for (let x = 0; x < W; x++) if (png.data[(y * W + x) * 4 + 3] < 250) transparent++;
  }
  return { dhash: hash.toString(16).padStart(16, '0'), transparentShare: transparent / (W * H), type, bytes: bytes.length };
}

export function hammingDistance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`), n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

/**
 * Compares the pictures of an editable source with those of its export. Each source picture is matched
 * to its nearest exported one; a picture used twice in the export (Canva splits a frame) still counts once.
 */
export async function compareExportImages(source: MediaPart[], exported: MediaPart[],
  options: { rsvgConvertPath?: string } = {}): Promise<ImageFidelityResult> {
  const unreadable: string[] = [];
  const read = async (parts: MediaPart[]) => (await Promise.all(parts.map(async (p) => {
    try { return { name: p.name, print: await imageFingerprint(p.bytes, options) }; } catch { unreadable.push(p.name); return null; }
  }))).filter((x): x is { name: string; print: ImageFingerprint } => x !== null);
  const src = await read(source), exp = await read(exported);
  const matches: ImageMatch[] = src.map((s) => {
    const best = exp.map((e) => ({ e, d: hammingDistance(s.print.dhash, e.print.dhash) })).sort((a, b) => a.d - b.d)[0];
    const hit = best && best.d <= MATCH_DISTANCE ? best : null;
    return { source: s.name, exported: hit?.e.name ?? null, distance: best?.d ?? null,
      transparencyLost: Boolean(hit && s.print.transparentShare > 0.02 && hit.e.print.transparentShare <= 0.002) };
  });
  const sum = (parts: MediaPart[]) => parts.reduce((n, p) => n + p.bytes.length, 0);
  const missing = [...matches.filter((m) => !m.exported).map((m) => m.source), ...unreadable.filter((n) => source.some((p) => p.name === n))];
  const transparencyLost = matches.filter((m) => m.transparencyLost).map((m) => m.source);
  return {
    pass: missing.length === 0 && transparencyLost.length === 0,
    sourceImages: source.length, exportedImages: exported.length, matched: matches.filter((m) => m.exported).length,
    missing, transparencyLost, byteRatio: sum(source) ? Math.round((sum(exported) / sum(source)) * 1000) / 1000 : null,
    matches, unreadable,
  };
}
