import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { encodeStudioTransferV2 } from '../src/studio/transfer-v2.js';
import { encodeEditableTransfer, type EditableTransferPlan } from '../src/editable-transfer.js';
import {
  renderLayoutV2ToSvg,
  effectiveLetterSpacingEm,
} from '../src/studio/render-layout-v2.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';

/**
 * The layout's letterSpacing is in em; pptxgenjs charSpacing is in points, and it writes the
 * OOXML attribute as spc="Math.round(charSpacing * 100)" on <a:rPr> — hundredths of a point.
 * Passing the em value straight through therefore reached Canva 12-90x too small: a Cinzel title
 * tracked 0.06em at 48px drew 2.88px in the judged preview and spc="6" (0.06pt, about 0.08px) in
 * the deck, so the tracked capitals that are this client's signature disappeared.
 */
const spcFromEm = (em: number, fontSizePx: number) => Math.round(em * fontSizePx * 0.75 * 100);

const slideXmlOf = (bytes: Buffer): string =>
  strFromU8(unzipSync(new Uint8Array(bytes))['ppt/slides/slide1.xml']);

const spcValues = (xml: string): number[] =>
  [...xml.matchAll(/spc="(-?\d+)"/g)].map((m) => Number(m[1]));

/** The <p:sp> fragments that actually carry copy, in the order the encoder wrote them (by copyIndex). */
const textShapes = (xml: string): string[] => xml.split('<p:sp>').filter((f) => f.includes('<a:t>'));

/** The letter-spacing the renderer emitted for one block, in px, or null when it drew none. */
const previewTrackingPx = (svg: string, copyIndex: number): number | null => {
  const openTag = svg.match(new RegExp(`<text id="text-copy-${copyIndex}"[^>]*>`));
  if (!openTag) throw new Error(`no rendered text block for copyIndex ${copyIndex}`);
  const attr = openTag[0].match(/letter-spacing="([\d.-]+)px"/);
  return attr ? Number(attr[1]) : null;
};

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const baseLayout = (text: StudioLayoutV2['text']): StudioLayoutV2 => ({
  width: 1080,
  height: 1350,
  background: { color: '#0A1628' },
  grid: { margin: 108, columns: 12, gutter: 24, baseline: 8 },
  shapes: [],
  text,
});

describe('letter spacing crosses to Canva as points, not as em', () => {
  it('sends a tracked Latin title to the deck and the preview at the same tracking', async () => {
    const layout = baseLayout([
      {
        copyIndex: 0,
        role: 'title',
        x: 108,
        y: 400,
        width: 864,
        height: 140,
        fontSize: 48,
        lineHeight: 1.3,
        letterSpacing: 0.06,
        fontFamily: 'Cinzel',
        color: '#FDF8F3',
        align: 'center',
      },
    ]);
    const copy = ['NATIONAL STANDARDS'];

    const encoded = await encodeStudioTransferV2(clone(layout), copy);
    // 0.06em at 48px = 2.88px = 2.16pt, which pptxgenjs writes as spc="216".
    expect(spcValues(slideXmlOf(encoded.bytes))).toEqual([216]);

    const { svg } = renderLayoutV2ToSvg(clone(layout), { copyText: { 0: copy[0] } });
    expect(previewTrackingPx(svg, 0)).toBe(2.88);

    // The two numbers are the same tracking in two units, which is the whole point of the fix.
    expect(spcFromEm(0.06, 48)).toBe(216);
    expect(Math.round(2.88 * 0.75 * 100)).toBe(216);
  });

  it('sends no tracking at all for a right-to-left block', async () => {
    const rtlLayout = baseLayout([
      {
        copyIndex: 0,
        role: 'title',
        x: 108,
        y: 400,
        width: 864,
        height: 160,
        fontSize: 44,
        lineHeight: 1.7,
        // The generator still emits tracking on Kurdish blocks; cursive scripts must never take it.
        letterSpacing: 0.05,
        fontFamily: 'Amiri',
        color: '#FDF8F3',
        align: 'right',
        rtl: true,
      },
    ]);
    const copy = ['کۆمپانیای هاوا بۆ دیزاین'];

    const encoded = await encodeStudioTransferV2(clone(rtlLayout), copy);
    expect(spcValues(slideXmlOf(encoded.bytes))).toEqual([]);

    const { svg } = renderLayoutV2ToSvg(clone(rtlLayout), { copyText: { 0: copy[0] } });
    expect(previewTrackingPx(svg, 0)).toBeNull();

    // An Arabic-script family without the rtl flag is the same case.
    const cairoLayout = clone(rtlLayout);
    cairoLayout.text[0].fontFamily = 'Cairo';
    delete cairoLayout.text[0].rtl;
    const cairo = await encodeStudioTransferV2(clone(cairoLayout), copy);
    expect(spcValues(slideXmlOf(cairo.bytes))).toEqual([]);
    expect(effectiveLetterSpacingEm(cairoLayout.text[0])).toBe(0);
  });

  it('converts em to points in the v1 editable transfer too', async () => {
    const plan: EditableTransferPlan = {
      width: 1200,
      height: 630,
      background: '#FFFFFF',
      shapes: [],
      text: [
        {
          copyIndex: 0,
          x: 100,
          y: 250,
          width: 900,
          height: 90,
          fontSize: 32,
          fontFamily: 'Inter',
          color: '#111827',
          align: 'left',
          letterSpacing: 0.06,
        },
      ],
    };

    const encoded = await encodeEditableTransfer(plan, ['Fidelity Check']);
    // 0.06em at 32px = 1.92px = 1.44pt.
    expect(spcValues(slideXmlOf(encoded.bytes))).toEqual([144]);

    const untracked = clone(plan);
    delete untracked.text[0].letterSpacing;
    const plainDeck = await encodeEditableTransfer(untracked, ['Fidelity Check']);
    expect(spcValues(slideXmlOf(plainDeck.bytes))).toEqual([]);
  });

  it('keeps preview and deck in agreement for every block of a stored layout', async () => {
    const fixturePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures/cheap-tier-overflow-1f392e16.json'
    );
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      copy: string[];
      layout: StudioLayoutV2;
    };
    const copyText = Object.fromEntries(fixture.copy.map((c, i) => [i, c]));

    const encoded = await encodeStudioTransferV2(clone(fixture.layout), fixture.copy);
    const shapes = textShapes(slideXmlOf(encoded.bytes));
    expect(shapes).toHaveLength(fixture.layout.text.length);

    const { svg } = renderLayoutV2ToSvg(clone(fixture.layout), { copyText });
    const blocks = [...fixture.layout.text].sort((a, b) => a.copyIndex - b.copyIndex);

    let tracked = 0;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const deck = spcValues(shapes[i]);
      const px = previewTrackingPx(svg, block.copyIndex);
      if (px === null) {
        expect(deck, `copyIndex ${block.copyIndex} must send no tracking`).toEqual([]);
        continue;
      }
      tracked++;
      const expected = Math.round(px * 0.75 * 100);
      expect(new Set(deck), `copyIndex ${block.copyIndex} tracking`).toEqual(new Set([expected]));
    }
    // The fixture is only a guard if some of its blocks are actually tracked.
    expect(tracked).toBeGreaterThan(0);
  });
});

// An eyebrow whose copy wraps is shrunk by the renderer until it fits on one line, and its tracking
// is dropped in the same step. The deck keeps the block's declared size and tracking, so the two
// diverge; before the units were fixed the divergence was invisible (0.04pt) rather than absent.
// Recorded here so the next change to eyebrow autofit closes it deliberately.
