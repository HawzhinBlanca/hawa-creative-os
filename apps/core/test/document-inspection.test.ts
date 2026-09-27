import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, withRlsContext, sql } from '@hawa/db';
import { DoclingParser, DocumentExtractionError } from '@hawa/retrieval';
import { createApp } from '../src/app.js';
const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const tenantId = '00000000-0000-4000-a000-000000000001';
const scope = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' as const };
const app = () => createApp({ db, testAuth: { principal: scope } });
const parsed = { documentId: 'd', title: 'source', sourceSha256: 'a'.repeat(64), chunks: [], tables: [], images: [],
  extraction: { version: 'fixture', pageCount: 1, limitations: [] } };
let parse: ReturnType<typeof vi.spyOn>;
beforeEach(() => { vi.stubEnv('HAWA_DOCLING_URL', 'http://127.0.0.1:19091'); parse = vi.spyOn(DoclingParser.prototype, 'parse').mockResolvedValue(parsed); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(() => Promise.all([db.destroy(), owner.destroy()]));
async function client(status: 'active' | 'inactive' = 'active') {
  const id = randomUUID();
  await withRlsContext(db, scope, trx => trx.insertInto('clients').values({ id, tenant_id: tenantId, code: id, name: 'PDF client', aliases: [], default_language: 'en', retention_policy: {}, model_egress_policy: {}, status }).execute());
  return id;
}
function inspect(id: string, body = '%PDF-1.7 fixture', headers = {}) {
  return app().request(`/v1/clients/${id}/documents/inspect`, { method: 'POST', body,
    headers: { 'Content-Type': 'application/pdf', ...headers } });
}
describe('client document inspection', () => {
  it('returns a scoped unsaved preview without creating tasks or approved knowledge', async () => {
    const id = await client();
    const first = await inspect(id), second = await inspect(id);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(await second.json());
    expect(parse.mock.calls[0][0]).toContain(id);
    expect(parse.mock.calls[0][1]).toEqual(Buffer.from('%PDF-1.7 fixture'));
    await withRlsContext(db, scope, async trx => {
      expect(await trx.selectFrom('tasks').select('id').where('client_id', '=', id).execute()).toEqual([]);
      expect(await trx.selectFrom('client_dna_versions').select('id').where('client_id', '=', id).execute()).toEqual([]);
    });
  });
  it('refuses unknown or inactive clients before parsing', async () => {
    for (const id of [randomUUID(), await client('inactive'), 'not-a-client']) expect((await inspect(id)).status).toBe(404);
    expect(parse).not.toHaveBeenCalled();
  });
  it('refuses revoked scope again after extraction', async () => {
    const id = await client();
    parse.mockImplementationOnce(async () => {
      await withRlsContext(db, scope, trx => trx.updateTable('clients').set({ status: 'inactive' }).where('id', '=', id).execute());
      return parsed;
    });
    expect((await inspect(id)).status).toBe(404);
  });
  it('refuses unconfigured extraction, bad media and actual oversized bytes', async () => {
    const id = await client();
    vi.stubEnv('HAWA_DOCLING_URL', '');
    expect((await inspect(id)).status).toBe(503);
    vi.stubEnv('HAWA_DOCLING_URL', 'http://127.0.0.1:19091');
    expect((await inspect(id, 'text', { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await inspect(id, 'x'.repeat(20 * 1024 * 1024 + 1))).status).toBe(413);
    expect(parse).not.toHaveBeenCalled();
  });
  it('preserves extraction failures without accepting partial text', async () => {
    parse.mockRejectedValueOnce(new DocumentExtractionError('DOCUMENT_OCR_REQUIRED'));
    const response = await inspect(await client());
    expect(response.status).toBe(422);
    expect(await response.text()).toContain('A page has no extractable text');
  });
  it('cannot inspect a client from another tenant', async () => {
    const otherTenant = randomUUID(), id = randomUUID();
    await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES (${otherTenant}::uuid,'Other office',${otherTenant})`.execute(owner);
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name,status)
      VALUES (${id}::uuid,${otherTenant}::uuid,${id},'Foreign client','active')`.execute(owner);
    const response = await inspect(id);
    expect(response.status).toBe(404); expect(parse).not.toHaveBeenCalled();
  });
  it('refuses unauthenticated callers and a same-tenant user without client membership', async () => {
    const id = await client(), userId = randomUUID();
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES (${userId}::uuid,${userId + '@example.test'},'PDF scope tester')`.execute(owner);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role,active)
      VALUES (${tenantId}::uuid,${userId}::uuid,'requester',true)`.execute(owner);
    const requester = createApp({ db, testAuth: { principal: { role: 'requester', userId } } });
    expect((await requester.request(`/v1/clients/${id}/documents/inspect`, { method: 'POST',
      headers: { 'Content-Type': 'application/pdf' }, body: '%PDF-1.7' })).status).toBe(404);
    expect((await inspect(id, '%PDF-1.7', { 'x-enforce-auth': '1' })).status).toBe(401);
    expect(parse).not.toHaveBeenCalled();
  });
  it('admits one conversion at a time and releases capacity after completion', async () => {
    const id = await client(), server = app();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    parse.mockImplementationOnce(() => { started(); return new Promise(resolve => { release = () => resolve(parsed); }); });
    const request = () => server.request(`/v1/clients/${id}/documents/inspect`, { method: 'POST',
      headers: { 'Content-Type': 'application/pdf' }, body: '%PDF-1.7' });
    const first = request();
    await ready;
    expect((await request()).status).toBe(503);
    expect(parse).toHaveBeenCalledTimes(1);
    release();
    expect((await first).status).toBe(200);
    expect((await request()).status).toBe(200);
  });
});
