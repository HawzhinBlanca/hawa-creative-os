import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';
import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { encodeStudioTransferV2 } from '../src/studio/transfer-v2.js';
import { renderLayoutV2ToSvg } from '../src/studio/render-layout-v2.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';

/**
 * Bug hunt 2026-09-24: an eyebrow that does not fit on one line is drawn in the preview (which QA and
 * the judge score, and which the requester approved) one line long, at a smaller size and with no
 * tracking. The deck sent to Canva keeps the original size and tracking, so Canva wraps it onto a
 * second line that the approved design does not have.
 */
const slideXmlOf = (bytes: Buffer): string => strFromU8(unzipSync(new Uint8Array(bytes))['ppt/slides/slide1.xml']);
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('HUNT: an eyebrow shrunk to one line in the preview', () => {
  it('reaches Canva at the size and tracking the preview drew', async () => {
    const layout: StudioLayoutV2 = {
      width: 1080,
      height: 1350,
      background: { color: '#0A1628' },
      grid: { margin: 108, columns: 12, gutter: 24, baseline: 8 },
      shapes: [],
      text: [
        { copyIndex: 0, role: 'eyebrow', x: 108, y: 200, width: 520, height: 48, fontSize: 30, lineHeight: 1.2, letterSpacing: 0.04, fontFamily: 'Verdana', color: '#FDF8F3', align: 'left' },
        { copyIndex: 1, role: 'title', x: 108, y: 260, width: 864, height: 160, fontSize: 64, lineHeight: 1.1, fontFamily: 'Verdana', color: '#FDF8F3', align: 'left' },
      ],
    } as StudioLayoutV2;
    const copy = ['KAAE ANNUAL ACCREDITATION FORUM', 'Quality in Higher Education'];

    const { svg } = renderLayoutV2ToSvg(clone(layout), { logoDataUri: KAAE_TEST_LOGO, copyText: { 0: copy[0], 1: copy[1] } });
    const eyebrowTag = svg.match(/<text id="text-copy-0"[^>]*>/)?.[0] || '';
    const previewPx = Number(eyebrowTag.match(/font-size="([\d.]+)(px)?"/)?.[1]);
    const previewTracked = /letter-spacing="[\d.]+px"/.test(eyebrowTag);
    expect(previewPx).toBeLessThan(30); // the preview shrank it to keep one line

    const deck = slideXmlOf((await encodeStudioTransferV2(clone(layout), copy)).bytes);
    const eyebrowShape = deck.split('<p:sp>').find((f) => f.includes('KAAE ANNUAL')) || '';
    const deckSz = Number(eyebrowShape.match(/ sz="(\d+)"/)?.[1]);
    const deckSpc = Number(eyebrowShape.match(/ spc="(-?\d+)"/)?.[1] || 0);

    expect({ sizePt: deckSz / 100, tracked: deckSpc > 0 }).toEqual({ sizePt: previewPx * 0.75, tracked: previewTracked });
  });
});
