import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { DoclingParser, localPdfExtractor } from '../../packages/retrieval/dist/docling-parser.js';
const parser = new DoclingParser(localPdfExtractor('http://docling:8091'));
const bytes = readFileSync(new URL('./fixtures/two-pages.pdf', import.meta.url));
const checks = [];
const record = async (name, check) => { await check(); checks.push({ name, passed: true }); };
let result;
await record('real compressed pages, exact text and measured boxes', async () => {
  result = await parser.parse('proof', bytes, 'application/pdf', 'uploaded.pdf');
  assert.deepEqual(result.chunks.map(c => [c.pageNumber, c.text]), [
    [1, 'Hawa source page one 123.45'], [2, 'Hawa source page two 678.90']]);
  assert.equal(result.chunks[0].metadata.coordinates.x, 72);
  assert.ok(result.chunks[0].metadata.coordinates.y > 83 && result.chunks[0].metadata.coordinates.y < 84);
  assert.equal(result.sourceSha256, createHash('sha256').update(bytes).digest('hex'));
});
await record('stable replay identity', async () => {
  assert.deepEqual(await parser.parse('proof', bytes, 'application/pdf', 'uploaded.pdf'), result);
});
for (const [file, code] of [['blank.pdf','DOCUMENT_OCR_REQUIRED'], ['too-many-pages.pdf','DOCUMENT_EXTRACTION_INCOMPLETE']]) {
  await record(`refuse ${file}`, async () => {
    await assert.rejects(parser.parse('proof', readFileSync(new URL(`./fixtures/${file}`, import.meta.url)), 'application/pdf', file), { code });
  });
}
await record('refuse malformed PDF', async () => {
  await assert.rejects(parser.parse('proof', Buffer.from('%PDF-1.7 garbage'), 'application/pdf', 'bad.pdf'), error =>
    ['DOCUMENT_EXTRACTION_FAILED','DOCUMENT_EXTRACTION_INCOMPLETE'].includes(error.code));
});
await record('refuse oversized declared body before extraction', async () => {
  const response = await fetch('http://docling:8091/parse', { method:'POST', headers:{'Content-Type':'application/pdf'}, body:Buffer.alloc(20*1024*1024+1) });
  assert.equal(response.status,413);
});
console.log(JSON.stringify({at:new Date().toISOString(), fixtureSha256:result.sourceSha256, extraction:result.extraction, checks}, null, 2));
