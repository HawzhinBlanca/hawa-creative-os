import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { checkCanvaPptx } from '../src/canva-pptx-check.js';

/**
 * ADR-275: a poster title set in capitals keeps the requester's copy exactly as typed. Canva may hand
 * it back as typed under cap="all", or with the capitals written into the text; only a block the
 * imported plan set in capitals is compared without regard to case. Every other block stays exact,
 * and a cap run that would show capitals the requester did not type is refused.
 */
const run = (text: string, face: string, cap?: string) =>
  `<a:r><a:rPr lang="en-US"${cap ? ` cap="${cap}"` : ''}><a:latin typeface="${face}"/></a:rPr><a:t>${text}</a:t></a:r>`;
const shape = (id: number, runs: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/></p:nvSpPr><p:txBody><a:p>${runs}</a:p></p:txBody></p:sp>`;
const deck = (...shapes: string[]) => zipSync({
  'ppt/presentation.xml': strToU8('<p:presentation/>'),
  'ppt/slides/slide1.xml': strToU8(`<p:sld>${shapes.join('')}</p:sld>`),
});

const COPY = ['Peer Review Week', 'Join KAAE’s network of peer evaluators.'];
const FONTS = ['Inter', 'Inter'];
const CAPS = [true, false];

describe('exact copy for blocks set in capitals (ADR-275)', () => {
  it('passes the deck as sent: the typed copy under cap="all" in the weighted face', () => {
    const sent = deck(shape(2, run('Peer Review Week', 'Inter ExtraBold', 'all')), shape(3, run(COPY[1], 'Inter')));
    const r = checkCanvaPptx(sent, COPY, { fontsByIndex: FONTS, uppercaseByIndex: CAPS });
    expect(r.copyPass).toBe(true);
    expect(r.fontPass).toBe(true);
    expect(r.shownTexts[0]).toBe('PEER REVIEW WEEK');
    expect(r.uppercaseByIndex).toEqual(CAPS);
    expect(r.checkVersion).toBe(10);
  });

  it('passes the capitals written into the text, for the capitals block only', () => {
    const baked = deck(shape(2, run('PEER REVIEW WEEK', 'Inter ExtraBold')), shape(3, run(COPY[1], 'Inter')));
    expect(checkCanvaPptx(baked, COPY, { fontsByIndex: FONTS, uppercaseByIndex: CAPS }).copyPass).toBe(true);
    // Without the policy the same text is a changed copy.
    expect(checkCanvaPptx(baked, COPY, { fontsByIndex: FONTS }).copyPass).toBe(false);
  });

  it('keeps every other block exact: a changed case or a cap run on it fails', () => {
    const recased = deck(shape(2, run('PEER REVIEW WEEK', 'Inter ExtraBold')), shape(3, run('JOIN KAAE’S NETWORK OF PEER EVALUATORS.', 'Inter')));
    expect(checkCanvaPptx(recased, COPY, { fontsByIndex: FONTS, uppercaseByIndex: CAPS }).copyPass).toBe(false);
    const capRun = deck(shape(2, run('Peer Review Week', 'Inter ExtraBold', 'all')), shape(3, run(COPY[1], 'Inter', 'all')));
    expect(checkCanvaPptx(capRun, COPY, { fontsByIndex: FONTS, uppercaseByIndex: CAPS }).copyPass).toBe(false);
    // A cap run on a capitals block, absent the policy, would show copy the requester did not type.
    const sent = deck(shape(2, run('Peer Review Week', 'Inter ExtraBold', 'all')), shape(3, run(COPY[1], 'Inter')));
    expect(checkCanvaPptx(sent, COPY, { fontsByIndex: FONTS }).copyPass).toBe(false);
  });

  it('still refuses different words in capitals', () => {
    const wrong = deck(shape(2, run('PEER REVIEW MONTH', 'Inter ExtraBold')), shape(3, run(COPY[1], 'Inter')));
    expect(checkCanvaPptx(wrong, COPY, { fontsByIndex: FONTS, uppercaseByIndex: CAPS }).copyPass).toBe(false);
  });

  it('accepts Inter\'s weighted family names as Inter, and nothing else', () => {
    for (const face of ['Inter ExtraBold', 'Inter Black', 'Inter SemiBold']) {
      const sent = deck(shape(2, run('Peer Review Week', face, 'all')), shape(3, run(COPY[1], 'Inter')));
      expect(checkCanvaPptx(sent, COPY, { fontsByIndex: FONTS, uppercaseByIndex: CAPS }).fontPass, face).toBe(true);
    }
    const other = deck(shape(2, run('Peer Review Week', 'Interstate Black', 'all')), shape(3, run(COPY[1], 'Inter')));
    expect(checkCanvaPptx(other, COPY, { fontsByIndex: FONTS, uppercaseByIndex: CAPS }).fontPass).toBe(false);
  });

  it('refuses a malformed capitals policy', () => {
    const sent = deck(shape(2, run('Peer Review Week', 'Inter')), shape(3, run(COPY[1], 'Inter')));
    expect(() => checkCanvaPptx(sent, COPY, { fontsByIndex: FONTS, uppercaseByIndex: [true] })).toThrow(/capitals policy/);
    expect(() => checkCanvaPptx(sent, COPY, { fontsByIndex: FONTS, uppercaseByIndex: ['yes', false] as unknown as boolean[] })).toThrow(/capitals policy/);
  });
});
