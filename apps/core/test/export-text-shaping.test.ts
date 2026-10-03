import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TextShapingPool } from '@hawa/creative';
import { checkExportTextShaping, checkExportTextShapingOffThread } from '../src/services/export-picture-fidelity.js';

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

describe('checkExportTextShapingOffThread (ADR-290 addendum)', () => {
  const pool = new TextShapingPool({ timeoutMs: 60_000 });
  afterAll(() => pool.close());
  const withoutTime = <T extends object>(r: T) => ('ms' in r ? { ...r, ms: 0 } : r);

  it.each([['group-1', 'group-1-round-2-canva.png'], ['group-2', 'group-2-canva.png'], ['group-3', 'group-3-canva.png'], ['group-4', 'group-4-canva.png']])(
    '%s: the worker records exactly what the in-process check records', async (id, file) => {
      const { manifest, png, source } = sheet(id, file);
      const inProcess = checkExportTextShaping(png, manifest, source);
      const run = await checkExportTextShapingOffThread(png, manifest, source, pool);
      if (!run.ran) throw new Error(run.reason);
      expect(withoutTime(run.result)).toEqual(withoutTime(inProcess));
    }, 60_000);

  it('the office\'s words for a block drawn other than designed are the same off the thread', async () => {
    const { manifest, png, source } = sheet('group-2', 'group-2-canva.png');
    const copy = [...manifest.copy];
    [copy[3], copy[4]] = [copy[4], copy[3]];
    const inProcess = checkExportTextShaping(png, { ...manifest, copy }, source);
    const run = await checkExportTextShapingOffThread(png, { ...manifest, copy }, source, pool);
    if (!run.ran || 'measured' in run.result || 'measured' in inProcess) throw new Error('not measured');
    expect(run.result.warnings).toEqual(inProcess.warnings);
    expect(run.result.warnings).toHaveLength(2);
  }, 60_000);

  it('a manifest without a plan is answered on this thread, in the same words', async () => {
    const { png } = sheet('group-1', 'group-1-round-2-canva.png');
    expect(await checkExportTextShapingOffThread(png, { copy: ['x'] }, null, pool))
      .toEqual({ ran: true, result: { measured: false, reason: 'The editable source records no transfer plan to draw the copy from.' } });
  });

  it('a check that did not run says so, and never throws', async () => {
    const { manifest, png, source } = sheet('group-1', 'group-1-round-2-canva.png');
    const late = new TextShapingPool({ timeoutMs: 50 });
    try {
      expect(await checkExportTextShapingOffThread(png, manifest, source, late)).toEqual({ ran: false, reason: 'timeout' });
    } finally {
      await late.close();
    }
    expect(await checkExportTextShapingOffThread(Buffer.from('not a png'), manifest, source, pool)).toMatchObject({ ran: false, reason: expect.stringMatching(/^Not measured: /) });
  }, 60_000);
});
