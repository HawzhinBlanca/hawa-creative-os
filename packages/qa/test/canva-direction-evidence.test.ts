import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { checkCanvaPptx } from '../src/canva-pptx-check.js';

const root = new URL('../../../output/acceptance/2026-09-27-canva-locale/', import.meta.url);
const fixtures = JSON.parse(readFileSync(new URL('fixtures.json', root), 'utf8'));
const copy = (index: number): string[] => fixtures.groups[index].cases.map((c: { text: string }) => c.text);
const wide = readFileSync(new URL('locale-v1-canva.pptx', root));
const styled = readFileSync(new URL('locale-v2-canva.pptx', root));
const options = { allowedFontsByScript: { latin: ['Noto Sans Arabic', 'Cairo', 'Verdana'], arabic: ['Noto Sans Arabic', 'Cairo'] } };
const change = (bytes: Uint8Array, alter: (xml: string) => string) => {
  const files = unzipSync(bytes);
  files['ppt/slides/slide1.xml'] = strToU8(alter(strFromU8(files['ppt/slides/slide1.xml'])));
  return zipSync(files);
};

describe('real Canva paragraph direction evidence', () => {
  it('reads true booleans and preserves the legitimate Latin-leading mixed block', () => {
    const r = checkCanvaPptx(wide, copy(0), options);
    expect(r).toMatchObject({ copyPass: true, fontPass: true, rtlTextObjectCount: 8, arabicTextObjectCount: 9,
      rtlPass: true, rtlMetadataPass: null, rtlVisualReviewRequired: true });
    expect(r.rtlNote).not.toMatch(/attribute absent/);
    expect(r.fullReleasePass).toBe(false);
  });
  it.each(['1', 'true'])('reads both XML true spellings (%s) equivalently', value => {
    const bytes = change(styled, xml => xml.replaceAll('rtl="true"', `rtl="${value}"`));
    expect(checkCanvaPptx(bytes, copy(1), options)).toMatchObject({ rtlTextObjectCount: 3, rtlPass: true, rtlVisualReviewRequired: true });
  });
  it.each(['0', 'false', 'invalid'])('does not call an explicit %s flag missing or let human review waive a conflict', value => {
    const bytes = change(wide, xml => xml.replaceAll('rtl="true"', `rtl="${value}"`));
    expect(checkCanvaPptx(bytes, copy(0), options)).toMatchObject({ rtlPass: false, rtlMetadataPass: false });
  });
  it('checks the second paragraph even when the first paragraph is correctly flagged', () => {
    let n = 0;
    const bytes = change(styled, xml => xml.replace(/rtl="true"/g, value => ++n === 2 ? 'rtl="false"' : value));
    const r = checkCanvaPptx(bytes, copy(1), { ...options, directionsByIndex: ['rtl', 'rtl', 'ltr', 'rtl'] });
    expect(r).toMatchObject({ rtlPass: false, rtlMetadataPass: false });
  });
  it('checks frozen explicit LTR for mixed text instead of deciding direction from script', () => {
    const r = checkCanvaPptx(styled, copy(1), { ...options, directionsByIndex: ['rtl', 'rtl', 'ltr', 'ltr'] });
    expect(r).toMatchObject({ rtlPass: false, rtlMetadataPass: false });
  });
  it('keeps the corrected native LTR roundtrip eligible for visual review without inventing metadata proof', () => {
    const capture = new URL('../../../output/acceptance/2026-09-27-explicit-direction/', import.meta.url);
    const sheet = JSON.parse(readFileSync(new URL('fixtures.json', capture), 'utf8')).groups[0];
    const bytes = readFileSync(new URL('direction-v2-canva.pptx', capture));
    const r = checkCanvaPptx(bytes, sheet.cases.map((c: { text: string }) => c.text), {
      ...options, directionsByIndex: ['rtl', 'rtl', 'ltr', 'ltr', 'ltr', 'ltr'],
    });
    expect(r).toMatchObject({ copyPass: true, fontPass: true, rtlPass: true, rtlMetadataPass: null,
      rtlVisualReviewRequired: true, directionViolations: [], fullReleasePass: false });
    expect(r.paragraphDirections.filter(p => p.expected === 'ltr')).toHaveLength(8);
    expect(r.paragraphDirections.filter(p => p.expected === 'ltr').every(p => p.observed === 'absent')).toBe(true);
  });
  it('reports unknown for genuinely missing Canva metadata and refuses invalid policy cardinality', () => {
    const bytes = change(wide, xml => xml.replaceAll(' rtl="true"', ''));
    expect(checkCanvaPptx(bytes, copy(0), options)).toMatchObject({ rtlPass: true, rtlMetadataPass: null, rtlVisualReviewRequired: true });
    expect(() => checkCanvaPptx(wide, copy(0), { ...options, directionsByIndex: ['rtl'] })).toThrow(/direction/i);
  });
});
