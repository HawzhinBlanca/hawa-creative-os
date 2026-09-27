import { describe, it, expect } from 'vitest';
import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { checkCanvaPptx } from '@hawa/qa';
import { evaluateCanvaExportQc } from '../src/app.js';

/**
 * The approval gate reads the qc_runs row this evaluator produces for a Canva draft. An earlier
 * version wrote a literal passing report, so every draft was approvable on checks nobody ran.
 * These tests pin the opposite: a pass needs a real copy and font result from the exported PPTX,
 * and anything missing, unreadable or altered is a failure.
 */

/** A stored (uncompressed) ZIP, written by hand so Core needs no archive dependency for one fixture. */
function zipSync(files: Record<string, Uint8Array>): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name, 'utf8');
    const d = Buffer.from(data);
    const crc = crc32(d);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(d.length, 18);
    local.writeUInt32LE(d.length, 22);
    local.writeUInt16LE(n.length, 26);
    parts.push(local, n, d);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(d.length, 20);
    cen.writeUInt32LE(d.length, 24);
    cen.writeUInt16LE(n.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, n);
    offset += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, end]));
}
const strToU8 = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'));

const COPY = ['KAAE Summit', 'کۆنفرانسی نیشتمانی'];
const SENT = { fontsByIndex: ['Cinzel', 'Amiri'] };
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function pptx(opts: { title?: string; sorani?: string; titleFont?: string; soraniFont?: string; rtl?: boolean; madeHere?: boolean } = {}) {
  const { title = COPY[0], sorani = COPY[1], titleFont = 'Cinzel', soraniFont = 'Amiri', rtl = true } = opts;
  return zipSync({
    'ppt/presentation.xml': strToU8('<p:presentation/>'),
    ...(opts.madeHere ? { 'docProps/core.xml': strToU8('<cp:coreProperties><dc:title>Editable Canva transfer (Hawa)</dc:title></cp:coreProperties>') } : {}),
    'ppt/slides/slide1.xml': strToU8(
      '<p:sld>' +
        `<p:sp><p:txBody><a:p><a:r><a:rPr><a:latin typeface="${titleFont}"/></a:rPr><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>` +
        `<p:sp><p:txBody><a:p>${rtl ? '<a:pPr rtl="1"/>' : ''}<a:r><a:rPr><a:cs typeface="${soraniFont}"/></a:rPr><a:t>${sorani}</a:t></a:r></a:p></p:txBody></p:sp>` +
        '</p:sld>'
    ),
  });
}

/** The row Core stores: the check is computed from the bytes at capture time, as canva-connect-service does. */
const storedRow = (bytes: Uint8Array) => ({
  sha256: sha256(bytes),
  format: 'pptx',
  content: bytes,
  content_check: checkCanvaPptx(bytes, COPY, SENT),
});

describe('evaluateCanvaExportQc: the QC record behind a Canva approval', () => {
  it('passes an export whose copy, fonts and direction survived Canva, and says what it did not measure', () => {
    const r = evaluateCanvaExportQc(storedRow(pptx()), COPY);
    expect(r.status).toBe('passed');
    expect(r.criticalPass).toBe(true);
    expect(r.qaReport.copyFidelity).toBe(true);
    expect(r.qaReport.fontFamilyPass).toBe(true);
    expect(r.qaReport.fontCoverage).toBeNull();
    expect(r.qaReport.bidiIsolation).toBe(true);
    expect(r.qaReport.errors).toEqual([]);
    expect(r.qaReport.exportSha256).toBe(sha256(storedRow(pptx()).content));
    // A PPTX read measures neither pixels nor geometry. Reporting true here would be the old fabrication.
    expect(r.qaReport.contrastCompliant).toBeNull();
    expect(r.qaReport.safeMargins).toBeNull();
  });

  it('refuses an export whose copy was changed in Canva', () => {
    const r = evaluateCanvaExportQc(storedRow(pptx({ title: 'KAAE Summit 2027' })), COPY);
    expect(r.criticalPass).toBe(false);
    expect(r.status).toBe('failed');
    expect(r.qaReport.passed).toBe(false);
    expect(r.qaReport.copyFidelity).toBe(false);
    expect(r.qaReport.errors.join(' ')).toMatch(/copy/i);
  });

  it('refuses an export with a changed Sorani letter', () => {
    // Arabic yeh (ي) in place of Farsi yeh (ی): one code point, invisible at a glance.
    const r = evaluateCanvaExportQc(storedRow(pptx({ sorani: COPY[1].replace('ی', 'ي') })), COPY);
    expect(r.criticalPass).toBe(false);
    expect(r.qaReport.copyFidelity).toBe(false);
  });

  it('refuses an export where Canva substituted the Sorani typeface', () => {
    const r = evaluateCanvaExportQc(storedRow(pptx({ soraniFont: 'Arimo' })), COPY);
    expect(r.criticalPass).toBe(false);
    expect(r.qaReport.copyFidelity).toBe(true);
    expect(r.qaReport.fontFamilyPass).toBe(false);
    expect(r.qaReport.fontCoverage).toBeNull();
    expect(r.qaReport.errors.join(' ')).toMatch(/font/i);
  });

  it('leaves reading direction to the visual review when a Canva export carries no rtl attribute at all', () => {
    // Canva's own export never writes it; failing it disabled Approve on every Kurdish design.
    const r = evaluateCanvaExportQc(storedRow(pptx({ rtl: false })), COPY);
    expect(r.criticalPass).toBe(true);
    expect(r.qaReport.bidiIsolation).toBeNull();
    expect(r.qaReport.rtlVisualReviewRequired).toBe(true);
    expect(r.qaReport.checks.find(c => c.name === 'bidiIsolation')?.passed).toBeNull();
  });

  it('refuses a deck made here whose Sorani paragraph lost its right-to-left flag', () => {
    const r = evaluateCanvaExportQc(storedRow(pptx({ rtl: false, madeHere: true })), COPY);
    expect(r.criticalPass).toBe(false);
    expect(r.qaReport.bidiIsolation).toBe(false);
    expect(r.qaReport.rtlVisualReviewRequired).toBe(false);
    expect(r.qaReport.errors.join(' ')).toMatch(/RTL/);
  });

  it('fails when no export was retrieved', () => {
    const r = evaluateCanvaExportQc(undefined, COPY);
    expect(r.criticalPass).toBe(false);
    expect(r.status).toBe('failed');
    expect(r.qaReport.checks.find(c => c.name === 'exportRetrieved')?.passed).toBe(false);
    expect(r.qaReport.exportSha256).toBeNull();
  });

  it('fails an export that carries no check and cannot be checked (a PNG)', () => {
    const r = evaluateCanvaExportQc({ sha256: 'b'.repeat(64), format: 'png', content: new Uint8Array([1, 2, 3]) }, COPY);
    expect(r.criticalPass).toBe(false);
    expect(r.qaReport.errors.join(' ')).toMatch(/Canva PPTX export bytes/);
  });

  it('fails a PPTX with no stored check when the expected copy is unknown', () => {
    const r = evaluateCanvaExportQc({ sha256: 'c'.repeat(64), format: 'pptx', content: pptx() }, undefined);
    expect(r.criticalPass).toBe(false);
  });

  it('fails unreadable PPTX bytes and never throws', () => {
    const r = evaluateCanvaExportQc({ sha256: 'd'.repeat(64), format: 'pptx', content: new Uint8Array([0, 1, 2, 3]) }, COPY);
    expect(r.criticalPass).toBe(false);
    expect(r.status).toBe('failed');
  });

  it('checks the bytes itself when the stored check is missing', () => {
    // Latin-only, because the fallback checks against one required face.
    const latin = zipSync({
      'ppt/presentation.xml': strToU8('<p:presentation/>'),
      'ppt/slides/slide1.xml': strToU8(
        '<p:sld><p:sp><p:txBody><a:p><a:r><a:rPr><a:latin typeface="Verdana"/></a:rPr><a:t>Exact copy</a:t></a:r></a:p></p:txBody></p:sp></p:sld>'
      ),
    });
    expect(evaluateCanvaExportQc({ sha256: sha256(latin), format: 'pptx', content: latin }, ['Exact copy'], 'Verdana').criticalPass).toBe(true);
    expect(evaluateCanvaExportQc({ sha256: sha256(latin), format: 'pptx', content: latin }, ['Exact  copy!'], 'Verdana').criticalPass).toBe(false);
  });

  it('does not accept a partial check record as a pass', () => {
    const base = { sha256: 'f'.repeat(64), format: 'pptx' };
    // A record that is silent on direction is not a checkCanvaPptx result.
    expect(evaluateCanvaExportQc({ ...base, content_check: { copyPass: true, fontPass: true } }, COPY).criticalPass).toBe(false);
    // Truthy non-booleans must not count.
    expect(evaluateCanvaExportQc({ ...base, content_check: { copyPass: 'yes', fontPass: 1, rtlPass: true } }, COPY).criticalPass).toBe(false);
    expect(evaluateCanvaExportQc({ ...base, content_check: { copyPass: true, fontPass: true, rtlPass: true, status: 'failed' } }, COPY).criticalPass).toBe(false);
    expect(evaluateCanvaExportQc({ ...base, content_check: {} }, COPY).criticalPass).toBe(false);
  });

  it('refuses a stale stored check even when the changed PPTX has a fresh matching hash', () => {
    const checked = storedRow(pptx());
    const changed = pptx({ title: 'KAAE Summit 2027' });
    const result = evaluateCanvaExportQc({ ...checked, content: changed, sha256: sha256(changed) }, COPY);
    expect(result.criticalPass).toBe(false);
    expect(result.qaReport.copyFidelity).toBe(false);
  });

  it('refuses a Canva font substitution hidden behind an earlier passing check', () => {
    const checked = storedRow(pptx());
    const changed = pptx({ soraniFont: 'Arimo' });
    const result = evaluateCanvaExportQc({ ...checked, content: changed, sha256: sha256(changed) }, COPY);
    expect(result.criticalPass).toBe(false);
    expect(result.qaReport.fontFamilyPass).toBe(false);
    expect(result.qaReport.fontCoverage).toBeNull();
  });

  it('refuses a wrong stored hash and a check with no export bytes', () => {
    const checked = storedRow(pptx());
    expect(evaluateCanvaExportQc({ ...checked, sha256: 'a'.repeat(64) }, COPY).criticalPass).toBe(false);
    expect(evaluateCanvaExportQc({ ...checked, content: undefined }, COPY).criticalPass).toBe(false);
  });

  it('keeps the top-level verdict and the stored report in agreement', () => {
    for (const row of [storedRow(pptx()), storedRow(pptx({ soraniFont: 'Arimo' })), undefined]) {
      const r = evaluateCanvaExportQc(row as any, COPY);
      expect(r.qaReport.criticalPass).toBe(r.criticalPass);
      expect(r.qaReport.passed).toBe(r.criticalPass);
      expect(r.qaReport.status).toBe(r.status);
      expect(r.status).toBe(r.criticalPass ? 'passed' : 'failed');
    }
  });

  it('does not claim rendered glyph coverage from the real Canva multilingual export', () => {
    const root = new URL('../../../output/acceptance/2026-09-27-canva-multilingual/', import.meta.url);
    const bytes = readFileSync(new URL('group-4-canva.pptx', root));
    const fixtures = JSON.parse(readFileSync(new URL('fixtures.json', root), 'utf8'));
    const copy = fixtures.groups[3].cases.map((item: { text: string }) => item.text);
    const check = checkCanvaPptx(bytes, copy, 'Noto Sans Arabic');
    expect(check.copyPass).toBe(true);
    expect(check.fontPass).toBe(true);
    expect(check.observedFonts).toEqual(['Noto Sans Arabic']);
    const result = evaluateCanvaExportQc({ format: 'pptx', sha256: sha256(bytes), content: bytes, content_check: check }, copy);
    // The corresponding real PDF also uses NotoSans-Regular and an unnamed Type3 font. PPTX
    // family declarations cannot certify those rendered glyphs, fallback behavior or licenses.
    expect(result.qaReport.fontCoverage).toBeNull();
    expect(result.qaReport.fontFamilyPass).toBe(true);
    expect(result.qaReport.rtlVisualReviewRequired).toBe(true);
    expect(result.qaReport.bidiIsolation).toBeNull();
  });
});
