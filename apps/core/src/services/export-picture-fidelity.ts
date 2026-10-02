/**
 * ADR-258: whether every picture of the editable source a design was imported from (its photos and its
 * official logo) is in the design Canva exports, where the source put it.
 *
 * Canva re-encodes and downsamples pictures, renames their media parts and turns a `p:pic` into an
 * image-filled shape, so neither bytes, names nor element types can be compared. Observed on the one
 * delivered design (task 5edca743, 2026-09-30): 4 source pictures (1.93 MB) came back as image-filled
 * shapes over 0.91 MB of media, at the same boxes to the pixel, each within difference-hash distance 8
 * of its source (unrelated pairs measured 16 or more). Pictures are paired by position first (a share of
 * the slide, so Canva's rounding of the page height does not matter), then by picture: one that moved
 * is reported as moved, one that is nowhere as missing. The logo is the source picture at the box the
 * transfer manifest records for it. Pictures Canva added (an effect it rasterised) are counted.
 *
 * Advisory: the result is recorded in the QC report and named in the office alert; it never changes
 * `passed` or `criticalPass` (ADR-257's rule). The customer download contract (ADR-258) reads `pass`.
 */
import { hammingDistance, imageFingerprint, MATCH_DISTANCE, type ImageFingerprint } from '@hawa/creative';
import { readPptxPictures, type PptxPicture, type PptxPictures } from '@hawa/qa';

export interface PictureFidelity {
  /** Every source picture is in the export at its place, and the logo kept its transparency. */
  pass: boolean;
  sourcePictures: number;
  exportPictures: number;
  matched: number;
  /** Source pictures found in the export, but not where the source put them. */
  moved: string[];
  /** Source pictures not in the export at all (by media part name in the source). */
  missing: string[];
  /** Pictures that were transparent in the source and are opaque in the export. */
  transparencyLost: string[];
  logo: 'preserved' | 'moved' | 'missing' | 'transparency_lost' | 'not_in_source';
  /** Export pictures that pair with no source picture: effects Canva rasterised into pictures. */
  addedByProvider: number;
  /** Exported media bytes / source media bytes (under 1: Canva re-encoded or downsampled). */
  byteRatio: number | null;
  warnings: string[];
}

interface Share { x: number; y: number; w: number; h: number }
const shareOf = (p: PptxPicture, doc: PptxPictures): Share =>
  ({ x: p.box.x / doc.slideWidth, y: p.box.y / doc.slideHeight, w: p.box.width / doc.slideWidth, h: p.box.height / doc.slideHeight });
/** Same place: every edge within half a percent of the page (about 5 px on a 1080 px design). */
const samePlace = (a: Share, b: Share) => Math.abs(a.x - b.x) <= 0.005 && Math.abs(a.y - b.y) <= 0.005 &&
  Math.abs(a.w - b.w) <= 0.005 && Math.abs(a.h - b.h) <= 0.005;

/**
 * @param logoBoxPx the logo box the transfer manifest records (`manifest.logo`, in layout pixels: the
 *   transfer writes one pixel as 9525 EMU), or undefined when the design has no logo.
 */
export async function checkExportPictures(sourcePptx: Uint8Array, exportPptx: Uint8Array,
  options: { logoBoxPx?: { x: number; y: number; width: number; height: number }; rsvgConvertPath?: string } = {}): Promise<PictureFidelity> {
  const source = readPptxPictures(sourcePptx), exported = readPptxPictures(exportPptx);
  const prints = new Map<string, ImageFingerprint | null>();
  const printOf = async (doc: PptxPictures, media: string, side: string) => {
    const key = `${side}:${media}`;
    if (!prints.has(key)) {
      const part = doc.media.find((m) => m.name === media);
      prints.set(key, part ? await imageFingerprint(part.bytes, options).catch(() => null) : null);
    }
    return prints.get(key) ?? null;
  };
  const logoAt = options.logoBoxPx && { x: options.logoBoxPx.x * 9525 / source.slideWidth, y: options.logoBoxPx.y * 9525 / source.slideHeight,
    w: options.logoBoxPx.width * 9525 / source.slideWidth, h: options.logoBoxPx.height * 9525 / source.slideHeight };
  const used = new Set<number>();
  const moved: string[] = [], missing: string[] = [], transparencyLost: string[] = [];
  let logo: PictureFidelity['logo'] = 'not_in_source';
  let matched = 0;
  for (const pic of source.pictures) {
    const place = shareOf(pic, source);
    const isLogo = Boolean(logoAt && samePlace(place, logoAt));
    const mine = await printOf(source, pic.media, 'source');
    const candidates = await Promise.all(exported.pictures.map(async (e, i) => {
      const theirs = await printOf(exported, e.media, 'export');
      return { i, e, here: samePlace(place, shareOf(e, exported)), d: mine && theirs ? hammingDistance(mine.dhash, theirs.dhash) : 64, theirs };
    }));
    const same = (c: { d: number }) => c.d <= MATCH_DISTANCE;
    const hit = candidates.filter((c) => !used.has(c.i) && c.here && same(c)).sort((a, b) => a.d - b.d)[0];
    const elsewhere = hit ? undefined : candidates.filter((c) => !used.has(c.i) && same(c)).sort((a, b) => a.d - b.d)[0];
    const found = hit ?? elsewhere;
    if (found) { used.add(found.i); matched++; }
    if (!found) missing.push(pic.media);
    else if (!hit) moved.push(pic.media);
    const lostAlpha = Boolean(found && mine && found.theirs && mine.transparentShare > 0.02 && found.theirs.transparentShare <= 0.002);
    if (lostAlpha) transparencyLost.push(pic.media);
    if (isLogo) logo = !found ? 'missing' : lostAlpha ? 'transparency_lost' : !hit ? 'moved' : 'preserved';
  }
  // Unpaired export pictures over the same media as a paired one are a frame Canva split, not an addition.
  const pairedMedia = new Set([...used].map((i) => exported.pictures[i].media));
  const addedByProvider = exported.pictures.filter((e, i) => !used.has(i) && !pairedMedia.has(e.media)).length;
  const sum = (doc: PptxPictures) => doc.media.reduce((n, m) => n + m.bytes.length, 0);
  const warnings = [
    ...(logo === 'missing' ? ['the logo is missing from the Canva export'] : []),
    ...(logo === 'transparency_lost' ? ['the logo lost its transparent background in the Canva export'] : []),
    ...(logo === 'moved' ? ['the logo moved in the Canva export'] : []),
    ...(missing.length - (logo === 'missing' ? 1 : 0) > 0 ? [`${missing.length - (logo === 'missing' ? 1 : 0)} photo(s) missing from the Canva export`] : []),
    ...(moved.length - (logo === 'moved' ? 1 : 0) > 0 ? [`${moved.length - (logo === 'moved' ? 1 : 0)} photo(s) moved in the Canva export`] : []),
  ];
  return {
    pass: missing.length === 0 && moved.length === 0 && transparencyLost.length === 0,
    sourcePictures: source.pictures.length, exportPictures: exported.pictures.length, matched, moved, missing, transparencyLost,
    logo, addedByProvider, byteRatio: sum(source) ? Math.round((sum(exported) / sum(source)) * 1000) / 1000 : null, warnings,
  };
}

