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
import { countInkLines, decodePicture, hammingDistance, imageFingerprint, MATCH_DISTANCE, type ImageFingerprint } from '@hawa/creative';
import { readPptxPictures, readPptxTextLayout, type PptxPicture, type PptxPictures, type PptxTextLayout } from '@hawa/qa';

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
/** Turned the same way: mirrored alike, and the angle within a degree (Canva writes near-zero angles). */
const sameTurn = (a: PptxPicture, b: PptxPicture) => a.orientation.mirrored === b.orientation.mirrored &&
  Math.min(Math.abs(a.orientation.rotation - b.orientation.rotation), 360 - Math.abs(a.orientation.rotation - b.orientation.rotation)) <= 1;
/** Drawn on the page: a picture whose box lies wholly off the page, or has no area, shows nothing. */
const onPage = (p: PptxPicture, doc: PptxPictures) => p.box.width > 0 && p.box.height > 0 &&
  p.box.x < doc.slideWidth && p.box.x + p.box.width > 0 && p.box.y < doc.slideHeight && p.box.y + p.box.height > 0;

/**
 * @param logoBoxPx the logo box the transfer manifest records (`manifest.logo`, in layout pixels: the
 *   transfer writes one pixel as 9525 EMU), or undefined when the design has no logo.
 */
export async function checkExportPictures(sourcePptx: Uint8Array, exportPptx: Uint8Array,
  options: { logoBoxPx?: { x: number; y: number; width: number; height: number }; rsvgConvertPath?: string } = {}): Promise<PictureFidelity> {
  const source = readPptxPictures(sourcePptx), exported = readPptxPictures(exportPptx);
  // Only pictures the page draws are compared: a logo dragged off the page is missing, not moved.
  const sourcePictures = source.pictures.filter((p) => onPage(p, source));
  const drawn = exported.pictures.filter((p) => onPage(p, exported));
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
  for (const pic of sourcePictures) {
    const place = shareOf(pic, source);
    const isLogo = Boolean(logoAt && samePlace(place, logoAt));
    const mine = await printOf(source, pic.media, 'source');
    const candidates = await Promise.all(drawn.map(async (e, i) => {
      const theirs = await printOf(exported, e.media, 'export');
      // In its place means where the source put it and turned as the source turned it.
      return { i, e, here: samePlace(place, shareOf(e, exported)) && sameTurn(pic, e), d: mine && theirs ? hammingDistance(mine.dhash, theirs.dhash) : 64, theirs };
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
  const pairedMedia = new Set([...used].map((i) => drawn[i].media));
  const addedByProvider = drawn.filter((e, i) => !used.has(i) && !pairedMedia.has(e.media)).length;
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
    sourcePictures: sourcePictures.length, exportPictures: drawn.length, matched, moved, missing, transparencyLost,
    logo, addedByProvider, byteRatio: sum(source) ? Math.round((sum(exported) / sum(source)) * 1000) / 1000 : null, warnings,
  };
}


/** What `qaReport.pictureFidelity` holds when the check did not run: why, as a code a caller can branch on. */
export interface PictureFidelityNotMeasured { measured: false; code?: 'no_editable_source' | 'error'; reason: string }

export interface PictureDownloadVerdict {
  /** pass: every picture in place; warn: a picture moved (a person editing in Canva may move one);
   *  block: the logo or a photo is missing, or a picture lost its transparency, or the check could not run;
   *  not_applicable: the design was not imported from an editable source. */
  status: 'pass' | 'warn' | 'block' | 'not_applicable';
  blocks: boolean;
  reasons: string[];
}

/**
 * ADR-258, the customer download contract: whether the picture check recorded on an export's QC report
 * (`qaReport.pictureFidelity`) lets that export be downloaded. Fails closed: a design imported from an
 * editable source whose pictures could not be compared is blocked until they are (the check is re-run on
 * the next export). A moved picture only warns, since an edit in Canva legitimately moves things; the
 * office alert still names it. Text wrapping (`textLines`) is advisory and never blocks.
 */
export function pictureDownloadVerdict(recorded: PictureFidelity | PictureFidelityNotMeasured | null | undefined): PictureDownloadVerdict {
  if (!recorded) return { status: 'block', blocks: true, reasons: ['the export has no picture check on record'] };
  if ('measured' in recorded && recorded.measured === false) {
    // Records written before `code` existed say why in words only.
    const noSource = recorded.code === 'no_editable_source' || (!recorded.code && !/^Not measured/.test(recorded.reason));
    return noSource ? { status: 'not_applicable', blocks: false, reasons: [] }
      : { status: 'block', blocks: true, reasons: [`the pictures could not be compared: ${recorded.reason}`] };
  }
  const f = recorded as PictureFidelity;
  const reasons: string[] = [];
  if (f.logo === 'missing') reasons.push('the logo is missing');
  if (f.logo === 'transparency_lost') reasons.push('the logo lost its transparent background');
  const photosMissing = f.missing.length - (f.logo === 'missing' ? 1 : 0);
  if (photosMissing > 0) reasons.push(`${photosMissing} photo(s) missing`);
  const otherAlpha = f.transparencyLost.length - (f.logo === 'transparency_lost' ? 1 : 0);
  if (otherAlpha > 0) reasons.push(`${otherAlpha} picture(s) lost their transparency`);
  if (reasons.length) return { status: 'block', blocks: true, reasons };
  if (f.moved.length) return { status: 'warn', blocks: false, reasons: [`${f.moved.length} picture(s) moved`] };
  return { status: 'pass', blocks: false, reasons: [] };
}

export interface TextLineFidelity {
  /** Every text frame has as many lines in Canva's PNG as in the Studio render it was designed in. */
  pass: boolean;
  frames: Array<{ text: string; studio: number; canva: number }>;
  /** Frames whose text or colour could not be paired or read, by their first words. */
  unmeasured: string[];
  warnings: string[];
}

/**
 * A frame's text without direction marks, joiners or spacing, for pairing a source frame with Canva's. In
 * capitals: a title sent as typed under cap="all" may come back with the capitals written in (ADR-275).
 */
const plain = (text: string) => text.replace(/[‎‏‪-‮⁦-⁩⁠​-‍\s]+/gu, '').toUpperCase();
const excerpt = (text: string) => { const t = text.replace(/[‎‏⁦-⁩⁠]/gu, '').trim(); return Array.from(t).length > 30 ? `${Array.from(t).slice(0, 29).join('')}…` : t; };

/**
 * ADR-258: whether Canva set each text frame on as many lines as the Studio render the design was chosen
 * from. Live 2026-09-20 (task 68b98306): a Sorani title wrapped on 3 lines in Studio and on 2 in Canva.
 * The source's frames place the Studio render's text; Canva's frames place its own. Frames are paired by
 * their text. Advisory, like the picture check.
 */
export function checkTextLines(studioPng: Buffer, canvaPng: Buffer, sourcePptx: Uint8Array, exportPptx: Uint8Array): TextLineFidelity {
  const source = readPptxTextLayout(sourcePptx), exported = readPptxTextLayout(exportPptx);
  const studio = decodePicture(studioPng), canva = decodePicture(canvaPng);
  const frames: TextLineFidelity['frames'] = [];
  const unmeasured: string[] = [];
  type Picture = ReturnType<typeof decodePicture>;
  const toPx = (doc: PptxTextLayout, png: Picture) => png.width / doc.slideWidth;
  for (const frame of source.frames) {
    const key = plain(frame.text);
    const twin = key ? exported.frames.find((f) => plain(f.text) === key) : undefined;
    const ink = frame.runs.find((r) => r.color)?.color;
    const size = frame.runs.find((r) => r.fontSizePt)?.fontSizePt;
    const twinInk = twin?.runs.find((r) => r.color)?.color ?? ink;
    if (!twin || !ink || !twinInk || !size) { if (key) unmeasured.push(excerpt(frame.text)); continue; }
    const at = (f: typeof frame, doc: PptxTextLayout, png: Picture) => {
      const k = toPx(doc, png);
      return { box: { x: f.box.x * k, y: f.box.y * k, width: f.box.width * k, height: f.box.height * k }, fontPx: size * f.scale * 12700 * k };
    };
    const s = at(frame, source, studio), c = at(twin, exported, canva);
    frames.push({ text: excerpt(frame.text), studio: countInkLines(studio, s.box, ink, s.fontPx).lines, canva: countInkLines(canva, c.box, twinInk, c.fontPx).lines });
  }
  const changed = frames.filter((f) => f.studio > 0 && f.canva > 0 && f.studio !== f.canva);
  return {
    pass: changed.length === 0,
    frames, unmeasured,
    warnings: changed.map((f) => `'${f.text}' wraps differently in Canva (${f.studio} line${f.studio === 1 ? '' : 's'} in the design, ${f.canva} in Canva)`),
  };
}
