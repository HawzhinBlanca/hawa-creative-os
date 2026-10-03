/**
 * ADR-287 addendum: the Desk's reviewed-PDF request opens a RequestLifecycle request.
 *
 * Until the addendum it saved a designer-owned `canva_manual` task (outbox MANUAL_DESK_OWNED), so a PDF
 * request got no automatic draft. It now opens like a Desk "New task", and the request carries the
 * reviewed source's evidence the way a Telegram PDF brief does: `reviewedSource` on its creation event and
 * the original as its `source_document` task file. The copy is the member's confirmed words, verbatim.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { assert, afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { blobStoreFromEnv, createDb, sql, withRlsContext } from '@hawa/db';
import { kaaeClientDNA } from '@hawa/domain';
import { DoclingParser, PDF_EXTRACTOR_VERSION } from '@hawa/retrieval';
import { createApp } from '../src/app.js';
import { openDraft } from '../src/services/lifecycle-open-draft.js';
import { savedDesignCopy, savedDesignCopyLocales } from '../src/services/saved-design-copy.js';

const db = createDb(process.env.TEST_DATABASE_URL!), owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const tenantId = '00000000-0000-4000-a000-000000000001';
const userId = '00000000-0000-4000-b000-000000000001';
const scope = { tenantId, userId, role: 'operator' as const };
const token = ['worker', 'desk', 'pdf', 'fixture'].join('_');
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const app = (principal: Record<string, unknown> = { role: 'operator', userId }) => createApp({ db, testAuth: { principal } } as any);
const saved = { ...process.env };

beforeAll(() => {
  process.env.HAWA_WORKER_TOKEN = token;
  process.env.AUTO_GENERATE_CHAT_DESIGNS = 'true';
});
beforeEach(() => {
  vi.stubEnv('HAWA_DOCLING_URL', 'http://127.0.0.1:19091');
  vi.spyOn(DoclingParser.prototype, 'parse').mockImplementation(async (id, bytes) => ({
    documentId: id, title: 'source.pdf', sourceSha256: hash(bytes), tables: [], images: [],
    chunks: [1, 2].map((pageNumber) => ({ chunkId: randomUUID(), documentId: id, pageNumber, text: `UNTRUSTED page ${pageNumber}: price 999`,
      sha256: hash(`page ${pageNumber}`), tokenCountEstimate: 4,
      metadata: { sourceKind: 'docling_native_pdf' as const, sourceId: 'uploaded.pdf', mimeType: 'application/pdf' } })),
    extraction: { version: PDF_EXTRACTOR_VERSION, pageCount: 2, limitations: ['Native order unverified'] },
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { process.env = saved; await Promise.all([db.destroy(), owner.destroy()]); });

async function client() {
  const id = randomUUID(), name = `Desk PDF client ${id}`;
  await withRlsContext(db, scope, async (trx) => {
    await trx.insertInto('clients').values({ id, tenant_id: tenantId, code: id, name, aliases: [], default_language: 'en',
      retention_policy: {}, model_egress_policy: {}, status: 'active' }).execute();
    await trx.insertInto('client_dna_versions').values({ id: randomUUID(), tenant_id: tenantId, client_id: id,
      version: 1, status: 'active', content_hash: randomUUID(), dna: { ...kaaeClientDNA, clientId: id, name } }).execute();
  });
  return id;
}

async function upload(clientId: string) {
  const raw = `%PDF-1.7 Desk reviewed source ${randomUUID()}`;
  const response = await app().request(`/v1/clients/${clientId}/documents`, { method: 'POST', body: raw,
    headers: { 'Content-Type': 'application/pdf' } });
  expect(response.status).toBe(201);
  return { raw, receipt: (await response.json() as { receipt: Record<string, string> }).receipt };
}

// Exactly what the Desk's reviewed-PDF form sends (apps/desk/src/services/manualTaskIntake.ts).
const copyEn = '  Offer 123.45 🎉\n---\nExact punctuation  ', copyCkb = 'نرخ ١٢٣';
const pdfBody = (clientId: string, receipt: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  clientId, title: 'Reviewed offer', priority: 'routine', description: `${copyEn}\n\n${copyCkb}`, copyEn, copyCkb,
  designInstructions: 'Keep the price editable.', referenceAssets: '', workflow: 'office_request',
  sourceDocument: { id: receipt.id, sourceSha256: receipt.sourceSha256, extractionSha256: receipt.extractionSha256, confirmed: true },
  source: { platform: 'hawa_desk', externalId: 'operator-desk' }, ...extra,
});

async function post(body: Record<string, unknown>, key = randomUUID(), principal?: Record<string, unknown>) {
  const response = await app(principal).request('/v1/tasks', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function recorded(key: string, clientId: string) {
  return withRlsContext(db, scope, async (trx) => ({
    open: await trx.selectFrom('outbox_commands').selectAll().where('idempotency_key', '=', `office-open:${key}`).execute(),
    tasks: await trx.selectFrom('tasks').select('id').where('client_id', '=', clientId).execute(),
  }));
}

describe('Desk reviewed-PDF request opens a RequestLifecycle request (ADR-287 addendum)', () => {
  it('carries the reviewed source evidence a Telegram PDF brief carries, and the Studio reads the confirmed copy verbatim', async () => {
    const clientId = await client(), { raw, receipt } = await upload(clientId), key = randomUUID();
    const first = await post(pdfBody(clientId, receipt), key);
    expect(first.status).toBe(201);
    const { requestId, id: taskId } = first.body;
    expect(first.body).toMatchObject({ clientId, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), sourcePlatform: 'hawa_desk', clientDnaVersion: 1 });

    const rows = await withRlsContext(db, scope, async (trx) => ({
      open: await trx.selectFrom('outbox_commands').selectAll().where('idempotency_key', '=', `office-open:${key}`).executeTakeFirstOrThrow(),
      created: await trx.selectFrom('outbox_commands').selectAll().where('aggregate_id', '=', taskId)
        .where('command_type', '=', 'task.created').executeTakeFirstOrThrow(),
      request: await trx.selectFrom('requests').selectAll().where('request_id', '=', requestId).executeTakeFirstOrThrow(),
      files: (await sql<{ sha256: string; role: string }>`SELECT sha256, role FROM hawa.task_files WHERE task_id = ${taskId}::uuid`.execute(trx)).rows,
      event: (await sql<{ data: any }>`SELECT data FROM hawa.task_events WHERE task_id = ${taskId}::uuid
        AND event_type = 'task.created'`.execute(trx)).rows[0].data,
    }));
    // An ordinary lifecycle request: drafted automatically, never MANUAL_DESK_OWNED.
    expect(rows.request).toMatchObject({ owner: 'restate', stage: 'designing', rev: '1', chat_id: `desk:${userId}`, root_task_id: taskId });
    expect(rows.created).toMatchObject({ state: 'delivered', last_error: 'OWNED_BY_LIFECYCLE' });
    expect(rows.open).toMatchObject({ command_type: 'office.request.open', aggregate_id: requestId, state: 'pending' });

    // The reviewed source's evidence, in the Telegram brief's shape (ReviewedSourceEvidence).
    const rawText = `${copyEn}\n\n${copyCkb}`;
    const evidence = { kind: 'pdf', origin: 'hawa_desk', sourceSha256: hash(raw), extractionSha256: receipt.extractionSha256,
      documentId: receipt.id, extractorVersion: PDF_EXTRACTOR_VERSION, clientId, pageCount: 2,
      confirmedBy: `desk:${userId}`, confirmation: 'request_copy_reviewed', copySha256: hash(rawText) };
    expect(rows.created.payload.reviewedSource).toEqual(evidence);
    expect(rows.event.payload.reviewedSource).toEqual(evidence);
    expect(rows.files).toEqual([{ sha256: hash(raw), role: 'source_document' }]);

    // Only identities cross to the worker: the brief carries the confirmed words, never the extraction.
    const draft = (rows.open.payload as { event: { draft: Record<string, unknown> } }).event.draft;
    expect(draft).toMatchObject({ platform: 'hawa_desk', rawText, copyEn, copyCkb, autoGenerate: true, designStudio: true });
    expect(draft.lifecycleSource).toBeUndefined();
    expect(JSON.stringify(rows.open.payload)).not.toContain('UNTRUSTED');
    expect(JSON.stringify(rows.event)).not.toContain('UNTRUSTED');
    expect(openDraft(JSON.parse(JSON.stringify(draft)), requestId)).toEqual(draft);

    // The Studio's copy: the member's confirmed fields, verbatim (no emoji or divider clean-up), with their languages.
    expect(savedDesignCopy(rows.event, '')).toEqual({ copy: [copyEn, copyCkb], instructions: 'Keep the price editable.' });
    expect(savedDesignCopyLocales(rows.event, [copyEn, copyCkb])).toEqual(['en', 'ckb']);

    // The Desk shows the original PDF on the task, as for a Telegram PDF brief.
    const detail = await (await app().request(`/v1/tasks/${taskId}`)).json() as Record<string, any>;
    expect(detail).toMatchObject({ copyEn, copyCkb, sourceDocument: { id: receipt.id, clientId, sourceSha256: hash(raw) },
      reviewedSource: evidence });

    // RequestLifecycle's own projection call replays Core's receipt.
    const replay = await createApp({ db } as any).request(`/v1/internal/lifecycle/${requestId}/project`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ v: 1, expectedRev: 0, rev: 1, key: `${requestId}:1:open`, ops: [{ kind: 'createRequest', draft }] }) });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ taskId, stage: 'designing', autoGenerate: true, design: { clientId, sourcePlatform: 'hawa_desk' } });

    // The same save answers the same task, even after the parser is gone; other words under its key are refused.
    vi.stubEnv('HAWA_DOCLING_URL', '');
    expect(await post(pdfBody(clientId, receipt), key)).toMatchObject({ status: 200, body: { id: taskId, requestId } });
    expect((await post(pdfBody(clientId, receipt, { copyEn: 'Changed price' }), key)).status).toBe(409);
    expect((await recorded(key, clientId)).open).toHaveLength(1);
  });

  it('refuses unconfirmed, changed, foreign and unreadable evidence, and a member who may not confirm copy, recording nothing', async () => {
    const clientId = await client(), other = await client(), { raw, receipt } = await upload(clientId);
    const { receipt: foreign } = await upload(other);
    const designer = randomUUID();
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES (${designer}::uuid,${`${designer}@example.test`},'Scoped designer')`.execute(owner);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role,active) VALUES (${tenantId}::uuid,${designer}::uuid,'designer',true)`.execute(owner);
    await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role,active)
      VALUES (${tenantId}::uuid,${clientId}::uuid,${designer}::uuid,'designer',true)`.execute(owner);
    const source = pdfBody(clientId, receipt).sourceDocument;
    const cases: Array<[Record<string, unknown>, number, string, Record<string, unknown>?]> = [
      [pdfBody(clientId, receipt, { sourceDocument: { ...source, confirmed: false } }), 422, 'explicitly confirm the request copy'],
      [pdfBody(clientId, receipt, { sourceDocument: { ...source, id: 'not-a-document' } }), 422, 'could not be identified'],
      [pdfBody(clientId, receipt, { sourceDocument: { ...source, sourceSha256: '0'.repeat(64) } }), 409, 'Source evidence changed'],
      [pdfBody(clientId, receipt, { sourceDocument: { ...source, extractionSha256: '0'.repeat(64) } }), 409, 'Source evidence changed'],
      [pdfBody(clientId, receipt, { sourceDocument: { ...source, id: randomUUID() } }), 403, 'unavailable in this client'],
      [pdfBody(clientId, foreign), 403, 'unavailable in this client'],
      [pdfBody(clientId, receipt, { copyEn: ' ', copyCkb: '' }), 422, 'exact words'],
      [pdfBody(clientId, receipt), 403, 'An office operator must save', { role: 'designer', userId: designer }],
    ];
    for (const [body, status, words, principal] of cases) {
      const key = randomUUID(), answer = await post(body, key, principal);
      expect(answer.status, words).toBe(status);
      expect(String(answer.body.detail)).toContain(words);
      expect(await recorded(key, clientId)).toEqual({ open: [], tasks: [] });
    }

    // A damaged original is never opened as a request.
    const store = blobStoreFromEnv(db), stat = await store.stat(receipt.sourceSha256);
    assert(stat, 'Expected retained source bytes');
    await fs.chmod(stat.path, 0o644); await fs.writeFile(stat.path, 'x'.repeat(Buffer.byteLength(raw)));
    const key = randomUUID(), damaged = await post(pdfBody(clientId, receipt), key);
    expect(damaged.status).toBe(503);
    expect(String(damaged.body.detail)).toContain('missing or damaged');
    expect(await recorded(key, clientId)).toEqual({ open: [], tasks: [] });
  });
});
