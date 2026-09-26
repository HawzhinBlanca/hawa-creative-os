import crypto from 'node:crypto';
import type { Context } from 'hono';
import type { RouteContext } from './types.js';
import { withRlsContext, sql } from '@hawa/db';
import { chaosPoint } from '@hawa/observability';
import { DoclingParser, DocumentExtractionError, DOCUMENT_MAX_BYTES, PDF_EXTRACTOR_VERSION, localPdfExtractor } from '@hawa/retrieval';
import { log } from '../logging.js';
import { blobStoreFor } from '../services/blob-store-context.js';
import { documentReceipt, savedDocument, findDocument, findDocumentByHash, retainDocument, DocumentIntakeError, type DocumentRow } from '../services/client-documents.js';
import { registerDocumentKnowledgeRoutes } from './document-knowledge.routes.js';

const uuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export function registerDocumentRoutes(ctx: RouteContext): void {
  registerDocumentKnowledgeRoutes(ctx);
  const { db, registerRoute, problem, verifyRequestAuth } = ctx;
  const store = blobStoreFor(db, ctx.options?.blobStore);
  const scopeOf = (c: Context) => {
    const auth = verifyRequestAuth(c);
    return { tenantId: auth.tenantId!, userId: auth.userId!, role: auth.role! };
  };
  // One bounded upload/conversion per Core process, without a queue of buffered documents.
  let documentInspectionActive = false;
  const upload = (retain: boolean) => async (c: Context) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated || !auth.userId || auth.role === 'service')
      return problem(c, 401, 'Authentication Required', 'Sign in to inspect a client document.');
    if (!db) return problem(c, 503, 'Database Unavailable', 'Client authorization could not be checked.');
    const clientId = c.req.param('clientId') ?? '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId))
      return problem(c, 404, 'Client Not Found', 'Select an available client.');
    const scope = scopeOf(c);
    const allowed = () => withRlsContext(db, scope, trx => trx.selectFrom('clients')
      .select('id').where('id', '=', clientId).where('tenant_id', '=', scope.tenantId)
      .where('status', '=', 'active')
      .$if(retain, q => q.where(sql<boolean>`hawa.can_write_client(${scope.tenantId}::uuid,${clientId}::uuid)`)).executeTakeFirst());
    let ownsSlot = false;
    try {
      if (!await allowed()) return problem(c, 404, 'Client Not Found', 'Select an available client.');
      if (documentInspectionActive) return problem(c, 503, 'DOCUMENT_PARSER_BUSY', 'Another PDF is being inspected. Retry shortly.');
      documentInspectionActive = true;
      ownsSlot = true;
      if (c.req.header('Content-Type') !== 'application/pdf')
        return problem(c, 415, 'DOCUMENT_MEDIA_UNSUPPORTED', 'Upload a PDF file.');
      const declared = c.req.header('Content-Length');
      if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > DOCUMENT_MAX_BYTES))
        return problem(c, 413, 'DOCUMENT_SIZE_LIMIT', 'PDF files must be at most 20 MiB.');
      const reader = c.req.raw.body?.getReader();
      if (!reader) return problem(c, 400, 'DOCUMENT_INPUT_EMPTY', 'Choose a PDF file.');
      const parts: Uint8Array[] = [];
      let size = 0;
      let timedOut = false;
      const deadline = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => undefined); }, 10_000);
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > DOCUMENT_MAX_BYTES) return problem(c, 413, 'DOCUMENT_SIZE_LIMIT', 'PDF files must be at most 20 MiB.');
          parts.push(part.value);
        }
      } finally { clearTimeout(deadline); await reader.cancel().catch(() => undefined); }
      if (timedOut) return problem(c, 408, 'DOCUMENT_INPUT_TIMEOUT', 'The PDF upload took too long. Retry the complete file.');
      const bytes = Buffer.concat(parts);
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      if (retain) {
        if (!store) return problem(c, 503, 'DOCUMENT_STORE_UNAVAILABLE', 'The original PDF store is unavailable.');
        const prior = await withRlsContext(db, scope, trx => findDocumentByHash(trx, scope.tenantId, clientId, digest, PDF_EXTRACTOR_VERSION));
        if (prior) {
          await store.put(bytes, 'application/pdf');
          await store.read(digest, { verify: true });
          if (!await allowed()) return problem(c, 404, 'Client Not Found', 'Client access changed.');
          return c.json(savedDocument(prior));
        }
      }
      if (!process.env.HAWA_DOCLING_URL) return problem(c, 503, 'DOCUMENT_PARSER_NOT_CONFIGURED',
        'Local PDF inspection is not configured. Keep the original file and ask the office operator to enable it.');
      const parser = new DoclingParser(localPdfExtractor(process.env.HAWA_DOCLING_URL));
      const document = await parser.parse(`${clientId}:${digest}`, bytes, 'application/pdf', 'uploaded.pdf');
      if (!await allowed()) return problem(c, 404, 'Client Not Found', 'Client access changed during inspection.');
      if (!retain) return c.json({ clientId, sourceSaved: false, approved: false, document });
      // Bytes commit first; an interrupted receipt transaction leaves a GC-eligible orphan.
      await store!.put(bytes, 'application/pdf');
      await store!.read(digest, { verify: true });
      await chaosPoint('core.documents.after-bytes', { clientId, sourceSha256: digest });
      const row = await withRlsContext(db, scope, async trx => {
        const client = await trx.selectFrom('clients').select('id').where('id', '=', clientId)
          .where('tenant_id', '=', scope.tenantId).where('status', '=', 'active')
          .where(sql<boolean>`hawa.can_write_client(${scope.tenantId}::uuid,${clientId}::uuid)`)
          .forShare().executeTakeFirst();
        if (!client) throw new DocumentIntakeError(403, 'Client access changed during inspection.');
        return retainDocument(trx, { ...scope, clientId, document });
      });
      await chaosPoint('core.documents.after-receipt', { clientId, documentId: row.id });
      return c.json(savedDocument(row), 201);
    } catch (error) {
      if (error instanceof DocumentIntakeError) return problem(c, error.status, 'DOCUMENT_INTAKE_REFUSED', error.message);
      if (error instanceof DocumentExtractionError) {
        const unavailable = /CONFIG|UNAVAILABLE|BUSY|TIMEOUT/.test(error.code);
        return problem(c, unavailable ? 503 : 422, error.code,
          error.code === 'DOCUMENT_OCR_REQUIRED'
            ? 'A page has no extractable text. Supply a text PDF or transcribe every page for review.'
            : `PDF inspection stopped (${error.code}). Keep the original and review it manually; no content was saved.`);
      }
      log.warn('[core:documents] Client document inspection unavailable');
      return problem(c, 503, 'DOCUMENT_INSPECTION_UNAVAILABLE', 'The document could not be inspected. Retry after the local service is available.');
    } finally {
      if (ownsSlot) documentInspectionActive = false;
    }
  };


  registerRoute('post', '/clients/:clientId/documents/inspect', upload(false));
  registerRoute('post', '/clients/:clientId/documents', upload(true));
  const read = (mode: 'list' | 'receipt' | 'content') => async (c: Context) => {
    const auth = verifyRequestAuth(c), clientId = c.req.param('clientId') ?? '', id = c.req.param('documentId') ?? '';
    if (!auth.authenticated || !auth.userId || auth.role === 'service') return problem(c, 401, 'Authentication Required');
    if (!uuid(clientId) || (mode !== 'list' && !uuid(id))) return problem(c, 404, 'Document Not Found');
    if (!db) return problem(c, 503, 'Database Unavailable');
    c.header('Cache-Control', 'private, no-store');
    try {
      const scope = scopeOf(c);
      if (mode === 'list') {
        const rows = await withRlsContext(db, scope, trx => sql<DocumentRow>`SELECT id,client_id,source_sha256,
          extraction_sha256,extractor_version,created_at FROM hawa.client_documents WHERE tenant_id=${scope.tenantId}::uuid
          AND client_id=${clientId}::uuid ORDER BY created_at DESC,id DESC LIMIT 20`.execute(trx));
        return c.json({ items: rows.rows.map(documentReceipt) });
      }
      const row = await withRlsContext(db, scope, trx => findDocument(trx, scope.tenantId, clientId, id));
      if (!row) return problem(c, 404, 'Document Not Found');
      if (mode === 'receipt') return c.json(savedDocument(row));
      if (!store) return problem(c, 503, 'Document Store Unavailable');
      const bytes = await store.read(row.source_sha256, { verify: true });
      return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="source.pdf"', 'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store', 'X-Content-SHA256': row.source_sha256 } });
    } catch {
      return problem(c, 503, 'Document Unavailable', 'The saved document could not be read. Restore missing or damaged source bytes before continuing.');
    }
  };
  registerRoute('get', '/clients/:clientId/documents', read('list'));
  registerRoute('get', '/clients/:clientId/documents/:documentId', read('receipt'));
  registerRoute('get', '/clients/:clientId/documents/:documentId/content', read('content'));
}
