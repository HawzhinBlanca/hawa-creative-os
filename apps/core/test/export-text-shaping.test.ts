import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkExportTextShaping } from '../src/services/export-picture-fidelity.js';

/**
 * ADR-290: Kurdish and Arabic shaping in a Canva export, read from the PNG of the same version against
 * the transfer plan it was imported from. The sheets are real Canva exports on record (golden RTL
 * corpus, 2026-09-27); no client copy.
 */
const root = resolve(__dirname, '../../../output/acceptance/2026-09-27-canva-multilingual');
const groups = JSON.parse(readFileSync(`${root}/fixtures.json`, 'utf8')).groups as Array<{ id: string; manifest: { copy: string[]; plan: unknown } }>;
const sheet = (id: string, png: string) => ({ manifest: groups.find((g) => g.id === id)!.manifest, png: readFileSync(`${root}/${png}`), source: readFileSync(`${root}/${id}-input.pptx`) });

describe('checkExportTextShaping (ADR-290)', () => {
  it('passes a Canva export whose Kurdish and Arabic lines are drawn as designed', () => {
    const { manifest, png, source } = sheet('group-1', 'group-1-round-2-canva.png');
    const r = checkExportTextShaping(png, manifest, source);
    if ('measured' in r) throw new Error(r.reason);
    expect(r.pass).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(r.blocks.map((b) => b.verdict)).toEqual(r.blocks.map(() => 'ok'));
    expect(r.blocks.length).toBe(9);
    expect(r.ms).toBeLessThan(2000);
  }, 60_000);

  it('names each block drawn other than designed, in the office\'s words', () => {
    const { manifest, png, source } = sheet('group-2', 'group-2-canva.png');
    // Blocks 3 and 4 swap copy: Canva's lines are well formed, but not the lines the plan sets there.
    const copy = [...manifest.copy];
    [copy[3], copy[4]] = [copy[4], copy[3]];
    const r = checkExportTextShaping(png, { ...manifest, copy }, source);
    if ('measured' in r) throw new Error(r.reason);
    expect(r.pass).toBe(false);
    expect(r.blocks.filter((b) => b.verdict !== 'ok').map((b) => b.id).sort()).toEqual(['text-copy-3', 'text-copy-4']);
    expect(r.warnings).toHaveLength(2);
    for (const w of r.warnings) expect(w).toMatch(/^'.+' (is set on other lines than the design|is drawn with other letter forms than the design \(unjoined letters or another typeface\)|shows boxes where letters are missing|is drawn in the wrong direction) in Canva$/);
  }, 60_000);

  it('measures nothing without a transfer plan, and says so', () => {
    const { png } = sheet('group-1', 'group-1-round-2-canva.png');
    expect(checkExportTextShaping(png, { copy: ['x'] })).toEqual({ measured: false, reason: 'The editable source records no transfer plan to draw the copy from.' });
    expect(checkExportTextShaping(png, null)).toMatchObject({ measured: false });
  });
});
