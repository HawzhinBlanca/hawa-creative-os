import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExemplarRetrievalIndex, exemplarSearchTokens } from '../src/studio/exemplar-retrieval.js';

const entry = (id: string, rank: number, reason: string, more = {}) => ({ filename: `${id}.png`, path: `${id}.png`, rank, reason,
  recommendedFor: [], format: '1:1', status: 'CONFIRMED', ...more });
const corpus = () => ({ status: 'CONFIRMED', exemplars: [
  entry('english', 1, 'New university accreditation standards', { format: '4:5' }),
  entry('sorani', 2, 'ڕێنمایی نوێی زانکۆی کوردستان ژمارە ٢٠٢٦'),
  entry('arabic', 3, 'معايير الجامعة الجديدة للعام ۲۰۲۶'),
  entry('other', 4, 'A football match invitation'),
] });
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('Unicode approved-exemplar lexical retrieval', () => {
  it.each([
    ['ڕێنمایی زانکۆی کوردستان', 'sorani'],
    ['معايير الجامعة الجديدة', 'arabic'],
    ['university accreditation', 'english'],
    ['زانكۆي كوردستان', 'sorani'],
    ['مَعَايِير الجَامِعَة', 'arabic'],
  ])('finds actual text evidence for %s', (text, id) => {
    const result = new ExemplarRetrievalIndex({ manifest: corpus() }).retrieveTopExemplars({ text }, 1);
    expect(result.retrievedIds).toEqual([id]);
    expect(result.evidence.mode).toBe('lexical');
    expect(result.evidence.matchedTokenCount).toBeGreaterThan(0);
    expect(result.retrievedExemplars[0].score).toBeGreaterThan(0);
    expect(result.apiCostUsd).toBe(0);
  });

  it('normalizes only search text, preserving distinct Sorani letters and exact descriptors', () => {
    const original = 'ڕێنمایی ٢٠٢٦ ـــ كوردستان';
    expect(exemplarSearchTokens(original)).toEqual(['ڕێنمایی', '2026', 'کوردستان']);
    expect(exemplarSearchTokens('ڕ ر ێ ی ۆ و ڵ ل ە ه')).toEqual(['ڕ', 'ر', 'ێ', 'ی', 'ۆ', 'و', 'ڵ', 'ل', 'ە', 'ه']);
    const manifest = { status: 'CONFIRMED', exemplars: [entry('exact', 1, original)] };
    const result = new ExemplarRetrievalIndex({ manifest }).retrieveTopExemplars({ text: 'ڕێنمایی ۲۰۲۶' });
    expect(result.brief).toBe('ڕێنمایی ۲۰۲۶');
    expect(result.retrievedExemplars[0].descriptor).toBe(original);
    expect(manifest.exemplars[0].reason).toBe(original);
  });

  it('does not treat separators or a requested format as semantic evidence', () => {
    const index = new ExemplarRetrievalIndex({ manifest: { status: 'CONFIRMED', exemplars: [
      entry('one', 1, 'Blank', { recommendedFor: ['policy_brief'] }), entry('two', 2, 'Other', { format: '4:5' }),
    ] } });
    expect(index.retrieveTopExemplars({ text: 'policy' }).retrievedIds).toEqual(['one']);
    const result = index.retrieveTopExemplars({ text: 'ئەمە هیچ هاوشێوەیەکی نییە', format: '4:5' });
    expect(result.retrievedIds[0]).toBe('two');
    expect(result.evidence.mode).toBe('format_fallback');
    expect(result.evidence.matchedTokenCount).toBe(0);
    expect(result.retrievedExemplars.every(e => e.score === 0)).toBe(true);
    expect(result.evidence.warnings[0]).toContain('cross-language semantic retrieval was not run');
  });

  it('does not let format preferences or zero-evidence fillers replace a lexical match', () => {
    const result = new ExemplarRetrievalIndex({ manifest: corpus() }).retrieveTopExemplars({ text: 'ڕێنمایی', format: '4:5' });
    expect(result.retrievedIds).toEqual(['sorani']);
    expect(result.evidence.matches[0].formatMatch).toBe(false);
  });

  it('filters pending, dropped and unknown admission before scoring', () => {
    const manifest = corpus();
    manifest.exemplars.push(entry('pending', 1, 'ڕێنمایی', { status: 'pending' }), entry('dropped', 1, 'ڕێنمایی', { status: 'dropped' }),
      entry('unknown', 1, 'ڕێنمایی', { status: 'surprise' }), entry('unreviewed', 1, 'ڕێنمایی', { status: undefined }));
    const result = new ExemplarRetrievalIndex({ manifest }).retrieveTopExemplars({ text: 'ڕێنمایی' }, 10);
    expect(result.retrievedIds).toEqual(['sorani']);
    expect(result.evidence.eligibleCount).toBe(4);
    expect(() => new ExemplarRetrievalIndex({ manifest: { ...manifest, status: 'pending' } })).toThrow('confirmed collection');
  });

  it('preserves recorded legacy collection confirmation without accepting explicit pending entries', () => {
    const manifest = { status: 'CONFIRMED', curator: 'Synthetic reviewer', confirmedAt: '2026-09-28', confirmationMethod: 'Fixture',
      exemplars: [entry('old', 1, 'Exact', { status: undefined }), entry('new', 2, 'Exact', { status: 'pending' })] };
    expect(new ExemplarRetrievalIndex({ manifest }).getConfirmedExemplars().map(e => e.id)).toEqual(['old']);
  });

  it('refreshes approval and text changes on an existing instance without any disk cache writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hawa-exemplar-unicode-')); directories.push(dir);
    const manifestPath = join(dir, 'manifest.json'); const manifest = corpus();
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const index = new ExemplarRetrievalIndex({ manifestPath });
    const first = index.retrieveTopExemplars({ text: 'ڕێنمایی' });
    manifest.exemplars[1].status = 'dropped';
    manifest.exemplars[3].reason = 'ڕێنمایی';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const next = index.retrieveTopExemplars({ text: 'ڕێنمایی' });
    expect(first.retrievedIds).toEqual(['sorani']); expect(next.retrievedIds).toEqual(['other']);
    expect(next.evidence.manifestSha256).not.toBe(first.evidence.manifestSha256);
    expect(next.fromCache).toBe(false);
    expect(index.retrieveTopExemplars({ text: 'ڕێنمایی' }).fromCache).toBe(true);
    expect(readdirSync(dir)).toEqual(['manifest.json']);
    writeFileSync(manifestPath, '{invalid');
    expect(() => index.retrieveTopExemplars({ text: 'ڕێنمایی' })).toThrow();
  });

  it('ranks only available admitted images and excludes their terms from lexical statistics', () => {
    const index = new ExemplarRetrievalIndex({ manifest: corpus() });
    const result = index.retrieveTopExemplars({ text: 'ڕێنمایی', format: '4:5' }, 3, ['english','other']);
    expect(result.evidence.eligibleCount).toBe(2);
    expect(result.evidence.matchedTokenCount).toBe(0);
    expect(result.evidence.mode).toBe('format_fallback');
    expect(result.retrievedIds).toEqual(['english','other']);
    expect(index.retrieveTopExemplars({ text: 'ڕێنمایی' }, 3, []).retrievedIds).toEqual([]);
  });

  it('freezes an explicit snapshot and does not expose mutable index state', () => {
    const manifest = corpus(); const index = new ExemplarRetrievalIndex({ manifest });
    manifest.exemplars[1].status = 'dropped';
    index.getConfirmedExemplars()[1].reason = 'mutated';
    expect(index.retrieveTopExemplars({ text: 'ڕێنمایی' }).retrievedIds).toEqual(['sorani']);
  });

  it('bounds counts, rejects invalid limits and resolves ties by curator order then identity', () => {
    const manifest = { status: 'CONFIRMED', exemplars: Array.from({ length: 20 }, (_, i) => entry(`e${i}`, i+1, 'Same')) };
    const index = new ExemplarRetrievalIndex({ manifest });
    expect(index.retrieveTopExemplars({ text: '' }, 100).retrievedIds).toHaveLength(10);
    expect(index.retrieveTopExemplars({ text: '' }, 0).retrievedIds).toEqual([]);
    for (const k of [-1, NaN, Infinity, 1.5]) expect(() => index.retrieveTopExemplars({ text: '' }, k)).toThrow(RangeError);
    expect(index.retrieveTopExemplars({ text: '' }, 2).retrievedIds).toEqual(['e0','e1']);
    manifest.exemplars.reverse();
    expect(new ExemplarRetrievalIndex({ manifest }).retrieveTopExemplars({ text: '' }, 2).retrievedIds).toEqual(['e0','e1']);
  });

  it('refuses duplicate identities and malformed approved metadata', () => {
    const manifest = corpus(); manifest.exemplars.push(manifest.exemplars[0]);
    expect(() => new ExemplarRetrievalIndex({ manifest })).toThrow('unique');
    expect(() => new ExemplarRetrievalIndex({ manifest: { status: 'CONFIRMED', exemplars: [entry('../escape', 1, 'text')] } })).toThrow('invalid');
  });
});
