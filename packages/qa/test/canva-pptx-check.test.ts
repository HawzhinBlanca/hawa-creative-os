import { describe,it,expect } from 'vitest';
import { zipSync,strToU8 } from 'fflate';
import { checkCanvaPptx } from '../src/canva-pptx-check.js';
const make=(text='Exact copy &amp; facts',font='Minion Variable Concept')=>zipSync({
 'ppt/presentation.xml':strToU8('<p:presentation/>'),
 'ppt/slides/slide1.xml':strToU8(`<p:sld><p:sp><p:txBody><a:p><a:r><a:rPr><a:latin typeface="${font}"/></a:rPr><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:sld>`),
});
describe('Canva native round-trip inspection',()=>{
 it('decodes exact live text and the actual per-run font without claiming full release',()=>{
  const r=checkCanvaPptx(make(),['Exact copy & facts'],'Minion Variable Concept');expect(r.copyPass).toBe(true);expect(r.fontPass).toBe(true);expect(r.fullReleasePass).toBe(false);
 });
 it('catches the observed Canva Arimo font substitution',()=>{const r=checkCanvaPptx(make(undefined,'Arimo'),['Exact copy & facts'],'Minion Variable Concept');expect(r.copyPass).toBe(true);expect(r.fontPass).toBe(false);});
 it('fails changed punctuation, omitted copy, and missing font evidence',()=>{
  expect(checkCanvaPptx(make('Exact copy and facts'),['Exact copy & facts'],'Minion Variable Concept').copyPass).toBe(false);
  expect(checkCanvaPptx(make(),['Exact copy & facts','Another block'],'Minion Variable Concept').copyPass).toBe(false);
  expect(checkCanvaPptx(make(undefined,''),['Exact copy & facts'],'Minion Variable Concept').fontPass).toBe(false);
 });
 it('rejects compressed oversized XML and entity declarations before parsing',()=>{
  const big=zipSync({'ppt/slides/slide1.xml':new Uint8Array(9*1024*1024)});expect(()=>checkCanvaPptx(big,['x'],'Minion')).toThrow('inspection limit');
  const entity=zipSync({'ppt/presentation.xml':strToU8('<p/>'),'ppt/slides/slide1.xml':strToU8('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///private">]><p/>')});expect(()=>checkCanvaPptx(entity,['x'],'Minion')).toThrow('entities');
 });
 it('detects Kurdish complex script font in a:cs run properties', () => {
  const kurdishPptx = zipSync({
   'ppt/presentation.xml': strToU8('<p:presentation/>'),
   'ppt/slides/slide1.xml': strToU8('<p:sld><p:sp><p:txBody><a:p><a:r><a:rPr><a:cs typeface="Rabar 021"/></a:rPr><a:t>سڵاو جیهان</a:t></a:r></a:p></p:txBody></p:sp></p:sld>'),
  });
  const r = checkCanvaPptx(kurdishPptx, ['سڵاو جیهان'], 'Rabar 021');
  expect(r.copyPass).toBe(true);
  expect(r.fontPass).toBe(true);
  expect(r.observedFonts).toContain('Rabar 021');
 });
});

describe('Sorani Kurdish round-trip evidence', async () => {
  const { encodeEditableTransfer } = await import('../../creative/src/editable-transfer.js');
  const copy = ['Quality Assurance Workshop', 'وۆرکشۆپی دڵنیایی جۆری بۆ بەرپرسانی زانکۆکان'];
  const plan = {
    width: 1080, height: 1080, background: '#0A1628',
    text: [
      { copyIndex: 0, x: 80, y: 300, width: 920, height: 120, fontSize: 48, fontFamily: 'Minion Variable Concept', color: '#F7B500', align: 'center' as const },
      { copyIndex: 1, x: 80, y: 480, width: 920, height: 200, fontSize: 36, fontFamily: 'Noto Sans Arabic', color: '#FDF8F3', align: 'right' as const, rtl: true },
    ],
    shapes: [],
  };
  const { bytes } = await encodeEditableTransfer(plan, copy, undefined, { extraFonts: ['Noto Sans Arabic'] });

  it('passes fonts per script and reports right-to-left evidence', () => {
    const r = checkCanvaPptx(bytes, copy, 'Minion Variable Concept', { scriptFonts: { arabic: 'Noto Sans Arabic' } });
    expect(r.copyPass).toBe(true);
    expect(r.fontPass).toBe(true);
    expect(r.rtlPass).toBe(true);
    expect(r.arabicTextObjectCount).toBe(1);
    expect(r.rtlTextObjectCount).toBe(1);
    expect(r.observedFonts.sort()).toEqual(['Minion Variable Concept', 'Noto Sans Arabic']);
  });

  it('fails the font check when the Kurdish typeface was not admitted', () => {
    const r = checkCanvaPptx(bytes, copy, 'Minion Variable Concept');
    expect(r.fontPass).toBe(false);
    expect(r.copyPass).toBe(true);
  });
});
