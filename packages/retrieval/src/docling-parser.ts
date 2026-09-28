import { createHash } from 'node:crypto';
import type { SHA256, UUID } from '@hawa/contracts';

export const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
export const PDF_EXTRACTOR_VERSION = 'docling-2.130.0/parse-7.22.0/native-v1';
const OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 1_000_000;
const PDF_LIMITS = ['Native text order is unverified.', 'OCR, table structure and images are not extracted.'];

export class DocumentExtractionError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'DocumentExtractionError'; }
}
const fail = (code: string): never => { throw new DocumentExtractionError(code); };
const hash = (bytes: string | Uint8Array): SHA256 => createHash('sha256').update(bytes).digest('hex');
const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

export interface DocumentChunk {
  chunkId: UUID;
  documentId: UUID;
  pageNumber: number | null;
  text: string;
  sha256: SHA256;
  tokenCountEstimate: number;
  metadata: {
    sourceKind: 'plain_text' | 'docling_native_pdf'; sourceId: string; mimeType: string;
    characterRange?: { start: number; end: number };
    coordinates?: { x: number; y: number; width: number; height: number };
    coordinateSystem?: 'top_left_points';
  };
}
export interface ParsedDocument {
  documentId: UUID; title: string; sourceSha256: SHA256; chunks: DocumentChunk[];
  tables: Array<{ name: string; rows: Record<string, string>[] }>;
  images: Array<{ storageKey: string; sha256: SHA256; caption?: string }>;
  extraction: { version: string; pageCount: number | null; limitations: string[] };
}
export type PdfExtractor = (bytes: Uint8Array) => Promise<unknown>;

/** Only a deployment-configured private sidecar is a valid destination; documents never supply a URL. */
export function localPdfExtractor(endpoint: string): PdfExtractor {
  let url: URL;
  try { url = new URL(endpoint); } catch { return fail('DOCUMENT_PARSER_CONFIG_INVALID'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', 'docling'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    return fail('DOCUMENT_PARSER_CONFIG_INVALID');
  url.pathname = '/parse';
  return async (bytes) => {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/pdf' },
        body: Buffer.from(bytes), redirect: 'error', signal: AbortSignal.timeout(35_000) });
      if (!response.body) return fail('DOCUMENT_PARSER_UNAVAILABLE');
      const reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > OUTPUT_MAX_BYTES) return fail('DOCUMENT_OUTPUT_LIMIT');
          parts.push(part.value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); }
      catch { return fail('DOCUMENT_RESPONSE_INVALID'); }
      if (!response.ok) {
        const allowed = ['DOCUMENT_SIZE_LIMIT', 'DOCUMENT_INVALID_PDF', 'DOCUMENT_EXTRACTION_INCOMPLETE',
          'DOCUMENT_PROVENANCE_INVALID', 'DOCUMENT_OUTPUT_LIMIT', 'DOCUMENT_OCR_REQUIRED',
          'DOCUMENT_EXTRACTION_FAILED', 'DOCUMENT_PARSER_BUSY', 'DOCUMENT_EXTRACTION_TIMEOUT'];
        return fail(object(body) && typeof body.error === 'string' && allowed.includes(body.error)
          ? body.error : 'DOCUMENT_PARSER_UNAVAILABLE');
      }
      return body;
    } catch (error) {
      if (error instanceof DocumentExtractionError) throw error;
      return fail('DOCUMENT_PARSER_UNAVAILABLE');
    }
  };
}

export class DoclingParser {
  constructor(private readonly extractPdf?: PdfExtractor) {}

  async parse(documentId: UUID, raw: string | Uint8Array, mimeType: string, sourceId: string): Promise<ParsedDocument> {
    const bytes = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw);
    if (!bytes.length || bytes.length > DOCUMENT_MAX_BYTES) return fail('DOCUMENT_SIZE_LIMIT');
    if (!documentId || !sourceId || sourceId.length > 512) return fail('DOCUMENT_SOURCE_INVALID');
    const sourceSha256 = hash(bytes);
    const version = mimeType === 'text/plain' ? 'utf8-paragraphs-v1' : PDF_EXTRACTOR_VERSION;
    const chunks: DocumentChunk[] = [];
    const push = (text: string, pageNumber: number | null, metadata: DocumentChunk['metadata']) => {
      const identity = hash(JSON.stringify([documentId, sourceId, sourceSha256, version, chunks.length, pageNumber, metadata, text]));
      const uuid = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-5${identity.slice(13, 16)}-a${identity.slice(17, 20)}-${identity.slice(20, 32)}`;
      chunks.push({ chunkId: uuid, documentId, pageNumber, text, sha256: hash(text),
        tokenCountEstimate: Math.ceil(text.length / 4), metadata });
    };
    let pageCount: number | null = null;
    if (mimeType === 'text/plain') {
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { return fail('DOCUMENT_UTF8_INVALID'); }
      if (text.length > MAX_TEXT || text.includes('\0')) return fail('DOCUMENT_TEXT_INVALID');
      for (const match of text.matchAll(/[^\r\n]+(?:(?:\r?\n)(?!\r?\n)[^\r\n]+)*/g)) {
        if (!match[0].trim()) continue;
        push(match[0], null, { sourceKind: 'plain_text', sourceId, mimeType,
          characterRange: { start: match.index, end: match.index + match[0].length } });
        if (chunks.length > 10_000) return fail('DOCUMENT_OUTPUT_LIMIT');
      }
    } else if (mimeType === 'application/pdf') {
      if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') return fail('DOCUMENT_INVALID_PDF');
      if (!this.extractPdf) return fail('DOCUMENT_PARSER_NOT_CONFIGURED');
      const result = await this.extractPdf(bytes);
      if (!object(result) || result.version !== version || result.sourceSha256 !== sourceSha256 ||
          !Array.isArray(result.pages) || !result.pages.length || result.pages.length > 40 ||
          !Array.isArray(result.blocks) || !result.blocks.length || result.blocks.length > 10_000)
        return fail('DOCUMENT_RESPONSE_INVALID');
      const dimensions = new Map<number, { width: number; height: number }>();
      for (const [index, p] of result.pages.entries()) {
        if (!object(p) || p.number !== index + 1 || typeof p.width !== 'number' || typeof p.height !== 'number' ||
            !Number.isFinite(p.width) || !Number.isFinite(p.height) || p.width <= 0 || p.height <= 0 ||
            p.width > 14_400 || p.height > 14_400) return fail('DOCUMENT_PROVENANCE_INVALID');
        dimensions.set(p.number as number, { width: p.width, height: p.height });
      }
      let total = 0;
      const covered = new Set<number>();
      for (const b of result.blocks) {
        if (!object(b) || typeof b.text !== 'string' || !b.text.trim() || b.text.includes('\0') ||
            typeof b.page !== 'number' || !dimensions.has(b.page) || !object(b.bbox)) return fail('DOCUMENT_PROVENANCE_INVALID');
        const box = b.bbox;
        if (![box.x, box.y, box.width, box.height].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0))
          return fail('DOCUMENT_PROVENANCE_INVALID');
        const coordinates = { x: box.x as number, y: box.y as number,
          width: box.width as number, height: box.height as number };
        const page = dimensions.get(b.page)!;
        if (coordinates.x + coordinates.width > page.width + 0.1 || coordinates.y + coordinates.height > page.height + 0.1)
          return fail('DOCUMENT_PROVENANCE_INVALID');
        total += b.text.length;
        if (total > MAX_TEXT) return fail('DOCUMENT_OUTPUT_LIMIT');
        covered.add(b.page);
        push(b.text, b.page, { sourceKind: 'docling_native_pdf', sourceId, mimeType,
          coordinates, coordinateSystem: 'top_left_points' });
      }
      if (covered.size !== dimensions.size) return fail('DOCUMENT_EXTRACTION_INCOMPLETE');
      pageCount = dimensions.size;
    } else return fail('DOCUMENT_MEDIA_UNSUPPORTED');
    if (!chunks.length) return fail('DOCUMENT_TEXT_EMPTY');
    return { documentId, title: sourceId, sourceSha256, chunks, tables: [], images: [],
      extraction: { version, pageCount, limitations: mimeType === 'application/pdf' ? [...PDF_LIMITS] : [] } };
  }
}
