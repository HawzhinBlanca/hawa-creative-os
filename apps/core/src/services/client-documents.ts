import { createHash, randomUUID } from 'node:crypto';
import { sql, type Database, type Kysely, type BlobStore } from '@hawa/db';
import type { ParsedDocument } from '@hawa/retrieval';

export class DocumentIntakeError extends Error {
  constructor(readonly status: 403 | 409 | 422 | 503, message: string) { super(message); }
}
export interface DocumentRow {
  id: string; client_id: string; source_sha256: string; extractor_version: string;
  extraction_json: string; extraction_sha256: string; created_at: Date;
}
export const documentReceipt = (row: DocumentRow) => ({
  id: row.id, clientId: row.client_id, sourceSha256: row.source_sha256,
  extractionSha256: row.extraction_sha256, extractorVersion: row.extractor_version,
  createdAt: row.created_at, contentUrl: `/v1/clients/${row.client_id}/documents/${row.id}/content`,
});
export const savedDocument = (row: DocumentRow) => ({
  clientId: row.client_id, sourceSaved: true, approved: false,
  receipt: documentReceipt(row), document: JSON.parse(row.extraction_json) as ParsedDocument,
});
export async function findDocument(trx: Kysely<Database>, tenantId: string, clientId: string, id: string) {
  return (await sql<DocumentRow>`SELECT * FROM hawa.client_documents WHERE tenant_id=${tenantId}::uuid
    AND client_id=${clientId}::uuid AND id=${id}::uuid`.execute(trx)).rows[0];
}
export async function findDocumentByHash(trx: Kysely<Database>, tenantId: string, clientId: string, hash: string, version: string) {
  return (await sql<DocumentRow>`SELECT * FROM hawa.client_documents WHERE tenant_id=${tenantId}::uuid
    AND client_id=${clientId}::uuid AND source_sha256=${hash} AND extractor_version=${version}`.execute(trx)).rows[0];
}
export async function retainDocument(trx: Kysely<Database>, input: {
  tenantId: string; clientId: string; userId: string; document: ParsedDocument;
}) {
  const { tenantId, clientId, userId, document } = input;
  const json = JSON.stringify(document), extractionHash = createHash('sha256').update(json).digest('hex');
  await sql`INSERT INTO hawa.client_documents(id,tenant_id,client_id,source_sha256,extractor_version,
    extraction_json,extraction_sha256,created_by) VALUES (${randomUUID()}::uuid,${tenantId}::uuid,${clientId}::uuid,
    ${document.sourceSha256},${document.extraction.version},${json},${extractionHash},${userId}::uuid)
    ON CONFLICT (tenant_id,client_id,source_sha256,extractor_version) DO NOTHING`.execute(trx);
  const row = await findDocumentByHash(trx, tenantId, clientId, document.sourceSha256, document.extraction.version);
  if (!row) throw new DocumentIntakeError(503, 'The document receipt could not be retained. Retry the original file.');
  return row;
}

/** Evidence is read from the immutable server receipt, never trusted from browser extraction text. */
export async function prepareDocumentIntake(trx: Kysely<Database>, store: BlobStore | null, input: {
  tenantId: string; clientId: string; userId: string; source: unknown;
}) {
  // The existing durable outbox admits office operators/admins. Match that boundary explicitly.
  const permission = (await sql<{ allowed: boolean }>`SELECT hawa.has_tenant_role(${input.tenantId}::uuid,
    ARRAY['administrator','operator']::hawa.membership_role[]) AS allowed`.execute(trx)).rows[0];
  if (!permission?.allowed) throw new DocumentIntakeError(403, 'An office operator must save this reviewed request. The PDF remains available for review.');
  const source = input.source as Record<string, unknown> | null;
  if (!source || source.confirmed !== true || typeof source.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(source.id))
    throw new DocumentIntakeError(422, 'Review the original PDF and explicitly confirm the request copy.');
  const row = await findDocument(trx, input.tenantId, input.clientId, source.id);
  if (!row) throw new DocumentIntakeError(403, 'The source document is unavailable in this client.');
  if (row.source_sha256 !== source.sourceSha256 || row.extraction_sha256 !== source.extractionSha256)
    throw new DocumentIntakeError(409, 'Source evidence changed. Reopen the saved PDF and review it again.');
  if (!store) throw new DocumentIntakeError(503, 'The original PDF store is unavailable.');
  // Read blob metadata on this transaction; reserving a second pool connection here can deadlock concurrent intake.
  const blob = (await sql<{ size: string; media_type: string }>`SELECT size,media_type FROM hawa.blobs WHERE sha256=${row.source_sha256}`.execute(trx)).rows[0];
  if (!blob || blob.media_type !== 'application/pdf') throw new DocumentIntakeError(503, 'The original PDF metadata is unavailable.');
  try { await store.read({ sha256: row.source_sha256, size: Number(blob.size), mediaType: 'application/pdf' }, { verify: true }); }
  catch { throw new DocumentIntakeError(503, 'The original PDF is missing or damaged. Restore it before creating a request.'); }
  return { sourceDocument: { ...documentReceipt(row), confirmedBy: input.userId,
    confirmedAt: new Date().toISOString(), confirmation: 'request_copy_reviewed', knowledgeApproved: false } };
}
