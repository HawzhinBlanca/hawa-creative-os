import { describe, expect, it } from 'vitest';
import { crc32, deflateSync } from 'node:zlib';
import { readPptxPictures } from '@hawa/qa';
import { checkExportPictures, checkTextLines, pictureDownloadVerdict } from '../src/services/export-picture-fidelity.js';
import { png, u8, zipSync } from './fixtures/shipped-export.js';

/**
 * ADR-258: the source's pictures in the Canva export. The live finding (task 5edca743, 2026-09-30): Canva
 * exports a source `p:pic` as an image-filled shape over re-encoded, downsampled media (4 pictures,
 * 1.93 MB → 0.91 MB), so counting `p:pic` reads the export as having no photos, and bytes never match.
 * Synthetic pictures only: no client media in the repository.
 */

/** An RGBA PNG from a pixel function (Core has no image dependency). */
function rgbaPng(width: number, height: number, at: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) raw.set(at(x, y), y * (width * 4 + 1) + 1 + x * 4);
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

// Three distinct pictures. `scale` draws the same picture smaller, `noise` perturbs it, as re-encoding does.
const sky = (scale = 1, noise = 0) => rgbaPng(Math.round(120 * scale), Math.round(80 * scale), (x, y) => {
  const v = Math.round((x / (120 * scale)) * 255); const n = ((x * 7 + y * 13) % 5) * noise; return [Math.min(255, v + n), 120, 255 - v, 255];
});
const blocks = (scale = 1, noise = 0) => rgbaPng(Math.round(90 * scale), Math.round(120 * scale), (x, y) => {
  const on = (Math.floor(x / (30 * scale)) + Math.floor(y / (40 * scale))) % 2 === 0; const n = ((x + y) % 3) * noise;
  return on ? [20 + n, 40, 60, 255] : [230 - n, 210, 90, 255];
});
/** A logo: a solid disc on a transparent ground; `opaque` paints the ground white, as a lost alpha would. */
const logo = (opaque = false) => rgbaPng(60, 60, (x, y) => {
  const inside = (x - 30) ** 2 + (y - 22) ** 2 < 20 ** 2 || (y > 44 && x > 10 && x < 50);
  return inside ? [71, 112, 163, 255] : opaque ? [255, 255, 255, 255] : [0, 0, 0, 0];
});
const effect = () => rgbaPng(100, 20, (x) => [Math.round(x * 2.5), Math.round(x * 2.5), 40, 255]);

const PX = 9525;
const SLIDE = { cx: 1080 * PX, cy: 1350 * PX };
interface Pic { media: string; box: [number, number, number, number]; as?: 'pic' | 'filled'; xfrmAttrs?: string }
const xfrm = ([x, y, w, h]: Pic['box'], attrs = '') => `<a:xfrm${attrs}><a:off x="${x * PX}" y="${y * PX}"/><a:ext cx="${w * PX}" cy="${h * PX}"/></a:xfrm>`;

/** A one-page PPTX drawing `pics` (source: `p:pic`; Canva export: image-filled `p:sp`) over `media`. */
function deck(pics: Pic[], media: Record<string, Uint8Array>, height = SLIDE.cy, title?: string): Uint8Array {
  const names = Object.keys(media);
  const text = title ? `<p:sp><p:nvSpPr><p:cNvPr id="90" name="t"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm([76, 600, 900, 120])}<a:prstGeom prst="rect"/></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="4000"><a:latin typeface="Cinzel"/></a:rPr><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>` : '';
  const shapes = pics.map((p, i) => {
    const rid = `rId${names.indexOf(p.media) + 2}`;
    return p.as === 'filled'
      ? `<p:sp><p:nvSpPr><p:cNvPr id="${i + 2}" name="s${i}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(p.box, p.xfrmAttrs)}<a:custGeom/><a:blipFill><a:blip r:embed="${rid}"/><a:stretch/></a:blipFill></p:spPr></p:sp>`
      : `<p:pic><p:nvPicPr><p:cNvPr id="${i + 2}" name="p${i}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch/></p:blipFill><p:spPr>${xfrm(p.box)}<a:prstGeom prst="rect"/></p:spPr></p:pic>`;
  }).join('');
  const ns = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const rels = names.map((n, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${n}"/>`).join('');
  return zipSync({
    'ppt/presentation.xml': u8(`<?xml version="1.0" encoding="UTF-8"?><p:presentation ${ns}><p:sldSz cx="${SLIDE.cx}" cy="${height}"/></p:presentation>`),
    'ppt/slides/slide1.xml': u8(`<?xml version="1.0" encoding="UTF-8"?><p:sld ${ns}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}${text}</p:spTree></p:cSld></p:sld>`),
    'ppt/slides/_rels/slide1.xml.rels': u8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`),
    ...Object.fromEntries(names.map((n) => [`ppt/media/${n}`, media[n]])),
  });
}

const LOGO_BOX = { x: 76, y: 76, width: 108, height: 108 };
const SOURCE = deck([
  { media: 'image-1-1.png', box: [0, 0, 670, 1067] },
  { media: 'image-1-2.png', box: [685, 0, 395, 526] },
  { media: 'image-1-3.png', box: [76, 76, 108, 108] },
], { 'image-1-1.png': sky(), 'image-1-2.png': blocks(), 'image-1-3.png': logo() });
/** What Canva gives back: filled shapes, renamed and smaller media, the page height rounded down by 1 px. */
const exported = (over: Partial<Record<'sky' | 'blocks' | 'logo', Uint8Array | null>> = {}, boxes: Partial<Record<'logo', Pic['box']>> = {}, extra = false, title?: string) => {
  const media: Record<string, Uint8Array> = {};
  const pics: Pic[] = [];
  const put = (name: string, bytes: Uint8Array | null | undefined, box: Pic['box']) => { if (!bytes) return; media[name] = bytes; pics.push({ media: name, box, as: 'filled' }); };
  put('image1.png', over.sky === undefined ? sky(0.5, 2) : over.sky, [0, 0, 670, 1067]);
  put('image2.png', over.blocks === undefined ? blocks(0.6, 3) : over.blocks, [685, 0, 395, 526]);
  put('image3.png', over.logo === undefined ? logo() : over.logo, boxes.logo ?? [76, 76, 108, 108]);
  if (extra) { media['image4.png'] = effect(); pics.push({ media: 'image4.png', box: [76, 1097, 928, 87], as: 'filled' }, { media: 'image4.png', box: [76, 1195, 928, 79], as: 'filled' }); }
  return deck(pics, media, SLIDE.cy - 6350, title);
};

describe('readPptxPictures reads a Canva export\'s photos (ADR-258)', () => {
  it('counts image-filled shapes, which a p:pic count misses, with their boxes and media', () => {
    const read = readPptxPictures(exported());
    expect(read.pictures.map((p) => p.kind)).toEqual(['filled-shape', 'filled-shape', 'filled-shape']);
    expect(read.pictures[2]).toMatchObject({ media: 'ppt/media/image3.png', box: { x: 76 * PX, y: 76 * PX, width: 108 * PX, height: 108 * PX } });
    expect(readPptxPictures(SOURCE).pictures.map((p) => p.kind)).toEqual(['pic', 'pic', 'pic']);
  });
});

describe('checkExportPictures: the source pictures in the export (ADR-258)', () => {
  it('re-encoded, downsampled and renamed pictures at their places pass, with the logo preserved', async () => {
    const r = await checkExportPictures(SOURCE, exported(), { logoBoxPx: LOGO_BOX });
    expect(r).toMatchObject({ pass: true, sourcePictures: 3, exportPictures: 3, matched: 3, missing: [], moved: [], transparencyLost: [], logo: 'preserved', addedByProvider: 0, warnings: [] });
    expect(typeof r.byteRatio).toBe("number");
  });

  it('a photo missing from the export fails, named, with a warning', async () => {
    const r = await checkExportPictures(SOURCE, exported({ blocks: null }), { logoBoxPx: LOGO_BOX });
    expect(r).toMatchObject({ pass: false, missing: ['ppt/media/image-1-2.png'], logo: 'preserved' });
    expect(r.warnings).toEqual(['1 photo(s) missing from the Canva export']);
  });

  it('a photo replaced by another picture is missing, not matched by its place', async () => {
    const r = await checkExportPictures(SOURCE, exported({ blocks: sky() }), { logoBoxPx: LOGO_BOX });
    expect(r.pass).toBe(false);
    expect(r.missing).toEqual(['ppt/media/image-1-2.png']);
  });

  it('a logo that lost its transparent ground is reported as such', async () => {
    const r = await checkExportPictures(SOURCE, exported({ logo: logo(true) }), { logoBoxPx: LOGO_BOX });
    expect(r).toMatchObject({ pass: false, logo: 'transparency_lost', transparencyLost: ['ppt/media/image-1-3.png'] });
    expect(r.warnings).toContain('the logo lost its transparent background in the Canva export');
  });

  it('a logo that is gone, or moved, is named', async () => {
    const gone = await checkExportPictures(SOURCE, exported({ logo: null }), { logoBoxPx: LOGO_BOX });
    expect(gone).toMatchObject({ pass: false, logo: 'missing' });
    expect(gone.warnings).toEqual(['the logo is missing from the Canva export']);
    const moved = await checkExportPictures(SOURCE, exported({}, { logo: [900, 1200, 108, 108] }), { logoBoxPx: LOGO_BOX });
    expect(moved).toMatchObject({ pass: false, logo: 'moved', moved: ['ppt/media/image-1-3.png'] });
  });

  it('an effect Canva rasterised into pictures is counted, and does not fail the check', async () => {
    const r = await checkExportPictures(SOURCE, exported({}, {}, true), { logoBoxPx: LOGO_BOX });
    expect(r).toMatchObject({ pass: true, addedByProvider: 2, exportPictures: 5 });
  });

  it('a design with no logo box says the source had none', async () => {
    const r = await checkExportPictures(SOURCE, exported());
    expect(r.logo).toBe('not_in_source');
    expect(r.pass).toBe(true);
  });
});

/** A one-page PPTX with text frames, at full size (9525 EMU a pixel). */
interface TextFrame { text: string; box: [number, number, number, number]; color: string; sz: number; rtl?: boolean; split?: boolean }
function textDeck(frames: TextFrame[], height = SLIDE.cy): Uint8Array {
  const ns = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const run = (t: string, f: TextFrame) => `<a:r><a:rPr sz="${f.sz}"><a:solidFill><a:srgbClr val="${f.color}"/></a:solidFill><a:latin typeface="Cinzel"/></a:rPr><a:t>${t}</a:t></a:r>`;
  const shapes = frames.map((f, i) => `<p:sp><p:nvSpPr><p:cNvPr id="${i + 2}" name="t${i}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(f.box)}<a:prstGeom prst="rect"/></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p>${f.rtl ? '<a:pPr rtl="1"/>' : ''}${f.split ? run('\u200f', f) + run(f.text, f) : run(f.text, f)}</a:p></p:txBody></p:sp>`).join('');
  return zipSync({
    'ppt/presentation.xml': u8(`<?xml version="1.0" encoding="UTF-8"?><p:presentation ${ns}><p:sldSz cx="${SLIDE.cx}" cy="${height}"/></p:presentation>`),
    'ppt/slides/slide1.xml': u8(`<?xml version="1.0" encoding="UTF-8"?><p:sld ${ns}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld></p:sld>`),
  });
}
/** A 1080 x 1350 render: each frame's text drawn as `lines` bars of ink, a line apart. */
function render(frames: Array<{ box: [number, number, number, number]; ink: string; lines: number; fontPx: number }>, background = '#0A1628'): Buffer {
  return png(1080, 1350, background, frames.flatMap((f) => Array.from({ length: f.lines }, (_, i) => ({
    x: f.box[0] + 10, y: Math.round(f.box[1] + i * f.fontPx * 1.3 + f.fontPx * 0.15), w: Math.round(f.box[2] * 0.8), h: Math.round(f.fontPx * 0.7), color: f.ink }))));
}
const HEAD: TextFrame = { text: 'Sorani title of the K-12 standards framework', box: [86, 387, 907, 265], color: 'F7B500', sz: 2900, rtl: true };
const BODY: TextFrame = { text: 'One line of body text', box: [151, 856, 778, 47], color: 'FFFFFF', sz: 1300 };
const HEAD_PX = 2900 / 100 * 12700 / 9525, BODY_PX = 1300 / 100 * 12700 / 9525;

describe('pictureDownloadVerdict: the customer download contract (ADR-258)', () => {
  it('passes intact pictures, warns on a moved picture, blocks a lost logo, photo or transparency', async () => {
    expect(pictureDownloadVerdict(await checkExportPictures(SOURCE, exported(), { logoBoxPx: LOGO_BOX }))).toEqual({ status: 'pass', blocks: false, reasons: [] });
    // An edit in Canva may move a picture: the download goes ahead, the office alert names it.
    const moved = await checkExportPictures(SOURCE, exported({}, { logo: [900, 1200, 108, 108] }), { logoBoxPx: LOGO_BOX });
    expect(pictureDownloadVerdict(moved)).toEqual({ status: 'warn', blocks: false, reasons: ['1 picture(s) moved'] });
    expect(pictureDownloadVerdict(await checkExportPictures(SOURCE, exported({ logo: null }), { logoBoxPx: LOGO_BOX })))
      .toEqual({ status: 'block', blocks: true, reasons: ['the logo is missing'] });
    expect(pictureDownloadVerdict(await checkExportPictures(SOURCE, exported({ logo: logo(true) }), { logoBoxPx: LOGO_BOX })))
      .toEqual({ status: 'block', blocks: true, reasons: ['the logo lost its transparent background'] });
    expect(pictureDownloadVerdict(await checkExportPictures(SOURCE, exported({ blocks: null }), { logoBoxPx: LOGO_BOX })))
      .toEqual({ status: 'block', blocks: true, reasons: ['1 photo(s) missing'] });
  });

  it('fails closed when the check could not run or is not on record; nothing to compare is not applicable', () => {
    expect(pictureDownloadVerdict(undefined)).toMatchObject({ status: 'block', blocks: true });
    expect(pictureDownloadVerdict({ measured: false, code: 'error', reason: 'Not measured: rsvg-convert failed' }))
      .toEqual({ status: 'block', blocks: true, reasons: ['the pictures could not be compared: Not measured: rsvg-convert failed'] });
    expect(pictureDownloadVerdict({ measured: false, code: 'no_editable_source', reason: 'The design was not imported from an editable source.' }))
      .toEqual({ status: 'not_applicable', blocks: false, reasons: [] });
    // Records written before the code existed are read by their words.
    expect(pictureDownloadVerdict({ measured: false, reason: 'Not measured: timeout' })).toMatchObject({ status: 'block' });
    expect(pictureDownloadVerdict({ measured: false, reason: 'The design was not imported from an editable source; there is nothing to compare its pictures with.' }))
      .toMatchObject({ status: 'not_applicable' });
  });
});

describe('a picture the export does not draw as the source did (hunt 3, 2026-10-03)', () => {
  /** The export with the logo drawn under the transform attributes `attrs` (rotation, flips), in its own box. */
  const transformed = (attrs: string) => deck([
    { media: 'image1.png', box: [0, 0, 670, 1067], as: 'filled' },
    { media: 'image2.png', box: [685, 0, 395, 526], as: 'filled' },
    { media: 'image3.png', box: [76, 76, 108, 108], as: 'filled', xfrmAttrs: attrs },
  ], { 'image1.png': sky(0.5, 2), 'image2.png': blocks(0.6, 3), 'image3.png': logo() }, SLIDE.cy - 6350);

  it('a logo moved off the page is missing, and blocks the download', async () => {
    for (const box of [[1100, 76, 108, 108], [76, 1400, 108, 108], [-200, 76, 108, 108]] as Pic['box'][]) {
      const r = await checkExportPictures(SOURCE, exported({}, { logo: box }), { logoBoxPx: LOGO_BOX });
      expect(r, String(box)).toMatchObject({ pass: false, logo: 'missing', missing: ['ppt/media/image-1-3.png'] });
      expect(pictureDownloadVerdict(r).status).toBe('block');
    }
    // Partly on the page it is drawn, and only moved.
    const edge = await checkExportPictures(SOURCE, exported({}, { logo: [1020, 76, 108, 108] }), { logoBoxPx: LOGO_BOX });
    expect(edge).toMatchObject({ logo: 'moved' });
  });

  it('a logo mirrored or turned in its own box is not the logo the source placed', async () => {
    const mirrored = await checkExportPictures(SOURCE, transformed(' flipH="1"'), { logoBoxPx: LOGO_BOX });
    expect(mirrored).toMatchObject({ pass: false, logo: 'moved' });
    const upsideDown = await checkExportPictures(SOURCE, transformed(' rot="10800000"'), { logoBoxPx: LOGO_BOX });
    expect(upsideDown).toMatchObject({ pass: false, logo: 'moved' });
    // Canva's own near-zero angles and explicit false flips are the source's orientation.
    const canva = await checkExportPictures(SOURCE, transformed(' rot="3300" flipH="false" flipV="false"'), { logoBoxPx: LOGO_BOX });
    expect(canva).toMatchObject({ pass: true, logo: 'preserved' });
  });
});

describe('checkTextLines: does Canva wrap each text frame as the design did? (ADR-258)', () => {
  it('a title the design set on 3 lines and Canva on 2 is named, with both counts', () => {
    const r = checkTextLines(
      render([{ box: HEAD.box, ink: '#F7B500', lines: 3, fontPx: HEAD_PX }, { box: BODY.box, ink: '#FFFFFF', lines: 1, fontPx: BODY_PX }]),
      render([{ box: HEAD.box, ink: '#F7B500', lines: 2, fontPx: HEAD_PX }, { box: BODY.box, ink: '#FFFFFF', lines: 1, fontPx: BODY_PX }]),
      textDeck([HEAD, BODY]), textDeck([{ ...HEAD, split: true }, BODY], SLIDE.cy - 6350));
    expect(r.frames).toEqual([{ text: 'Sorani title of the K-12 stan…', studio: 3, canva: 2 }, { text: 'One line of body text', studio: 1, canva: 1 }]);
    expect(r.pass).toBe(false);
    expect(r.warnings).toEqual(["'Sorani title of the K-12 stan…' wraps differently in Canva (3 lines in the design, 2 in Canva)"]);
  });

  it('the same wrapping passes, and a frame Canva renamed or dropped is unmeasured, not failed', () => {
    const studio = render([{ box: HEAD.box, ink: '#F7B500', lines: 2, fontPx: HEAD_PX }, { box: BODY.box, ink: '#FFFFFF', lines: 1, fontPx: BODY_PX }]);
    const same = checkTextLines(studio, studio, textDeck([HEAD, BODY]), textDeck([HEAD, BODY]));
    expect(same).toMatchObject({ pass: true, warnings: [], unmeasured: [] });
    const dropped = checkTextLines(studio, studio, textDeck([HEAD, BODY]), textDeck([HEAD]));
    expect(dropped).toMatchObject({ pass: true, unmeasured: ['One line of body text'] });
  });

  it('pairs a capitals title Canva wrote in capitals with its typed source frame (ADR-275)', () => {
    const title: TextFrame = { text: 'Peer Review Week', box: [86, 387, 907, 265], color: 'F7B500', sz: 2900 };
    const r = checkTextLines(
      render([{ box: title.box, ink: '#F7B500', lines: 2, fontPx: HEAD_PX }]),
      render([{ box: title.box, ink: '#F7B500', lines: 1, fontPx: HEAD_PX }]),
      textDeck([title]), textDeck([{ ...title, text: 'PEER REVIEW WEEK' }], SLIDE.cy - 6350));
    expect(r.unmeasured).toEqual([]);
    expect(r.frames).toEqual([{ text: 'Peer Review Week', studio: 2, canva: 1 }]);
    expect(r.pass).toBe(false);
  });
});

// The recorded QC run and the office alert, through the lifecycle's own outcome path on the test database.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, vi } from 'vitest';
import { CanvaBindingRepository, createDb, sql, withRlsContext } from '@hawa/db';
import { checkCanvaPptx } from '@hawa/qa';
import { projectLifecycleDesignOutcome, projectLifecycleOpen } from '../src/services/lifecycle-projection.js';

const db = createDb(process.env.TEST_DATABASE_URL!);
afterAll(() => db.destroy());
afterEach(() => vi.unstubAllEnvs());
const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const scope = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' as const };
const OFFICE = ['91500011', '91500012'];
const TITLE = 'Autumn workshop poster';
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function imported(exportDeck: Uint8Array, source: Uint8Array | null, pictures?: { studio: Buffer; canva: Buffer }) {
  vi.stubEnv('TELEGRAM_ALLOWED_USERS', OFFICE.join(','));
  const requestId = randomUUID();
  const { taskId } = await projectLifecycleOpen(db, {
    requestId, tenantId, expectedRev: 0, rev: 1, key: `${requestId}:1:open`,
    draft: { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: String(67_000_000 + Math.floor(Math.random() * 8_000_000)),
      rawText: TITLE, title: TITLE, designInstructions: 'Use the exact copy', exactCopy: [TITLE], clientId, autoGenerate: true, designStudio: false },
  });
  const designId = `DA${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await withRlsContext(db, scope, async (trx) => {
    await new CanvaBindingRepository(trx).createBinding({ tenantId, taskId, clientId, canvaDesignId: designId, editUrl: `https://www.canva.com/design/${designId}/edit` }, trx);
    const binding = await trx.selectFrom('canva_bindings').select(['version']).where('tenant_id', '=', tenantId).where('task_id', '=', taskId).executeTakeFirstOrThrow();
    if (source) {
      const create = randomUUID();
      await sql`INSERT INTO hawa.canva_remote_operations (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, metadata)
        VALUES (${create}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid, 'test', ${`import-${create}`}, ${hash(source)}, 'create', 'retrieved', ${designId},
          '{"method":"pptx_import"}'::jsonb)`.execute(trx);
      await sql`INSERT INTO hawa.canva_editable_sources (id, tenant_id, task_id, client_id, actor_id, operation_id, sha256, content, manifest)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid, 'test', ${create}::uuid, ${hash(source)}, ${Buffer.from(source)},
          ${JSON.stringify({ copy: [TITLE], logo: LOGO_BOX })}::jsonb)`.execute(trx);
    }
    if (pictures) {
      const runId = randomUUID();
      await sql`INSERT INTO hawa.design_studio_runs (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, tier, status, stages)
        VALUES (${runId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid, 'test', ${randomUUID()}, 'h', '{}'::jsonb, 'standard', 'transferred', '{}'::jsonb)`.execute(trx);
      await sql`INSERT INTO hawa.design_studio_candidates (id, run_id, tenant_id, ordinal, concept, status, preview_png, preview_sha256)
        VALUES (${randomUUID()}::uuid, ${runId}::uuid, ${tenantId}::uuid, 0, '{}'::jsonb, 'winner', ${pictures.studio}, ${hash(pictures.studio)})`.execute(trx);
      const pngOp = randomUUID();
      await sql`INSERT INTO hawa.canva_remote_operations (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata)
        VALUES (${pngOp}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid, 'test', ${`png-${pngOp}`}, ${hash(pictures.canva)}, 'export', 'retrieved', ${designId}, ${binding.version},
          '{"format":"png","designUpdatedAt":"2026-10-02T09:00:00Z"}'::jsonb)`.execute(trx);
      await sql`INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid, ${pngOp}::uuid, 'png', ${hash(pictures.canva)}, ${pictures.canva})`.execute(trx);
    }
    const op = randomUUID();
    const deckBytes = Buffer.from(exportDeck);
    await sql`INSERT INTO hawa.canva_remote_operations (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata)
      VALUES (${op}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid, 'test', ${`deck-${op}`}, ${hash(deckBytes)}, 'export', 'retrieved', ${designId}, ${binding.version},
        '{"format":"pptx","designUpdatedAt":"2026-10-02T09:00:00Z"}'::jsonb)`.execute(trx);
    await sql`INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content, content_check)
      VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid, ${op}::uuid, 'pptx', ${hash(deckBytes)}, ${deckBytes},
        ${JSON.stringify(checkCanvaPptx(deckBytes, [TITLE], { fontsByIndex: ['Cinzel'] }))}::jsonb)`.execute(trx);
  });
  const runId = `dr-${taskId}`;
  const result = await projectLifecycleDesignOutcome(db, {
    requestId, tenantId, taskId, runId, expectedRev: 1, rev: 2, key: `${requestId}:2:designFinished:${runId}`,
    report: { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId },
  });
  const report = (await withRlsContext(db, scope, (trx) => sql<{ report: any }>`SELECT report FROM hawa.qc_runs
    WHERE tenant_id = ${tenantId}::uuid AND task_id = ${taskId}::uuid ORDER BY started_at DESC LIMIT 1`.execute(trx))).rows[0]?.report;
  return { result, report };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('the recorded QC run carries the picture check (ADR-258)', () => {
  it('an import whose pictures all survive records pass, logo preserved; the verdict is the copy check\'s', async () => {
    const { report, result } = await imported(exported({}, {}, false, TITLE), deck([
      { media: 'image-1-1.png', box: [0, 0, 670, 1067] }, { media: 'image-1-2.png', box: [685, 0, 395, 526] }, { media: 'image-1-3.png', box: [76, 76, 108, 108] },
    ], { 'image-1-1.png': sky(), 'image-1-2.png': blocks(), 'image-1-3.png': logo() }, SLIDE.cy, TITLE));
    expect(report.pictureFidelity).toMatchObject({ pass: true, logo: 'preserved', matched: 3 });
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'pictureFidelity', passed: true }));
    expect(report.passed).toBe(true);
    expect(result.officePhotoAlerts?.[0].text ?? result.officeAlerts?.[0].text).not.toContain('Check before approving');
  });

  it('a lost logo is recorded and named in the office alert, without changing the verdict', async () => {
    const { report, result } = await imported(exported({ logo: null }, {}, false, TITLE), deck([
      { media: 'image-1-1.png', box: [0, 0, 670, 1067] }, { media: 'image-1-2.png', box: [685, 0, 395, 526] }, { media: 'image-1-3.png', box: [76, 76, 108, 108] },
    ], { 'image-1-1.png': sky(), 'image-1-2.png': blocks(), 'image-1-3.png': logo() }, SLIDE.cy, TITLE));
    expect(report.pictureFidelity).toMatchObject({ pass: false, logo: 'missing' });
    expect(report.passed).toBe(true);
    expect(report.warnings).toContain('the logo is missing from the Canva export');
    const alert = result.officePhotoAlerts?.[0].text ?? result.officeAlerts?.[0].text;
    expect(alert).toContain('Check before approving: the logo is missing from the Canva export');
  });

  it('a title Canva wraps on fewer lines than the Studio render is recorded and named in the office alert', async () => {
    const frames = (lines: number) => render([{ box: HEAD.box, ink: '#F7B500', lines, fontPx: HEAD_PX }]);
    const words = { ...HEAD, text: TITLE };
    const { report, result } = await imported(textDeck([words], SLIDE.cy - 6350), textDeck([words]), { studio: frames(3), canva: frames(2) });
    expect(report.textLines).toMatchObject({ pass: false, frames: [{ studio: 3, canva: 2 }] });
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'textLines', passed: false }));
    expect(report.passed).toBe(true);
    const alert = result.officePhotoAlerts?.[0].text ?? result.officeAlerts?.[0].text;
    expect(alert).toContain(`'${TITLE}' wraps differently in Canva (3 lines in the design, 2 in Canva)`);
  });

  it('without a Studio render or a same-version PNG, the line check says why it measured nothing', async () => {
    const { report } = await imported(exported({}, {}, false, TITLE), deck([
      { media: 'image-1-1.png', box: [0, 0, 670, 1067] }, { media: 'image-1-2.png', box: [685, 0, 395, 526] }, { media: 'image-1-3.png', box: [76, 76, 108, 108] },
    ], { 'image-1-1.png': sky(), 'image-1-2.png': blocks(), 'image-1-3.png': logo() }, SLIDE.cy, TITLE));
    expect(report.textLines).toMatchObject({ measured: false, reason: 'No PNG of the same Canva version was retrieved.' });
  });

  it('a design not imported from an editable source says there is nothing to compare', async () => {
    const { report } = await imported(exported({}, {}, false, TITLE), null);
    expect(report.pictureFidelity).toMatchObject({ measured: false, code: 'no_editable_source' });
    expect(pictureDownloadVerdict(report.pictureFidelity as never)).toMatchObject({ status: 'not_applicable', blocks: false });
  });
});

// One exported object cannot prove two independently addressable source pictures.
it('does not reuse one export picture for two same-position source pictures',async()=>{
 const source=deck([{media:'one.png',box:[0,0,600,800]},{media:'two.png',box:[0,0,600,800]}],{'one.png':sky(),'two.png':sky()});
 const exported=deck([{media:'export.png',box:[0,0,600,800]}],{'export.png':sky()});
 const result=await checkExportPictures(source,exported);
 expect(result).toMatchObject({pass:false,sourcePictures:2,matched:1,missing:['ppt/media/two.png']});
});
