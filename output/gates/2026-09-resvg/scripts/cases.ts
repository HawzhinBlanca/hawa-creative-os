#!/usr/bin/env tsx
/**
 * Builds every input of the resvg gate (ADR-036 section 2.3) as an SVG on disk, with the files it
 * references beside it, and the list of render jobs. No model calls, no network, no product change.
 *
 *   npx tsx output/gates/2026-09-resvg/scripts/cases.ts --work <dir> --corpus <output/proofs dir> [--designs 67]
 *
 * The SVGs come from the repo's own renderer (renderLayoutV2ToSvg, the renderer-neutral markup of
 * Phase 0.5) and its own treatment code (photo-treatments.ts), so they are what production would
 * hand a rasteriser. The SVG is built once, on the host; both rasterisers then read the same bytes.
 *
 * Classes:
 *   stored     stored qualification designs, re-prepared in every production mode (plain, ornament,
 *              each committed style reference) exactly as scripts/proofs/reprepare_stored_runs.mjs does;
 *              a design with art gets its motif (or an exemplar standing in for generated art)
 *   photo      one picture in every container and pixel format, framed, and every framed treatment
 *   exif-raw   JPEGs tagged with EXIF orientation 1-8, drawn directly (what a renderer does with the tag)
 *   exif-upright  the SVG photo-upright.ts renders to turn such a JPEG upright (the product path)
 *   cutout     cut-out people with outlines 1-24 px, glows, both, fades, filters, overlap, off-canvas (1x)
 *   bake       the same treatments as the deck bakes them: the fragment alone at 2x
 *   kurdish    Sorani text: every Arabic-script face, right/centre/left, Latin, digits, punctuation
 *   latin      Latin text: every Latin face, the same alignments, digits and punctuation
 *   logo       the logo pre-scale job (a 2687 px PNG fitted into its box)
 *   motif      the procedural motif SVGs (rendered by the rasteriser in production too)
 *   stress     a 12 MP photo as a data URI and as a file beside the SVG
 *   line       one text line of any of the above, alone (for per-line boxes and word order)
 *   control    a Kurdish line with its words deliberately reversed (rsvg only), which the word-order
 *              detector must flag
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as creative from '../../../../packages/creative/src/index.js';
import type { PhotoElement, StudioLayoutV2, TextElement } from '../../../../packages/creative/src/studio/layout-v2.js';
import type { PhotoCutoutAsset } from '../../../../packages/creative/src/studio/photo-cutout.js';
import { imageDataUri } from '../../../../packages/creative/src/studio/image-type.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const ARABIC = /[\u0600-\u06FF]/;

export interface Job {
  id: string;
  cls: string;
  /** Case directory, relative to <work>/cases. */
  dir: string;
  svg: string;
  width: number;
  height: number;
  /** Canvases are timed and repeated; lines only compared. */
  kind: 'canvas' | 'line';
  renderers: Array<'rsvg' | 'resvg'>;
  parent?: string;
  script?: 'arabic' | 'latin';
  text?: string;
  /** For a control line: the job id of the unreversed line. */
  controlOf?: string;
  note?: string;
}

interface Args {
  work: string;
  corpus: string;
  designs: number;
  image: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { work: '', corpus: '', designs: 67, image: 'hawa-resvg-gate:0.48.1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--work') args.work = path.resolve(argv[++i]);
    else if (a === '--corpus') args.corpus = path.resolve(argv[++i]);
    else if (a === '--designs') args.designs = Number(argv[++i]);
    else if (a === '--image') args.image = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!args.work || !args.corpus) throw new Error('--work <dir> and --corpus <output/proofs dir> are required');
  return args;
}

const jobs: Job[] = [];
let casesDir = '';

// ---------------------------------------------------------------------------------------------
// The font choice the production image would make
//
// renderTextElementToSvg swaps a family its rasteriser does not draw for Verdana or Noto Sans Arabic,
// and it asks the host's rsvg-convert. On this Mac (Homebrew librsvg 2.62) Cinzel, Playfair Display
// and Cairo probe as substituted, so the host writes font-family="Verdana" where the production
// image, which draws all three, writes the family itself. The probe cannot be pointed at the image
// without changing the product, so the image's verdicts are measured here, with its own
// rsvg-convert and fontconfig, and the family attribute is set to what the image would choose.

const PROBE_SENTINEL = 'ZZHawaNoSuchFamilyZZ';
let imageVerdicts: Record<string, 'exact' | 'stand-in'> = {};

function probeSvgFor(family: string): string {
  // render-layout-v2.ts probeSvg, byte for byte.
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="120">' +
    '<rect width="900" height="120" fill="#ffffff"/>' +
    `<text x="20" y="80" font-family="${family}" font-size="60" fill="#000000">Handgloves 0123</text>` +
    '</svg>'
  );
}

function measureImageVerdicts(work: string, image: string): void {
  const dir = path.join(work, 'probe');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const families = [...creative.ADMITTED_FONT_FAMILIES, PROBE_SENTINEL];
  families.forEach((f, i) => fs.writeFileSync(path.join(dir, `p${i}.svg`), probeSvgFor(f)));
  const scripts = path.dirname(fileURLToPath(import.meta.url));
  const r = spawnSync('docker', ['run', '--rm', '-v', `${work}:/work`, '-v', `${scripts}:/gate:ro`, image, '/bin/sh', '/gate/probe_fonts.sh'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`font probe in ${image} failed: ${r.stderr}`);
  const hashes = new Map<string, string>();
  for (const line of r.stdout.trim().split('\n')) {
    const [hash, file] = line.trim().split(/\s+/);
    hashes.set(file, hash);
  }
  const sentinel = hashes.get(`p${families.length - 1}.png`);
  imageVerdicts = {};
  families.slice(0, -1).forEach((f, i) => (imageVerdicts[f] = hashes.get(`p${i}.png`) === sentinel ? 'stand-in' : 'exact'));
  fs.writeFileSync(path.join(work, 'image-font-verdicts.json'), JSON.stringify(imageVerdicts, null, 2));
  console.log(`font verdicts in ${image}: ${JSON.stringify(imageVerdicts)}`);
}

/** renderTextElementToSvg's choice of family, with the image's verdicts in place of the host's. */
function imageDrawFamily(t: TextElement): string {
  if ((imageVerdicts[t.fontFamily] ?? 'exact') === 'exact') return t.fontFamily;
  const fallback = t.rtl || creative.ARABIC_SCRIPT_FAMILIES.has(t.fontFamily) ? 'Noto Sans Arabic' : 'Verdana';
  return imageVerdicts[fallback] === 'exact' ? fallback : t.fontFamily;
}

/** The SVG with each text element's font-family set to what the production image would draw. */
function withImageFamilies(svg: string, layout: StudioLayoutV2): string {
  const queue = new Map<number, TextElement[]>();
  for (const t of layout.text) queue.set(t.copyIndex, [...(queue.get(t.copyIndex) ?? []), t]);
  return svg.replace(/<text id="text-copy-(\d+)"([^>]*?) font-family="([^"]*)"/g, (whole, idx: string, before: string) => {
    const t = queue.get(Number(idx))?.shift();
    if (!t) return whole;
    return `<text id="text-copy-${idx}"${before} font-family="${creative.escapeXml(imageDrawFamily(t))}"`;
  });
}

function renderSvg(layout: StudioLayoutV2, options: Parameters<typeof creative.renderLayoutV2ToSvg>[1]): string {
  return withImageFamilies(creative.renderLayoutV2ToSvg(layout, options).svg, layout);
}

function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
}

function writeCase(id: string, cls: string, svg: string, width: number, height: number, files: Record<string, Buffer> = {}, note?: string): string {
  const dir = slug(id);
  const abs = path.join(casesDir, dir);
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(path.join(abs, 'design.svg'), svg);
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(abs, name), bytes);
  jobs.push({ id: dir, cls, dir, svg: 'design.svg', width, height, kind: 'canvas', renderers: ['rsvg', 'resvg'], note });
  return dir;
}

function decodeXml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Each line of each <text> in the SVG as its own document: the text element's attributes and that
 * line's tspans only, in a band of the canvas around the line. Rendering a line alone gives its ink
 * box without neighbours, and a column profile that shows a change of word order.
 */
function lineJobs(parentId: string, svg: string, width: number, controls: boolean): void {
  const texts = [...svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)];
  let k = 0;
  for (const [, attrs, body] of texts) {
    const size = Number(/font-size="([\d.]+)px"/.exec(attrs)?.[1] ?? '16');
    const tspans = [...body.matchAll(/<tspan\b([^>]*)>([\s\S]*?)<\/tspan>/g)];
    const lines: Array<{ y: number; parts: string[]; text: string }> = [];
    for (const [whole, tAttrs, content] of tspans) {
      const y = /\by="([\d.-]+)"/.exec(tAttrs);
      if (/\bx="/.test(tAttrs) || !lines.length) lines.push({ y: Number(y?.[1] ?? 0), parts: [], text: '' });
      const line = lines[lines.length - 1];
      line.parts.push(whole);
      line.text += decodeXml(content);
    }
    for (const line of lines) {
      if (!line.text.replace(/[\u202A-\u202E\s]/g, '')) continue;
      const top = Math.floor(line.y - 2.0 * size);
      const height = Math.ceil(3.1 * size);
      const doc = (parts: string[]) =>
        `<?xml version="1.0" encoding="UTF-8"?>\n<svg width="${width}" height="${height}" viewBox="0 ${top} ${width} ${height}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><text${attrs}>${parts.join('')}</text></svg>`;
      const file = `line-${String(k).padStart(2, '0')}.svg`;
      fs.writeFileSync(path.join(casesDir, parentId, file), doc(line.parts));
      const script = ARABIC.test(line.text) ? 'arabic' : 'latin';
      const id = `${parentId}~${file.replace('.svg', '')}`;
      jobs.push({ id, cls: 'line', dir: parentId, svg: file, width, height, kind: 'line', renderers: ['rsvg', 'resvg'], parent: parentId, script, text: line.text });
      // The control: the same line with its words in reverse order, drawn by rsvg only. The detector
      // must tell it from the original, or a clean word-order result means nothing.
      if (controls && script === 'arabic' && line.parts.length === 1) {
        const m = /^(<tspan\b[^>]*>)\u202B([\s\S]*)\u202C(<\/tspan>)$/.exec(line.parts[0]);
        const words = m ? m[2].split(' ') : [];
        if (m && words.length >= 3) {
          const cfile = file.replace('line-', 'control-');
          fs.writeFileSync(path.join(casesDir, parentId, cfile), doc([`${m[1]}\u202B${[...words].reverse().join(' ')}\u202C${m[3]}`]));
          jobs.push({ id: `${parentId}~${cfile.replace('.svg', '')}`, cls: 'control', dir: parentId, svg: cfile, width, height, kind: 'line', renderers: ['rsvg'], parent: parentId, script, text: line.text, controlOf: id });
        }
      }
      k++;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Stored designs in every production mode

function rawDesigns(corpus: string, want: number): Array<{ id: string; layout: StudioLayoutV2; blocks: string[] }> {
  const fixtures = path.join(ROOT, 'packages/creative/test/fixtures');
  const out: Array<{ id: string; layout: StudioLayoutV2; blocks: string[] }> = [];
  const ref = JSON.parse(fs.readFileSync(path.join(fixtures, 'reference-k12-89c242f2.json'), 'utf8'));
  (ref.layouts as StudioLayoutV2[]).forEach((layout, i) => {
    for (const lang of ['ckb', 'en'] as const) out.push({ id: `fixture-reference-${lang}-${i}`, layout, blocks: ref.copy[lang] });
  });
  for (const name of ['cheap-tier-dead-band-8fb76534.json', 'cheap-tier-overflow-1f392e16.json', 'cheap-tier-stroke-slab-brief_08.json']) {
    const f = JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
    out.push({ id: `fixture-${name.replace('.json', '')}`, layout: f.layout, blocks: f.copy });
  }
  // Round-robin over the stored runs, so a sample smaller than the corpus still has every run in it.
  const runs = fs
    .readdirSync(corpus)
    .filter((r) => r.startsWith('2026-09-18-') && fs.existsSync(path.join(corpus, r, 'briefs')))
    .sort()
    .map((r) => ({
      run: r,
      briefs: fs
        .readdirSync(path.join(corpus, r, 'briefs'))
        .sort()
        .filter((b) => fs.existsSync(path.join(corpus, r, 'briefs', b, 'layout.json')) && fs.existsSync(path.join(corpus, r, 'briefs', b, 'brief.json'))),
    }));
  for (let i = 0; out.length < want && runs.some((r) => i < r.briefs.length); i++) {
    for (const { run, briefs } of runs) {
      if (out.length >= want || i >= briefs.length) continue;
      const dir = path.join(corpus, run, 'briefs', briefs[i]);
      const brief = JSON.parse(fs.readFileSync(path.join(dir, 'brief.json'), 'utf8'));
      const blocks: string[] = [];
      for (const b of brief.copyBlocks) blocks[b.copyIndex] = b.text;
      out.push({ id: `${run.replace('2026-09-18-', '')}-${briefs[i]}`, layout: JSON.parse(fs.readFileSync(path.join(dir, 'layout.json'), 'utf8')), blocks });
    }
  }
  return out.slice(0, want);
}

async function storedCases(corpus: string, want: number): Promise<void> {
  // @ts-ignore -- a plain .mjs proof script with no type declarations
  const gate = await import('../../../../scripts/proofs/reprepare_stored_runs.mjs');
  const reference = creative.studioReferenceFromRaw(JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/creative/assets/kaae-reference.json'), 'utf8')));
  const logoPng = fs.readFileSync(path.join(ROOT, 'packages/creative/assets/logos/kaae-official-logo.png'));
  const logoAspect = logoPng.readUInt32BE(16) / (logoPng.readUInt32BE(20) || 1);
  const modes = gate.productionModes(creative) as Array<{ name: string; options: Record<string, unknown> }>;
  const exemplar = fs.readFileSync(path.join(ROOT, 'packages/creative/assets/exemplars/KAAE_Standards_Higher_Ed_1080x1350.png'));
  const artCache = new Map<string, string>();
  const raws = rawDesigns(corpus, want);
  console.log(`stored: ${raws.length} raw designs x ${modes.length} modes (${modes.map((m) => m.name).join(', ')})`);
  for (const raw of raws) {
    const text: Record<number, string> = {};
    const scripts: Record<number, 'arabic' | 'latin'> = {};
    raw.blocks.forEach((t, i) => {
      text[i] = t;
      scripts[i] = ARABIC.test(t) ? 'arabic' : 'latin';
    });
    for (const mode of modes) {
      const layout = creative.prepareGeneratedLayoutV3(JSON.parse(JSON.stringify(raw.layout)), { text, scripts }, {
        width: raw.layout.width,
        height: raw.layout.height,
        logoAspect,
        palette: reference.palette,
        ...mode.options,
      } as Parameters<typeof creative.prepareGeneratedLayoutV3>[2]);
      // The art production would have: the procedural motif drawn at full strength (art.stage.ts),
      // or, for generated art, whose pixels no stored run kept, an exemplar poster standing in.
      let artImagePath: string | undefined;
      if (layout.art) {
        const motif = layout.art.motif;
        const key = layout.art.source === 'generated' || !motif ? `exemplar` : `${motif}|${layout.width}x${layout.height}`;
        if (!artCache.has(key)) {
          const png = key === 'exemplar' ? exemplar : creative.renderMotifPng(motif!, { width: layout.width, height: layout.height, palette: reference.palette, opacity: 1 });
          artCache.set(key, `data:image/png;base64,${png.toString('base64')}`);
        }
        artImagePath = artCache.get(key);
      }
      const svg = renderSvg(layout, { copyText: text, artImagePath });
      const id = writeCase(`stored-${raw.id}@${mode.name}`, 'stored', svg, layout.width, layout.height, {}, `mode ${mode.name}${layout.art ? `, art ${layout.art.source}/${layout.art.motif ?? '-'}` : ''}`);
      lineJobs(id, svg, layout.width, false);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Photos

/** An APP1 Exif block holding only an Orientation tag, inserted after the JPEG's SOI marker. */
function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.from([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF header, IFD0 at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation, SHORT, 1
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('not a JPEG');
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

/** photo-upright.ts's matrix per orientation (not exported there; the same eight cases). */
function orientationMatrix(orientation: number, w: number, h: number): string | undefined {
  switch (orientation) {
    case 2: return `matrix(-1,0,0,1,${w},0)`;
    case 3: return `matrix(-1,0,0,-1,${w},${h})`;
    case 4: return `matrix(1,0,0,-1,0,${h})`;
    case 5: return `matrix(0,1,1,0,0,0)`;
    case 6: return `matrix(0,1,-1,0,${h},0)`;
    case 7: return `matrix(0,-1,-1,0,${h},${w})`;
    case 8: return `matrix(0,-1,1,0,0,${w})`;
    default: return undefined;
  }
}

function photoLayout(photos: PhotoElement[], width = 1080, height = 1080): StudioLayoutV2 {
  return {
    version: 2,
    width,
    height,
    grid: { margin: 72, columns: 6, gutter: 24, baseline: 8 },
    background: { color: '#0A1628' },
    shapes: [],
    text: [],
    photos,
  } as unknown as StudioLayoutV2;
}

function photoCases(photosDir: string): void {
  const box = { x: 140, y: 190, width: 800, height: 700 };
  const formats = fs
    .readdirSync(photosDir)
    .filter((f) => /^(jpeg|png|webp|gif)-/.test(f))
    .sort();
  const treatments: Array<{ name: string; photo: Partial<PhotoElement> }> = [
    { name: 'framed', photo: { radius: 24 } },
    { name: 'arch-fade-duotone', photo: { mask: 'arch', fade: { edge: 'bottom', length: 0.4 }, filter: { kind: 'duotone', dark: '#0A1628', light: '#F7B500' } } },
  ];
  const allTreatments: Array<{ name: string; photo: Partial<PhotoElement> }> = [
    { name: 'circle', photo: { mask: 'circle' } },
    { name: 'arch', photo: { mask: 'arch' } },
    { name: 'fade-top', photo: { fade: { edge: 'top', length: 0.3 } } },
    { name: 'fade-bottom', photo: { fade: { edge: 'bottom', length: 0.5 } } },
    { name: 'fade-left', photo: { fade: { edge: 'left', length: 0.25 } } },
    { name: 'fade-right', photo: { fade: { edge: 'right', length: 1 } } },
    { name: 'bw', photo: { filter: { kind: 'bw' } } },
    { name: 'tint', photo: { filter: { kind: 'tint', color: '#4770A3', strength: 0.45 } } },
    { name: 'focus-zoom', photo: { focus: { x: 0.2, y: 0.25 }, zoom: 2 } },
    { name: 'circle-fade-bw', photo: { mask: 'circle', fade: { edge: 'right', length: 0.4 }, filter: { kind: 'bw' } } },
  ];
  for (const f of formats) {
    const bytes = fs.readFileSync(path.join(photosDir, f));
    const href = imageDataUri(bytes, f);
    const list = f === 'jpeg-baseline.jpg' ? [...treatments, ...allTreatments] : treatments;
    for (const t of list) {
      const photo = { photoIndex: 0, role: 'hero', ...box, ...t.photo } as PhotoElement;
      const svg = renderSvg(photoLayout([photo]), { photoDataUris: [href] });
      writeCase(`photo-${f.replace('.', '_')}-${t.name}`, 'photo', svg, 1080, 1080);
      // The deck bakes a treated framed photo alone at its bake scale (photo-treatments.ts).
      if (creative.framedPhotoTreated(photo) && f === 'jpeg-baseline.jpg') {
        const fragment = creative.framedPhotoFragment(photo, href, creative.dataUriPixelSize(href));
        const size = creative.photoBakePixelSize(fragment);
        writeCase(`bake-photo-${t.name}-x${creative.photoBakeScale(fragment)}`, 'bake', creative.photoFragmentDocument(fragment, size), size.width, size.height);
      }
    }
  }

  for (let o = 1; o <= 8; o++) {
    const tagged = withExifOrientation(fs.readFileSync(path.join(photosDir, `exif-${o}-pixels.jpg`)), o);
    if (creative.jpegOrientation(tagged) !== o) throw new Error(`EXIF ${o} did not read back`);
    fs.writeFileSync(path.join(photosDir, `exif-${o}.jpg`), tagged);
    // Drawn as it is: what each renderer does with the tag.
    const photo = { photoIndex: 0, role: 'hero', ...box } as PhotoElement;
    const svg = renderSvg(photoLayout([photo]), { photoDataUris: [imageDataUri(tagged, 'exif')] });
    writeCase(`exif-raw-${o}`, 'exif-raw', svg, 1080, 1080, {}, 'the renderer is handed the tagged JPEG directly');
    // The product path: photo-upright.ts's own SVG, the file beside it.
    const size = creative.imagePixelSize(tagged)!;
    const turned = o >= 5;
    const w = turned ? size.height : size.width;
    const h = turned ? size.width : size.height;
    const matrix = orientationMatrix(o, size.width, size.height);
    const upright =
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<image xlink:href="photo.jpg" x="0" y="0" width="${size.width}" height="${size.height}" preserveAspectRatio="none"${matrix ? ` transform="${matrix}"` : ''}/>` +
      `</svg>`;
    writeCase(`exif-upright-${o}`, 'exif-upright', upright, w, h, { 'photo.jpg': tagged }, 'photo-upright.ts turns the pixels itself; the renderer must ignore the tag');
  }

  // A 12 MP photo: as a data URI (the JPEG fits, the PNG passes rsvg's 10 MB attribute limit), and
  // as a file beside the SVG, which is how ADR-035 has the renderer read photos.
  const bigJpeg = fs.readFileSync(path.join(photosDir, 'large-12mp.jpg'));
  const bigPng = fs.readFileSync(path.join(photosDir, 'large-12mp.png'));
  const photo = { photoIndex: 0, role: 'hero', ...box } as PhotoElement;
  writeCase('stress-12mp-jpeg-datauri', 'stress', renderSvg(photoLayout([photo]), { photoDataUris: [imageDataUri(bigJpeg)] }), 1080, 1080);
  writeCase('stress-12mp-png-datauri', 'stress', renderSvg(photoLayout([photo]), { photoDataUris: [imageDataUri(bigPng)] }), 1080, 1080, {}, 'a 22.7 MB attribute; rsvg refuses attributes over 10,000,000 bytes');
  const fileSvg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1080" height="1080" viewBox="0 0 1080 1080">` +
    `<rect width="1080" height="1080" fill="#0A1628"/><image xlink:href="photo.png" x="140" y="190" width="800" height="700" preserveAspectRatio="xMidYMid slice"/></svg>`;
  writeCase('stress-12mp-png-file', 'stress', fileSvg, 1080, 1080, { 'photo.png': bigPng });
}

// ---------------------------------------------------------------------------------------------
// Cut-outs

function cutoutCases(photosDir: string): void {
  const png = fs.readFileSync(path.join(photosDir, 'person.png'));
  const shadowPng = fs.readFileSync(path.join(photosDir, 'person-shadow.png'));
  const asset: PhotoCutoutAsset = { png, width: 1200, height: 1800, shadowPng, shadowWidth: 1400, shadowHeight: 320, shadowX: -100, shadowY: 1600 };
  const canvas = { width: 1080, height: 1350 };
  const person = (over: Partial<PhotoElement>, index = 0): PhotoElement =>
    ({ photoIndex: index, role: 'portrait', x: 290, y: 400, width: 500, height: 900, treatment: 'cutout', ...over }) as PhotoElement;
  const variants: Array<{ name: string; photos: PhotoElement[] }> = [];
  for (const w of [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24]) variants.push({ name: `outline-${w}`, photos: [person({ outline: { color: '#F7B500', width: w } })] });
  for (const r of [2, 8, 16, 30, 60]) variants.push({ name: `glow-${r}`, photos: [person({ glow: { color: '#4770A3', radius: r } })] });
  variants.push({ name: 'outline-12-glow-30', photos: [person({ outline: { color: '#FFFFFF', width: 12 }, glow: { color: '#F7B500', radius: 30 } })] });
  variants.push({ name: 'outline-24-glow-60', photos: [person({ outline: { color: '#FFFFFF', width: 24 }, glow: { color: '#F7B500', radius: 60 } })] });
  variants.push({ name: 'fade-outline-8', photos: [person({ fade: { edge: 'bottom', length: 0.4 }, outline: { color: '#F7B500', width: 8 } })] });
  variants.push({ name: 'duotone-outline-6', photos: [person({ filter: { kind: 'duotone', dark: '#0A1628', light: '#FDF8F3' }, outline: { color: '#F7B500', width: 6 } })] });
  variants.push({ name: 'plain-shadow', photos: [person({})] });
  variants.push({
    name: 'overlap-two',
    photos: [
      person({ x: 110, width: 460, outline: { color: '#F7B500', width: 8 } }, 0),
      person({ x: 420, width: 460, outline: { color: '#FFFFFF', width: 8 }, glow: { color: '#4770A3', radius: 16 } }, 1),
    ],
  });
  variants.push({ name: 'offcanvas-left', photos: [person({ x: -220, outline: { color: '#F7B500', width: 16 } })] });
  variants.push({ name: 'offcanvas-top', photos: [person({ y: -200, height: 1000, outline: { color: '#F7B500', width: 16 }, glow: { color: '#4770A3', radius: 30 } })] });
  variants.push({ name: 'offcanvas-right', photos: [person({ x: 760, outline: { color: '#F7B500', width: 24 } })] });

  for (const v of variants) {
    const layout = photoLayout(v.photos, canvas.width, canvas.height);
    const cutouts = v.photos.map(() => asset);
    const svg = renderSvg(layout, { photoCutouts: cutouts });
    writeCase(`cutout-${v.name}`, 'cutout', svg, canvas.width, canvas.height);
    // The deck's bake of each effect and treated person: the fragment alone at its bake scale.
    for (const layer of creative.photoLayers(v.photos, cutouts)) {
      let fragment;
      if (layer.kind === 'cutout-glow' || layer.kind === 'cutout-outline') {
        fragment = creative.cutoutEffectFragment(layer.kind === 'cutout-glow' ? 'glow' : 'outline', layer.photo, layer.png, layer.rect, canvas);
      } else if (layer.kind === 'cutout-person' && creative.cutoutPersonTreated(layer.photo)) {
        fragment = creative.cutoutPersonFragment(layer.photo, layer.png, layer.rect);
      }
      if (!fragment) continue;
      const size = creative.photoBakePixelSize(fragment);
      writeCase(`bake-${v.name}-${layer.kind}-${layer.photo.photoIndex}-x${creative.photoBakeScale(fragment)}`, 'bake', creative.photoFragmentDocument(fragment, size), size.width, size.height);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Text matrices

const SORANI = {
  title: 'دەستەی متمانەپێدانی کوردستان بۆ پەروەردە',
  latinMix: 'کۆنفرانسی نێودەوڵەتی Quality Assurance لە هەولێر',
  westernDigits: 'ساڵی 2026 و 15 زانکۆ و 3 کۆلێژ',
  indicDigits: 'ڕێکەوتی ٢٠٢٦/٩/٢٤ کاتژمێر ١٠:٣٠',
  punctuation: '«پێوەرەکانی کوالیتی»، ڕێنمایی (نوێ)؛ ئایا ئامادەن؟ - ٢٠٢٦!',
  contact: 'بۆ زانیاری: kaae.gov.krd یان +964 750 123 4567',
  paragraph:
    'هەموو زانکۆکان دەبێت ڕاپۆرتی متمانەپێدانی وردبینیکراو بڵاو بکەنەوە پێش کۆتایی چارەگی سێیەم، بەپێی یاسای ژمارە ٦ی ساڵی ٢٠٢٦ و ڕێنماییەکانی دەستە.',
};

const LATIN = {
  title: 'Mandatory Quality Standards 2026',
  footer: 'Erbil • September 2026 • kaae.gov.krd',
  digits: 'Deadline: 30/09/2026 — 10:30 AM (GMT+3)',
  punctuation: '“Excellence” & ‘Integrity’: 100% compliance!',
  kurdishInside: 'KAAE — دەستەی متمانەپێدان — 2026',
  paragraph: 'All universities must publish audited accreditation reports by the end of Q3, as Law No. 6 of 2026 requires of every accredited programme.',
};

function textMatrixLayout(blocks: Array<{ size: number; rtl: boolean; height: number }>, family: string, bold: boolean, italic: boolean, align: TextElement['align']): StudioLayoutV2 {
  let y = 90;
  const text = blocks.map((b, i) => {
    const t = { copyIndex: i, role: i === 0 ? 'title' : 'body', x: 100, y, width: 880, height: b.height, fontSize: b.size, lineHeight: 1.45, fontFamily: family, color: '#FFFFFF', align, bold, italic, rtl: b.rtl } as TextElement;
    y += b.height + 24;
    return t;
  });
  return {
    version: 2,
    width: 1080,
    height: 1350,
    grid: { margin: 72, columns: 6, gutter: 24, baseline: 8 },
    background: { color: '#0A1628' },
    shapes: [],
    text,
  } as unknown as StudioLayoutV2;
}

function textMatrixCases(): void {
  const arabicFaces: Array<[string, boolean]> = [
    ['Noto Sans Arabic', false],
    ['Noto Sans Arabic', true],
    ['IBM Plex Sans Arabic', false],
    ['IBM Plex Sans Arabic', true],
    ['Amiri', false],
    ['Amiri', true],
    ['Cairo', false],
  ];
  const latinFaces: Array<[string, boolean, boolean]> = [
    ['Verdana', false, false],
    ['Verdana', true, false],
    ['Verdana', false, true],
    ['Verdana', true, true],
    ['Cinzel', false, false],
    ['Cinzel', true, false],
    ['Playfair Display', true, false],
    ['Playfair Display', false, true],
  ];
  const aligns: Array<TextElement['align']> = ['right', 'center', 'left'];
  const soraniCopy = Object.values(SORANI);
  const soraniBlocks = soraniCopy.map((_, i) => ({ size: i === 0 ? 56 : 34, rtl: true, height: i === 0 ? 170 : i === soraniCopy.length - 1 ? 200 : 60 }));
  for (const [family, bold] of arabicFaces) {
    for (const align of aligns) {
      const layout = textMatrixLayout(soraniBlocks, family, bold, false, align);
      const copyText: Record<number, string> = {};
      soraniCopy.forEach((t, i) => (copyText[i] = t));
      const svg = renderSvg(layout, { copyText });
      const id = writeCase(`kurdish-${family}-${bold ? 'bold' : 'regular'}-${align}`, 'kurdish', svg, 1080, 1350);
      lineJobs(id, svg, 1080, true);
    }
  }
  const latinCopy = Object.values(LATIN);
  const latinBlocks = latinCopy.map((t, i) => ({ size: i === 0 ? 52 : 30, rtl: false, height: i === 0 ? 160 : i === latinCopy.length - 1 ? 170 : 56 }));
  for (const [family, bold, italic] of latinFaces) {
    for (const align of aligns) {
      const layout = textMatrixLayout(latinBlocks, family, bold, italic, align);
      const copyText: Record<number, string> = {};
      latinCopy.forEach((t, i) => (copyText[i] = t));
      const svg = renderSvg(layout, { copyText });
      const id = writeCase(`latin-${family}-${bold ? 'bold' : 'regular'}${italic ? '-italic' : ''}-${align}`, 'latin', svg, 1080, 1350);
      lineJobs(id, svg, 1080, false);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Logo pre-scale and motifs

function logoAndMotifCases(): void {
  const logo = fs.readFileSync(path.join(ROOT, 'packages/creative/assets/logos/kaae-official-logo.png'));
  for (const side of [80, 100, 120, 130, 160, 200]) {
    // render-layout-v2.ts logoPrescaleJob: the logo fitted into its box, drawn at the box's size.
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${side}" height="${side}" viewBox="0 0 ${side} ${side}">` +
      `<image xlink:href="logo.png" x="0" y="0" width="${side}" height="${side}" preserveAspectRatio="xMidYMid meet"/>` +
      `</svg>`;
    writeCase(`logo-prescale-${side}`, 'logo', svg, side, side, { 'logo.png': logo });
  }
  const reference = creative.studioReferenceFromRaw(JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/creative/assets/kaae-reference.json'), 'utf8')));
  for (const motif of ['guilloche', 'sun-rays', 'thin-rules', 'gradient-wash', 'diagonal-lines'] as const) {
    const svg = creative.generateMotifSvg(motif, { width: 1080, height: 1350, palette: reference.palette, opacity: 1 });
    writeCase(`motif-${motif}`, 'motif', svg, 1080, 1350);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  casesDir = path.join(args.work, 'cases');
  fs.rmSync(casesDir, { recursive: true, force: true });
  fs.mkdirSync(casesDir, { recursive: true });
  const photosDir = path.join(args.work, 'photos');
  if (!fs.existsSync(path.join(photosDir, 'base.png'))) throw new Error(`run make_photos.sh into ${photosDir} first`);
  measureImageVerdicts(args.work, args.image);

  await storedCases(args.corpus, args.designs);
  photoCases(photosDir);
  cutoutCases(photosDir);
  textMatrixCases();
  logoAndMotifCases();

  fs.writeFileSync(path.join(args.work, 'jobs.json'), JSON.stringify(jobs, null, 1));
  const byClass: Record<string, number> = {};
  for (const j of jobs) byClass[j.cls] = (byClass[j.cls] ?? 0) + 1;
  console.log(JSON.stringify({ jobs: jobs.length, byClass }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
