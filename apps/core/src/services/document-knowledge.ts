import { sql, type Database, type Kysely, type BlobStore } from '@hawa/db';
import { DocumentIntakeError, findDocument } from './client-documents.js';

export type KnowledgeScope = { tenantId: string; userId: string; clientId: string; sessionHash: string | null };
export interface KnowledgeChange {
  approved: boolean; expectedVersion: number; sourceSha256: string; extractionSha256: string;
  reviewed: boolean; reason: string;
}
interface EventRow {
  action_id: string; version: number; approved: boolean; actor_user_id: string; actor_display_name: string; reason: string; created_at: Date;
}
const event = (r: EventRow) => ({ actionId: r.action_id, version: r.version, approved: r.approved,
  actorUserId: r.actor_user_id, actorDisplayName: r.actor_display_name, reason: r.reason, createdAt: r.created_at });
export async function canManageKnowledge(trx: Kysely<Database>, scope: KnowledgeScope) {
  if (!scope.sessionHash) return false;
  return (await sql<{ allowed: boolean }>`SELECT hawa.lock_named_knowledge_manager(${scope.tenantId}::uuid,
    ${scope.clientId}::uuid,${scope.userId}::uuid,${scope.sessionHash}) AS allowed`.execute(trx)).rows[0]?.allowed === true;
}
export async function knowledgeState(trx: Kysely<Database>, scope: KnowledgeScope, documentId: string) {
  const rows = (await sql<EventRow>`SELECT action_id,version,approved,actor_user_id,actor_display_name,reason,created_at
    FROM hawa.client_document_knowledge_events WHERE tenant_id=${scope.tenantId}::uuid AND client_id=${scope.clientId}::uuid
      AND document_id=${documentId}::uuid ORDER BY version DESC LIMIT 20`.execute(trx)).rows;
  return { state: rows[0] ? event(rows[0]) : { version: 0, approved: false }, events: rows.map(event) };
}

export async function changeKnowledge(trx: Kysely<Database>, store: BlobStore | null,
  scope: KnowledgeScope, documentId: string, actionId: string, change: KnowledgeChange) {
  if (!await canManageKnowledge(trx, scope)) throw new DocumentIntakeError(403, 'Sign in as a named client knowledge manager or administrator.');
  const source = await findDocument(trx, scope.tenantId, scope.clientId, documentId);
  if (!source) throw new DocumentIntakeError(403, 'The saved source is unavailable in this client.');
  if (source.source_sha256 !== change.sourceSha256 || source.extraction_sha256 !== change.extractionSha256)
    throw new DocumentIntakeError(409, 'Source evidence changed. Reopen the saved PDF.');
  const prior = (await sql`SELECT action_id FROM hawa.client_document_knowledge_events
    WHERE tenant_id=${scope.tenantId}::uuid AND action_id=${actionId}::uuid`.execute(trx)).rows[0];
  if (change.approved && !prior) {
    if (!store) throw new DocumentIntakeError(503, 'The original PDF store is unavailable.');
    const blob = (await sql<{ size: string; media_type: string }>`SELECT size,media_type FROM hawa.blobs
      WHERE sha256=${source.source_sha256}`.execute(trx)).rows[0];
    if (!blob || blob.media_type !== 'application/pdf') throw new DocumentIntakeError(503, 'Original PDF metadata is unavailable.');
    try { await store.read({ sha256: source.source_sha256, size: Number(blob.size), mediaType: blob.media_type }, { verify: true }); }
    catch { throw new DocumentIntakeError(503, 'Restore the missing or damaged original PDF before approving it.'); }
  }
  const result = (await sql<{ result: { replayed: boolean; action: EventRow } }>`SELECT hawa.admit_document_knowledge(
    ${scope.tenantId}::uuid,${scope.clientId}::uuid,${documentId}::uuid,${scope.userId}::uuid,${scope.sessionHash},
    ${actionId}::uuid,${change.expectedVersion},${change.approved},${change.sourceSha256},${change.extractionSha256},
    ${change.reviewed},${change.reason}) AS result`.execute(trx)).rows[0].result;
  return { ...await knowledgeState(trx, scope, documentId), action: event(result.action), replayed: result.replayed, canManage: true };
}

interface SearchRow {
  document_id: string; chunk_id: string; content_original: string; truncated: boolean; chunk_sha256: string;
  page_number: number | null; provenance: Record<string, unknown>; source_sha256: string; extraction_sha256: string;
  extractor_version: string; version: number; action_id: string; score: number;
}
/** Authorized admission is materialized before any similarity ranking. Scope never comes from document text. */
export async function searchKnowledge(trx: Kysely<Database>, scope: { tenantId: string; clientId: string }, query: string) {
  await sql`SET LOCAL statement_timeout='3s'`.execute(trx);
  const rows = (await sql<SearchRow>`WITH latest AS MATERIALIZED (
      SELECT DISTINCT ON(document_id) document_id,version,approved,action_id
      FROM hawa.client_document_knowledge_events WHERE tenant_id=${scope.tenantId}::uuid AND client_id=${scope.clientId}::uuid
      ORDER BY document_id,version DESC
    ), eligible AS MATERIALIZED (
      SELECT k.*,d.source_sha256,d.extraction_sha256,d.extractor_version,a.version,a.action_id
      FROM hawa.client_document_knowledge_chunks k
      JOIN hawa.client_documents d ON (d.tenant_id,d.client_id,d.id)=(k.tenant_id,k.client_id,k.document_id)
      JOIN hawa.clients c ON (c.tenant_id,c.id)=(k.tenant_id,k.client_id) AND c.status='active'
      JOIN latest a ON a.document_id=k.document_id AND a.approved
      WHERE k.tenant_id=${scope.tenantId}::uuid AND k.client_id=${scope.clientId}::uuid
    ), query AS (SELECT hawa.knowledge_search_text(${query}) AS text,
      plainto_tsquery('simple',hawa.knowledge_search_text(${query})) AS terms)
    SELECT e.document_id,e.chunk_id,left(e.content_original,2000) AS content_original,
      length(e.content_original)>2000 AS truncated,e.chunk_sha256,e.page_number,e.provenance,
      e.source_sha256,e.extraction_sha256,e.extractor_version,e.version,e.action_id,
      (CASE WHEN strpos(e.content_search,q.text)>0 THEN 2 ELSE 0 END +
        ts_rank_cd(e.search_vector,q.terms) + word_similarity(q.text,e.content_search)) AS score
    FROM eligible e CROSS JOIN query q
    WHERE strpos(e.content_search,q.text)>0 OR e.search_vector @@ q.terms OR word_similarity(q.text,e.content_search)>=0.45
    ORDER BY score DESC,e.document_id,e.chunk_index LIMIT 10`.execute(trx)).rows;
  return { clientId: scope.clientId, mode: 'postgres_lexical_v1', vectorStatus: 'not_run', rerankerStatus: 'not_run',
    items: rows.map(row => ({ text: row.content_original, truncated: row.truncated, score: row.score, citation: {
      documentId: row.document_id, chunkId: row.chunk_id, pageNumber: row.page_number, chunkSha256: row.chunk_sha256,
      sourceSha256: row.source_sha256, extractionSha256: row.extraction_sha256, extractorVersion: row.extractor_version,
      approvalVersion: row.version, approvalActionId: row.action_id, coordinates: row.provenance.coordinates ?? null,
      coordinateSystem: row.provenance.coordinateSystem ?? null,
    } })) };
}
