import { registerDocumentRoutes } from './documents.routes.js';
import { sanitizeSvg } from '@hawa/domain';
import type { Context } from 'hono';
import type { RouteContext } from './types.js';
import { DEFAULT_TENANT_ID, OPERATOR_USER_ID } from '../core-context.js';
import { findClientRowId } from '../services/client-row.js';
import { listUploadedAssets, saveUploadedAsset, uploadedAssetContent } from '../services/uploaded-assets.js';
import { log } from '../logging.js';
import { sql, withRlsContext } from '@hawa/db';
import { parseBlobRef, isSha256Hex } from '@hawa/contracts';
import { inspectUploadedAssetBytes } from '@hawa/creative';
import { chaosPoint } from '@hawa/observability';
import { blobStoreFor } from '../services/blob-store-context.js';
import { parseAssetUpload, AssetUploadError, ASSET_JSON_MAX_BYTES } from '../services/uploaded-asset-input.js';

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

  registerDocumentRoutes(ctx);

  // Asset Security & Ingestion
  const store = blobStoreFor(db, ctx.options?.blobStore);
  let assetUploadActive = false;
  registerRoute('post', '/assets/upload', async (c: Context) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated || !auth.userId || auth.role === 'service') return problem(c, 401, 'Authentication Required');
    if (assetUploadActive) return problem(c, 503, 'ASSET_UPLOAD_BUSY', 'Another asset is being inspected. Retry shortly.');
    if (c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
      return problem(c, 415, 'ASSET_JSON_REQUIRED', 'Upload an asset JSON object.');
    const declared = c.req.header('Content-Length');
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > ASSET_JSON_MAX_BYTES))
      return problem(c, 413, 'ASSET_SIZE_LIMIT', 'The upload exceeds the bounded JSON envelope.');
    assetUploadActive = true;
    try {
      const reader = c.req.raw.body?.getReader();
      if (!reader) throw new AssetUploadError(400, 'ASSET_INPUT_EMPTY', 'Supply actual file content.');
      const parts: Uint8Array[] = []; let total = 0, timedOut = false;
      const deadline = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => undefined); }, 10_000);
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          total += part.value.byteLength;
          if (total > ASSET_JSON_MAX_BYTES) throw new AssetUploadError(413, 'ASSET_SIZE_LIMIT', 'The upload exceeds the bounded JSON envelope.');
          parts.push(part.value);
        }
      } finally { clearTimeout(deadline); await reader.cancel().catch(() => undefined); }
      if (timedOut) throw new AssetUploadError(408, 'ASSET_INPUT_TIMEOUT', 'Retry the complete upload.');
      let body: unknown;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))); }
      catch { throw new AssetUploadError(400, 'ASSET_JSON_INVALID', 'Supply a valid UTF-8 JSON object.'); }
      const input = parseAssetUpload(body), { actorId, ...scope } = scopeOf(c);
      if (!db || !clientRepo || !store) return problem(c, 503, 'ASSET_STORE_UNAVAILABLE', 'A verified database and original-file store are required.');
      const clientId = await findClientRowId(db, clientRepo, scope, input.clientId);
      if (!clientId || !await withRlsContext(db, scope, trx => trx.selectFrom('clients').select('id')
        .where('tenant_id', '=', scope.tenantId).where('id', '=', clientId).where('status', '=', 'active')
        .where(sql<boolean>`hawa.can_write_client(${scope.tenantId}::uuid,${clientId}::uuid)`).executeTakeFirst()))
        return problem(c, 404, 'Client Not Found', 'Select an available writable client.');
      try { await inspectUploadedAssetBytes(input.admittedBytes, input.mimeType); }
      catch { throw new AssetUploadError(422, 'ASSET_CONTENT_UNREADABLE', 'The file could not be decoded within the upload limits.'); }
      const source = await store.put(input.sourceBytes, input.mimeType);
      const blob = input.sourceBytes.equals(input.admittedBytes) ? source : await store.put(input.admittedBytes, input.mimeType);
      await store.read(source, { verify: true });
      if (source.sha256 !== blob.sha256) await store.read(blob, { verify: true });
      await chaosPoint('core.assets.after-bytes', { clientId, sourceSha256: source.sha256 });
      const saved = await saveUploadedAsset(db, scope, { clientId, category: input.category, filename: input.filename,
        blob, source, sanitized: input.sanitized, uploadedBy: actorId });
      await chaosPoint('core.assets.after-receipt', { clientId, assetId: saved.assetId });
      broadcast('asset:ingested', { assetId: saved.assetId, clientId, filename: saved.filename, sha256: saved.sha256 });
      return c.json({ ...saved, contentUrl: `/v1/assets/${saved.assetId}/content`, sourceSha256: source.sha256 }, 201);
    } catch (error) {
      if (error instanceof AssetUploadError) return problem(c, error.status, error.code, error.message);
      log.warn('[core:assets] Asset retention did not complete');
      return problem(c, 503, 'ASSET_RETENTION_UNAVAILABLE', 'Asset retention could not be confirmed. Retry the same complete content after the source store and database are available.');
    } finally { assetUploadActive = false; }
  });

  const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const content = (original: boolean) => async (c: Context) => {
    const auth = verifyRequestAuth(c), id = c.req.param('assetId') ?? '', source = original ? c.req.param('sourceSha256') : undefined;
    if (!auth.authenticated || !auth.userId || auth.role === 'service') return problem(c, 401, 'Authentication Required');
    if (!uuid(id) || (original && !isSha256Hex(source))) return problem(c, 404, 'Asset Not Found');
    if (!db || !store) return problem(c, 503, 'ASSET_STORE_UNAVAILABLE');
    c.header('Cache-Control', 'private, no-store');
    try {
      const { actorId: _actor, ...scope } = scopeOf(c);
      const row = await uploadedAssetContent(db, scope, id, source);
      if (!row) return problem(c, 404, 'Asset Not Found');
      const ref = parseBlobRef({ sha256: row.sha256, mediaType: row.media_type, size: Number(row.size) });
      if (!ref) return problem(c, 409, 'ASSET_SOURCE_NOT_RETAINED', 'This historical asset has no retained file. Supply its genuine original bytes.');
      const bytes = await store.read(ref, { verify: true });
      return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': original ? 'application/octet-stream' : ref.mediaType,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, no-store', 'X-Content-SHA256': ref.sha256, 'Content-Length': String(bytes.length) } });
    } catch {
      return problem(c, 503, 'ASSET_SOURCE_UNAVAILABLE', 'Restore missing or damaged source bytes before continuing.');
    }
  };
  registerRoute('get', '/assets/:assetId/content', content(false));
  registerRoute('get', '/assets/:assetId/sources/:sourceSha256/content', content(true));
  registerRoute('get', '/assets/:assetId/sources', async (c: Context) => {
    const auth = verifyRequestAuth(c), id = c.req.param('assetId') ?? '';
    if (!auth.authenticated || !auth.userId || auth.role === 'service') return problem(c, 401, 'Authentication Required');
    if (!uuid(id)) return problem(c, 404, 'Asset Not Found');
    if (!db) return problem(c, 503, 'Database Unavailable');
    c.header('Cache-Control', 'private, no-store');
    try {
      const { actorId: _actor, ...scope } = scopeOf(c);
      return await withRlsContext(db, scope, async trx => {
        const asset = (await sql`SELECT id FROM hawa.brand_assets WHERE tenant_id=${scope.tenantId}::uuid AND id=${id}::uuid`.execute(trx)).rows[0];
        if (!asset) return problem(c, 404, 'Asset Not Found');
        const rows = (await sql`SELECT source_sha256 AS "sourceSha256",filename,uploaded_by AS "uploadedBy",created_at AS "createdAt"
          FROM hawa.uploaded_asset_sources WHERE tenant_id=${scope.tenantId}::uuid AND asset_id=${id}::uuid
          ORDER BY created_at DESC,source_sha256 DESC LIMIT 101`.execute(trx)).rows;
        return c.json({ assetId: id, items: rows.slice(0,100), truncated: rows.length > 100 });
      });
    } catch { return problem(c, 503, 'ASSET_SOURCE_UNAVAILABLE'); }
  });

  registerRoute('post', '/assets/sanitize-svg', async (c: any) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.svg !== 'string') {
      return problem(c, 400, 'Invalid SVG Request', 'svg string is required');
    }

    const res = sanitizeSvg(body.svg);
    return c.json(res);
  });

  // Inspect supplied text without silently rewriting facts (FR-013, FR-014).
  registerRoute('post', '/assets/transcribe-brief', async (c: any) => {
    const body = await c.req.json().catch(() => ({}));
    // This standalone route has no locked client scope or trusted policy decision. A caller's
    // claimed clientId/egressPolicy cannot authorize sending uploaded voice to a cloud provider.
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return problem(c, 422, 'Invalid Source', 'Supply a text source object.');
    if (body.audioBase64 !== undefined && body.audioBase64 !== '') {
      return problem(c, 412, 'Voice Egress Not Authorized',
        'A verified client model-egress decision is required before audio transcription. Send the brief as text or use a scoped intake flow.');
    }
    const textHint = body.text ?? body.transcript;
    if (typeof textHint !== 'string' || !textHint.trim() || textHint.length > 100_000)
      return problem(c, 422, 'Invalid Source', 'Supply non-empty text of at most 100,000 characters.');

    const result = await voiceTranscriber.transcribe(
      {
        durationSeconds: typeof body.durationSeconds === 'number' ? body.durationSeconds : undefined,
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
