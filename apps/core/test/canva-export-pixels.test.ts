import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkCanvaPptx } from '@hawa/qa';
import { evaluateCanvaExportQc } from '../src/app.js';
import { composeOfficeDraftAlert, qcReportWarnings } from '../src/services/office-draft-alert.js';
import { COPY, SENT, capture, png, pptx, sha256, type Frame } from './fixtures/shipped-export.js';

/**
 * ADR-256 (found live 2026-10-02, task f3cb89e8): the export QC checked copy, fonts and direction on
 * the Canva PPTX but left contrast and the safe area null, so nothing measured the design that ships.
 * They are now measured on the PNG capture of the same Canva version, with the PPTX's text frames for
 * the boxes. They are recorded and shown to the office; they never change passed or criticalPass.
 */

const row = (bytes: Uint8Array, preview?: Buffer | null) => ({
  sha256: sha256(bytes), format: 'pptx', content: bytes, content_check: checkCanvaPptx(bytes, COPY, SENT),
  ...(preview ? { preview_png: preview, preview_sha256: sha256(preview) } : {}),
});

const TITLE: Frame = { x: 12, y: 20, w: 84, h: 20, color: '14253D' };
const SORANI: Frame = { x: 20, y: 80, w: 68, h: 12, color: '14253D' };

describe('evaluateCanvaExportQc measures contrast and the safe area on the shipped PNG (ADR-256)', () => {
  it('a compliant design: both true, with what was measured in its checks', () => {
    const bytes = pptx(TITLE, SORANI);
    const r = evaluateCanvaExportQc(row(bytes, capture([{ ...TITLE, ink: '#14253D' }, { ...SORANI, ink: '#14253D' }])), COPY);
    expect(r.criticalPass).toBe(true);
    expect(r.qaReport.passed).toBe(true);
    expect(r.qaReport.safeMargins).toBe(true);
    expect(r.qaReport.contrastCompliant).toBe(true);
    expect(r.qaReport.warnings).toEqual([]);
    const contrast = r.qaReport.checks.find((c) => c.name === 'contrast');
    expect(contrast?.passed).toBe(true);
    // Both frames were read, the grouped Sorani line through its group's scale.
    expect(contrast?.details.measured.map((m: { text: string }) => m.text)).toEqual(COPY);
    expect(contrast?.details.measured[0]).toMatchObject({ color: '#14253D', background: '#FFFFFF', required: 3 });
    const margins = r.qaReport.checks.find((c) => c.name === 'safeMargins');
    expect(margins?.passed).toBe(true);
    // The grouped frame lands where its group puts it: 20..88 x 80..92 PNG pixels.
    const grouped = margins?.details.frames.find((f: { text: string }) => f.text === COPY[1]);
    expect(grouped.box.x).toBeCloseTo(20, 3);
    expect(grouped.box.width).toBeCloseTo(68, 3);
    expect(grouped.box.y).toBeCloseTo(80, 3);
  });

  it('light-grey text on white: contrastCompliant false with the ratio in the warning; the verdict is unchanged', () => {
    const grey = { ...TITLE, color: 'CCCCCC' };
    const r = evaluateCanvaExportQc(row(pptx(grey, SORANI), capture([{ ...grey, ink: '#CCCCCC' }, { ...SORANI, ink: '#14253D' }])), COPY);
    expect(r.qaReport.contrastCompliant).toBe(false);
    expect(r.qaReport.safeMargins).toBe(true);
    expect(r.qaReport.warnings).toEqual(["low contrast on 'KAAE Summit' (1.6:1, needs 3:1)"]);
    expect(r.qaReport.checks.find((c) => c.name === 'contrast')?.passed).toBe(false);
    expect(r.qaReport.errors).toEqual([]);
    expect(r.status).toBe('passed');
    expect(r.criticalPass).toBe(true);
    expect(r.qaReport.passed).toBe(true);
    expect(r.qaReport.criticalPass).toBe(true);
  });

  it('small grey body text is held to 4.5:1, large text to 3:1, as hard QA holds them', () => {
    // #949494 on white is 3.03:1: enough for the 48 pt title (64 px, large), not for 9 pt (12 px) text.
    const large = { ...TITLE, color: '949494' };
    const small = { ...TITLE, color: '949494', sz: 900 };
    const page = capture([{ ...TITLE, ink: '#949494' }, { ...SORANI, ink: '#14253D' }]);
    expect(evaluateCanvaExportQc(row(pptx(large, SORANI), page), COPY).qaReport.contrastCompliant).toBe(true);
    const r = evaluateCanvaExportQc(row(pptx(small, SORANI), page), COPY);
    expect(r.qaReport.contrastCompliant).toBe(false);
    expect(r.qaReport.warnings?.[0]).toBe("low contrast on 'KAAE Summit' (3.0:1, needs 4.5:1)");
  });

  it('a text box past the safe area: safeMargins false naming the text; the verdict is unchanged', () => {
    const edge = { ...TITLE, x: 2 };
    const r = evaluateCanvaExportQc(row(pptx(edge, SORANI), capture([{ ...edge, ink: '#14253D' }, { ...SORANI, ink: '#14253D' }])), COPY);
    expect(r.qaReport.safeMargins).toBe(false);
    expect(r.qaReport.contrastCompliant).toBe(true);
    expect(r.qaReport.warnings).toEqual(["text close to the edge: 'KAAE Summit'"]);
    expect(r.qaReport.checks.find((c) => c.name === 'safeMargins')?.details.outside).toEqual([
      expect.objectContaining({ text: 'KAAE Summit', edges: ['left'] }),
    ]);
    expect(r.status).toBe('passed');
    expect(r.criticalPass).toBe(true);
    expect(r.qaReport.passed).toBe(true);
  });

  it('a failed copy check stays failed and the measures are still recorded', () => {
    const edge = { ...TITLE, x: 2 };
    const bytes = pptx(edge, SORANI);
    const r = evaluateCanvaExportQc(row(bytes, capture([{ ...edge, ink: '#14253D' }])), ['Other title', COPY[1]]);
    expect(r.criticalPass).toBe(false);
    expect(r.qaReport.safeMargins).toBe(false);
  });

  it('no PNG capture of the same version: both stay null, as before', () => {
    const r = evaluateCanvaExportQc(row(pptx(TITLE, SORANI)), COPY);
    expect(r.qaReport.contrastCompliant).toBeNull();
    expect(r.qaReport.safeMargins).toBeNull();
    expect(r.qaReport.warnings).toEqual([]);
    expect(r.criticalPass).toBe(true);
    expect(r.qaReport.checks.map((c) => c.name)).not.toContain('contrast');
  });

  it('a PNG whose bytes do not match its hash, or of another shape, measures nothing', () => {
    const bytes = pptx(TITLE, SORANI);
    const good = capture([{ ...TITLE, ink: '#14253D' }]);
    const tampered = { ...row(bytes, good), preview_sha256: sha256(Buffer.from('other')) };
    const t = evaluateCanvaExportQc(tampered, COPY);
    expect([t.qaReport.contrastCompliant, t.qaReport.safeMargins]).toEqual([null, null]);
    expect(t.qaReport.checks.find((c) => c.name === 'contrast')?.details).toMatch(/integrity/);
    const square = evaluateCanvaExportQc(row(bytes, png(100, 100, '#FFFFFF')), COPY);
    expect([square.qaReport.contrastCompliant, square.qaReport.safeMargins]).toEqual([null, null]);
    expect(square.qaReport.checks.find((c) => c.name === 'contrast')?.details).toMatch(/shape/);
    expect(square.criticalPass).toBe(true);
  });

  it('a theme colour it cannot resolve is skipped and named; the other runs are still measured', () => {
    const themed = { ...TITLE, color: undefined, scheme: 'tx1' };
    const r = evaluateCanvaExportQc(row(pptx(themed, SORANI), capture([{ ...SORANI, ink: '#14253D' }])), COPY);
    expect(r.qaReport.contrastCompliant).toBe(true);
    const details = r.qaReport.checks.find((c) => c.name === 'contrast')?.details;
    expect(details.unmeasured).toEqual([{ text: 'KAAE Summit', reason: 'theme colour tx1' }]);
    expect(details.measured.map((m: { text: string }) => m.text)).toEqual([COPY[1]]);
  });

  it('measures the real Canva multilingual export with its own PNG capture', () => {
    const root = new URL('../../../output/acceptance/2026-09-27-canva-multilingual/', import.meta.url);
    const bytes = readFileSync(new URL('group-4-canva.pptx', root));
    const preview = readFileSync(new URL('group-4-canva.png', root));
    const fixtures = JSON.parse(readFileSync(new URL('fixtures.json', root), 'utf8'));
    const copy = fixtures.groups[3].cases.map((item: { text: string }) => item.text);
    const check = checkCanvaPptx(bytes, copy, 'Noto Sans Arabic');
    const r = evaluateCanvaExportQc({ format: 'pptx', sha256: sha256(bytes), content: bytes, content_check: check,
      preview_png: preview, preview_sha256: sha256(preview) }, copy);
    // Ten rows of #14253D on #F6F8FC (14.5:1), each Canva group scaled by 3/4: 18 pt, 24 px type.
    const contrast = r.qaReport.checks.find((c) => c.name === 'contrast');
    expect(contrast?.details.measured.length).toBe(copy.length);
    expect(contrast?.details.measured[0]).toMatchObject({ color: '#14253D', background: '#F6F8FC', ratio: 14.5, fontPx: 24, required: 4.5 });
    expect(r.qaReport.contrastCompliant).toBe(true);
    // The test sheet stacks its rows from 57 px to 1944 px of a 2000 px page whose safe area is 72 px
    // in: the first row's box breaks the top edge and the last the bottom. The measure says so.
    expect(r.qaReport.safeMargins).toBe(false);
    const outside = r.qaReport.checks.find((c) => c.name === 'safeMargins')?.details.outside;
    expect(outside.map((m: { text: string; edges: string[] }) => [m.text, m.edges])).toEqual([[copy[0], ['top']], [copy[9], ['bottom']]]);
    expect(r.qaReport.passed).toBe(r.criticalPass);
  });
});

describe('the office draft alert carries the export warnings (ADR-256)', () => {
  it('adds one "Check before approving" line from the QC report, in the text and the caption', () => {
    const grey = { ...TITLE, color: 'CCCCCC', x: 2 };
    const qc = evaluateCanvaExportQc(row(pptx(grey, SORANI), capture([{ ...grey, ink: '#CCCCCC' }, { ...SORANI, ink: '#14253D' }])), COPY);
    const warnings = qcReportWarnings(qc.qaReport);
    const base = { title: 'KAAE Summit poster', clientName: 'KAAE', canvaUrl: 'https://www.canva.com/design/DA1/edit', warnings };
    const line = "Check before approving: low contrast on 'KAAE Summit' (1.6:1, needs 3:1); text close to the edge: 'KAAE Summit'";
    for (const alert of [composeOfficeDraftAlert(base), composeOfficeDraftAlert({ ...base, telegramDecision: true })]) {
      expect(alert.split('\n')).toContain(line);
      // It sits with the check line, before the Canva link and the decision words.
      expect(alert.indexOf(line)).toBeLessThan(alert.indexOf('Edit in Canva'));
    }
  });

  it('has no line when the report has no warnings, and reads only short strings from a stored report', () => {
    const plain = composeOfficeDraftAlert({ title: 'KAAE Summit poster', warnings: [] });
    expect(plain).not.toContain('Check before approving');
    expect(qcReportWarnings({ warnings: ['a', 3, null, 'x'.repeat(500)] })).toEqual(['a']);
    expect(qcReportWarnings({ warnings: 'low contrast' })).toEqual([]);
    expect(qcReportWarnings(null)).toEqual([]);
    const many = composeOfficeDraftAlert({ title: 'T', warnings: ['one', 'two', 'three', 'four', 'five'] });
    expect(many).toContain('Check before approving: one; two; three (and 2 more)');
  });
});
