import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { encodeStudioTransferV2, studioLayoutV2ToTransferPlan } from '../src/studio/transfer-v2.js';
import { encodeEditableTransfer } from '../src/editable-transfer.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';

describe('R08 Transfer Fidelity & Feature Preservation', () => {
  it('preserves exact audit fixture visual properties: ellipse, rotation, alpha, stroke, and text properties in DrawingML XML', async () => {
    const layout: StudioLayoutV2 = {
      width: 1080,
      height: 1080,
      background: { color: '#FFFFFF' },
      grid: { margin: 40, columns: 12, gutter: 12, baseline: 8 },
      shapes: [
        {
          kind: 'ellipse',
          x: 100,
          y: 100,
          width: 120,
          height: 120,
          color: '#FF0000',
          opacity: 0.2,
          rotation: 45,
          strokeWidth: 5,
          strokeColor: '#0000FF',
          role: 'accent',
        },
      ],
      text: [
        {
          copyIndex: 0,
          role: 'title',
          x: 100,
          y: 300,
          width: 800,
          height: 100,
          fontSize: 40,
          lineHeight: 1.3,
          fontFamily: 'Arial',
          color: '#000000',
          align: 'left',
          letterSpacing: 0.1,
          opacity: 0.3,
        },
      ],
    };

    const encoded = await encodeStudioTransferV2(layout, ['Audit fixture text']);
    expect(encoded.bytes).toBeDefined();

    // Verify manifest plan shape fidelity
    const manifestShape = encoded.manifest.plan.shapes[0];
    expect(manifestShape.kind).toBe('ellipse');
    expect(manifestShape.rotation).toBe(45);
    expect(manifestShape.opacity).toBe(0.2);
    expect(manifestShape.strokeWidth).toBe(5);
    expect(manifestShape.strokeColor).toBe('#0000FF');

    const manifestText = encoded.manifest.plan.text[0];
    expect(manifestText.opacity).toBe(0.3);
    expect(manifestText.letterSpacing).toBe(0.1);

    // Unzip and inspect PPTX DrawingML XML
    const unzipped = unzipSync(new Uint8Array(encoded.bytes));
    const slideXml = strFromU8(unzipped['ppt/slides/slide1.xml']);

    // 1. Shape Geometry: prst="ellipse" (NOT hardcoded rect)
    expect(slideXml).toContain('prst="ellipse"');

    // 2. Rotation: 45 degrees in 60,000ths of a degree = 2,700,000
    expect(slideXml).toContain('rot="2700000"');

    // 3. Shape Fill Alpha: 0.2 opacity = 20,000 / 100,000
    expect(slideXml).toContain('<a:alpha val="20000"');

    // 4. Blue Stroke: #0000FF
    expect(slideXml).toContain('0000FF');

    // 5. Text Alpha: 0.3 opacity = 30,000 / 100,000
    expect(slideXml).toContain('<a:alpha val="30000"');

    // 6. Text Character Spacing: spc attribute present in DrawingML
    expect(slideXml).toContain('spc="');
  });

  it('supports roundRect and line shapes with stroke and rotation', async () => {
    const layout: StudioLayoutV2 = {
      width: 1080,
      height: 1080,
      background: { color: '#0A1628' },
      grid: { margin: 40, columns: 12, gutter: 12, baseline: 8 },
      shapes: [
        {
          kind: 'roundRect',
          x: 50,
          y: 50,
          width: 200,
          height: 100,
          color: '#10B981',
          opacity: 0.8,
          rotation: 15,
          strokeWidth: 2,
          strokeColor: '#FFFFFF',
          role: 'badge',
        },
        {
          kind: 'line',
          x: 50,
          y: 200,
          width: 980,
          height: 4,
          color: '#F59E0B',
          opacity: 1,
          role: 'divider',
        },
      ],
      text: [
        {
          copyIndex: 0,
          role: 'title',
          x: 50,
          y: 250,
          width: 980,
          height: 100,
          fontSize: 36,
          fontFamily: 'Cairo',
          color: '#FFFFFF',
          align: 'center',
          italic: true,
        },
      ],
    };

    const encoded = await encodeStudioTransferV2(layout, ['خزمەتگوزارییەکان']);
    const slideXml = strFromU8(unzipSync(new Uint8Array(encoded.bytes))['ppt/slides/slide1.xml']);

    expect(slideXml).toContain('prst="roundRect"');
    expect(slideXml).toContain('prst="line"');
    // 15 degrees = 900,000
    expect(slideXml).toContain('rot="900000"');
    // 0.8 opacity = 80,000
    expect(slideXml).toContain('<a:alpha val="80000"');
    // Italic text
    expect(slideXml).toContain('i="1"');
  });

  it('preserves Kurdish Sorani RTL text blocks with Cairo font and right alignment', async () => {
    const layout: StudioLayoutV2 = {
      width: 1080,
      height: 1080,
      background: { color: '#0F172A' },
      grid: { margin: 64, columns: 12, gutter: 16, baseline: 8 },
      shapes: [],
      text: [
        {
          copyIndex: 0,
          role: 'title',
          x: 64,
          y: 120,
          width: 952,
          height: 140,
          fontSize: 48,
          lineHeight: 1.4,
          fontFamily: 'Cairo',
          color: '#F8FAFC',
          align: 'right',
          bold: true,
        },
      ],
    };

    const copy = ['کۆمپانیای هاوا بۆ دیزاین و تەکنەلۆژیا'];
    const plan = studioLayoutV2ToTransferPlan(layout);
    expect(plan.text[0].rtl).toBe(true);

    const encoded = await encodeStudioTransferV2(layout, copy);
    const slideXml = strFromU8(unzipSync(new Uint8Array(encoded.bytes))['ppt/slides/slide1.xml']);

    // PPTX DrawingML right alignment
    expect(slideXml).toContain('algn="r"');
    // Arabic typeface
    expect(slideXml).toContain('typeface="Cairo"');
  });

  it('supports direct encodeEditableTransfer with full geometry and formatting fidelity', async () => {
    const transferPlan: EditableTransferPlan = {
      width: 1200,
      height: 630,
      background: '#FFFFFF',
      shapes: [
        {
          kind: 'ellipse',
          x: 100,
          y: 100,
          width: 150,
          height: 150,
          color: '#3B82F6',
          opacity: 0.5,
          rotation: 30,
          strokeColor: '#1D4ED8',
          strokeWidth: 3,
        },
        {
          kind: 'roundRect',
          x: 300,
          y: 100,
          width: 200,
          height: 80,
          color: '#EC4899',
        },
      ],
      text: [
        {
          copyIndex: 0,
          x: 100,
          y: 350,
          width: 600,
          height: 80,
          fontSize: 32,
          fontFamily: 'Inter',
          color: '#111827',
          align: 'left',
          bold: true,
          italic: true,
          opacity: 0.75,
          letterSpacing: 2,
        },
      ],
    };

    const encoded = await encodeEditableTransfer(transferPlan, ['Fidelity Check']);
    expect(encoded.bytes).toBeDefined();

    const slideXml = strFromU8(unzipSync(new Uint8Array(encoded.bytes))['ppt/slides/slide1.xml']);
    expect(slideXml).toContain('prst="ellipse"');
    expect(slideXml).toContain('prst="roundRect"');
    // 30 degrees = 1,800,000
    expect(slideXml).toContain('rot="1800000"');
    // 0.5 opacity = 50,000
    expect(slideXml).toContain('<a:alpha val="50000"');
    // 0.75 opacity = 75,000
    expect(slideXml).toContain('<a:alpha val="75000"');
    // Stroke
    expect(slideXml).toContain('1D4ED8');
    // Italic
    expect(slideXml).toContain('i="1"');
    // Letter spacing
    expect(slideXml).toContain('spc="200"');
  });

  it('rejects unsupported fonts with clear validation errors instead of silent corruption', async () => {
    const invalidLayout: StudioLayoutV2 = {
      width: 1080,
      height: 1080,
      background: { color: '#000000' },
      grid: { margin: 40, columns: 12, gutter: 12, baseline: 8 },
      shapes: [],
      text: [
        {
          copyIndex: 0,
          role: 'title',
          x: 100,
          y: 100,
          width: 800,
          height: 100,
          fontSize: 40,
          fontFamily: 'ComicSansMS_NotAllowed',
          color: '#FFFFFF',
          align: 'left',
        },
      ],
    };

    await expect(encodeStudioTransferV2(invalidLayout, ['Title'])).rejects.toThrow(/Unsupported font/i);
  });
});
