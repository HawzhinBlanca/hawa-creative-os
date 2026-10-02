import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { checkCanvaPptx } from '../src/canva-pptx-check.js';
import { characterReferenceDeck as deck } from './fixtures/character-reference-deck.js';

describe('PPTX XML character references without entity double decoding', () => {
  for (const [name, source, expected] of [
    ['decimal', '&#79;&#114;&#105;&#103;&#105;&#110;&#97;&#108; 123.45', 'Original 123.45'],
    ['hexadecimal', '&#x4f;&#x72;&#x69;&#x67;&#x69;&#x6e;&#x61;&#x6c; 123.45', 'Original 123.45'],
    ['newline and tab', 'Original 123.45&#10;Exact&#9;date 2026', 'Original 123.45\nExact\tdate 2026'],
    ['supplementary Unicode', 'Launch &#x1F680; 2026', 'Launch 🚀 2026'],
    ['padded decimal', '&#' + '0'.repeat(40) + '79;riginal', 'Original'],
    ['padded hexadecimal', '&#x' + '0'.repeat(40) + '4F;riginal', 'Original'],
    ['predefined XML', 'A &amp; B &lt; &gt; &quot; &apos;', 'A & B < > " \''],
    ['escaped numeric', 'Keep &amp;#10; as copy', 'Keep &#10; as copy'],
    ['escaped named', 'Keep &amp;lt; and &amp;nbsp; as copy', 'Keep &lt; and &nbsp; as copy'],
    ['CDATA literal', '<![CDATA[Keep &#0; and &#10; as copy]]>', 'Keep &#0; and &#10; as copy'],
  ]) {
    it(`retains exact addressable source text for ${name}`, () => {
      const checked = checkCanvaPptx(deck(source), [expected]);
      expect(checked.copyPass).toBe(true); expect(checked.fontPass).toBe(true);
      expect(checked.sourceTextObjects).toEqual([{ id: 'ppt/slides/slide1.xml#2', type: 'text', text: expected,
        source: { format: 'pptx', part: 'ppt/slides/slide1.xml', shapeId: '2' } }]);
      expect(checked.fullReleasePass).toBe(false);
    });
  }

  it('uses decoded numeric attributes for observed identities, fonts and RTL metadata', () => {
    const checked = checkCanvaPptx(deck('&#x0633;&#x06B5;&#x0627;&#x0648;', 'id="&#50;"',
      '<a:pPr rtl="&#49;"/>', 'Noto Sans Arab&#105;c'), ['سڵاو'],
    { fontsByIndex: ['Noto Sans Arabic'], directionsByIndex: ['rtl'] });
    expect(checked.copyPass).toBe(true); expect(checked.fontPass).toBe(true); expect(checked.rtlMetadataPass).toBe(true);
    expect(checked.sourceTextObjects?.[0].source.shapeId).toBe('2');
    expect(checked.rtlVisualReviewRequired).toBe(true); expect(checked.fullReleasePass).toBe(false);
  });

  it('does not give decoded identity collisions or font/direction conflicts new authority', () => {
    const bytes = zipSync({ 'ppt/presentation.xml': strToU8('<p:presentation/>'),
      'ppt/slides/slide1.xml': strToU8('<p:sld><p:sp><p:nvSpPr><p:cNvPr id="&#50;"/></p:nvSpPr><p:txBody><a:p><a:r><a:rPr><a:latin typeface="Verdana"/></a:rPr><a:t>Original</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:nvPicPr><p:cNvPr id="2"/></p:nvPicPr></p:pic></p:sld>') });
    expect(checkCanvaPptx(bytes, ['Original']).sourceTextObjects).toBeNull();
    expect(checkCanvaPptx(deck('Original', 'id="2"', '', 'Ar&#105;mo'), ['Original']).fontPass).toBe(false);
    expect(checkCanvaPptx(deck('Original', 'id="2"', '<a:pPr rtl="&#49;"/>'), ['Original'],
      { directionsByIndex: ['ltr'] }).rtlPass).toBe(false);
  });

  it('does not decode HTML-only named entities or erase a real factual mismatch', () => {
    expect(checkCanvaPptx(deck('Edition &copy; 2026'), ['Edition © 2026']).copyPass).toBe(false);
    expect(checkCanvaPptx(deck('Edition&nbsp;2026'), ['Edition 2026']).copyPass).toBe(false);
    expect(checkCanvaPptx(deck('Price &#49;23.45'), ['Price 124.45']).copyPass).toBe(false);
  });

  for (const reference of ['&#0;', '&#1;', '&#xD800;', '&#xDFFF;', '&#xFFFE;', '&#xFFFF;',
    '&#1114112;', '&#x110000;', '&#x;', '&#xNO;', '&#-1;', '&#X41;', '&#65oops;', '&#65']) {
    it(`refuses invalid XML reference ${reference} rather than dropping or passing it as copy`, () => {
      expect(() => checkCanvaPptx(deck('Ori' + reference + 'ginal'), ['Original'])).toThrow(/character reference/);
    });
  }

  it('keeps DTD refusal and bounded expansion before copy admission', () => {
    expect(() => checkCanvaPptx(deck('<!DOCTYPE x [<!ENTITY x "Original">]>&x;'), ['Original'])).toThrow(/entities/);
    expect(checkCanvaPptx(deck('&#65;'.repeat(100000)), ['A'.repeat(100000)]).copyPass).toBe(true);
    expect(() => checkCanvaPptx(deck('&#65;'.repeat(100001)), ['A'.repeat(100001)])).toThrow(/reference inspection limit/);
    expect(() => checkCanvaPptx(deck('X'.repeat(9 * 1024 * 1024)), ['X'])).toThrow(/inspection limit/);
  });
});
