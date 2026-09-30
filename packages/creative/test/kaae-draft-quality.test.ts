import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';
import { evaluateHardQa, type HardQaContext } from '../src/studio/hard-qa.js';
import { validateLayoutV2, type LayoutValidationContext } from '../src/studio/validate-layout-v2.js';
import { computeNegativeSpace, computeBalance } from '../src/studio/design-metrics.js';
import { centerPanelStacks, fitLogoBand, fitPhotoBoxesToImages, coverCropLoss, rankCandidatesV3, fewerFindingsFirst, type PipelineV3Copy } from '../src/studio/pipeline-v3.js';
import { measureTextGeometry } from '../src/studio/render-layout-v2.js';
import { inkBoxOf } from '../src/studio/composite-contrast.js';
import { logoClearZone } from '../src/studio/house-rules.js';

/**
 * ADR-157. The production KAAE report-cover draft of 2026-09-30 (1080x1350, six field-visit photos),
 * its geometry measured off the render by the audit (audit-kaae-draft.test.ts). Every assertion
 * here failed on 6bd479c1.
 */
const FONT = 'Inter';
const kaae = (): StudioLayoutV2 => ({
  version: 2, width: 1080, height: 1350,
  grid: { margin: 65, columns: 6, gutter: 20, baseline: 8 },
  background: { color: '#0A1628' },
  shapes: [
    { kind: 'rect', role: 'panel', x: 65, y: 863, width: 950, height: 393, color: '#1E3A5F' },
    { kind: 'rect', role: 'rule', x: 480, y: 992, width: 120, height: 2, color: '#F7B500' },
  ] as StudioLayoutV2['shapes'],
  logo: { x: 490, y: 135, width: 100, height: 80 },
  photos: [
    { photoIndex: 0, role: 'grid', x: 65, y: 297, width: 302, height: 257 },
    { photoIndex: 1, role: 'grid', x: 383, y: 297, width: 324, height: 257 },
    { photoIndex: 2, role: 'grid', x: 724, y: 297, width: 292, height: 257 },
    { photoIndex: 3, role: 'grid', x: 65, y: 574, width: 324, height: 257 },
    { photoIndex: 4, role: 'grid', x: 405, y: 574, width: 292, height: 257 },
    { photoIndex: 5, role: 'grid', x: 713, y: 574, width: 302, height: 257 },
  ] as unknown as StudioLayoutV2['photos'],
  text: [
    { copyIndex: 0, role: 'title', x: 110, y: 900, width: 860, height: 72, fontSize: 44, lineHeight: 1.2, fontFamily: FONT, color: '#FFFFFF', align: 'center', bold: true },
    { copyIndex: 1, role: 'subtitle', x: 110, y: 1020, width: 860, height: 44, fontSize: 28, lineHeight: 1.3, fontFamily: FONT, color: '#F7B500', align: 'center', bold: true },
    { copyIndex: 2, role: 'body', x: 110, y: 1130, width: 860, height: 40, fontSize: 19, lineHeight: 1.4, fontFamily: FONT, color: '#FFFFFF', align: 'center' },
  ] as StudioLayoutV2['text'],
});
const copyText = { 0: 'KAAE K-12 Pilot Study', 1: 'Field Visit Report', 2: 'Insights from KAAE school field visits and next steps toward' };
const copy: PipelineV3Copy = { text: copyText, scripts: { 0: 'latin', 1: 'latin', 2: 'latin' } };
const palette = ['#0A1628', '#1E3A5F', '#4770A3', '#F7B500', '#FDF8F3', '#FFFFFF', '#1A1A1A'];
const ctx: HardQaContext = {
  width: 1080, height: 1350, copyScripts: ['latin', 'latin', 'latin'], latinFont: FONT, arabicFont: 'Noto Sans Arabic',
  palette, logoAspect: 1.25, copyText, photoCount: 6,
};
const validation = (extra: Partial<LayoutValidationContext> = {}): LayoutValidationContext => ({
  expectedWidth: 1080, expectedHeight: 1350, copyCount: 3, copyScripts: ['latin', 'latin', 'latin'], photoCount: 6,
  reference: { rules: { fontFamily: FONT, palette }, logoAspect: 1.25 }, ...extra,
});

/** A no-text composite: the canvas navy, the panel, and optionally a pale band behind one block. */
function composite(layout: StudioLayoutV2, paleBehind?: { y: number; height: number }): Buffer {
  const png = new PNG({ width: layout.width, height: layout.height });
  const panel = layout.shapes[0];
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const inPanel = x >= panel.x && x < panel.x + panel.width && y >= panel.y && y < panel.y + panel.height;
      const pale = paleBehind && y >= paleBehind.y && y < paleBehind.y + paleBehind.height && x >= 100 && x < 980;
      const [r, g, b] = pale ? [0xf0, 0xf0, 0xf0] : inPanel ? [0x1e, 0x3a, 0x5f] : [0x0a, 0x16, 0x28];
      const i = (y * png.width + x) * 4;
      png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

describe('KAAE report-cover draft (ADR-157)', () => {
  it('D1 (#16): the subtitle ending on "toward" is a review finding, and does not fail the design', () => {
    const qa = evaluateHardQa(kaae(), ctx);
    expect(qa.findings).toEqual([expect.objectContaining({ code: 'COPY_DANGLING_END', copyIndex: 2, severity: 'warning' })]);
    expect(qa.defectCodes).not.toContain('COPY_DANGLING_END');
    expect(qa.passed).toBe(true);
  });

  it('D1: a review finding breaks a composite tie, and only a tie', () => {
    const clean = { hardQa: { findings: [] } } as never;
    const flagged = { hardQa: { findings: [{ code: 'FONT_SUBSTITUTED' }] } } as never;
    expect(fewerFindingsFirst(flagged, clean)).toEqual([clean, flagged]);
    expect(fewerFindingsFirst(clean, flagged)).toEqual([clean, flagged]);
    // Two identical designs, one set in a face the renderer substituted: the other ranks first.
    const substituted = { ...ctx, fontFidelity: { Inter: 'stand-in' as const } };
    const ranked = rankCandidatesV3([{ sourceIndex: 0, layout: kaae() }, { sourceIndex: 1, layout: kaae() }], copy, ctx);
    expect(ranked.map((r) => r.sourceIndex)).toEqual([0, 1]);
    const one = evaluateHardQa(kaae(), substituted);
    expect(one.findings.map((f) => f.code)).toEqual(['COPY_DANGLING_END', 'FONT_SUBSTITUTED']);
  });

  it('D2 (#17): "choose the best photos" admits a distinct subset of at least the minimum, and records what was left out', () => {
    const four = kaae();
    four.photos = four.photos!.slice(0, 4);
    expect(validateLayoutV2(four, validation())).toMatchObject({ ok: false, code: 'PHOTOS' });
    expect(validateLayoutV2(four, validation({ photoSelection: { mode: 'choose', minimum: 3 } })).ok).toBe(true);
    const two = kaae();
    two.photos = two.photos!.slice(0, 2);
    expect(validateLayoutV2(two, validation({ photoSelection: { mode: 'choose', minimum: 3 } }))).toMatchObject({ ok: false, code: 'PHOTOS' });
    const twice = kaae();
    twice.photos = [twice.photos![0], twice.photos![1], { ...twice.photos![2], photoIndex: 1 }];
    expect(validateLayoutV2(twice, validation({ photoSelection: { mode: 'choose', minimum: 3 } }))).toMatchObject({ ok: false, code: 'PHOTOS' });
    const qa = evaluateHardQa(four, { ...ctx, photoSelection: { mode: 'choose', minimum: 3 } });
    expect(qa.defectCodes).not.toContain('PHOTOS');
    expect(qa.omittedPhotos).toEqual([4, 5]);
  });

  it('D4 (#19): negative space and balance see the photos', () => {
    const withPhotos = kaae();
    const without = { ...kaae(), photos: [] };
    const a = computeNegativeSpace(withPhotos);
    const b = computeNegativeSpace(without);
    // Six photos of about 300x257 are about 32% of the canvas.
    expect(Number(b.details!.fraction) - Number(a.details!.fraction)).toBeGreaterThan(0.3);
    // Without the photos the gap between the logo and the panel (215 to 863) was the largest gap.
    expect(Number(b.details!.internalGapFraction)).toBeGreaterThan(0.45);
    expect(Number(a.details!.internalGapFraction)).toBeLessThan(0.07);
    expect(computeBalance(withPhotos)).not.toEqual(computeBalance(without));
  });

  it('D5 (P2): the panel text stack is centred as one unit on its inked lines', () => {
    const layout = kaae();
    const inkGaps = (l: StudioLayoutV2) => {
      const m = measureTextGeometry(l, copyText);
      const inks = l.text.map((t) => inkBoxOf(t, m.find((x) => x.copyIndex === t.copyIndex) as never));
      const panel = l.shapes[0];
      return { above: Math.min(...inks.map((b) => b.y)) - panel.y, below: panel.y + panel.height - Math.max(...inks.map((b) => b.y + b.height)) };
    };
    const before = inkGaps(layout);
    expect(before.below - before.above).toBeGreaterThan(40);
    const gapsBefore = layout.text.slice(1).map((t, i) => t.y - layout.text[i].y);
    const ruleOffset = layout.shapes[1].y - layout.text[0].y;
    centerPanelStacks(layout, copy);
    const after = inkGaps(layout);
    expect(Math.abs(after.below - after.above)).toBeLessThanOrEqual(2);
    // Rigid: the blocks keep their spacing and the rule travels with them.
    expect(layout.text.slice(1).map((t, i) => t.y - layout.text[i].y)).toEqual(gapsBefore);
    expect(layout.shapes[1].y - layout.text[0].y).toBe(ruleOffset);
  });

  it('D5 (P2): the logo band is sized to the logo and its clear space, and the composition re-centred', () => {
    const layout = kaae();
    const clear = layout.logo.y - logoClearZone(layout.logo).y;
    expect(layout.photos![0].y - (layout.logo.y + layout.logo.height)).toBe(82);
    const photosToPanel = layout.shapes[0].y - (layout.photos![3].y + layout.photos![3].height);
    fitLogoBand(layout, copy);
    expect(layout.photos![0].y - (layout.logo.y + layout.logo.height)).toBe(clear);
    // Spacing inside the content is unchanged, and the composition sits between the margins evenly.
    expect(layout.shapes[0].y - (layout.photos![3].y + layout.photos![3].height)).toBe(photosToPanel);
    const top = layout.logo.y - 65;
    const bottom = 1350 - 65 - (layout.shapes[0].y + layout.shapes[0].height);
    expect(Math.abs(top - bottom)).toBeLessThanOrEqual(1);
    expect(evaluateHardQa(layout, ctx).defectCodes).toEqual([]);
  });

  it('D6 (P2): a row is re-divided towards each photo\'s own aspect, cropping less of it', () => {
    // The door photo (index 2) is a portrait, the others landscape, as in the draft.
    const sizes = [{ width: 1600, height: 1200 }, { width: 1600, height: 1067 }, { width: 900, height: 1200 },
      { width: 1600, height: 1067 }, { width: 1600, height: 1067 }, { width: 1600, height: 1200 }];
    const layout = kaae();
    const door = () => layout.photos!.find((p) => p.photoIndex === 2)!;
    const lossBefore = coverCropLoss(door(), sizes[2]);
    const rowEnd = layout.photos![2].x + layout.photos![2].width;
    fitPhotoBoxesToImages(layout, sizes, copy);
    expect(coverCropLoss(door(), sizes[2])).toBeLessThan(lossBefore);
    // The row keeps its ends, its gaps and its height; every photo keeps its minimum size.
    expect(layout.photos![0].x).toBe(65);
    expect(door().x + door().width).toBe(rowEnd);
    for (const p of layout.photos!) expect(Math.min(p.width, p.height)).toBeGreaterThanOrEqual(238);
    expect(evaluateHardQa(layout, ctx).defectCodes).toEqual([]);
  });

  it('D6: a detected face the new crop would cut keeps the row as it was', () => {
    // Photo 0 is a close portrait whose face fills nearly its whole height. Re-divided, its box
    // becomes a little wider than the photo, and a cover crop would take the top of the head.
    const sizes = [{ width: 1440, height: 1200 }, { width: 1600, height: 1067 }, { width: 900, height: 1200 }];
    const row = () => {
      const l = kaae();
      l.photos = l.photos!.slice(0, 3);
      return l;
    };
    const without = row();
    fitPhotoBoxesToImages(without, sizes, copy);
    expect(without.photos![0].width).toBeGreaterThan(302);
    const layout = row();
    const before = JSON.stringify(layout.photos);
    fitPhotoBoxesToImages(layout, sizes, copy, [{ x: 0.5, y: 0.5, faceShare: 0.995 }, null, null]);
    expect(JSON.stringify(layout.photos)).toBe(before);
  });

  it('D7 (#20): hard QA measures contrast on the render that ships, not only the declared colours', () => {
    const layout = kaae();
    // The declared colours pass: white and gold on the navy panel.
    expect(evaluateHardQa(layout, { ...ctx, renderedComposite: composite(layout) }).defectCodes).toEqual([]);
    // Art that paints a pale band behind the body's lines: the declared colours still pass, the pixels do not.
    const art = composite(layout, { y: 1125, height: 50 });
    expect(evaluateHardQa(layout, ctx).defectCodes).toEqual([]);
    const qa = evaluateHardQa(layout, { ...ctx, renderedComposite: art });
    expect(qa.defectCodes).toContain('CONTRAST');
    expect(qa.messages.join(' ')).toMatch(/block 2 \(body\).*rendered pixels/);
    expect(qa.measuredContrast![2]).toBeLessThan(1.5);
    expect(qa.measuredContrast![0]).toBeGreaterThan(9);
  });

  it('D7: a pale strip under the box but outside its lines does not count against the copy', () => {
    const layout = kaae();
    // 40px box, 27px of lines centred in it: the top 6px are box, not lines.
    const art = composite(layout, { y: 1130, height: 5 });
    expect(evaluateHardQa(layout, { ...ctx, renderedComposite: art }).defectCodes).toEqual([]);
  });

  it('D8 (P2): a substituted face is a recorded finding, not only a console warning', () => {
    const qa = evaluateHardQa(kaae(), { ...ctx, fontFidelity: { Inter: 'stand-in', Verdana: 'exact' } });
    expect(qa.findings.find((f) => f.code === 'FONT_SUBSTITUTED')?.message).toMatch(/Inter \(blocks 0, 1, 2\)/);
    expect(qa.passed).toBe(true);
  });

  it('D9 (P2): instructions that name a language the copy lacks are a finding', () => {
    const qa = evaluateHardQa(kaae(), { ...ctx, instructions: 'Report cover in English and Kurdish please' });
    expect(qa.findings.map((f) => f.code)).toEqual(['COPY_DANGLING_END', 'LANGUAGE_MISSING']);
  });
});
