import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { encodeEditableTransfer } from '../src/editable-transfer.js';

const copy = ['Quality Assurance Workshop', 'وۆرکشۆپی دڵنیایی جۆری بۆ بەرپرسانی زانکۆکان، ٢٨ی ئەیلوول ٢٠٢٦'];
const plan = {
  width: 1080, height: 1080, background: '#0A1628',
  text: [
    { copyIndex: 0, x: 80, y: 300, width: 920, height: 120, fontSize: 48, fontFamily: 'Verdana', color: '#F7B500', align: 'center' as const, bold: true },
    { copyIndex: 1, x: 80, y: 480, width: 920, height: 200, fontSize: 36, fontFamily: 'Noto Sans Arabic', color: '#FDF8F3', align: 'left' as const, rtl: true },
  ],
  shapes: [],
};

describe('editable transfer: Sorani Kurdish blocks', () => {
  it('writes a right-to-left, right-aligned Kurdish run in the admitted script typeface', async () => {
    const out = await encodeEditableTransfer(plan, copy, undefined, { extraFonts: ['Noto Sans Arabic'], copyLocales: ['en', 'ckb'] });
    const files = unzipSync(out.bytes, { filter: (f) => f.name === 'ppt/slides/slide1.xml' });
    const xml = strFromU8(files['ppt/slides/slide1.xml']);
    const kurdish = xml.slice(xml.indexOf('وۆرکشۆپی') - 900, xml.indexOf('وۆرکشۆپی'));
    expect(kurdish).toContain('rtl="1"');
    expect(kurdish).toContain('algn="r"');
    expect(kurdish).toContain('lang="ckb"');
    expect(kurdish).toContain('<a:cs typeface="Noto Sans Arabic"');
    const english = xml.slice(xml.indexOf('Quality Assurance') - 900, xml.indexOf('Quality Assurance'));
    expect(english).not.toContain('rtl="1"');
    expect(english).toContain('typeface="Verdana"');
    expect(out.manifest.rtlBlocks).toEqual([1]);
  });

  it('refuses a script typeface the reference pack did not admit', async () => {
    const badPlan = { ...plan, text: [plan.text[0], { ...plan.text[1], fontFamily: 'UnadmittedScriptFont' }] };
    await expect(encodeEditableTransfer(badPlan, copy)).rejects.toThrow('Unsupported font');
  });
});
