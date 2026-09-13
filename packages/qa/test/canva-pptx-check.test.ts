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
