import { describe, expect, it } from 'vitest';
import { encodeEditableTransfer } from '@hawa/creative';
import { checkCanvaPptx } from '@hawa/qa';
import { studioSentBlocks } from '../src/services/canva-connect-service.js';

const copy = ['چوارچێوەی ستانداردەکانی پەروەردە (R1.BL)', 'ئێستا لە kaae.org بەردەستە'];
const reference = { rules: { fontFamily: 'Verdana', scriptFonts: { arabic: 'Noto Sans Arabic' } } };
const text = copy.map((_, copyIndex) => ({ copyIndex, x: 20, y: 20 + copyIndex * 180,
  width: 600, height: 140, fontSize: 24, fontFamily: 'Noto Sans Arabic', color: '#000000',
  align: 'right' as const, rtl: true, role: copyIndex === 0 ? 'headline' : 'body' }));
const manifest = { copy, reference, plan: { text } };

describe('immutable imported font plan authority', () => {
  it('checks intact mixed-script planner bytes against the actual per-block faces', async () => {
    const source = await encodeEditableTransfer({ width: 640, height: 640, background: '#FFFFFF', shapes: [], text }, copy);
    expect(checkCanvaPptx(source.bytes, copy, 'Verdana', { scriptFonts: reference.rules.scriptFonts }).fontPass).toBe(false);
    const blocks = studioSentBlocks(manifest);
    expect(blocks).not.toBeNull();
    if (!blocks) throw new Error('A complete indexed planner source must retain its sent font policy');
    const checked = checkCanvaPptx(source.bytes, copy, { fontsByIndex: blocks.map(block => block.fontFamily) });
    expect(checked.copyPass).toBe(true);
    expect(checked.fontPass).toBe(true);
    expect(checked.fullReleasePass).toBe(false);
    expect(checked.rtlVisualReviewRequired).toBe(true);
  });

  it('orders a complete source by copy identity while retaining distinct approved display/body choices', () => {
    const source = { copy: ['Title', 'Body'], reference,
      plan: { text: [{ copyIndex: 1, fontFamily: 'Verdana', role: 'body' }, { copyIndex: 0, fontFamily: 'Cinzel', role: 'headline' }] } };
    expect(studioSentBlocks(source)?.map(block => block.fontFamily)).toEqual(['Cinzel', 'Verdana']);
    expect(source.plan.text[0].copyIndex).toBe(1);
  });

  it.each([
    { name: 'duplicate indices', text: [{ copyIndex: 0, fontFamily: 'Verdana' }, { copyIndex: 0, fontFamily: 'Verdana' }] },
    { name: 'foreign index', text: [{ copyIndex: 0, fontFamily: 'Verdana' }, { copyIndex: 2, fontFamily: 'Verdana' }] },
    { name: 'missing index', text: [{ fontFamily: 'Verdana' }, { copyIndex: 1, fontFamily: 'Verdana' }] },
    { name: 'null block', text: [null, { copyIndex: 1, fontFamily: 'Verdana' }] },
    { name: 'blank family', text: [{ copyIndex: 0, fontFamily: ' ' }, { copyIndex: 1, fontFamily: 'Verdana' }] },
    { name: 'missing family', text: [{ copyIndex: 0 }, { copyIndex: 1, fontFamily: 'Verdana' }] },
  ])('refuses $name rather than assigning an ambiguous sent face', ({ text: blocks }) => {
    expect(studioSentBlocks({ copy: ['Title', 'Body'], plan: { text: blocks } })).toBeNull();
  });

  it('retains the explicit historical reference-only path when no plan was recorded', () => {
    expect(studioSentBlocks({ copy: ['Title'], reference })).toBeNull();
  });

  it('still rejects substitution in a used Latin fragment of the Arabic block', async () => {
    const source = await encodeEditableTransfer({ width: 640, height: 640, background: '#FFFFFF', shapes: [],
      text: [{ ...text[0], fontFamily: 'Verdana' }, text[1]] }, copy);
    const checked = checkCanvaPptx(source.bytes, copy, { fontsByIndex: text.map(block => block.fontFamily) });
    expect(checked.copyPass).toBe(true);
    expect(checked.fontPass).toBe(false);
    expect(checked.offendingObjects.some(object => object.index === 0)).toBe(true);
  });
});
