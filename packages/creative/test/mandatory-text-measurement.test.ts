import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluateHardQa, type HardQaContext } from '../src/studio/hard-qa.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';
import { measureTextGeometry } from '../src/studio/render-layout-v2.js';

const dirs: string[] = [];
function folder() { const p = mkdtempSync(join(tmpdir(), 'hawa-required-measurement-')); dirs.push(p); return p; }
afterEach(() => { for (const p of dirs.splice(0)) rmSync(p, {recursive: true, force: true}); });

const copy = { 0: 'Mandatory Quality Standards 2026' };
const context: HardQaContext = { width: 1080, height: 1350, copyScripts: ['latin'], latinFont: 'Verdana',
  arabicFont: 'Noto Sans Arabic', palette: ['#0A1628', '#FFFFFF'], logoAspect: 1 };
function layout(): StudioLayoutV2 {
  return {version: 2, width: 1080, height: 1350, grid: {margin: 76, columns: 6, gutter: 26, baseline: 8},
    background: {color: '#0A1628'}, shapes: [], logo: {x: 480, y: 80, width: 120, height: 120},
    text: [{copyIndex: 0, role: 'title', x: 76, y: 360, width: 928, height: 100,
      fontFamily: 'Playfair Display', fontSize: 72, lineHeight: 1.35, color: '#FFFFFF', align: 'center', bold: true}]};
}

describe('mandatory text measurement', () => {
  it.each([undefined, {}, {0: ''}, {0: '   '}] as Array<Record<number, string> | undefined>)('cannot pass by omitting required copy (%j)', (copyText) => {
    expect(evaluateHardQa(layout(), {...context, copyText: copy}).defectCodes).toContain('COPY_OVERFLOW');
    const qa = evaluateHardQa(layout(), {...context, copyText});
    expect(qa.passed).toBe(false);
    expect(qa.defectCodes).toContain('COPY_UNMEASURED');
    expect(qa.textMeasurements[0]).toMatchObject({status: 'unmeasured', reason: copyText?.[0] !== undefined ? 'EMPTY_COPY' : 'MISSING_COPY'});
  });

  it('refuses inherited text instead of measuring a prototype value', () => {
    const inherited = Object.create(copy) as Record<number, string>;
    expect(measureTextGeometry(layout(), inherited)[0]).toMatchObject({status: 'unmeasured', reason: 'MISSING_COPY'});
  });

  it('reports missing/corrupt font evidence and recovers only after actual bytes return', () => {
    const dir = folder(), candidate = layout();
    candidate.text[0].fontFamily = 'Noto Sans Arabic';
    candidate.text[0].bold = false;
    candidate.text[0].fontSize = 32;
    const text = {0: 'ڕێنمایی زانکۆی کوردستان'};
    const ctx = {...context, copyScripts: ['arabic'] as Array<'latin' | 'arabic'>, copyText: text, textMeasurementOptions: {fontsDir: dir}};
    for (const fontsDir of [dir, join(dir, 'absent')]) {
      const qa = evaluateHardQa(candidate, {...ctx, textMeasurementOptions: {fontsDir}});
      expect(qa.passed).toBe(false);
      expect(qa.textMeasurements[0]).toMatchObject({status: 'unmeasured', reason: 'FONT_UNAVAILABLE'});
    }
    const file = join(dir, 'NotoSansArabic-Regular.ttf');
    writeFileSync(file, 'not a font');
    expect(evaluateHardQa(candidate, ctx).textMeasurements[0]).toMatchObject({status: 'unmeasured', reason: 'FONT_UNAVAILABLE'});
    copyFileSync(resolve(import.meta.dirname, '../assets/fonts/NotoSansArabic-Regular.ttf'), file);
    const measured = measureTextGeometry(candidate, text, {fontsDir: dir})[0];
    expect(measured).toMatchObject({status: 'measured', lineCount: 1});
    copyFileSync(resolve(import.meta.dirname, '../assets/fonts/Amiri-Regular.ttf'), file);
    const replaced = measureTextGeometry(candidate, text, {fontsDir: dir})[0];
    expect(replaced.status).toBe('measured');
    if (measured.status === 'measured' && replaced.status === 'measured') {
      expect(replaced.fontSha256).not.toBe(measured.fontSha256);
      expect(replaced.inputSha256).not.toBe(measured.inputSha256);
    }
  });

  it.each([
    ['width', 0], ['height', NaN], ['fontSize', Infinity], ['lineHeight', -1], ['letterSpacing', NaN],
  ] as const)('refuses invalid %s=%s', (field, value) => {
    const candidate = layout(); candidate.text[0][field] = value;
    expect(measureTextGeometry(candidate, copy)[0]).toMatchObject({status: 'unmeasured', reason: 'INVALID_GEOMETRY'});
  });

  it('refuses a parseable font with unusable shaping units instead of certifying nonfinite widths', () => {
    const bytes = readFileSync(resolve(import.meta.dirname, '../assets/fonts/NotoSansArabic-Regular.ttf'));
    const tables = bytes.readUInt16BE(4);
    let head = -1;
    for (let i = 0; i < tables; i++) {
      const at = 12 + i * 16;
      if (bytes.toString('ascii', at, at + 4) === 'head') head = bytes.readUInt32BE(at + 8);
    }
    expect(head).toBeGreaterThan(0);
    bytes.writeUInt16BE(0, head + 18); // sfnt head.unitsPerEm; actual temporary font, no measurement mock.
    const fontsDir = folder(); writeFileSync(join(fontsDir, 'NotoSansArabic-Regular.ttf'), bytes);
    const candidate = layout(); Object.assign(candidate.text[0], {fontFamily: 'Noto Sans Arabic', bold: false});
    const qa = evaluateHardQa(candidate, {...context, copyText: {0: 'ڕێنمایی'}, textMeasurementOptions: {fontsDir}});
    expect(qa.passed).toBe(false);
    expect(qa.defectCodes).toContain('COPY_UNMEASURED');
    expect(qa.textMeasurements[0]).toMatchObject({status: 'unmeasured', reason: 'SHAPING_FAILED'});
  });

  it('refuses visible missing glyphs, including an unavailable symbol', () => {
    const candidate = layout(); candidate.text[0].fontFamily = 'Verdana';
    const qa = evaluateHardQa(candidate, {...context, copyText: {0: 'Approved \u{10FFFF}'}});
    expect(qa.passed).toBe(false);
    expect(qa.textMeasurements[0]).toMatchObject({status: 'unmeasured', reason: 'MISSING_GLYPHS', missingCodePoints: ['U+10FFFF']});
  });

  it.each([
    ['Verdana', 'Approved title 2026 (workshop)', 'latin'],
    ['Noto Sans Arabic', 'ڕێنمایی زانکۆی کوردستان ٢٠٢٦', 'arabic'],
    ['Amiri', 'التعليم والجودة (٢٠٢٦)\nالمعايير', 'arabic'],
    ['Amiri', 'ڕێنمایی \u2066Office 2026\u2069', 'arabic'],
  ] as const)('measures %s copy without altering it (%s)', (fontFamily, text, script) => {
    const candidate = layout(); Object.assign(candidate.text[0], {fontFamily, fontSize: 32, height: 300, lineHeight: script === 'arabic' ? 1.7 : 1.35, bold: false, rtl: script === 'arabic'});
    const source = {0: text}; const before = JSON.stringify({candidate, source});
    const qa = evaluateHardQa(candidate, {...context, copyScripts: [script], copyText: source});
    expect(qa.passed, qa.messages.join('\n')).toBe(true);
    expect(qa.textMeasurements[0]).toMatchObject({status: 'measured', copySha256: createHash('sha256').update(text).digest('hex')});
    expect(JSON.stringify({candidate, source})).toBe(before);
    const narrower = structuredClone(candidate); narrower.text[0].width = 450;
    const next = measureTextGeometry(narrower, source)[0], previous = qa.textMeasurements[0];
    if (next.status === 'measured' && previous.status === 'measured') expect(next.inputSha256).not.toBe(previous.inputSha256);
  });

  it('measures vertical and horizontal overflow instead of turning it into unknown', () => {
    const vertical = evaluateHardQa(layout(), {...context, copyText: copy});
    expect(vertical.textMeasurements[0]).toMatchObject({status: 'measured', lineCount: 2, requiredHeightPx: 195});
    const horizontal = evaluateHardQa(layout(), {...context, copyText: {0: 'W'.repeat(50)}});
    expect(horizontal.defectCodes).toContain('COPY_OVERFLOW');
    expect(horizontal.messages.some((m) => m.includes('exceeds box width'))).toBe(true);
  });
});
