/**
 * ADR-290 calibration: the Sorani shaping check (checkTextShaping) on correct renders and on deliberately
 * broken ones, read exactly (the Studio render against its text-free render) and by colour (as a
 * provider's export is read), and on every real Canva export on record. No model, no Canva, no network.
 *
 *   pnpm tsx scripts/proofs/sorani_shaping_calibration.ts <outDir>
 *
 * Writes <outDir>/calibration.json: every case with its verdicts, lowest line score and time, and the
 * summary the ADR quotes. Host renders: the bundled faces are pinned (ADR-118), but re-run inside the
 * core image before treating a host-only failure as the product's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { decodePicture } from '../../packages/creative/src/studio/export-text-lines.js';
import { OFFICE_POSTS } from '../../packages/creative/test/fixtures/office-posts/office-posts.js';
import { syntheticPhoto } from '../../packages/creative/test/fixtures/synthetic-photos.js';
import { KAAE_TEST_LOGO } from '../../packages/creative/test/fixtures/kaae-render-options.js';
import { applyShapingControl, type ShapingControl } from '../../packages/creative/test/fixtures/shaping-controls.js';
import { renderLayoutV2, svgToPngAsync } from '../../packages/creative/src/studio/render-layout-v2.js';
import { checkTextShaping, textShapingBlocks, type TextShapingFidelity } from '../../packages/creative/src/studio/export-text-shaping.js';

const outDir = process.argv[2];
if (!outDir) throw new Error('usage: sorani_shaping_calibration.ts <outDir>');
fs.mkdirSync(outDir, { recursive: true });
const root = path.resolve(import.meta.dirname, '../..');
const CONTROLS: ShapingControl[] = ['unjoined', 'one-join-broken', 'reversed', 'substituted-face', 'rewrapped', 'missing-glyph'];
const lowest = (r: TextShapingFidelity, id?: string) => Math.min(1, ...r.blocks.filter((b) => !id || b.id === id).flatMap((b) => b.lines.map((l) => l.score)));
const summarise = (r: TextShapingFidelity) => r.blocks.map((b) => ({ id: b.id, verdict: b.verdict, designed: b.designedLines, found: b.foundLines,
  lines: b.lines.map((l) => ({ verdict: l.verdict, score: l.score, widthRatio: l.widthRatio, ...(l.detail ? { detail: l.detail } : {}) })) }));

const positives: unknown[] = [];
const negatives: Array<{ post: string; block: string; control: ShapingControl; exact: string; colour: string; exactScore: number; colourScore: number; ms: number }> = [];
for (const post of OFFICE_POSTS.filter((p) => p.language !== 'en')) {
  const copyText = Object.fromEntries(post.copy.map((c, i) => [i, c]));
  const photoFiles = (post.layout.photos ?? []).map((_, i) => ({ bytes: syntheticPhoto(600, 400, i + 3) }));
  const render = renderLayoutV2(post.layout, { copyText, logoDataUri: KAAE_TEST_LOGO, photoFiles });
  const blocks = textShapingBlocks(post.layout, copyText);
  const exact = checkTextShaping(render.png, blocks, { background: render.noTextPng });
  const colour = checkTextShaping(render.png, blocks);
  positives.push({ post: post.id, exact: { pass: exact.pass, ms: exact.ms, lowest: lowest(exact), blocks: summarise(exact) },
    colour: { pass: colour.pass, ms: colour.ms, lowest: lowest(colour), blocks: summarise(colour) } });
  for (const block of blocks) {
    const t = post.layout.text.find((x) => `text-copy-${x.copyIndex}` === block.id)!;
    for (const control of CONTROLS) {
      const svg = applyShapingControl(render.svg, block.id, block.rtl, control,
        { substitute: t.fontFamily === 'Noto Sans Arabic' ? 'Vazirmatn' : 'Noto Sans Arabic', pitchPx: t.lineHeight * block.fontSizePx });
      if (!svg) continue;
      const png = await svgToPngAsync(svg, post.layout.width, post.layout.height, {}, render.files);
      const e = checkTextShaping(png, blocks, { background: render.noTextPng });
      const c = checkTextShaping(png, blocks);
      const verdict = (r: TextShapingFidelity) => r.blocks.find((b) => b.id === block.id)?.verdict ?? 'unmeasured';
      negatives.push({ post: post.id, block: block.id, control, exact: verdict(e), colour: verdict(c),
        exactScore: lowest(e, block.id), colourScore: lowest(c, block.id), ms: Math.max(e.ms, c.ms) });
    }
  }
}

const sheets: Array<[string, Record<string, string>]> = [
  ['output/acceptance/2026-09-27-canva-multilingual', { 'group-1': 'group-1-round-2-canva.png', 'group-2': 'group-2-canva.png', 'group-3': 'group-3-canva.png', 'group-4': 'group-4-canva.png' }],
  ['output/acceptance/2026-09-27-canva-locale', { 'locale-v1': 'locale-v1-canva.png', 'locale-v2': 'locale-v2-canva.png' }],
  ['output/acceptance/2026-09-27-explicit-direction', { 'direction-v2': 'direction-v2-canva.png' }],
];
const canva: unknown[] = [];
for (const [dir, pngs] of sheets) {
  const fixtures = JSON.parse(fs.readFileSync(path.join(root, dir, 'fixtures.json'), 'utf8'));
  for (const group of fixtures.groups) {
    if (!pngs[group.id]) continue;
    const bytes = fs.readFileSync(path.join(root, dir, pngs[group.id]));
    const plan = group.manifest.plan;
    const blocks = textShapingBlocks(plan, Object.fromEntries(group.manifest.copy.map((c: string, i: number) => [i, c])), { scale: decodePicture(bytes).width / plan.width });
    const r = checkTextShaping(bytes, blocks);
    canva.push({ sheet: `${dir}/${pngs[group.id]}`, pass: r.pass, ms: r.ms, unmeasured: r.unmeasured,
      blocks: summarise(r).map((b) => ({ ...b, fontFamily: plan.text.find((t: { copyIndex: number }) => `text-copy-${t.copyIndex}` === b.id)?.fontFamily })) });
  }
}

const tally = (key: 'exact' | 'colour') => Object.fromEntries(CONTROLS.map((c) => {
  const rows = negatives.filter((n) => n.control === c);
  return [c, { cases: rows.length, detected: rows.filter((n) => n[key] !== 'ok').length,
    verdicts: rows.reduce<Record<string, number>>((m, n) => ({ ...m, [n[key]]: (m[n[key]] ?? 0) + 1 }), {}),
    highestScore: Math.max(...rows.map((n) => key === 'exact' ? n.exactScore : n.colourScore)) }];
}));
const pos = positives as Array<{ exact: { pass: boolean; ms: number; lowest: number; blocks: unknown[] }; colour: { pass: boolean; ms: number; lowest: number } }>;
const sheetsOut = canva as Array<{ ms: number; blocks: Array<{ verdict: string; fontFamily?: string; lines: unknown[] }>; unmeasured: unknown[] }>;
const summary = {
  correctRenders: { posts: pos.length, blocks: pos.reduce((n, p) => n + p.exact.blocks.length, 0),
    exactFailures: pos.filter((p) => !p.exact.pass).length, colourFailures: pos.filter((p) => !p.colour.pass).length,
    exactLowest: Math.min(...pos.map((p) => p.exact.lowest)), colourLowest: Math.min(...pos.map((p) => p.colour.lowest)),
    exactMaxMs: Math.max(...pos.map((p) => p.exact.ms)), colourMaxMs: Math.max(...pos.map((p) => p.colour.ms)) },
  negativeControls: { exact: tally('exact'), colour: tally('colour'), maxMs: Math.max(...negatives.map((n) => n.ms)) },
  canvaExports: { sheets: sheetsOut.length, blocks: sheetsOut.reduce((n, s) => n + s.blocks.length, 0),
    lines: sheetsOut.reduce((n, s) => n + s.blocks.reduce((m, b) => m + b.lines.length, 0), 0),
    flagged: sheetsOut.flatMap((s) => s.blocks.filter((b) => b.verdict !== 'ok').map((b) => ({ verdict: b.verdict, fontFamily: b.fontFamily }))),
    unmeasured: sheetsOut.reduce((n, s) => n + s.unmeasured.length, 0), maxMs: Math.max(...sheetsOut.map((s) => s.ms)) },
};
fs.writeFileSync(path.join(outDir, 'calibration.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), summary, positives, negatives, canva }, null, 1)}\n`);
console.log(JSON.stringify(summary, null, 1));
