import type { StudioLayoutV2 } from '../../src/studio/layout-v2.js';

/**
 * Positive Fixtures: Exactly the SIX Owner-Confirmed KAAE Exemplars
 * Source of truth: packages/creative/assets/kaae-exemplars.json ("status": "CONFIRMED")
 */
export const SIX_CONFIRMED_EXEMPLARS: StudioLayoutV2[] = [
  // 1. post1_accreditation_mandate (1080x1080, Rank 1 confirmed)
  {
    version: 2,
    width: 1080,
    height: 1080,
    grid: { margin: 80, columns: 12, gutter: 20, baseline: 8 },
    background: { color: '#0C2340' },
    logo: { x: 80, y: 80, width: 180, height: 90 },
    shapes: [
      { x: 80, y: 320, width: 920, height: 2, color: '#C5A059', kind: 'line', role: 'rule' },
      { x: 80, y: 640, width: 280, height: 220, color: '#1B365D', kind: 'roundRect', role: 'panel' },
      { x: 400, y: 640, width: 280, height: 220, color: '#1B365D', kind: 'roundRect', role: 'panel' },
      { x: 720, y: 640, width: 280, height: 220, color: '#1B365D', kind: 'roundRect', role: 'panel' },
    ],
    text: [
      { copyIndex: 0, role: 'title', x: 80, y: 200, width: 920, height: 100, fontSize: 38, lineHeight: 1.3, fontFamily: 'Cinzel', color: '#C5A059', align: 'left', bold: true },
      { copyIndex: 1, role: 'body', x: 80, y: 360, width: 920, height: 120, fontSize: 18, lineHeight: 1.5, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left' },
      { copyIndex: 2, role: 'body', x: 80, y: 510, width: 920, height: 80, fontSize: 16, lineHeight: 1.4, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left' },
      { copyIndex: 3, role: 'body', x: 100, y: 670, width: 240, height: 160, fontSize: 15, lineHeight: 1.4, fontFamily: 'Verdana', color: '#FFFFFF', align: 'center' },
      { copyIndex: 4, role: 'body', x: 420, y: 670, width: 240, height: 160, fontSize: 15, lineHeight: 1.4, fontFamily: 'Verdana', color: '#FFFFFF', align: 'center' },
      { copyIndex: 5, role: 'body', x: 740, y: 670, width: 240, height: 160, fontSize: 15, lineHeight: 1.4, fontFamily: 'Verdana', color: '#FFFFFF', align: 'center' },
      { copyIndex: 6, role: 'footer', x: 80, y: 980, width: 920, height: 40, fontSize: 12, lineHeight: 1.4, fontFamily: 'Verdana', color: '#C5A059', align: 'left' },
    ],
    typeScale: { base: 15, ratio: 1.25 },
  },

  // 2. post2_standards_higher_ed (1080x1350, Rank 2 confirmed)
  {
    version: 2,
    width: 1080,
    height: 1350,
    grid: { margin: 80, columns: 12, gutter: 20, baseline: 8 },
    background: { color: '#0A1628' },
    logo: { x: 440, y: 80, width: 200, height: 100 },
    shapes: [
      { x: 80, y: 450, width: 920, height: 2, color: '#F7B500', kind: 'line', role: 'rule' },
      { x: 80, y: 780, width: 440, height: 350, color: '#1E3A5F', kind: 'roundRect', role: 'panel' },
      { x: 560, y: 780, width: 440, height: 350, color: '#1E3A5F', kind: 'roundRect', role: 'panel' },
    ],
    text: [
      { copyIndex: 0, role: 'title', x: 80, y: 220, width: 920, height: 120, fontSize: 42, lineHeight: 1.3, fontFamily: 'Lora', color: '#F7B500', align: 'center', bold: true },
      { copyIndex: 1, role: 'subtitle', x: 120, y: 360, width: 840, height: 70, fontSize: 22, lineHeight: 1.4, fontFamily: 'Verdana', color: '#FDF8F3', align: 'center' },
      { copyIndex: 2, role: 'body', x: 100, y: 480, width: 880, height: 140, fontSize: 17, lineHeight: 1.5, fontFamily: 'Verdana', color: '#FDF8F3', align: 'center' },
      { copyIndex: 3, role: 'body', x: 100, y: 810, width: 400, height: 290, fontSize: 15, lineHeight: 1.4, fontFamily: 'Verdana', color: '#FDF8F3', align: 'left' },
      { copyIndex: 4, role: 'body', x: 580, y: 810, width: 400, height: 290, fontSize: 15, lineHeight: 1.4, fontFamily: 'Verdana', color: '#FDF8F3', align: 'left' },
      { copyIndex: 5, role: 'footer', x: 80, y: 1220, width: 920, height: 40, fontSize: 12, lineHeight: 1.4, fontFamily: 'Verdana', color: '#F7B500', align: 'center' },
    ],
    typeScale: { base: 14, ratio: 1.25 },
  },

  // 3. post3_strategic_roadmap (1080x1080, Rank 3 confirmed)
  {
    version: 2,
    width: 1080,
    height: 1080,
    grid: { margin: 80, columns: 12, gutter: 20, baseline: 8 },
    background: { color: '#0A1628' },
    logo: { x: 80, y: 70, width: 180, height: 90 },
    shapes: [
      { x: 80, y: 480, width: 920, height: 400, color: '#1E3A5F', kind: 'roundRect', role: 'panel' },
    ],
    text: [
      { copyIndex: 0, role: 'title', x: 80, y: 180, width: 920, height: 100, fontSize: 36, lineHeight: 1.3, fontFamily: 'Cinzel', color: '#F7B500', align: 'left', bold: true },
      { copyIndex: 1, role: 'body', x: 80, y: 300, width: 920, height: 140, fontSize: 18, lineHeight: 1.5, fontFamily: 'Verdana', color: '#FDF8F3', align: 'left' },
      { copyIndex: 2, role: 'body', x: 110, y: 520, width: 860, height: 320, fontSize: 16, lineHeight: 1.5, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left' },
      { copyIndex: 3, role: 'footer', x: 80, y: 980, width: 920, height: 40, fontSize: 12, lineHeight: 1.4, fontFamily: 'Verdana', color: '#F7B500', align: 'left' },
    ],
    typeScale: { base: 12, ratio: 1.25 },
  },

  // 4. AUK002 kurdi (1080x1350, Rank 4 confirmed)
  {
    version: 2,
    width: 1080,
    height: 1350,
    grid: { margin: 70, columns: 12, gutter: 20, baseline: 8 },
    background: { color: '#0C2340' },
    logo: { x: 440, y: 70, width: 200, height: 100 },
    shapes: [{ x: 140, y: 350, width: 800, height: 2, color: '#C5A059', kind: 'line', role: 'rule' }],
    text: [
      { copyIndex: 0, role: 'title', x: 70, y: 200, width: 940, height: 130, fontSize: 42, lineHeight: 1.3, fontFamily: 'Cairo', color: '#C5A059', align: 'center', bold: true },
      { copyIndex: 1, role: 'body', x: 100, y: 390, width: 880, height: 240, fontSize: 18, lineHeight: 1.5, fontFamily: 'Noto Sans Arabic', color: '#FFFFFF', align: 'center' },
      { copyIndex: 2, role: 'body', x: 100, y: 670, width: 880, height: 260, fontSize: 18, lineHeight: 1.5, fontFamily: 'Noto Sans Arabic', color: '#FFFFFF', align: 'center' },
      { copyIndex: 3, role: 'footer', x: 70, y: 1220, width: 940, height: 50, fontSize: 12, lineHeight: 1.4, fontFamily: 'Noto Sans Arabic', color: '#C5A059', align: 'center' },
    ],
    typeScale: { base: 12, ratio: 1.5 },
  },

  // 5. CC002 kurdi (1080x1350, Rank 5 confirmed)
  {
    version: 2,
    width: 1080,
    height: 1350,
    grid: { margin: 80, columns: 12, gutter: 20, baseline: 8 },
    background: { color: '#0C2340' },
    logo: { x: 440, y: 80, width: 200, height: 100 },
    shapes: [{ x: 100, y: 360, width: 880, height: 2, color: '#C5A059', kind: 'line', role: 'rule' }],
    text: [
      { copyIndex: 0, role: 'title', x: 80, y: 210, width: 920, height: 130, fontSize: 42, lineHeight: 1.3, fontFamily: 'Cairo', color: '#C5A059', align: 'center', bold: true },
      { copyIndex: 1, role: 'body', x: 100, y: 400, width: 880, height: 300, fontSize: 18, lineHeight: 1.5, fontFamily: 'Noto Sans Arabic', color: '#FFFFFF', align: 'center' },
      { copyIndex: 2, role: 'body', x: 100, y: 730, width: 880, height: 260, fontSize: 18, lineHeight: 1.5, fontFamily: 'Noto Sans Arabic', color: '#FFFFFF', align: 'center' },
      { copyIndex: 3, role: 'footer', x: 80, y: 1220, width: 920, height: 40, fontSize: 12, lineHeight: 1.4, fontFamily: 'Noto Sans Arabic', color: '#C5A059', align: 'center' },
    ],
    typeScale: { base: 12, ratio: 1.5 },
  },

  // 6. CUE002 kurdi (1080x1350, Rank 6 confirmed)
  {
    version: 2,
    width: 1080,
    height: 1350,
    grid: { margin: 80, columns: 12, gutter: 20, baseline: 8 },
    background: { color: '#0A1628' },
    logo: { x: 440, y: 80, width: 200, height: 100 },
    shapes: [{ x: 100, y: 360, width: 880, height: 2, color: '#F7B500', kind: 'line', role: 'rule' }],
    text: [
      { copyIndex: 0, role: 'title', x: 80, y: 210, width: 920, height: 130, fontSize: 42, lineHeight: 1.3, fontFamily: 'Cairo', color: '#F7B500', align: 'center', bold: true },
      { copyIndex: 1, role: 'body', x: 100, y: 400, width: 880, height: 300, fontSize: 18, lineHeight: 1.5, fontFamily: 'Noto Sans Arabic', color: '#FDF8F3', align: 'center' },
      { copyIndex: 2, role: 'body', x: 100, y: 730, width: 880, height: 260, fontSize: 18, lineHeight: 1.5, fontFamily: 'Noto Sans Arabic', color: '#FDF8F3', align: 'center' },
      { copyIndex: 3, role: 'footer', x: 80, y: 1220, width: 920, height: 40, fontSize: 12, lineHeight: 1.4, fontFamily: 'Noto Sans Arabic', color: '#F7B500', align: 'center' },
    ],
    typeScale: { base: 12, ratio: 1.5 },
  },
];

/**
 * Negative Fixtures: Exactly the SIX Dropped Entries from packages/creative/assets/kaae-exemplars.json
 * Must all FAIL the deterministic gate on their specific, named defect.
 */
export const SIX_DROPPED_NEGATIVE_FIXTURES = [
  // 1. KAAE_Commences_2026_Cycle_1080x1350.png (formerRank 1)
  // Reason: System-generated (circular); slate-gray footer #64748B on #0A1628 fails WCAG AA (3.06:1 < 4.5:1)
  {
    name: 'KAAE_Commences_2026_Cycle_1080x1350 (Dropped: Circular & Low Contrast Footer)',
    expectedFailingMetric: 'textLegibility',
    layout: {
      version: 2 as const,
      width: 1080,
      height: 1350,
      grid: { margin: 70, columns: 12 as const, gutter: 20, baseline: 8 },
      background: { color: '#0A1628' },
      logo: { x: 440, y: 70, width: 200, height: 100 },
      shapes: [
        { x: 70, y: 360, width: 940, height: 2, color: '#F7B500', kind: 'line' as const, role: 'rule' as const },
      ],
      text: [
        { copyIndex: 0, role: 'title' as const, x: 70, y: 200, width: 940, height: 140, fontSize: 44, lineHeight: 1.3, fontFamily: 'Cairo', color: '#F7B500', align: 'center' as const, bold: true },
        { copyIndex: 1, role: 'body' as const, x: 100, y: 400, width: 880, height: 180, fontSize: 16, lineHeight: 1.5, fontFamily: 'Verdana', color: '#FDF8F3', align: 'center' as const },
        // Failing contact channel footer: #64748B on #0A1628 (3.06:1 contrast ratio)
        { copyIndex: 2, role: 'footer' as const, x: 70, y: 1220, width: 940, height: 50, fontSize: 13, lineHeight: 1.4, fontFamily: 'Verdana', color: '#64748B', align: 'center' as const },
      ],
      typeScale: { base: 14, ratio: 1.25 },
    }
  },

  // 2. kaae 5 kurdi.jpg.jpeg (formerRank 4)
  // Reason: Photograph of officials with a caption bar. Fails semanticLayout (no title/body hierarchy).
  {
    name: 'kaae 5 kurdi (Dropped: Photograph of officials with caption bar)',
    expectedFailingMetric: 'semanticLayout',
    layout: {
      version: 2 as const,
      width: 1080,
      height: 1080,
      grid: { margin: 80, columns: 12 as const, gutter: 20, baseline: 8 },
      background: { color: '#0C2340' },
      logo: { x: 80, y: 80, width: 150, height: 80 },
      shapes: [
        // Huge photo bounding box dominating canvas
        { x: 0, y: 0, width: 1080, height: 950, color: '#1B365D', kind: 'rect' as const, role: 'frame' as const },
      ],
      text: [
        // Single bottom caption bar, no title, no structured hierarchy
        { copyIndex: 0, role: 'footer' as const, x: 80, y: 980, width: 920, height: 60, fontSize: 16, lineHeight: 1.4, fontFamily: 'Noto Sans Arabic', color: '#FFFFFF', align: 'center' as const },
      ],
    }
  },

  // 3. call for kurdi.jpg.jpeg (formerRank 7)
  // Reason: Real published post but weak composition with large dead void > 25% height. Fails regularity.
  {
    name: 'call for kurdi (Dropped: Large dead area / excessive void)',
    expectedFailingMetric: 'regularity',
    layout: {
      version: 2 as const,
      width: 1080,
      height: 1350,
      grid: { margin: 80, columns: 12 as const, gutter: 20, baseline: 8 },
      background: { color: '#0A1628' },
      logo: { x: 440, y: 80, width: 200, height: 100 },
      shapes: [],
      text: [
        { copyIndex: 0, role: 'title' as const, x: 80, y: 210, width: 920, height: 100, fontSize: 40, lineHeight: 1.3, fontFamily: 'Cairo', color: '#F7B500', align: 'center' as const, bold: true },
        // Massive 420px dead void gap between title (bottom 310) and body (top 730): 420px > 1350 * 0.25 (337px)
        { copyIndex: 1, role: 'body' as const, x: 100, y: 730, width: 880, height: 260, fontSize: 18, lineHeight: 1.5, fontFamily: 'Noto Sans Arabic', color: '#FDF8F3', align: 'center' as const },
        { copyIndex: 2, role: 'footer' as const, x: 80, y: 1220, width: 920, height: 40, fontSize: 12, lineHeight: 1.4, fontFamily: 'Noto Sans Arabic', color: '#F7B500', align: 'center' as const },
      ],
      typeScale: { base: 12, ratio: 1.5 },
    }
  },

  // 4. image16.png (formerRank 10)
  // Reason: 16:9 PowerPoint presentation slide. Fails gridAppropriateness for wrong canvas genre.
  {
    name: 'image16 (Dropped: 16:9 PowerPoint slide)',
    expectedFailingMetric: 'gridAppropriateness',
    layout: {
      version: 2 as const,
      width: 1920,
      height: 1080,
      grid: { margin: 120, columns: 12 as const, gutter: 30, baseline: 8 },
      background: { color: '#0A1628' },
      logo: { x: 120, y: 100, width: 220, height: 110 },
      shapes: [{ x: 120, y: 440, width: 1680, height: 2, color: '#F7B500', kind: 'line' as const, role: 'rule' as const }],
      text: [
        { copyIndex: 0, role: 'title' as const, x: 120, y: 250, width: 1680, height: 160, fontSize: 56, lineHeight: 1.25, fontFamily: 'Cinzel', color: '#F7B500', align: 'left' as const, bold: true },
        { copyIndex: 1, role: 'subtitle' as const, x: 120, y: 480, width: 1400, height: 80, fontSize: 28, lineHeight: 1.4, fontFamily: 'Verdana', color: '#FDF8F3', align: 'left' as const },
        { copyIndex: 2, role: 'body' as const, x: 120, y: 600, width: 1400, height: 240, fontSize: 20, lineHeight: 1.5, fontFamily: 'Verdana', color: '#FDF8F3', align: 'left' as const },
        { copyIndex: 3, role: 'footer' as const, x: 120, y: 960, width: 1680, height: 40, fontSize: 14, lineHeight: 1.4, fontFamily: 'Verdana', color: '#F7B500', align: 'left' as const },
      ],
      typeScale: { base: 20, ratio: 1.414 },
    }
  },

  // 5. image17.png (formerRank 11)
  // Reason: 16:9 PowerPoint presentation slide. Fails gridAppropriateness for wrong canvas genre.
  {
    name: 'image17 (Dropped: 16:9 PowerPoint slide)',
    expectedFailingMetric: 'gridAppropriateness',
    layout: {
      version: 2 as const,
      width: 1920,
      height: 1080,
      grid: { margin: 120, columns: 12 as const, gutter: 30, baseline: 8 },
      background: { color: '#0C2340' },
      logo: { x: 120, y: 100, width: 220, height: 110 },
      shapes: [
        { x: 120, y: 480, width: 520, height: 380, color: '#1B365D', kind: 'roundRect' as const, role: 'panel' as const },
        { x: 700, y: 480, width: 520, height: 380, color: '#1B365D', kind: 'roundRect' as const, role: 'panel' as const },
        { x: 1280, y: 480, width: 520, height: 380, color: '#1B365D', kind: 'roundRect' as const, role: 'panel' as const },
      ],
      text: [
        { copyIndex: 0, role: 'title' as const, x: 120, y: 260, width: 1680, height: 130, fontSize: 50, lineHeight: 1.3, fontFamily: 'Lora', color: '#C5A059', align: 'left' as const, bold: true },
        { copyIndex: 1, role: 'body' as const, x: 150, y: 520, width: 460, height: 300, fontSize: 18, lineHeight: 1.5, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left' as const },
        { copyIndex: 2, role: 'body' as const, x: 730, y: 520, width: 460, height: 300, fontSize: 18, lineHeight: 1.5, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left' as const },
        { copyIndex: 3, role: 'body' as const, x: 1310, y: 520, width: 460, height: 300, fontSize: 18, lineHeight: 1.5, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left' as const },
        { copyIndex: 4, role: 'footer' as const, x: 120, y: 960, width: 1680, height: 40, fontSize: 14, lineHeight: 1.4, fontFamily: 'Verdana', color: '#C5A059', align: 'left' as const },
      ],
      typeScale: { base: 18, ratio: 1.333 },
    }
  },

  // 6. image19.png (formerRank 12)
  // Reason: 16:9 PowerPoint presentation slide. Fails gridAppropriateness for wrong canvas genre.
  {
    name: 'image19 (Dropped: 16:9 PowerPoint slide)',
    expectedFailingMetric: 'gridAppropriateness',
    layout: {
      version: 2 as const,
      width: 1920,
      height: 1080,
      grid: { margin: 120, columns: 12 as const, gutter: 30, baseline: 8 },
      background: { color: '#0A1628' },
      logo: { x: 120, y: 100, width: 220, height: 110 },
      shapes: [{ x: 120, y: 440, width: 1680, height: 2, color: '#F7B500', kind: 'line' as const, role: 'rule' as const }],
      text: [
        { copyIndex: 0, role: 'title' as const, x: 120, y: 250, width: 1680, height: 150, fontSize: 56, lineHeight: 1.3, fontFamily: 'Cinzel', color: '#F7B500', align: 'left' as const, bold: true },
        { copyIndex: 1, role: 'subtitle' as const, x: 120, y: 480, width: 1400, height: 80, fontSize: 28, lineHeight: 1.4, fontFamily: 'Verdana', color: '#FDF8F3', align: 'left' as const },
        { copyIndex: 2, role: 'body' as const, x: 120, y: 600, width: 1400, height: 260, fontSize: 20, lineHeight: 1.5, fontFamily: 'Verdana', color: '#FDF8F3', align: 'left' as const },
        { copyIndex: 3, role: 'footer' as const, x: 120, y: 960, width: 1680, height: 40, fontSize: 14, lineHeight: 1.4, fontFamily: 'Verdana', color: '#F7B500', align: 'left' as const },
      ],
      typeScale: { base: 20, ratio: 1.414 },
    }
  },
];

// Three Known-Bad Layouts from 09-15/16 Audits
export const BAD_BILATERAL_GRID: StudioLayoutV2 = {
  version: 2,
  width: 1080,
  height: 1350,
  grid: { margin: 70, columns: 6, gutter: 20, baseline: 8 },
  background: { color: '#0A1628' },
  logo: { x: 485, y: 70, width: 110, height: 110 },
  shapes: [
    { x: 35, y: 35, width: 1010, height: 1280, color: '#F7B500', kind: 'rect', role: 'frame' },
    { x: 65, y: 575, width: 450, height: 375, color: '#0E1F36', kind: 'rect', role: 'panel' },
    { x: 565, y: 575, width: 450, height: 375, color: '#0E1F36', kind: 'rect', role: 'panel' },
    { x: 65, y: 575, width: 450, height: 2, color: '#F7B500', kind: 'line', role: 'rule' },
    { x: 565, y: 575, width: 450, height: 2, color: '#F7B500', kind: 'line', role: 'rule' },
  ],
  text: [
    // Audit DAHVV23EF_8 defect: Disallowed font 'Arimo' (F12 violation) and jagged left alignments (80, 160, 65, 565)
    { copyIndex: 0, role: 'title', x: 80, y: 220, width: 920, height: 100, fontSize: 36, lineHeight: 1.3, fontFamily: 'Arimo', color: '#F7B500', align: 'center', bold: true },
    { copyIndex: 1, role: 'body', x: 160, y: 340, width: 760, height: 60, fontSize: 18, lineHeight: 1.4, fontFamily: 'Arimo', color: '#FDF8F3', align: 'left' },
    { copyIndex: 2, role: 'body', x: 85, y: 600, width: 410, height: 330, fontSize: 16, lineHeight: 1.4, fontFamily: 'Arimo', color: '#FDF8F3', align: 'left' },
    { copyIndex: 3, role: 'body', x: 585, y: 600, width: 410, height: 330, fontSize: 16, lineHeight: 1.4, fontFamily: 'Arimo', color: '#FDF8F3', align: 'left' },
    { copyIndex: 4, role: 'footer', x: 80, y: 1100, width: 920, height: 60, fontSize: 14, lineHeight: 1.4, fontFamily: 'Arimo', color: '#FDF8F3', align: 'center' },
  ],
  typeScale: { base: 14, ratio: 1.25 },
};

export const BAD_LOW_CONTRAST: StudioLayoutV2 = {
  version: 2,
  width: 1080,
  height: 1350,
  grid: { margin: 86, columns: 6, gutter: 20, baseline: 8 },
  background: { color: '#0A1628' }, // Midnight Navy
  logo: { x: 86, y: 86, width: 120, height: 120 },
  shapes: [],
  text: [
    {
      copyIndex: 0,
      role: 'body',
      x: 86,
      y: 300,
      width: 908,
      height: 100,
      fontSize: 18,
      lineHeight: 1.4,
      fontFamily: 'Verdana',
      color: '#1E3A5F', // Royal navy on midnight navy: 1.58:1 contrast (violates WCAG 4.5:1)
      align: 'left',
    },
  ],
};

export const BAD_OFF_GRID: StudioLayoutV2 = {
  version: 2,
  width: 1080,
  height: 1350,
  grid: { margin: 70, columns: 12, gutter: 20, baseline: 8 },
  background: { color: '#0A1628' },
  logo: { x: 33, y: 47, width: 119, height: 97 }, // Completely erratic coordinates
  shapes: [],
  text: [
    { copyIndex: 0, role: 'title', x: 19, y: 183, width: 843, height: 113, fontSize: 37, lineHeight: 1.3, fontFamily: 'Cinzel', color: '#F7B500', align: 'left' },
    { copyIndex: 1, role: 'body', x: 53, y: 341, width: 719, height: 87, fontSize: 17, lineHeight: 1.4, fontFamily: 'Verdana', color: '#FDF8F3', align: 'left' },
    { copyIndex: 2, role: 'body', x: 107, y: 499, width: 661, height: 191, fontSize: 15, lineHeight: 1.5, fontFamily: 'Verdana', color: '#FDF8F3', align: 'left' },
    { copyIndex: 3, role: 'footer', x: 41, y: 1117, width: 533, height: 49, fontSize: 13, lineHeight: 1.4, fontFamily: 'Verdana', color: '#F7B500', align: 'left' },
  ],
};

// Hand-built Degenerate Set (Three near-identical candidates)
export const DEGENERATE_SET: StudioLayoutV2[] = [
  {
    version: 2,
    width: 1080,
    height: 1350,
    grid: { margin: 70, columns: 12, gutter: 20, baseline: 8 },
    background: { color: '#0A1628' },
    logo: { x: 440, y: 70, width: 200, height: 100 },
    shapes: [],
    text: [
      { copyIndex: 0, role: 'title', x: 80, y: 200, width: 920, height: 100, fontSize: 36, lineHeight: 1.3, fontFamily: 'Cinzel', color: '#F7B500', align: 'center', bold: true },
      { copyIndex: 1, role: 'body', x: 80, y: 350, width: 920, height: 150, fontSize: 16, lineHeight: 1.5, fontFamily: 'Verdana', color: '#FFFFFF', align: 'center' },
    ],
  },
  {
    version: 2,
    width: 1080,
    height: 1350,
    grid: { margin: 70, columns: 12, gutter: 20, baseline: 8 },
    background: { color: '#0A1628' },
    logo: { x: 441, y: 70, width: 200, height: 100 },
    shapes: [],
    text: [
      { copyIndex: 0, role: 'title', x: 80, y: 201, width: 920, height: 100, fontSize: 36, lineHeight: 1.3, fontFamily: 'Cinzel', color: '#F7B500', align: 'center', bold: true },
      { copyIndex: 1, role: 'body', x: 80, y: 351, width: 920, height: 150, fontSize: 16, lineHeight: 1.5, fontFamily: 'Verdana', color: '#FFFFFF', align: 'center' },
    ],
  },
  {
    version: 2,
    width: 1080,
    height: 1350,
    grid: { margin: 70, columns: 12, gutter: 20, baseline: 8 },
    background: { color: '#0A1628' },
    logo: { x: 440, y: 71, width: 200, height: 100 },
    shapes: [],
    text: [
      { copyIndex: 0, role: 'title', x: 81, y: 200, width: 920, height: 100, fontSize: 36, lineHeight: 1.3, fontFamily: 'Cinzel', color: '#F7B500', align: 'center', bold: true },
      { copyIndex: 1, role: 'body', x: 80, y: 350, width: 920, height: 150, fontSize: 16, lineHeight: 1.5, fontFamily: 'Verdana', color: '#FFFFFF', align: 'center' },
    ],
  },
];
