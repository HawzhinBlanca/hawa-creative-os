/**
 * ADR-275 proof: poster display titles in heavy sans capitals, rendered locally. No model, no Canva,
 * no network. Writes PNGs, the Canva fixture deck and a JSON report into <outDir>.
 *
 *   pnpm tsx scripts/proofs/display_caps_proof.ts <outDir>
 *
 * For each layout it reports what the renderer drew each face with (fontFidelity, the weighted ink
 * check), how close the ink of adjacent title lines comes (measureLineInkClearance), the validator's
 * verdict, and, for the deck, the Canva copy check with and without the capitals policy. Host
 * renders are not authoritative for typography (memory: font-rendering traps); re-run inside the
 * core image before judging the type.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  encodeStudioTransferV2,
  measureLineInkClearance,
  pageGrammarFromRaw,
  posterDisplayStyle,
  posterLabelStyle,
  renderLayoutV2,
  validateLayoutV2,
  withPosterDisplayStyle,
  measureTextGeometry,
  type StudioLayoutV2,
  type TextElement,
} from '../../packages/creative/src/index.js';
import { checkCanvaPptx } from '../../packages/qa/src/canva-pptx-check.js';

// fflate is a dependency of the creative package, not of the repository root.
const { strFromU8, strToU8, unzipSync, zipSync } = createRequire(new URL('../../packages/creative/package.json', import.meta.url))('fflate') as {
  strFromU8(data: Uint8Array): string;
  strToU8(text: string): Uint8Array;
  unzipSync(data: Uint8Array): Record<string, Uint8Array>;
  zipSync(files: Record<string, Uint8Array>): Uint8Array;
};
const outDir = path.resolve(process.argv[2] || 'output/display-caps-proof');
fs.mkdirSync(outDir, { recursive: true });
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const raw = JSON.parse(fs.readFileSync(path.join(root, 'packages/creative/assets/kaae-reference.json'), 'utf8'));
const grammar = pageGrammarFromRaw(raw)!;
const logo = fs.readFileSync(path.join(root, 'packages/creative/assets/logos/kaae-official-logo.png'));
const logoDataUri = `data:image/png;base64,${logo.toString('base64')}`;
const W = 1080, H = 1350, M = 65;

const latin = posterDisplayStyle(grammar, 'latin')!;
const arabic = posterDisplayStyle(grammar, 'arabic')!;
const label = posterLabelStyle(grammar)!;

const base = (text: TextElement[], background = '#FDF8F3'): StudioLayoutV2 => ({
  version: 2, width: W, height: H, grid: { margin: M, columns: 12, gutter: 24, baseline: 8 },
  background: { color: background }, shapes: [], text, logo: { x: M, y: M, width: 173, height: 173 },
});
const block = (copyIndex: number, role: TextElement['role'], y: number, height: number, fontSize: number, extra: Partial<TextElement> = {}): TextElement => ({
  copyIndex, role, x: M, y, width: W - 2 * M, height, fontSize, lineHeight: 1.4, fontFamily: 'Inter', color: '#1E3A5F', align: 'left', ...extra,
});

/** The largest size in [lo, hi] (px) at which the block's copy fits its width in at most `maxLines`. */
function fitSize(t: TextElement, copy: string, lo: number, hi: number, maxLines: number): number {
  for (let size = hi; size >= lo; size -= 2) {
    const m = measureTextGeometry({ ...base([{ ...t, fontSize: size, height: 100000 }]) }, { [t.copyIndex]: copy })[0];
    if (m.status === 'measured' && m.lineCount <= maxLines && m.maxLineWidthPx <= t.width) return size;
  }
  return lo;
}

interface Case { id: string; copy: string[]; scripts: Array<'latin' | 'arabic'>; layout: StudioLayoutV2 }
const cases: Case[] = [];

{
  const copy = ['K-12 | Higher Education', 'Peer Review Week', 'Join KAAE’s network of peer evaluators.'];
  const titleBase = withPosterDisplayStyle(block(1, 'title', 400, 700, 200, { color: '#1E3A5F', accentColor: '#4770A3', accentText: 'Peer' }), latin, W);
  const size = fitSize(titleBase, copy[1], Math.round(0.18 * W), Math.round(0.2 * W), 3);
  const title = { ...titleBase, fontSize: size, height: Math.ceil(3 * size * latin.lineHeight) + 40 };
  const eyebrow = { ...block(0, 'eyebrow', 340, 40, 30, { fontWeight: 700 as const, bold: true, color: '#4770A3' }), ...label };
  const body = block(2, 'body', title.y + title.height + 40, 120, 40, { color: '#0A1628' });
  cases.push({ id: 'en_caps_title', copy, scripts: ['latin', 'latin', 'latin'], layout: base([eyebrow, title, body]) });
}
{
  const copy = ['بانگەواز بۆ هەڵسەنگێنەرانی هاوتا', 'ببە بە بەشداربوو لە تۆڕی هەڵسەنگێنەرانی هاوتای KAAE.'];
  const title = withPosterDisplayStyle(block(0, 'title', 360, 400, 112, { align: 'right', color: '#1E3A5F' }), arabic, W);
  const body = block(1, 'body', 820, 140, 40, { align: 'right', fontFamily: 'Noto Sans Arabic', rtl: true, lineHeight: 1.7, color: '#0A1628' });
  cases.push({ id: 'ckb_display_title', copy, scripts: ['arabic', 'arabic'], layout: base([title, body]) });
}
{
  // Negative: the same Sorani title at a leading the ink check must refuse.
  const copy = ['بانگەواز بۆ هەڵسەنگێنەرانی هاوتا', 'ببە بە بەشداربوو لە تۆڕی هەڵسەنگێنەرانی هاوتای KAAE.'];
  const title = { ...withPosterDisplayStyle(block(0, 'title', 360, 400, 112, { align: 'right', color: '#1E3A5F' }), arabic, W), lineHeight: 1.0 };
  const body = block(1, 'body', 820, 140, 40, { align: 'right', fontFamily: 'Noto Sans Arabic', rtl: true, lineHeight: 1.7, color: '#0A1628' });
  cases.push({ id: 'ckb_display_title_too_tight', copy, scripts: ['arabic', 'arabic'], layout: base([title, body]) });
}

const report: Record<string, unknown> = {};
for (const c of cases) {
  const copyText = Object.fromEntries(c.copy.map((t, i) => [i, t]));
  const render = renderLayoutV2(c.layout, { copyText, logoDataUri });
  fs.writeFileSync(path.join(outDir, `${c.id}.png`), render.png);
  const validation = validateLayoutV2(c.layout, {
    expectedWidth: W, expectedHeight: H, copyCount: c.copy.length, copyScripts: c.scripts,
    reference: { rules: { fontFamily: 'Inter', palette: raw.rules.palette, scriptFonts: { arabic: 'Noto Sans Arabic' },
      admittedDisplayFonts: { latin: ['Crimson Pro', 'Inter'], arabic: ['Noto Sans Arabic', 'IBM Plex Sans Arabic'] } },
    logoAspect: 1, logoMinimumWidthPx: 80, logoClearSpaceShareOfHeight: 0.15 },
    copyText,
  });
  const titleEl = c.layout.text.find((t) => t.role === 'title')!;
  const entry: Record<string, unknown> = {
    png: path.join(outDir, `${c.id}.png`),
    title: { fontFamily: titleEl.fontFamily, fontWeight: titleEl.fontWeight, fontSize: titleEl.fontSize, shareOfWidth: +(titleEl.fontSize / W).toFixed(3),
      lineHeight: titleEl.lineHeight, letterSpacing: titleEl.letterSpacing, textTransform: titleEl.textTransform ?? null, lines: render.wrappedLines[titleEl.copyIndex] },
    fontFidelity: render.fontFidelity,
    titleInk: measureLineInkClearance(titleEl, c.copy[titleEl.copyIndex]),
    validation: validation.ok ? 'ok' : `${validation.code}: ${validation.message}`,
  };
  if (c.id === 'en_caps_title') {
    const deck = await encodeStudioTransferV2(structuredClone(c.layout), c.copy, { bytes: logo, sha256: raw.logoSha256, mimeType: 'image/png' });
    const deckPath = path.join(outDir, 'canva_display_caps_fixture.pptx');
    fs.writeFileSync(deckPath, deck.bytes);
    const slide = strFromU8(unzipSync(new Uint8Array(deck.bytes))['ppt/slides/slide1.xml']);
    const fonts = c.layout.text.map((t) => t.fontFamily);
    entry.deck = {
      path: deckPath,
      sha256: deck.sha256,
      capsRuns: (slide.match(/cap="all"/g) || []).length,
      typefaces: [...new Set([...slide.matchAll(/<a:latin typeface="([^"]+)"/g)].map((m) => m[1]))],
      plan: deck.plan.text.map((t) => ({ copyIndex: t.copyIndex, fontWeight: t.fontWeight ?? null, fontFace: t.fontFace ?? null, textTransform: t.textTransform ?? null })),
      checkAsSent: checkCanvaPptx(deck.bytes, c.copy, { fontsByIndex: fonts, uppercaseByIndex: c.layout.text.map((t) => t.textTransform === 'uppercase') }).copyPass,
      // What Canva may hand back: the capitals written into the text, cap removed.
      checkBakedCapitals: checkCanvaPptx(Buffer.from(rewriteSlide(deck.bytes, bakeCapitals)), c.copy,
        { fontsByIndex: fonts, uppercaseByIndex: c.layout.text.map((t) => t.textTransform === 'uppercase') }).copyPass,
      // The same baked capitals checked without the policy: the exact check must refuse them.
      checkBakedCapitalsWithoutPolicy: checkCanvaPptx(Buffer.from(rewriteSlide(deck.bytes, bakeCapitals)), c.copy, { fontsByIndex: fonts }).copyPass,
      // A cap="all" run on a block the plan did not set in capitals must be refused too.
      checkCapsOnUntransformedBlock: checkCanvaPptx(deck.bytes, c.copy, { fontsByIndex: fonts }).copyPass,
    };
  }
  report[c.id] = entry;
}
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

/** What Canva may hand back for a capitals block: cap removed and the capitals written into the text. */
function bakeCapitals(xml: string): string {
  return xml.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, (sp) => !sp.includes('cap="all"') ? sp
    : sp.replace(/ cap="all"/g, '').replace(/<a:t>([^<]*)<\/a:t>/g, (_m, t: string) => `<a:t>${t.toUpperCase()}</a:t>`));
}

function rewriteSlide(bytes: Buffer, edit: (xml: string) => string): Uint8Array {
  const files = unzipSync(new Uint8Array(bytes));
  files['ppt/slides/slide1.xml'] = strToU8(edit(strFromU8(files['ppt/slides/slide1.xml'])));
  return zipSync(files);
}
