import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DoclingParser, PDF_EXTRACTOR_VERSION, localPdfExtractor } from '../src/docling-parser.js';

describe('document source fidelity', () => {
  it('never invents page locations for plain text', async () => {
    const result = await new DoclingParser().parse('doc', 'First\n\nSecond', 'text/plain', 'guide.txt');
    expect(result.chunks[0].pageNumber).toBeNull();
    expect(result.chunks[0].metadata.coordinates).toBeUndefined();
    expect(result.chunks[1].metadata).toMatchObject({ sourceKind: 'plain_text', characterRange: { start: 7, end: 13 } });
  });
  it('retains identical chunk identities across replay', async () => {
    const p = new DoclingParser();
    expect(await p.parse('doc', 'Same source', 'text/plain', 'guide.txt'))
      .toEqual(await p.parse('doc', 'Same source', 'text/plain', 'guide.txt'));
  });
  it('rejects invalid UTF-8 rather than rewriting the source bytes', async () => {
    await expect(new DoclingParser().parse('doc', Buffer.from([0xff, 0xfe]), 'text/plain', 'guide.txt')).rejects.toThrow();
  });
  it('refuses PDF parsing without an actual configured extractor', async () => {
    await expect(new DoclingParser().parse('doc', Buffer.from('%PDF-1.7\nnot parsed'), 'application/pdf', 'guide.pdf')).rejects.toThrow();
  });
  it('refuses a claimed MIME type it cannot extract', async () => {
    await expect(new DoclingParser().parse('doc', 'hidden content', 'application/zip', 'guide.zip')).rejects.toThrow();
  });
  it('hashes original bytes, including the UTF-8 BOM', async () => {
    const bytes = Buffer.from('\ufeffOriginal text');
    const result = await new DoclingParser().parse('doc', bytes, 'text/plain', 'guide.txt');
    expect(result.sourceSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});

describe('Docling result validation', () => {
  const bytes = Buffer.from('%PDF-1.7 fixture');
  const good = () => ({ version: PDF_EXTRACTOR_VERSION, sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    pages: [{ number: 1, width: 612, height: 792 }],
    blocks: [{ page: 1, text: 'Keep exact ١٢٬٠٠٠', bbox: { x: 50, y: 80, width: 200, height: 12 } }] });
  it('keeps exact text and real coordinates with stable IDs and explicit limits', async () => {
    const p = new DoclingParser(async () => good());
    const result = await p.parse('d', bytes, 'application/pdf', 'source.pdf');
    expect(result.chunks[0]).toMatchObject({ pageNumber: 1, text: 'Keep exact ١٢٬٠٠٠',
      metadata: { coordinateSystem: 'top_left_points', coordinates: { x: 50, y: 80 } } });
    expect(result.extraction.limitations).toHaveLength(2);
    expect(await p.parse('d', bytes, 'application/pdf', 'source.pdf')).toEqual(result);
    expect((await p.parse('different', bytes, 'application/pdf', 'source.pdf')).chunks[0].chunkId).not.toBe(result.chunks[0].chunkId);
  });
  it.each(['hash', 'version', 'page', 'box', 'missing', 'oversize'] as const)('refuses %s mismatch without partial output', async kind => {
    const result = good();
    if (kind === 'hash') result.sourceSha256 = 'f'.repeat(64);
    if (kind === 'version') result.version = 'unknown';
    if (kind === 'page') result.blocks[0].page = 3;
    if (kind === 'box') result.blocks[0].bbox.width = 10000;
    if (kind === 'missing') result.pages.push({ number: 2, width: 612, height: 792 });
    if (kind === 'oversize') result.blocks[0].text = 'x'.repeat(1_000_001);
    await expect(new DoclingParser(async () => result).parse('d', bytes, 'application/pdf', 'source.pdf')).rejects.toThrow();
  });
  it('refuses off-machine or redirected destinations and bounds service responses', async () => {
    for (const endpoint of ['https://example.test', 'http://127.0.0.1@evil.test', 'file:///etc/passwd', 'http://localhost/?url=x'])
      expect(() => localPdfExtractor(endpoint)).toThrow();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('x'.repeat(8 * 1024 * 1024 + 1)));
    try {
      await expect(localPdfExtractor('http://127.0.0.1:19091')(bytes)).rejects.toThrow('DOCUMENT_OUTPUT_LIMIT');
      expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
    } finally { fetcher.mockRestore(); }
  });
});
