/** Retained adapter originals stay inspectable even when extraction never produced a document. */
import type { Context } from 'hono';
import { sql, withRlsContext } from '@hawa/db';
import { parseBlobRef } from '@hawa/contracts';
import type { RouteContext } from './types.js';
import type { SourceUpload } from '../services/lifecycle-source-store.js';
import { blobStoreFor } from '../services/blob-store-context.js';

export function registerSourceFileRoutes(ctx: RouteContext): void {
  const { db, registerRoute, problem, verifyRequestAuth } = ctx;
  const store = blobStoreFor(db, ctx.options?.blobStore);
  const read = (content: boolean) => async (c: Context) => {
    const auth = verifyRequestAuth(c), clientId = c.req.param('clientId') ?? '', updateId = c.req.param('updateId') ?? '';
    if (!auth.authenticated || !auth.userId || auth.role === 'service') return problem(c, 401, 'Authentication Required');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId) ||
        (content && (!/^[1-9][0-9]*$/.test(updateId) || !Number.isSafeInteger(Number(updateId)))))
      return problem(c, 404, 'Source Not Found');
    if (!db) return problem(c, 503, 'Database Unavailable');
    c.header('Cache-Control', 'private, no-store');
    const scope = { tenantId: auth.tenantId!, userId: auth.userId, role: auth.role! };
    try {
      const result = await withRlsContext(db, scope, async trx => {
        const client = await trx.selectFrom('clients').select('id').where('tenant_id', '=', scope.tenantId)
          .where('id', '=', clientId).where('status', '=', 'active').executeTakeFirst();
        if (!client) return null;
        // Inbox rows are tenant scoped. Join the RLS-visible client in the source read itself.
        return (await sql<{ payload: SourceUpload; received_at: Date; document_id: string | null;
          confirmed: boolean; failure: string | null }>`SELECT e.payload,e.received_at,
            x.payload->>'documentId' AS document_id,(f.id IS NOT NULL) AS confirmed,
            a.payload->'answer'->'extra'->>'sourceMessage' AS failure
          FROM hawa.inbox_events e JOIN hawa.clients c ON c.tenant_id=e.tenant_id AND c.id::text=e.payload->>'clientId'
          LEFT JOIN hawa.inbox_events x ON x.tenant_id=e.tenant_id AND x.source_event_id=e.source_event_id AND x.source_account_id='lifecycle_source_extraction'
          LEFT JOIN hawa.inbox_events f ON f.tenant_id=e.tenant_id AND f.source_event_id=e.source_event_id AND f.source_account_id='lifecycle_source_confirmation'
          LEFT JOIN hawa.inbox_events a ON a.tenant_id=e.tenant_id AND a.source_event_id=e.source_event_id AND a.source_account_id='lifecycle_source_answer'
          WHERE e.tenant_id=${scope.tenantId}::uuid AND e.source_account_id='lifecycle_source_upload'
            AND e.event_kind='lifecycle_source_upload' AND e.payload->>'clientId'=${clientId} AND c.status='active'
            AND (${!content} OR e.source_event_id=${updateId})
          ORDER BY e.received_at DESC,e.source_event_id DESC LIMIT 20`.execute(trx)).rows;
      });
      if (!result) return problem(c, 404, 'Client Not Found');
      if (!content) return c.json({ clientId, items: result.map(row => ({ clientId, updateId: row.payload.updateId,
        sourceSha256: row.payload.blob.sha256, createdAt: row.received_at, documentId: row.document_id,
        stage: row.confirmed ? 'copy_confirmed' : row.failure ? 'extraction_stopped' : row.document_id ? 'ready' : 'retained',
        message: row.failure,
      })) });
      const ref = result[0] && parseBlobRef(result[0].payload.blob);
      if (!ref) return problem(c, 404, 'Source Not Found');
      if (!store) return problem(c, 503, 'Source Store Unavailable');
      const bytes = await store.read(ref, { verify: true });
      return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="source.pdf"', 'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store', 'X-Content-SHA256': ref.sha256 } });
    } catch {
      return problem(c, 503, 'Source Unavailable', 'The saved original is unavailable. Ask the operator to restore missing or damaged bytes.');
    }
  };
  registerRoute('get', '/clients/:clientId/source-files', read(false));
  registerRoute('get', '/clients/:clientId/source-files/:updateId/content', read(true));
}
