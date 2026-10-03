import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { OFFICE_POSTS } from './fixtures/office-posts/office-posts.js';
import { syntheticPhoto } from './fixtures/synthetic-photos.js';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';
import { applyShapingControl, type ShapingControl } from './fixtures/shaping-controls.js';
import { fontFileFor, renderLayoutV2, svgToPngAsync, type RenderLayoutV2Result } from '../src/studio/render-layout-v2.js';
import { checkTextShaping, shapeLine, textShapingBlocks, type ShapingVerdict } from '../src/studio/export-text-shaping.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';

/**
 * ADR-290: the Sorani shaping check on the raster. Correct renders pass (the office posts' Sorani
 * blocks, drawn by the Studio renderer, and real Canva exports on record); deliberately broken renders of
 * the same blocks fail with the defect named. Strings are the fixtures' and the golden corpus's own.
 */

const SORANI_POSTS = OFFICE_POSTS.filter((p) => p.language !== 'en');
const copyOf = (copy: string[]) => Object.fromEntries(copy.map((c, i) => [i, c]));
const renders = new Map<string, RenderLayoutV2Result>();
function render(id: string): { layout: StudioLayoutV2; copyText: Record<number, string>; out: RenderLayoutV2Result } {
  const post = SORANI_POSTS.find((p) => p.id === id)!;
  const copyText = copyOf(post.copy);
  if (!renders.has(id)) {
    const photoFiles = (post.layout.photos ?? []).map((_, i) => ({ bytes: syntheticPhoto(600, 400, i + 3) }));
    renders.set(id, renderLayoutV2(post.layout, { copyText, logoDataUri: KAAE_TEST_LOGO, photoFiles }));
  }
  return { layout: post.layout, copyText, out: renders.get(id)! };
}

describe('shaping a line (ADR-290)', () => {
  it('puts digits and Latin inside a right-to-left line in bidi order', () => {
    // Golden RTL-008: a Kurdish word, then "8:30 PM". Under a right-to-left base the bidi algorithm
    // draws "PM", then "8:30", then the word, left to right (Canva drew exactly that).
    const text = 'کاتژمێر 8:30 PM';
    const noto = fontFileFor('Noto Sans Arabic', false, false), inter = fontFileFor('Inter', false, false);
    const line = shapeLine([noto, inter], text, true, 32);
    const ids = (face: string, s: string) => shapeLine(face, s, false, 32).glyphs.map((g) => g.id);
    // Noto Sans Arabic has the digits and the colon; "PM" falls back to Inter. Visual order, left to
    // right: P, M, space, 8, :, 3, 0, space, then the Kurdish word.
    expect(line.glyphs.slice(0, 2).map((g) => [g.file, g.id])).toEqual(ids(inter, 'PM').map((id) => [inter, id]));
    expect(line.glyphs.slice(3, 7).map((g) => g.id)).toEqual(ids(noto, '8:30'));
    expect(line.glyphs.slice(0, 7).filter((g) => g.id !== ids(noto, ' ')[0]).every((g) => g.loose)).toBe(true);
    expect(line.glyphs.slice(8).every((g) => g.file === noto && !g.loose)).toBe(true);
  });

  it('shapes the same line the same way whatever was drawn before (fontkit glyph cache)', async () => {
    // The final form of U+06D5 in IBM Plex Sans Arabic Bold is a composite built on the heh glyph.
    // Reading its outline used to create the heh glyph with no code points, after which U+0647 shaped
    // as non-joining in every later line (a title measured 506 px instead of 529).
    const bold = fontFileFor('IBM Plex Sans Arabic', true, false);
    const title = OFFICE_POSTS.find((p) => p.id === 'photo08_prime_minister_meeting_scrim_ckb')!.copy[0];
    const before = shapeLine(bold, title, true, 42).advance;
    const { layout, copyText, out } = render('photo02_k12_field_visit_report_ckb');
    checkTextShaping(out.png, textShapingBlocks(layout, copyText), { background: out.noTextPng });
    expect(shapeLine(bold, title, true, 42).advance).toBeCloseTo(before, 6);
  });
});

describe('correct renders pass (ADR-290)', () => {
  it.each(SORANI_POSTS.map((p) => p.id))('%s, read exactly and by colour', (id) => {
    const { layout, copyText, out } = render(id);
    const blocks = textShapingBlocks(layout, copyText);
    expect(blocks.length).toBeGreaterThan(0);
    const exact = checkTextShaping(out.png, blocks, { background: out.noTextPng });
    expect(exact.unmeasured).toEqual([]);
    expect(exact.blocks.flatMap((b) => b.lines.filter((l) => l.verdict !== 'ok'))).toEqual([]);
    expect(exact.pass).toBe(true);
    expect(exact.ms).toBeLessThan(1000);
    const byColour = checkTextShaping(out.png, blocks);
    expect(byColour.pass).toBe(true);
    expect(byColour.ms).toBeLessThan(1500);
  }, 60_000);
});

describe('negative controls fail with the defect named (ADR-290)', () => {
  const expected: Record<ShapingControl, ShapingVerdict[]> = {
    'unjoined': ['shaping-mismatch'],
    'one-join-broken': ['shaping-mismatch'],
    'reversed': ['wrong-direction'],
    'substituted-face': ['shaping-mismatch'],
    'rewrapped': ['wrapped-differently'],
    'missing-glyph': ['missing-glyphs'],
  };
  const cases = ['photo02_k12_field_visit_report_ckb', 'photo08_prime_minister_meeting_scrim_ckb', 'photo12_peer_evaluators_call_ckb']
    .flatMap((id) => (Object.keys(expected) as ShapingControl[]).map((control) => [id, control] as const));
  it.each(cases)('%s: %s', async (id, control) => {
    const { layout, copyText, out } = render(id);
    const blocks = textShapingBlocks(layout, copyText);
    // The first block the control applies to (a one-word block cannot be re-wrapped).
    const attempt = blocks.map((block) => {
      const t = layout.text.find((x) => `text-copy-${x.copyIndex}` === block.id)!;
      return { block, svg: applyShapingControl(out.svg, block.id, block.rtl, control,
        { substitute: t.fontFamily === 'Noto Sans Arabic' ? 'Vazirmatn' : 'Noto Sans Arabic', pitchPx: t.lineHeight * block.fontSizePx }) };
    }).find((a) => a.svg);
    expect(attempt).toBeDefined();
    const { block, svg } = attempt!;
    const broken = await svgToPngAsync(svg!, layout.width, layout.height, {}, out.files);
    // Read exactly (the Studio render): detected and named.
    const exact = checkTextShaping(broken, blocks, { background: out.noTextPng });
    const verdict = exact.blocks.find((b) => b.id === block.id)!.verdict;
    expect(exact.pass).toBe(false);
    expect(expected[control]).toContain(verdict);
    // Read by colour (a provider's export): detected, except a face as close as the substitute can be
    // (ADR-290 records which substitutions the colour reading misses).
    const byColour = checkTextShaping(broken, blocks);
    if (control !== 'substituted-face') expect(byColour.blocks.find((b) => b.id === block.id)!.verdict).not.toBe('ok');
  }, 60_000);
});

describe('real Canva exports on record (ADR-290)', () => {
  const root = resolve(__dirname, '../../../output/acceptance/2026-09-27-canva-multilingual');
  const fixtures = JSON.parse(readFileSync(`${root}/fixtures.json`, 'utf8'));
  const captures: Record<string, string> = { 'group-1': 'group-1-round-2-canva.png', 'group-2': 'group-2-canva.png', 'group-3': 'group-3-canva.png', 'group-4': 'group-4-canva.png' };

  it.each(Object.keys(captures))('%s: every Kurdish and Arabic block Canva drew passes', (id) => {
    const group = fixtures.groups.find((g: { id: string }) => g.id === id);
    const bytes = readFileSync(`${root}/${captures[id]}`);
    const blocks = textShapingBlocks(group.manifest.plan, copyOf(group.manifest.copy), { scale: PNG.sync.read(bytes).width / group.manifest.plan.width });
    const report = checkTextShaping(bytes, blocks);
    expect(report.blocks.length).toBeGreaterThanOrEqual(9);
    expect(report.blocks.filter((b) => b.verdict !== 'ok')).toEqual([]);
    // Group 4 holds an emoji no bundled face has: the renderer refuses that block, so it is not measured.
    expect(report.unmeasured.map((u) => u.id)).toEqual(id === 'group-4' ? ['text-copy-9'] : []);
  }, 60_000);

  it('fails a Canva export checked against copy it does not show', () => {
    const group = fixtures.groups.find((g: { id: string }) => g.id === 'group-1');
    const bytes = readFileSync(`${root}/${captures['group-1']}`);
    const copy: string[] = [...group.manifest.copy];
    // Blocks 0 and 1 swap their copy: the export's lines are well shaped, but not the lines designed.
    [copy[0], copy[1]] = [copy[1], copy[0]];
    const report = checkTextShaping(bytes, textShapingBlocks(group.manifest.plan, copyOf(copy)).filter((b) => ['text-copy-0', 'text-copy-1'].includes(b.id)));
    expect(report.pass).toBe(false);
    expect(report.blocks.every((b) => b.verdict !== 'ok')).toBe(true);
  }, 60_000);
});
