import crypto from 'node:crypto';
import { validateUploadedAsset, sanitizeSvg } from '@hawa/domain';
import type { Context } from 'hono';
import type { RouteContext } from './types.js';
import { DEFAULT_TENANT_ID, OPERATOR_USER_ID } from '../core-context.js';
import { findClientRowId } from '../services/client-row.js';
import { listUploadedAssets, saveUploadedAsset } from '../services/uploaded-assets.js';
import { log } from '../logging.js';
import { withRlsContext } from '@hawa/db';
import { DoclingParser, DocumentExtractionError, DOCUMENT_MAX_BYTES, localPdfExtractor } from '@hawa/retrieval';

/**
 * Asset upload and SVG sanitising, and the voice-brief transcriber. Moved out of app.ts by group G1
 * (leaves) of the split (architecture programme 1.3, SPLIT_PLAN.md section 2).
 */
export function registerAssetsRoutes(ctx: RouteContext): void {
  const { registerRoute, problem, uploadedAssets, voiceTranscriber, broadcastEvent: broadcast, db, clientRepo, verifyRequestAuth } = ctx;
  const scopeOf = (c: Context) => {
    const auth = verifyRequestAuth(c);
    return { tenantId: auth.tenantId || DEFAULT_TENANT_ID, userId: auth.userId || OPERATOR_USER_ID, role: auth.role || 'operator', actorId: auth.actorId || 'operator' };
  };

  // One bounded upload/conversion per Core process, without a queue of buffered documents.
  let documentInspectionActive = false;
  // Inspection only: no persistent source, knowledge approval or task creation.
  registerRoute('post', '/clients/:clientId/documents/inspect', async (c: Context) => {
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
      .where('status', '=', 'active').executeTakeFirst());
    let ownsSlot = false;
    try {
      if (!await allowed()) return problem(c, 404, 'Client Not Found', 'Select an available client.');
      if (documentInspectionActive) return problem(c, 503, 'DOCUMENT_PARSER_BUSY', 'Another PDF is being inspected. Retry shortly.');
      documentInspectionActive = true;
      ownsSlot = true;
      if (!process.env.HAWA_DOCLING_URL) return problem(c, 503, 'DOCUMENT_PARSER_NOT_CONFIGURED',
        'Local PDF inspection is not configured. Keep the original file and ask the office operator to enable it.');
      const parser = new DoclingParser(localPdfExtractor(process.env.HAWA_DOCLING_URL));
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
      const document = await parser.parse(`${clientId}:${digest}`, bytes, 'application/pdf', 'uploaded.pdf');
      if (!await allowed()) return problem(c, 404, 'Client Not Found', 'Client access changed during inspection.');
      return c.json({ clientId, sourceSaved: false, approved: false, document });
    } catch (error) {
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
  });

  // Asset Security & Ingestion
  registerRoute('post', '/assets/upload', async (c: any) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !body.filename || !body.mimeType) {
      return problem(c, 400, 'Invalid Asset Request', 'filename and mimeType are required');
    }

    const validation = validateUploadedAsset({
      filename: body.filename,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes || (body.content ? (typeof body.content === 'string' ? Buffer.byteLength(body.content) : body.content.length) : 1024),
      content: body.content,
    });

    if (!validation.ok) {
      return problem(c, 400, 'Asset Security Policy Violation', validation.violations.join('; '));
    }

    const assetId = crypto.randomUUID();
    const storageKey = `assets/${validation.sha256}/${body.filename}`;
    // Every asset belongs to a client. One sent without a client was filed under the fixture office
    // client-office-1 (SPLIT_PLAN.md section 6), where a search for the real client never found it.
    const clientId = typeof body.clientId === 'string' && body.clientId.trim() ? body.clientId.trim() : undefined;
    if (!clientId) return problem(c, 422, 'CLIENT_REQUIRED', 'Name the client this asset belongs to (clientId).');
    const category = body.category || 'asset';

    // With a database the admitted asset is a row of hawa.brand_assets (services/uploaded-assets.ts)
    // for a client Postgres knows; the no-database store below held it for this process only.
    if (db && clientRepo) {
      const { actorId, ...scope } = scopeOf(c);
      try {
        const clientRowId = await findClientRowId(db, clientRepo, scope, clientId);
        if (!clientRowId) return problem(c, 404, 'Client Not Found', `Client '${clientId}' is not in the database`);
        const saved = await saveUploadedAsset(db, scope, {
          clientId: clientRowId, category, filename: body.filename, mimeType: validation.mimeType ?? body.mimeType, sha256: String(validation.sha256),
          sanitized: Boolean(validation.sanitizedContent), uploadedBy: actorId,
        });
        broadcast('asset:ingested', { assetId: saved.assetId, clientId: saved.clientId, filename: saved.filename, sha256: saved.sha256 });
        return c.json({ ...saved, ...(validation.sanitizedContent ? { sanitizedContent: validation.sanitizedContent } : {}) }, 201);
      } catch (err) {
        // A client id that names no client row breaks the foreign key.
        if ((err as { code?: string })?.code === '23503') return problem(c, 404, 'Client Not Found', `Client '${clientId}' is not in the database`);
        log.error('[core:assets] the uploaded asset could not be recorded:', err);
        return problem(c, 503, 'Database Unavailable', 'The asset could not be recorded; try again');
      }
    }

    const record = {
      assetId,
      clientId,
      category,
      filename: body.filename,
      mimeType: validation.mimeType,
      sha256: validation.sha256,
      storageKey,
      sanitized: Boolean(validation.sanitizedContent),
      sanitizedContent: validation.sanitizedContent,
      createdAt: new Date().toISOString(),
    };
    uploadedAssets.set(assetId, record);

    broadcast('asset:ingested', { assetId, clientId, filename: record.filename, sha256: record.sha256 });

    return c.json(record, 201);
  });

  registerRoute('post', '/assets/sanitize-svg', async (c: any) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.svg !== 'string') {
      return problem(c, 400, 'Invalid SVG Request', 'svg string is required');
    }

    const res = sanitizeSvg(body.svg);
    return c.json(res);
  });

  // Transcribe Kurdish Voice Message into Normalized Brief & Protected Tokens (FR-013, FR-014)
  registerRoute('post', '/assets/transcribe-brief', async (c: any) => {
    const body = await c.req.json().catch(() => ({}));
    // This standalone route has no locked client scope or trusted policy decision. A caller's
    // claimed clientId/egressPolicy cannot authorize sending uploaded voice to a cloud provider.
    if (typeof body.audioBase64 === 'string' && body.audioBase64.trim()) {
      return problem(c, 412, 'Voice Egress Not Authorized',
        'A verified client model-egress decision is required before audio transcription. Send the brief as text or use a scoped intake flow.');
    }
    const textHint = body.text || body.transcript;
    const duration = body.durationSeconds || 12;

    const result = await voiceTranscriber.transcribe(
      {
        audioBase64: body.audioBase64,
        audioMimeType: body.audioMimeType || 'audio/ogg',
        durationSeconds: duration,
        languageHint: 'ckb',
      },
      textHint
    );

    return c.json(result, 200);
  });

  // List All Admitted & Verified Assets (FR-018, Gate A & B)
  registerRoute('get', '/assets', async (c: any) => {
    const clientId = c.req.query('clientId');
    if (db && clientRepo) {
      const { actorId: _actor, ...scope } = scopeOf(c);
      try {
        if (!clientId || clientId === 'all') return c.json(await listUploadedAssets(db, scope), 200);
        const clientRowId = await findClientRowId(db, clientRepo, scope, clientId);
        return c.json(clientRowId ? await listUploadedAssets(db, scope, clientRowId) : [], 200);
      } catch (err) {
        log.error('[core:assets] the assets could not be read:', err);
        return problem(c, 503, 'Database Unavailable', 'The assets could not be read; try again');
      }
    }
    // Without a database, the no-database store's.
    let all = Array.from(uploadedAssets.values());
    if (clientId && clientId !== 'all') {
      all = all.filter((a: any) => !a.clientId || a.clientId === clientId);
    }
    return c.json(all, 200);
  });
}
