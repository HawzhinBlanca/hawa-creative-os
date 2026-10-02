import { describe, expect, it } from 'vitest';
import { OFFICE_POSTS } from './fixtures/office-posts/office-posts.js';
import { composedForm, copyOf, scoreOfficePost } from './fixtures/office-posts/gates.js';
import { computeGridAppropriateness, computeNegativeSpace, computeRegularity, GRID_APPROPRIATENESS_POLICY } from '../src/studio/design-metrics.js';
import { ALIGNMENT_POLICY, computeLayoutMetrics } from '../src/studio/layout-metrics.js';
import { NEGATIVE_SPACE_POLICY } from '../src/studio/negative-space-policy.js';
import { measureWrappedLines } from '../src/studio/render-layout-v2.js';
import type { StudioLayoutV2, TextElement } from '../src/studio/layout-v2.js';

/**
 * ADR-273: the studio's gates, calibrated on twelve of the office's own published posts. Each post
 * is annotated as a layout (fixtures/office-posts) and run through the exact functions production
 * gates with: computeNegativeSpace, computeLayoutMetrics().alignmentScore (hard QA's
 * POOR_GRID_ALIGNMENT), evaluateDesignMetrics().passed with gridAppropriateness, evaluateHardQa's
 * layout checks and validateLayoutV2. "A gate that rejects an owner-approved design is
 * miscalibrated."
 *
 * Each post is scored as it is carried on the recipe path (its ADR-170 recipe record) and as a
 * composed poster carries it (the same geometry with no recipe record), the path a text-only
 * KAAE poster takes (ADR-271) when office photos feed it.
 */

/**
 * The regression record: what each gate rejected on the base (e7aebad7, before ADR-273), measured
 * by this same harness. The recipe-path negative space, alignment, hard QA's layout checks and the
 * validator passed every post already.
 */
const REJECTED_BEFORE: Record<string, string[]> = {
  photo01_k12_field_visit_report_en: ['composed negativeSpace: 0.00 empty (both photos counted as occupied)'],
  photo02_k12_field_visit_report_ckb: ['composed negativeSpace: 0.00 empty'],
  photo03_why_accreditation_card_en: ['composed negativeSpace: 0.00 empty'],
  photo04_why_accreditation_card_ckb: ['composed negativeSpace: 0.00 empty'],
  photo05_global_partnership_plate_en: ['composed negativeSpace: 0.13 empty', 'typeScale (both forms)'],
  photo06_global_partnership_plate_ckb: ['composed negativeSpace: 0.12 empty', 'typeScale (both forms)'],
  photo07_prime_minister_meeting_scrim_en: ['composed negativeSpace: 0.00 empty', 'composed gridAppropriateness 0.50'],
  photo08_prime_minister_meeting_scrim_ckb: ['composed negativeSpace: 0.00 empty', 'composed gridAppropriateness 0.50'],
  photo09_eid_al_adha_sky_title: ['composed negativeSpace: 0.00 empty'],
  photo10_educational_forum_speaker_en: ['regularity: EXCESSIVE_DEAD_AREA, the 392px gap beside the cut-out speaker (both forms)'],
  photo11_peer_evaluators_call_en: ['composed gridAppropriateness 0.36 (bleeding tab, card and pill; ragged caps)', 'typeScale (both forms)'],
  photo12_peer_evaluators_call_ckb: ['composed gridAppropriateness 0.30', 'typeScale (both forms)'],
};

/**
 * Not recalibrated: typeScale holds every size to a modular scale within 1.5px. The fixtures' sizes
 * are read off 864px JPEGs (a few px of error) and the display lines are re-set at the house leading
 * (font size = the office's line box / 1.2 or 1.6), so their sizes cannot say whether the office
 * works on a scale. Four posts fail it, as before; the ADR leaves it open.
 */
const MEASUREMENT_LIMITED = ['typeScale'];

describe('ADR-273: every annotated office post passes every gate', () => {
  it('annotates twelve posts, each from its own exemplar', () => {
    expect(OFFICE_POSTS).toHaveLength(12);
    expect(new Set(OFFICE_POSTS.map((p) => p.source)).size).toBe(12);
    expect(Object.keys(REJECTED_BEFORE).sort()).toEqual(OFFICE_POSTS.map((p) => p.id).sort());
    for (const p of OFFICE_POSTS) expect(p.layout.text).toHaveLength(p.copy.length);
  });

  for (const post of OFFICE_POSTS) {
    it(`${post.id} (${post.recipe}; before: ${REJECTED_BEFORE[post.id].join('; ')})`, () => {
      const r = scoreOfficePost(post);
      expect(r.negativeSpace.passed, JSON.stringify(r.negativeSpace.details)).toBe(true);
      expect(r.negativeSpaceComposed.passed, JSON.stringify(r.negativeSpaceComposed.details)).toBe(true);
      expect(r.alignment.score).toBeGreaterThanOrEqual(ALIGNMENT_POLICY.passScore);
      for (const report of [r.designMetrics, r.designMetricsComposed]) {
        expect(report.failing.filter((m) => !MEASUREMENT_LIMITED.includes(m))).toEqual([]);
        expect(report.grid).toBeGreaterThanOrEqual(GRID_APPROPRIATENESS_POLICY.passScore);
        expect(report.composite).toBeGreaterThanOrEqual(0.75);
      }
      expect(r.hardQa.codes, r.hardQa.messages.join(' | ')).toEqual([]);
      expect(r.validation, r.validation.message).toEqual({ passed: true });
      // Text over a photo is still held to its contrast on the rendered pixels, which needs a render.
      const overPhoto = post.layout.text.some((t) => (post.layout.photos || []).some((p) =>
        t.x < p.x + p.width && t.x + t.width > p.x && t.y < p.y + p.height && t.y + t.height > p.y));
      expect(r.hardQa.needsRender.length > 0).toBe(overPhoto);
    });
  }

  it('records typeScale as the one gate still rejecting office posts, measurement-limited', () => {
    const failing = OFFICE_POSTS.filter((p) => scoreOfficePost(p).designMetrics.failing.includes('typeScale')).map((p) => p.id.slice(0, 7));
    expect(failing).toEqual(['photo05', 'photo06', 'photo11', 'photo12']);
  });
});

// ---------------------------------------------------------------------------------------------
// The fixes, each on the smallest layout that shows it. Values measured on the base (e7aebad7)
// are stated in the comments.
// ---------------------------------------------------------------------------------------------
const W = 1080, H = 1350;
const text = (t: Partial<TextElement> & Pick<TextElement, 'copyIndex' | 'role' | 'x' | 'y' | 'width' | 'height' | 'fontSize'>): TextElement =>
  ({ lineHeight: 1.2, fontFamily: 'Inter', color: '#FFFFFF', align: 'left', ...t });
const base = (over: Partial<StudioLayoutV2>): StudioLayoutV2 => ({
  version: 2, width: W, height: H, grid: { margin: 64, columns: 12, gutter: 20, baseline: 8 }, background: { color: '#FDF8F3' },
  shapes: [], text: [], logo: { x: 64, y: 64, width: 130, height: 130 }, ...over,
});

describe('negative space (policy 2026-10-02.1)', () => {
  it('counts a band and the title on it once', () => {
    const band = { x: 0, y: 300, width: W, height: 400, kind: 'rect' as const, role: 'panel' as const, color: '#1E3A5F' };
    const title = text({ copyIndex: 0, role: 'title', x: 64, y: 360, width: 900, height: 280, fontSize: 116 });
    const l = base({ shapes: [band], text: [title] });
    const ns = computeNegativeSpace(l, { 0: 2 });
    // Union: the band at 0.6 with the title's ink on it raised to 1, plus the logo: 376,324 px. The
    // sum counted the title on the band again: 526,660 px, 0.639 empty on the base.
    expect(ns.details).toMatchObject({ fraction: 0.742, occupiedArea: 376324, measure: 'measured_lines' });
  });

  it('still stacks type set over type, so a crammed layout stays crammed', () => {
    const block = (i: number, y: number) => text({ copyIndex: i, role: 'body', x: 64, y, width: 952, height: 300, fontSize: 40 });
    const l = base({ text: [block(0, 250), block(1, 400), block(2, 550), block(3, 700), block(4, 850)] });
    const ns = computeNegativeSpace(l, { 0: 6, 1: 6, 2: 6, 3: 6, 4: 6 });
    expect(Number(ns.details?.fraction)).toBeLessThan(NEGATIVE_SPACE_POLICY.bands.measured_lines.floor);
    expect(ns.passed).toBe(false);
  });

  it('reads a photo under a carrying fade as ground, and its own fade as partly empty', () => {
    const photo = { photoIndex: 0, role: 'inset' as const, x: 540, y: 700, width: 540, height: 500, fade: { edge: 'left' as const, length: 0.5 } };
    const plain = computeNegativeSpace(base({ photos: [{ ...photo, fade: undefined }], text: [text({ copyIndex: 0, role: 'title', x: 64, y: 260, width: 900, height: 140, fontSize: 58 })] }), { 0: 2 });
    const faded = computeNegativeSpace(base({ photos: [photo], text: [text({ copyIndex: 0, role: 'title', x: 64, y: 260, width: 900, height: 140, fontSize: 58 })] }), { 0: 2 });
    // The faded half of the box occupies half: 540x500 x (0.5 + 0.5 x 0.5) = 202,500 px instead of 270,000.
    expect(Number(plain.details?.occupiedArea) - Number(faded.details?.occupiedArea)).toBe(67500);
    const under = base({
      photos: [{ ...photo, fade: undefined }],
      overlays: [{ kind: 'gradient', x: 540, y: 700, width: 540, height: 500, color: '#0A1628', direction: 'to-bottom', purpose: 'scrim',
        stops: [{ at: 0, opacity: 0 }, { at: 0.5, opacity: 0.55 }, { at: 1, opacity: 0.9 }] }],
      text: [text({ copyIndex: 0, role: 'title', x: 64, y: 260, width: 900, height: 140, fontSize: 58 })],
    });
    // The scrim carries text over its lower half (0.55 from at 0.5), so that half of the photo is ground.
    expect(Number(plain.details?.occupiedArea) - Number(computeNegativeSpace(under, { 0: 2 }).details?.occupiedArea)).toBe(135000);
  });

  it('measures a photo-led layout by its quiet region, with or without a recipe record', () => {
    const post = OFFICE_POSTS.find((p) => p.id.startsWith('photo05'))!;
    const composed = composedForm(post.layout);
    const ns = computeNegativeSpace(composed, measureWrappedLines(composed, copyOf(post)));
    // On the base this layout measured 0.13 empty and failed; the plate carries the title.
    expect(ns.details).toMatchObject({ measure: 'photo_led_quiet_region', titleInQuietRegion: true, bareTextOnPhoto: [] });
    expect(ns.passed).toBe(true);
    // A block left bare on the photo still fails it.
    const bare = structuredClone(composed);
    bare.overlays = [];
    expect(computeNegativeSpace(bare, measureWrappedLines(bare, copyOf(post))).details).toMatchObject({ bareTextOnPhoto: [1] });
  });
});

describe('alignment (hard QA POOR_GRID_ALIGNMENT, ALIGNMENT_POLICY 2026-10-02.1)', () => {
  // The office's call for peer evaluators in miniature: a title tab bleeding off the start edge with
  // its caps centred in it, the title on the margin, and a pill on the margin with its call to
  // action centred in it.
  const tabbed = () => base({
    shapes: [
      { x: 0, y: 260, width: 520, height: 96, kind: 'rect', role: 'panel', color: '#1E3A5F', surface: 'tab' },
      { x: 64, y: 1100, width: 300, height: 72, kind: 'roundRect', role: 'panel', color: '#1E3A5F', surface: 'pill', radius: 36 },
    ],
    text: [
      text({ copyIndex: 0, role: 'eyebrow', x: 80, y: 272, width: 360, height: 72, fontSize: 60, bold: true, align: 'center' }),
      text({ copyIndex: 1, role: 'title', x: 64, y: 400, width: 880, height: 240, fontSize: 100, color: '#1E3A5F' }),
      text({ copyIndex: 2, role: 'cta', x: 94, y: 1112, width: 240, height: 48, fontSize: 40, bold: true, align: 'center' }),
    ],
  });

  it('counts the canvas edge and the text on a container as aligned', () => {
    // On the base: 0.583. The tab's edge at x=0, the eyebrow centred in the tab and the call to action
    // centred in the pill lined up with nothing, so hard QA failed it as POOR_GRID_ALIGNMENT. Now the
    // tab and the pill share their text's centre, and only the logo's right edge meets nothing.
    expect(computeLayoutMetrics(tabbed()).alignmentScore).toBe(0.917);
  });

  it('still fails a layout whose edges line up with nothing', () => {
    const off = tabbed();
    off.shapes[0].x = 17;
    off.shapes[1].x = 41;
    off.text[0].x = 49;
    off.text[2].x = 83;
    off.logo.x = 33;
    expect(computeLayoutMetrics(off).alignmentScore).toBeLessThan(ALIGNMENT_POLICY.passScore);
  });
});

describe('gridAppropriateness (GRID_APPROPRIATENESS_POLICY 2026-10-02.1)', () => {
  it('admits bleeds, flush boxes and ragged text on its own axis, on every layout', () => {
    const l = base({
      shapes: [
        { x: 0, y: 1295, width: W, height: 55, kind: 'rect', role: 'panel', color: '#1E3A5F' },
        { x: 0, y: 300, width: 520, height: 120, kind: 'rect', role: 'panel', color: '#1E3A5F' },
        { x: 64, y: 640, width: 158, height: 11, kind: 'rect', role: 'accent', color: '#F7B500' },
      ],
      text: [
        text({ copyIndex: 0, role: 'title', x: 64, y: 450, width: 731, height: 170, fontSize: 70 }),
        text({ copyIndex: 1, role: 'subtitle', x: 64, y: 680, width: 433, height: 48, fontSize: 40 }),
      ],
    });
    // On the base: 0.400 (the logo and the accent bar conformed; the bleeding tab and the two
    // ragged left-aligned blocks did not; the full-width footer bar is not counted).
    expect(computeGridAppropriateness(l).score).toBe(1);
  });
});

describe('regularity: a dead area is a gap without composition', () => {
  const forum = () => {
    const post = OFFICE_POSTS.find((p) => p.id.startsWith('photo10'))!;
    return structuredClone(post.layout);
  };

  it('lets a cut-out photo spanning the gap compose it', () => {
    expect(computeRegularity(forum())).toMatchObject({ passed: true, details: { composedGap: 392 } });
  });

  it('still rejects the same gap with nothing in it', () => {
    const l = forum();
    l.photos = [];
    expect(computeRegularity(l)).toMatchObject({ passed: false, details: { reason: expect.stringMatching(/^EXCESSIVE_DEAD_AREA/) } });
  });
});
