import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { sql, withRlsContext } from '@hawa/db';
import { isValidUuid } from '../core-helpers.js';
import { blobStoreFor } from '../services/blob-store-context.js';
import { DocumentIntakeError, findDocument } from '../services/client-documents.js';
import { canManageKnowledge, changeKnowledge, knowledgeState, searchKnowledge, type KnowledgeChange } from '../services/document-knowledge.js';
import type { RouteContext } from './types.js';

async function approvalBody(c: Context): Promise<string> {
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new DocumentIntakeError(422, 'Approval request is empty.');
  const parts: Uint8Array[] = []; let bytes = 0, expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => undefined); }, 5000);
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 8192) throw new DocumentIntakeError(422, 'Approval request is too large.');
      parts.push(part.value);
    }
    if (expired) throw new DocumentIntakeError(422, 'Approval upload timed out.');
    return Buffer.concat(parts).toString('utf8');
  } finally { clearTimeout(timer); await reader.cancel().catch(() => undefined); }
}

export function registerDocumentKnowledgeRoutes(ctx: RouteContext) {
  const { registerRoute, verifyRequestAuth, problem, db } = ctx;
  const store = blobStoreFor(db, ctx.options?.blobStore);
  const statePath = '/clients/:clientId/documents/:documentId/knowledge';
  for (const method of ['get', 'put'] as const) registerRoute(method, statePath, async (c: Context) => {
    const auth = verifyRequestAuth(c), token = ctx.bearerTokenOf?.(c);
    const clientId = c.req.param('clientId') ?? '', documentId = c.req.param('documentId') ?? '';
    if (!auth.authenticated || !auth.userId || !auth.tenantId || auth.role === 'service') return problem(c, method === 'put' ? 403 : 401, 'Sign In Required');
    if (!db) return problem(c, 503, 'Database Unavailable');
    if (!isValidUuid(clientId) || !isValidUuid(documentId)) return problem(c, 404, 'Document Not Found');
    const sessionHash = auth.authMethod === 'google_oidc' && token ? createHash('sha256').update(token).digest('hex') : null;
    if (method === 'put' && !sessionHash) return problem(c, 403, 'Named Knowledge Manager Required', 'Sign in with your named office account to approve or revoke reference material.');
    const scope = { tenantId: auth.tenantId, userId: auth.userId, role: auth.role, clientId, sessionHash };
    c.header('Cache-Control', 'private, no-store');
    try {
      let change: KnowledgeChange | undefined;
      const actionId = c.req.header('Idempotency-Key') ?? '';
      if (method === 'put') {
        const raw = await approvalBody(c);
        if (raw.length > 4096) return problem(c, 422, 'Approval Request Too Large');
        try { change = JSON.parse(raw) as KnowledgeChange; } catch { return problem(c, 422, 'Invalid Approval Request'); }
        if (!change || !isValidUuid(actionId) || typeof change.approved !== 'boolean' || typeof change.reviewed !== 'boolean' ||
            (change.approved && !change.reviewed) || !Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < 0 || change.expectedVersion > 2147483646 ||
            typeof change.reason !== 'string' || !change.reason.trim() || change.reason.length > 1000 ||
            typeof change.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(change.sourceSha256) ||
            typeof change.extractionSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(change.extractionSha256))
          return problem(c, 422, 'Review Required', 'Review the original and extraction limits; provide a reason, exact source hashes, current version and a stable action ID.');
      }
      const result = await withRlsContext(db, scope, async trx => {
        if (!await findDocument(trx, scope.tenantId, clientId, documentId)) return null;
        if (change) return changeKnowledge(trx, store, scope, documentId, actionId, change);
        return { ...await knowledgeState(trx, scope, documentId), canManage: await canManageKnowledge(trx, scope) };
      });
      if (!result) return problem(c, 404, 'Document Not Found');
      return c.json(result, 'replayed' in result && !result.replayed ? 201 : 200);
    } catch (error) {
      if (error instanceof DocumentIntakeError) return problem(c, error.status, 'Knowledge Change Refused', error.message);
      const code = (error as { code?: string }).code;
      if (code === '42501') return problem(c, 403, 'Named Knowledge Manager Required');
      if (code === '40001' || code === '23505') return problem(c, 409, 'Knowledge Changed', 'Refresh the source state before making a new decision. Retry an uncertain action unchanged.');
      if (code === '22023') return problem(c, 422, 'Review Required');
      if (code === 'P0002') return problem(c, 404, 'Document Not Found');
      return problem(c, 503, 'Knowledge Unavailable', 'The outcome is unconfirmed. Retry the same saved action.');
    }
  });
  registerRoute('get', '/clients/:clientId/knowledge/search', async (c: Context) => {
    const auth = verifyRequestAuth(c), clientId = c.req.param('clientId') ?? '', query = c.req.query('q')?.trim() ?? '';
    if (!auth.authenticated || !auth.userId || !auth.tenantId || auth.role === 'service') return problem(c, 401, 'Sign In Required');
    if (!db) return problem(c, 503, 'Database Unavailable');
    if (!isValidUuid(clientId)) return problem(c, 404, 'Client Not Found');
    if (!query || query.length > 500 || query.split(/\s+/u).length > 50 || !/[\p{L}\p{N}]/u.test(query)) return problem(c, 422, 'Search Text Required', 'Search for up to 500 characters and 50 words.');
    c.header('Cache-Control', 'private, no-store');
    try {
      const scope = { tenantId: auth.tenantId, userId: auth.userId, role: auth.role, clientId };
      const result = await withRlsContext(db, scope, async trx => {
        const client = (await sql`SELECT id FROM hawa.clients WHERE tenant_id=${scope.tenantId}::uuid AND id=${clientId}::uuid AND status='active'`.execute(trx)).rows[0];
        return client ? searchKnowledge(trx, scope, query) : null;
      });
      return result ? c.json(result) : problem(c, 404, 'Client Not Found');
    } catch { return problem(c, 503, 'Search Unavailable', 'Search could not finish. Retry a more specific query.'); }
  });
}
