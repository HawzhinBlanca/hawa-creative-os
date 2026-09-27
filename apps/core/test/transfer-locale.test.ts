import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { checkCanvaPptx } from '@hawa/qa';
import { savedDesignCopy, savedDesignCopyLocales } from '../src/services/saved-design-copy.js';
import { runTransferStage } from '../src/services/design-studio/stages/transfer.stage.js';
import type { CandidateState, StageContext } from '../src/services/design-studio/types.js';

describe('saved copy language authority', () => {
  it('binds labelled Desk English and Sorani fields in actual copy order, including Sorani-only requests', () => {
    for (const body of [
      { workflow: 'canva_manual', headlineEn: 'Cafe\u0301', copyEn: '  Exact\n\nspacing  ', copyCkb: 'کوردی' },
      { workflow: 'canva_manual', copyEn: '', headlineCkb: 'کوردی', copyCkb: '٢٠٢٦' },
    ]) {
      const payload = { payload: { body } };
      const { copy } = savedDesignCopy(payload, '');
      expect(savedDesignCopyLocales(payload, copy)).toEqual(copy.length === 3 ? ['en', 'en', 'ckb'] : ['ckb', 'ckb']);
      expect(savedDesignCopyLocales(payload, [...copy].reverse())).toEqual(copy.map(() => 'und'));
      expect(savedDesignCopyLocales(payload, copy.map(t => t + 'changed'))).toEqual(copy.map(() => 'und'));
    }
  });
  it('retains the explicitly labelled fields of a reviewed PDF request', () => {
    const payload = { sourceDocument: { confirmation: 'request_copy_reviewed' }, body: { copyEn: 'Exact', copyCkb: 'کوردی' } };
    expect(savedDesignCopyLocales(payload, savedDesignCopy(payload, '').copy)).toEqual(['en', 'ckb']);
  });
  it('does not trust historical language guesses, layout metadata, or raw Arabic/Latin script', () => {
    for (const payload of [
      { exactCopy: [{ text: 'مرحبا', language: 'ckb' }], rawRequestText: 'Use navy.\n---\nمرحبا' },
      { reviewedSource: { confirmation: 'request_copy_reviewed' }, body: { exactCopy: [{ text: 'مرحبا', language: 'ckb' }], copyCkb: 'مرحبا' } },
      { rawRequestText: 'Instructions\n---\nBonjour', locale: 'en-US' },
    ]) {
      expect(savedDesignCopyLocales(payload, savedDesignCopy(payload, '').copy)).toEqual(['und']);
    }
  });
});

describe('saved Studio transfer languages', () => {
  const copy = ['English', 'کوردی'];
  const ctx = {
    copyBlocks: copy.map((text, i) => ({ text, script: i ? 'arabic' : 'latin', locale: i ? 'ckb' : 'en',
      localeCopySha256: createHash('sha256').update(text).digest('hex') })),
    latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic',
  } as StageContext;
  const winner = { currentLayout: {
    version: 2, width: 1080, height: 1080, background: { color: '#FFFFFF' }, shapes: [],
    grid: { columns: 12, margin: 80, gutter: 16, baseline: 8 },
    text: copy.map((_, copyIndex) => ({ copyIndex, role: 'body', x: 80, y: 100 + copyIndex * 240,
      width: 920, height: 180, fontSize: 32, lineHeight: 1.7, color: '#000000', align: 'center',
      fontFamily: copyIndex ? 'Noto Sans Arabic' : 'Verdana', rtl: Boolean(copyIndex) })),
  } } as CandidateState;
  it('carries persisted copy languages through the actual Studio transfer stage', async () => {
    const out = await runTransferStage(ctx, winner);
    expect(out.manifest).toMatchObject({ copy, copyLocales: ['en', 'ckb'] });
    expect(checkCanvaPptx(out.pptxBytes, copy, 'Verdana', { scriptFonts: { arabic: 'Noto Sans Arabic' } }).copyPass).toBe(true);
  });
  it('does not carry a stale language label onto revised text or invent one for old saved runs', async () => {
    const changed = structuredClone(ctx);
    changed.copyBlocks[0].text = 'مرحبا';
    delete changed.copyBlocks[1].localeCopySha256;
    const out = await runTransferStage(changed, winner);
    expect(out.manifest).toMatchObject({ copy: ['مرحبا', 'کوردی'], copyLocales: ['und', 'und'] });
    expect(checkCanvaPptx(out.pptxBytes, changed.copyBlocks.map(b => b.text), 'Verdana').copyPass).toBe(true);
  });
});
