import { createHash } from 'node:crypto';
import { dataUriBytes, imageFileExtension, sniffImageType } from './image-type.js';

/**
 * Pictures a render's SVG reads as files beside it, not as data URIs inside it (ADR-035 section 5,
 * FILESTORE_DESIGN.md section 6).
 *
 * rsvg refuses any XML attribute over 10,000,000 bytes, and its parser gives up after some tens of
 * megabytes of large data URIs: a rotated 12 MP photo redrawn as a PNG data URI failed every render of
 * its design (2026-09-23). librsvg reads a file in the SVG's own folder by its relative name, so a
 * photo, a cut-out, the art and the logo are named by a hash of their bytes and written beside the SVG
 * by the rasteriser (`svgToPngAsync`'s `files`). The pixels are the ones the data URI gave: the same
 * bytes, decoded by the same loader.
 */

/** The file name a picture gets: `<kind>-<first 16 hex of its sha256>.<ext>`, the extension from its bytes. */
export function svgFileName(bytes: Buffer, kind: string): string {
  if (!/^[a-z0-9-]+$/.test(kind)) throw new Error(`svgFileName: unsafe kind ${kind}`);
  const type = sniffImageType(bytes);
  // A picture of no type we know is still written: rsvg reads what it can, as it did from a data URI.
  const ext = type ? imageFileExtension(type) : 'bin';
  return `${kind}-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.${ext}`;
}

/** The files one SVG reads, by name; the same bytes of the same kind are one file. */
export class SvgFiles {
  private readonly byName = new Map<string, Buffer>();

  /** Adds the bytes and returns the name the SVG refers to them by. */
  add(bytes: Buffer, kind: string): string {
    const name = svgFileName(bytes, kind);
    if (!this.byName.has(name)) this.byName.set(name, bytes);
    return name;
  }

  /**
   * The href to draw a picture given as a data URI (a caller's logo, the art, a photo from a legacy
   * payload): its file's name when it is base64, as it came otherwise (nothing can be read from it).
   */
  hrefFor(uri: string, kind: string): string {
    const bytes = uri.startsWith('data:') ? dataUriBytes(uri) : undefined;
    return bytes && bytes.length ? this.add(bytes, kind) : uri;
  }

  merge(files: Record<string, Buffer> | undefined): void {
    for (const [name, bytes] of Object.entries(files ?? {})) if (!this.byName.has(name)) this.byName.set(name, bytes);
  }

  get files(): Record<string, Buffer> {
    return Object.fromEntries(this.byName);
  }
}

/** The largest data URI the rasterisers accept inline; everything larger goes beside the SVG as a file. */
export const INLINE_DATA_URI_MAX = 100 * 1024;

/** The length, in characters, of the longest data: URI in an href of this SVG (0 when there is none). */
export function largestInlineDataUri(svg: string): number {
  let largest = 0;
  const re = /href="data:[^"]*"/g;
  for (let m = re.exec(svg); m; m = re.exec(svg)) largest = Math.max(largest, m[0].length - 'href=""'.length);
  return largest;
}

export type InlineDataUriGuardMode = 'throw' | 'log';
let guardMode: InlineDataUriGuardMode | undefined;

/**
 * How a large inline data URI is treated: with HAWA_INLINE_DATA_URI_GUARD=throw (vitest.config.ts sets
 * it) the render throws, so a regression fails the suite; otherwise a server logs `[render] inline data
 * URI N bytes` and renders, until a clean week in production makes it a throw there too
 * (FILESTORE_DESIGN.md section 6). An explicit setting rather than the test-runner environment, so
 * production code has no test-only branch.
 */
export function setInlineDataUriGuard(mode: InlineDataUriGuardMode | undefined): void {
  guardMode = mode;
}

export function checkInlineDataUris(svg: string, where: string): void {
  const largest = largestInlineDataUri(svg);
  if (largest <= INLINE_DATA_URI_MAX) return;
  const mode = guardMode ?? (process.env.HAWA_INLINE_DATA_URI_GUARD === 'throw' ? 'throw' : 'log');
  const message = `[render] inline data URI ${largest} bytes in ${where} (limit ${INLINE_DATA_URI_MAX}); pictures go beside the SVG as files`;
  if (mode === 'throw') throw new Error(message);
  console.warn(message);
}

/**
 * The SVG with every file it reads put back inline as a data URI: one self-contained document, for a
 * person to open or a proof script to save. Never handed to a rasteriser.
 */
export function inlineSvgFiles(svg: string, files: Record<string, Buffer> | undefined): string {
  let out = svg;
  for (const [name, bytes] of Object.entries(files ?? {})) {
    const type = sniffImageType(bytes) ?? 'application/octet-stream';
    out = out.split(`href="${name}"`).join(`href="data:${type};base64,${bytes.toString('base64')}"`);
  }
  return out;
}
