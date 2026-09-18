import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { encodeStudioTransferV2, studioLayoutV2ToTransferPlan } from '../src/studio/transfer-v2.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';

describe('encodeStudioTransferV2 robustness & tolerance', () => {
  const baseLayout: StudioLayoutV2 = {
    width: 1080,
    height: 1080,
    background: { color: '#0A1628' },
    grid: { margin: 64, columns: 12, gutter: 16, baseline: 8 },
    shapes: [],
    text: [
      {
        copyIndex: 0,
        role: 'title',
        x: 64,
        y: 100,
        width: 952,
        height: 120,
        fontSize: 48,
        fontFamily: 'cinzel', // lowercase
        color: '#FFFFFF',
        align: 'center',
        bold: true,
      },
      {
        copyIndex: 1,
        role: 'subtitle',
        x: 64,
        y: 240,
        width: 952,
        height: 80,
        fontSize: 28,
        fontFamily: 'Cairo',
        color: '#E2E8F0',
        align: 'center',
      },
    ],
  };

  const copy = ['Official Gala 2026', 'بەخێربێن بۆ ئاهەنگی ساڵانە'];

  it('accepts valid fonts with lowercase or mixed-case casing and normalizes to canonical casing', async () => {
    const res = await encodeStudioTransferV2(baseLayout, copy);
    expect(res.bytes).toBeDefined();
    expect(res.sha256).toHaveLength(64);
    expect(baseLayout.text[0].fontFamily).toBe('Cinzel');
  });

  it('tolerates minor floating-point overages within 0.5px epsilon and clamps bounds', async () => {
    const overageLayout: StudioLayoutV2 = {
      ...baseLayout,
      text: [
        {
          ...baseLayout.text[0],
          x: 0,
          width: 1080.3, // 0.3px over canvas width
        },
        baseLayout.text[1],
      ],
    };

    const res = await encodeStudioTransferV2(overageLayout, copy);
    expect(res.bytes).toBeDefined();
    expect(overageLayout.text[0].width).toBeLessThanOrEqual(1080);
  });

  it('permits large poster font sizes up to 25% canvas height without crashing', async () => {
    const posterLayout: StudioLayoutV2 = {
      width: 1920,
      height: 1080,
      background: { color: '#000000' },
      grid: { margin: 80, columns: 12, gutter: 20, baseline: 8 },
      shapes: [],
      text: [
        {
          copyIndex: 0,
          role: 'title',
          x: 80,
          y: 100,
          width: 1760,
          height: 300,
          fontSize: 220, // > 160, within 25% of 1080 (270px)
          fontFamily: 'Inter',
          color: '#FFFFFF',
          align: 'left',
          bold: true,
        },
        {
          copyIndex: 1,
          role: 'body',
          x: 80,
          y: 450,
          width: 800,
          height: 100,
          fontSize: 32,
          fontFamily: 'Inter',
          color: '#CCCCCC',
          align: 'left',
        },
      ],
    };

    const res = await encodeStudioTransferV2(posterLayout, copy);
    expect(res.bytes).toBeDefined();
  });

  it('correctly marks Cairo font blocks as RTL in transfer plan', () => {
    const plan = studioLayoutV2ToTransferPlan(baseLayout);
    expect(plan.text[1].rtl).toBe(true);
  });

  it('writes each block\'s line pitch in exact points, never as a multiple of the font\'s own line height', async () => {
    // A multiple is read against the font's natural line height (~1.33 em for Playfair Display), so
    // Canva drew titles ~30% looser than rendered and clipped the last line (task b6621947).
    const layout = { ...baseLayout, text: [{ ...baseLayout.text[0], fontFamily: 'Playfair Display', fontSize: 41, lineHeight: 1.3 }, baseLayout.text[1]] };
    const res = await encodeStudioTransferV2(layout as StudioLayoutV2, copy);
    const slide = strFromU8(unzipSync(new Uint8Array(res.bytes))['ppt/slides/slide1.xml']);
    expect(slide).not.toContain('<a:spcPct');
    // 41px x 1.3 = 53.3px = 39.98pt, written in hundredths of a point.
    expect(slide).toContain('<a:lnSpc><a:spcPts val="3998"/></a:lnSpc>');
  });
});
