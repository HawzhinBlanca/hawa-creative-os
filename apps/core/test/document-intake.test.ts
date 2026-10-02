import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { assert, afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, withRlsContext, sql, blobStoreFromEnv, TaskRepository } from '@hawa/db';
import { kaaeClientDNA } from '@hawa/domain';
import { DoclingParser, PDF_EXTRACTOR_VERSION } from '@hawa/retrieval';
import { savedDesignCopy } from '../src/services/canva-design-planner.js';
import { createApp } from '../src/app.js';
const db = createDb(process.env.TEST_DATABASE_URL!), owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const tenantId = '00000000-0000-4000-a000-000000000001';
const scope = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' as const };
const app = () => createApp({ db, testAuth: { principal: scope } });
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
let parse: import('vitest').MockInstance<DoclingParser['parse']>;
beforeEach(() => {
  vi.stubEnv('HAWA_DOCLING_URL', 'http://127.0.0.1:19091');
  parse = vi.spyOn(DoclingParser.prototype, 'parse').mockImplementation(async (id, bytes) => ({
    documentId: id, title: 'source.pdf', sourceSha256: hash(bytes), tables: [], images: [],
    chunks: [{ chunkId: randomUUID(), documentId: id, pageNumber: 1, text: 'Price 123.45', sha256: hash('Price 123.45'),
      tokenCountEstimate: 4, metadata: { sourceKind: 'docling_native_pdf', sourceId: 'uploaded.pdf', mimeType: 'application/pdf' } }],
    extraction: { version: PDF_EXTRACTOR_VERSION, pageCount: 1, limitations: ['Native order unverified'] },
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(() => Promise.all([db.destroy(), owner.destroy()]));
async function client() {
  const id = randomUUID();
  await withRlsContext(db, scope, async trx => {
    await trx.insertInto('clients').values({ id, tenant_id: tenantId, code: id, name: 'PDF intake client', status: 'active', aliases: [], default_language: 'en', retention_policy: {}, model_egress_policy: {} }).execute();
    await trx.insertInto('client_dna_versions').values({ id: randomUUID(), tenant_id: tenantId, client_id: id,
      version: 1, status: 'active', content_hash: randomUUID(), dna: kaaeClientDNA }).execute();
  });
  return id;
}
const bytes = () => `%PDF-1.7 retained fixture ${randomUUID()}`;
async function upload(id: string, raw = bytes()) {
  const response = await app().request(`/v1/clients/${id}/documents`, { method: 'POST', body: raw,
    headers: { 'Content-Type': 'application/pdf' } });
  return { status: response.status, data: await response.json(), raw };
}
function body(id: string, receipt: Record<string, unknown>) {
  return { clientId: id, workflow: 'canva_manual', title: 'Reviewed offer', copyEn: 'Offer 123.45', copyCkb: 'نرخ ١٢٣',
    description: 'Offer 123.45\n\nنرخ ١٢٣', designInstructions: 'Keep the price editable.',
    sourceDocument: { id: receipt.id, sourceSha256: receipt.sourceSha256, extractionSha256: receipt.extractionSha256, confirmed: true } };
}
async function submit(input: Record<string, unknown>, key = randomUUID()) {
  const response = await app().request('/v1/tasks', { method: 'POST', body: JSON.stringify(input),
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key } });
  return { status: response.status, data: await response.json() };
}
describe('retained PDF request handoff', () => {
  it('retains original bytes and immutable extraction, reuses them after restart without a parser, and protects pending bytes from GC', async () => {
    const id = await client(), first = await upload(id);
    expect(first.status).toBe(201);
    expect(first.data).toMatchObject({ clientId: id, sourceSaved: true, approved: false });
    expect(first.data.receipt.sourceSha256).toBe(hash(first.raw));
    vi.stubEnv('HAWA_DOCLING_URL', '');
    const retry = await upload(id, first.raw);
    expect(retry.status).toBe(200); expect(retry.data).toEqual(first.data); expect(parse).toHaveBeenCalledTimes(1);
    const content = await app().request(first.data.receipt.contentUrl);
    expect(content.status).toBe(200); expect(await content.text()).toBe(first.raw);
    const saved = await app().request(`/v1/clients/${id}/documents/${first.data.receipt.id}`);
    expect(await saved.json()).toEqual(first.data);
    const list = await app().request(`/v1/clients/${id}/documents`);
    expect((await list.json()).items).toHaveLength(1);
    await sql`SELECT * FROM hawa.blob_gc_mark()`.execute(db);
    const retained = (await sql<{ unreferenced_since: Date | null }>`SELECT unreferenced_since FROM hawa.blobs WHERE sha256=${hash(first.raw)}`.execute(db)).rows[0];
    expect(retained.unreferenced_since).toBeNull();
    const row = (await sql<{ extraction_json: string; extraction_sha256: string }>`SELECT extraction_json,extraction_sha256 FROM hawa.client_documents WHERE id=${first.data.receipt.id}::uuid`.execute(owner)).rows[0];
    expect(hash(row.extraction_json)).toBe(row.extraction_sha256);
    await expect(sql`UPDATE hawa.client_documents SET extraction_json='{}' WHERE id=${first.data.receipt.id}::uuid`.execute(owner)).rejects.toThrow();
  });
  it('records one task, event and outbox under concurrent cold-app retries, keeps edited copy, and rejects changed replay', async () => {
    const id = await client(), source = await upload(id), key = randomUUID();
    const input = body(id, source.data.receipt);
    const results = await Promise.all([submit(input, key), submit(input, key)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 201]);
    expect(results[0].data.id).toBe(results[1].data.id);
    const taskId = results[0].data.id;
    const detail = await (await app().request(`/v1/tasks/${taskId}`)).json();
    expect(detail).toMatchObject({ copyEn: input.copyEn, copyCkb: input.copyCkb,
      sourceDocument: { id: source.data.receipt.id, confirmedBy: scope.userId, knowledgeApproved: false } });
    await withRlsContext(db, scope, async trx => {
      expect(await trx.selectFrom('tasks').select('id').where('client_id', '=', id).execute()).toHaveLength(1);
      expect(await trx.selectFrom('task_events').select('id').where('task_id', '=', taskId).execute()).toHaveLength(1);
      expect(await trx.selectFrom('outbox_commands').select('id').where('aggregate_id', '=', taskId).execute()).toHaveLength(1);
      await trx.updateTable('clients').set({ status: 'inactive' }).where('id', '=', id).execute();
    });
    vi.stubEnv('HAWA_DOCLING_URL', '');
    expect((await submit(input, key)).status).toBe(200);
    expect((await submit({ ...input, copyEn: 'Changed price' }, key)).status).toBe(409);
    expect(parse).toHaveBeenCalledTimes(1);
  });
  it('refuses unconfirmed, mismatched, missing and cross-client evidence without any task side effects', async () => {
    const id = await client(), other = await client(), source = await upload(id), input = body(id, source.data.receipt);
    for (const [patch, status] of [
      [{ confirmed: false }, 422], [{ sourceSha256: '0'.repeat(64) }, 409],
      [{ extractionSha256: '0'.repeat(64) }, 409], [{ id: randomUUID() }, 403], [{ id: 'z'.repeat(36) }, 422],
    ] as const) {
      expect((await submit({ ...input, sourceDocument: { ...input.sourceDocument, ...patch } })).status).toBe(status);
    }
    expect((await submit({ ...input, clientId: other })).status).toBe(403);
    const tasks = await withRlsContext(db, scope, trx => trx.selectFrom('tasks').select('id').where('client_id', 'in', [id, other]).execute());
    expect(tasks).toEqual([]);
  });
  it('refuses damaged original bytes at download and task creation', async () => {
    const id = await client(), source = await upload(id);
    const store = blobStoreFromEnv(db), stat = await store.stat(source.data.receipt.sourceSha256); assert(stat, "Expected retained source bytes");
    await fs.chmod(stat.path, 0o644); await fs.writeFile(stat.path, 'x'.repeat(Buffer.byteLength(source.raw)));
    expect((await app().request(source.data.receipt.contentUrl)).status).toBe(503);
    expect((await submit(body(id, source.data.receipt))).status).toBe(503);
    expect((await upload(id, source.raw)).status).toBe(503);
    await fs.unlink(stat.path);
    expect((await upload(id, source.raw)).status).toBe(200);
    expect(await (await app().request(source.data.receipt.contentUrl)).text()).toBe(source.raw);
  });
  it('fails a source save without a file store and a document task without PostgreSQL', async () => {
    const id = await client();
    vi.stubEnv('HAWA_BLOB_DIR', '');
    expect((await upload(id)).status).toBe(503); expect(parse).not.toHaveBeenCalled();
    vi.stubEnv('DATABASE_URL', '');
    const response = await createApp({ testAuth: { principal: scope } }).request('/v1/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body(id, {})),
    });
    expect(response.status).toBe(503);
  });
  it('does not retain a receipt when client access is revoked during extraction', async () => {
    const id = await client(), impl = parse.getMockImplementation()!;
    parse.mockImplementationOnce(async (...args) => {
      const result = await impl(...args);
      await withRlsContext(db, scope, trx => trx.updateTable('clients').set({ status: 'inactive' }).where('id', '=', id).execute());
      return result;
    });
    expect((await upload(id)).status).toBe(404);
    expect((await sql`SELECT id FROM hawa.client_documents WHERE client_id=${id}::uuid`.execute(owner)).rows).toEqual([]);
  });
  it('isolates receipts and originals by client and refuses a read-only identity', async () => {
    const id = await client(), other = await client(), source = await upload(id), userId = randomUUID();
    expect((await app().request(`/v1/clients/${other}/documents/${source.data.receipt.id}`)).status).toBe(404);
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES (${userId}::uuid,${userId+'@example.test'},'Read only')`.execute(owner);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role,active) VALUES (${tenantId}::uuid,${userId}::uuid,'auditor',true)`.execute(owner);
    const reader = createApp({ db, testAuth: { principal: { role: 'auditor', userId } } });
    expect((await reader.request(`/v1/clients/${id}/documents`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: bytes() })).status).toBe(404);
    expect((await app().request(source.data.receipt.contentUrl, { headers: { 'x-enforce-auth': '1' } })).status).toBe(401);
  });
  it('rolls back task, event and outbox if the transaction fails after aggregate creation', async () => {
    const id = await client(), source = await upload(id), key = randomUUID();
    const original = TaskRepository.prototype.createTaskAggregate;
    const fault = vi.spyOn(TaskRepository.prototype, 'createTaskAggregate').mockImplementationOnce(async function (this: TaskRepository, ...args) {
      await original.apply(this, args);
      throw new Error('Simulated commit boundary failure');
    });
    expect((await submit(body(id, source.data.receipt), key)).status).toBe(503);
    fault.mockRestore();
    const rows = await withRlsContext(db, scope, async trx => ({
      tasks: await trx.selectFrom('tasks').select('id').where('client_id', '=', id).execute(),
      outbox: await trx.selectFrom('outbox_commands').select('id').where('idempotency_key', '=', key).execute(),
    }));
    expect(rows).toEqual({ tasks: [], outbox: [] });
    expect((await submit(body(id, source.data.receipt), key)).status).toBe(201);
  });
  it('keeps explicitly confirmed Sorani-only copy exact through task readback and planner input', async () => {
    const id = await client(), source = await upload(id), input = body(id, source.data.receipt);
    const exact = '  نرخ ١٢٣ 🎉\n---\nExact punctuation  '; input.copyEn = ''; input.copyCkb = exact;
    const task = await submit(input);
    expect(task.status).toBe(201);
    const detail = await (await app().request(`/v1/tasks/${task.data.id}`)).json();
    expect(detail.copyEn).toBe(''); expect(detail.copyCkb).toBe(exact);
    const event = await withRlsContext(db, scope, trx => trx.selectFrom('task_events').select('data').where('task_id', '=', task.data.id).executeTakeFirstOrThrow());
    expect(savedDesignCopy(event.data, input.description)).toEqual({ copy: [exact], instructions: input.designInstructions });
  });
  it('refuses the same receipt and content under a different authenticated tenant', async () => {
    const otherTenant = randomUUID(), id = randomUUID();
    await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES (${otherTenant}::uuid,'Other PDF office',${otherTenant})`.execute(owner);
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name,status) VALUES (${id}::uuid,${otherTenant}::uuid,${id},'Other PDF client','active')`.execute(owner);
    const ownClient = await client(), source = await upload(ownClient);
    // Owner creates an otherwise identical foreign receipt to make the isolation check non-vacuous.
    const foreignId = randomUUID();
    await sql`INSERT INTO hawa.client_documents(id,tenant_id,client_id,source_sha256,extractor_version,extraction_json,extraction_sha256,created_by)
      SELECT ${foreignId}::uuid,${otherTenant}::uuid,${id}::uuid,source_sha256,extractor_version,extraction_json,extraction_sha256,created_by
      FROM hawa.client_documents WHERE id=${source.data.receipt.id}::uuid`.execute(owner);
    expect((await app().request(`/v1/clients/${id}/documents/${foreignId}`)).status).toBe(404);
    expect((await app().request(`/v1/clients/${id}/documents/${foreignId}/content`)).status).toBe(404);
    expect((await (await app().request(`/v1/clients/${id}/documents`)).json()).items).toEqual([]);
    expect((await submit(body(id, { ...source.data.receipt, id: foreignId }))).status).toBe(403);
  });

  it('lets a client-level designer retain their own PDF for an operator to confirm without granting other clients', async () => {
    const id = await client(), other = await client(), userId = randomUUID();
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES (${userId}::uuid,${userId+'@example.test'},'Scoped designer')`.execute(owner);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role,active)
      VALUES (${tenantId}::uuid,${userId}::uuid,'designer',true)`.execute(owner);
    await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role,active)
      VALUES (${tenantId}::uuid,${id}::uuid,${userId}::uuid,'designer',true)`.execute(owner);
    const designer = createApp({ db, testAuth: { principal: { role: 'designer', userId } } });
    const uploadAsDesigner = (clientId: string) => designer.request(`/v1/clients/${clientId}/documents`, {
      method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: bytes(),
    });
    const response = await uploadAsDesigner(id); expect(response.status).toBe(201);
    const source = await response.json();
    expect((await uploadAsDesigner(other)).status).toBe(404);
    const confirmed = await designer.request('/v1/tasks', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body(id, source.receipt)),
    });
    expect(confirmed.status).toBe(403);
    expect(await confirmed.text()).toContain('An office operator must save');
    const committed = await submit(body(id, source.receipt));
    expect(committed.status).toBe(201);
    const task = committed.data;
    const detail = await (await designer.request(`/v1/tasks/${task.id}`)).json();
    expect(detail.sourceDocument.confirmedBy).toBe(scope.userId);
  });

});
