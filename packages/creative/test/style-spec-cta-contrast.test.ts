import { describe, it, expect } from 'vitest';
import { applyStyleSpec, NEUTRAL_STYLE_SPEC, type StudioLayoutV2 } from '../src/index.js';
import { calculateLuminanceContrastRatio, hexToLuminance } from '../src/studio/composite-contrast.js';

/**
 * The call-to-action button (ADR-127). Its text fell back to KAAE's navy #0A1628 when the client's
 * colour failed on the button; the port made that the client's darkest colour, which for a client
 * whose darkest colour is mid-tone can itself fail, and nothing checked again (review 2026-09-28).
 */
const layout = (): StudioLayoutV2 =>
  ({
    version: 2,
    width: 1080,
    height: 1350,
    grid: { margin: 72, columns: 12, gutter: 24, baseline: 8 },
    background: { color: '#FFFFFF' },
    shapes: [],
    text: [
      { x: 72, y: 200, width: 900, height: 260, copyIndex: 0, role: 'title', fontSize: 96, lineHeight: 1.2, fontFamily: 'Verdana', color: '#333333', align: 'left', bold: true },
      { x: 72, y: 1100, width: 600, height: 60, copyIndex: 1, role: 'cta', fontSize: 40, lineHeight: 1.2, fontFamily: 'Verdana', color: '#333333', align: 'left', bold: false },
    ],
  }) as unknown as StudioLayoutV2;
const COPY = { text: { 0: 'Open day', 1: 'Register now' } };
const ratio = (a: string, b: string) => calculateLuminanceContrastRatio(hexToLuminance(a), hexToLuminance(b));

describe('the call to action on its button', () => {
  for (const palette of [['#8A8A8A', '#F2C14E'], ['#7A869A', '#E8D07A', '#FFFFFF'], ['#0A1628', '#F7B500'], []]) {
    it(`reads at 4.5:1 or better on the button for palette [${palette.join(', ')}]`, () => {
      const l = applyStyleSpec(layout(), COPY, { ...NEUTRAL_STYLE_SPEC, cta: 'gold_button' }, palette);
      const cta = l.text.find((t) => t.role === 'cta')!;
      const button = (l.shapes || []).find((s) => s.role === 'panel')!;
      expect(button).toBeTruthy();
      expect(ratio(cta.color, button.color!)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("keeps the client's own darkest colour when it passes", () => {
    const l = applyStyleSpec(layout(), COPY, { ...NEUTRAL_STYLE_SPEC, cta: 'gold_button' }, ['#0A1628', '#F7B500']);
    expect(l.text.find((t) => t.role === 'cta')!.color).toBe('#0A1628');
  });
});
