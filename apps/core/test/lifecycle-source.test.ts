import { randomUUID, createHash } from 'node:crypto';
import { readFile, chmod, writeFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { DoclingParser, PDF_EXTRACTOR_VERSION, DocumentExtractionError } from '@hawa/retrieval';
import { TelegramBridgeDaemon } from '@hawa/integrations';
import { createApp } from '../src/app.js';
import { blobStoreFor } from '../src/services/blob-store-context.js';
import { savedDesignCopy } from '../src/services/canva-design-planner.js';
import { persistChatIntake } from '../src/services/chat-intake.js';

const db = createDb(process.env.TEST_DATABASE_URL!), owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const tenantId = '00000000-0000-4000-a000-000000000001';
const workerToken = ['source','review','worker','fixture'].join('-');
const headers = { Authorization: `Bearer ${workerToken}`, 'Content-Type': 'application/json' };
const scope = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' as const };
const pdf = await readFile(new URL('../../../services/docling/fixtures/two-pages.pdf', import.meta.url));
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const next = () => Math.floor(Math.random() * 1_000_000_000) + 1;
const apps: ReturnType<typeof createApp>[] = [];
const app = () => { const value = createApp({ db }); apps.push(value); return value; };
beforeEach(() => {
  vi.stubEnv('HAWA_WORKER_TOKEN', workerToken);
  vi.stubEnv('HAWA_DOCLING_URL', 'http://127.0.0.1:19091');
  vi.stubEnv('AUTO_GENERATE_DAILY_CAP_GLOBAL', '1000000');
  vi.spyOn(TelegramBridgeDaemon.prototype, 'downloadFile').mockResolvedValue(pdf);
  vi.spyOn(DoclingParser.prototype, 'parse').mockImplementation(async (id, bytes) => ({
    documentId: id, title: 'source.pdf', sourceSha256: hash(bytes), tables: [], images: [],
    extraction: { version: PDF_EXTRACTOR_VERSION, pageCount: 2, limitations: ['Native order unverified'] },
    chunks: [1, 2].map(page => ({ chunkId: randomUUID(), documentId: id, pageNumber: page,
      text: `Source page ${page}`, sha256: hash(`Source page ${page}`), tokenCountEstimate: 4,
      metadata: { sourceKind: 'docling_native_pdf', sourceId: 'source.pdf', mimeType: 'application/pdf',
        coordinates: { x: 10, y: 10, width: 100, height: 15 }, coordinateSystem: 'top_left_points' } })),
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await Promise.all(apps.map(a => a.clientDnaHydrated)); await Promise.all([db.destroy(), owner.destroy()]); });
async function fixture() {
  const clientId = randomUUID(), code = `source-${next()}`, chat = next(), sender = next(), id = next();
  await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES (${clientId}::uuid,${tenantId}::uuid,${code},${code})`.execute(owner);
  vi.stubEnv('HAWA_LIFECYCLE_CHATS', String(chat));
  const update = { update_id: id, message: { message_id: id, from: { id: sender, is_bot: false, first_name: 'Requester' },
    chat: { id: chat, type: 'private' }, caption: `/new\nClient: ${code}\nUse editable typography.`,
    document: { file_id: 'original-pdf', file_name: '../original.pdf', mime_type: 'application/pdf', file_size: pdf.length } } };
  const confirm = (copy = '  Confirmed 123\n_____\nKeep this exact.  ') => ({ update_id: next(), message: {
    message_id: next(), from: update.message.from, chat: update.message.chat,
    reply_to_message: { message_id: update.message.message_id }, text: `/use_source\n${copy}` } });
  return { clientId, code, chat, sender, update, confirm };
}
async function intake(update: unknown, instance = app()) {
  const response = await instance.request('/v1/internal/telegram/intake', { method: 'POST', headers,
    body: JSON.stringify({ v: 1, update, mode: 'legacy' }) });
  expect(response.status, await response.clone().text()).toBe(200); return response.json();
}
async function project(open: { requestId: string; draft: unknown }) {
  return app().request(`/v1/internal/lifecycle/${open.requestId}/project`, { method: 'POST', headers,
    body: JSON.stringify({ v: 1, expectedRev: 0, rev: 1, key: `${open.requestId}:1:open`, ops: [{ kind: 'createRequest', draft: open.draft }] }) });
}
const tasks = async (clientId: string) => (await sql<{ id: string; payload: Record<string, unknown> }>`SELECT t.id,o.payload
  FROM hawa.tasks t JOIN hawa.outbox_commands o ON o.aggregate_id=t.id AND o.command_type='task.created'
  WHERE t.client_id=${clientId}::uuid`.execute(owner)).rows;

describe('requester-reviewed PDF source', () => {
  it('keeps task source downloads inside the reader’s assigned client', async () => {
    const f = await fixture(); await intake(f.update); const opened = await intake(f.confirm());
    expect((await project(opened)).status).toBe(200);
    const task = (await tasks(f.clientId))[0], readerId = randomUUID(), otherId = randomUUID();
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES (${readerId}::uuid,${`${readerId}@example.test`},'Assigned designer')`.execute(owner);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role,active) VALUES (${tenantId}::uuid,${readerId}::uuid,'designer',true)`.execute(owner);
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES (${otherId}::uuid,${tenantId}::uuid,${otherId},'Other client')`.execute(owner);
    await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role,active)
      VALUES (${tenantId}::uuid,${otherId}::uuid,${readerId}::uuid,'designer',true)`.execute(owner);
    const reader = createApp({ db, testAuth: { principal: { ...scope, userId: readerId } } }); apps.push(reader);
    const path = `/v1/tasks/${task.id}/files/${hash(pdf)}`;
    expect((await reader.request(path)).status).toBe(404);
    const sourcePath = `/v1/clients/${f.clientId}/source-files`;
    expect((await reader.request(sourcePath)).status).toBe(404);
    expect((await reader.request(`${sourcePath}/${f.update.update_id}/content`)).status).toBe(404);
    await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role,active)
      VALUES (${tenantId}::uuid,${f.clientId}::uuid,${readerId}::uuid,'designer',true)`.execute(owner);
    const allowed = await reader.request(path); expect(allowed.status).toBe(200);
    expect(hash(new Uint8Array(await allowed.arrayBuffer()))).toBe(hash(pdf));
    const listing = await reader.request(sourcePath); expect(listing.status).toBe(200);
    expect(await listing.json()).toMatchObject({ clientId: f.clientId, items: [{ updateId: f.update.update_id, stage: 'copy_confirmed' }] });
    const original = await reader.request(`${sourcePath}/${f.update.update_id}/content`);
    expect(original.status).toBe(200); expect(hash(new Uint8Array(await original.arrayBuffer()))).toBe(hash(pdf));
    await sql`UPDATE hawa.client_memberships SET active=false WHERE user_id=${readerId}::uuid AND client_id=${f.clientId}::uuid`.execute(owner);
    expect((await reader.request(path)).status).toBe(404);
    expect((await reader.request(`${sourcePath}/${f.update.update_id}/content`)).status).toBe(404);
  });

  it('keeps a failed extraction original available to the office without approving or creating work', async () => {
    const f = await fixture(); vi.mocked(DoclingParser.prototype.parse).mockRejectedValueOnce(new DocumentExtractionError('DOCUMENT_OCR_REQUIRED'));
    const refused = await intake(f.update); expect(refused.intakeStatus).toBe(422);
    const reader = createApp({ db, testAuth: { principal: scope } }); apps.push(reader);
    const path = `/v1/clients/${f.clientId}/source-files`;
    const listing = await reader.request(path); expect(listing.status).toBe(200);
    expect(await listing.json()).toMatchObject({ clientId: f.clientId, items: [{ updateId: f.update.update_id,
      stage: 'extraction_stopped', sourceSha256: hash(pdf), documentId: null }] });
    const original = await reader.request(`${path}/${f.update.update_id}/content`);
    expect(original.status).toBe(200); expect(original.headers.get('cache-control')).toBe('private, no-store');
    expect(hash(new Uint8Array(await original.arrayBuffer()))).toBe(hash(pdf));
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', ''); expect(await intake(f.update)).toEqual(refused);
    expect(DoclingParser.prototype.parse).toHaveBeenCalledTimes(1); expect(await tasks(f.clientId)).toHaveLength(0);
  });

  it('retains original evidence before exact copy confirmation and projects one complete request', async () => {
    const f = await fixture();
    f.update.message.caption += '\nSize: 1080x1080';
    const upload = await intake(f.update);
    expect(upload).toMatchObject({ intakeStatus: 200, lifecycleAction: 'source-message' });
    expect(upload.sourceMessage).toContain('Source page 1'); expect(await tasks(f.clientId)).toHaveLength(0);
    await withRlsContext(db, scope, trx => sql`SELECT * FROM hawa.blob_gc_mark()`.execute(trx));
    expect((await sql<{ unreferenced_since: unknown }>`SELECT unreferenced_since FROM hawa.blobs WHERE sha256=${hash(pdf)}`.execute(owner)).rows[0].unreferenced_since).toBeNull();
    const confirmation = f.confirm(); const copy = confirmation.message.text.slice('/use_source\n'.length);
    const first = await intake(confirmation);
    expect(first).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request', draft: { rawText: copy, clientId: f.clientId, variant: { width: 1080, height: 1080 } } });
    expect((await project(first)).status).toBe(200);
    const replay = await intake(confirmation); expect(replay.requestId).toBe(first.requestId);
    expect((await project(replay)).status).toBe(200);
    const rows = await tasks(f.clientId); expect(rows).toHaveLength(1);
    expect(rows[0].payload.reviewedSource).toMatchObject({ sourceSha256: hash(pdf), copySha256: hash(copy),
      confirmation: 'request_copy_reviewed', confirmedBy: `telegram:${f.sender}`, clientId: f.clientId });
    expect(savedDesignCopy(rows[0].payload, 'fallback').copy).toEqual([copy]);
    expect((await sql`SELECT * FROM hawa.task_files WHERE task_id=${rows[0].id}::uuid AND role='source_document'`.execute(owner)).rows).toHaveLength(1);
    expect((await sql`SELECT * FROM hawa.client_document_knowledge_events WHERE client_id=${f.clientId}::uuid`.execute(owner)).rows).toHaveLength(0);
  });

  it('reopens retained extraction and confirmation after restart and flag rollback without reprocessing', async () => {
    const f = await fixture(); const first = await intake(f.update), c = f.confirm(); const opened = await intake(c);
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', ''); vi.stubEnv('HAWA_DOCLING_URL', '');
    expect(await intake(f.update)).toEqual(first);
    expect(await intake(c)).toMatchObject({ duplicate: true, requestId: opened.requestId, draft: opened.draft });
    expect(TelegramBridgeDaemon.prototype.downloadFile).toHaveBeenCalledTimes(1);
    expect(DoclingParser.prototype.parse).toHaveBeenCalledTimes(1);
  });

  it('rejects source identity mutation, a second confirmation and worker omission or replacement', async () => {
    const f = await fixture(); await intake(f.update); const c = f.confirm(); const open = await intake(c);
    expect((await intake({ ...f.update, message: { ...f.update.message, document: undefined, text: 'Changed new brief' } })).intakeStatus).toBe(409);
    expect((await intake({ ...c, message: { ...c.message, text: '/use_source\nChanged' } })).intakeStatus).toBe(409);
    expect((await intake(f.confirm())).intakeStatus).toBe(409);
    const altered = structuredClone(open); delete altered.draft.lifecycleSource;
    expect((await project(altered)).status).toBe(409);
    altered.draft = { ...open.draft, rawText: 'Changed copy', exactCopy: [{ text: 'Changed copy' }] };
    expect((await project(altered)).status).toBe(409); expect(await tasks(f.clientId)).toHaveLength(0);
  });

  it('binds copy review to sender, chat, topic and exact original reply', async () => {
    const f = await fixture(); await intake(f.update);
    const sender = f.confirm(); sender.message.from = { ...sender.message.from, id: next() };
    expect((await intake(sender)).intakeStatus).toBe(404);
    const chat = f.confirm(); chat.message.chat = { ...chat.message.chat, id: next() };
    expect((await intake(chat)).intakeStatus).toBe(404);
    const topic = f.confirm(); Object.assign(topic.message, { message_thread_id: 99 });
    expect((await intake(topic)).intakeStatus).toBe(404);
    const wrongReply = f.confirm(); wrongReply.message.reply_to_message.message_id = next();
    expect((await intake(wrongReply)).intakeStatus).toBe(404); expect(await tasks(f.clientId)).toHaveLength(0);
  });

  it('requires active explicit client scope and deliberate group promotion before download', async () => {
    const f = await fixture(); f.update.message.caption = 'Some document';
    expect((await intake(f.update)).intakeStatus).toBe(422);
    const other = await fixture(); other.update.message.chat.type = 'group'; other.update.message.caption = `Client: ${other.code}`;
    expect((await intake(other.update)).intakeStatus).toBe(409);
    expect(TelegramBridgeDaemon.prototype.downloadFile).not.toHaveBeenCalled();
    other.update.message.caption = `/new\nClient: ${other.code}`;
    other.update.update_id = next(); other.update.message.message_id = next();
    expect((await intake(other.update)).intakeStatus).toBe(200);
  });

  it('keeps refused source events refused after restart, flag rollback and payload replacement', async () => {
    const f = await fixture(); f.update.message.caption = 'No client selected';
    const refused = await intake(f.update); expect(refused.intakeStatus).toBe(422);
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', '');
    expect(await intake(f.update)).toEqual(refused);
    const changed = structuredClone(f.update); changed.message.caption = `/new\nClient: ${f.code}`;
    expect((await intake(changed)).intakeStatus).toBe(409);
    expect(TelegramBridgeDaemon.prototype.downloadFile).not.toHaveBeenCalled();
    expect(await tasks(f.clientId)).toHaveLength(0);
  });

  it('pins the selected client before download so a retry cannot follow a reassigned client code', async () => {
    const f = await fixture(); vi.mocked(TelegramBridgeDaemon.prototype.downloadFile).mockResolvedValueOnce(null);
    expect((await intake(f.update)).intakeStatus).toBe(503);
    const otherId = randomUUID();
    await sql`UPDATE hawa.clients SET code=${`${f.code}-renamed`},name=${`${f.code}-renamed`} WHERE id=${f.clientId}::uuid`.execute(owner);
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES (${otherId}::uuid,${tenantId}::uuid,${f.code},${f.code})`.execute(owner);
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', '');
    expect((await intake(f.update)).intakeStatus).toBe(200);
    const open = await intake(f.confirm());
    expect(open).toMatchObject({ lifecycleAction: 'open-request', draft: { clientId: f.clientId } });
    expect((await project(open)).status).toBe(200);
    expect(await tasks(f.clientId)).toHaveLength(1); expect(await tasks(otherId)).toHaveLength(0);
  });

  it('preserves a premature copy refusal and accepts correction only as a new event', async () => {
    const f = await fixture(), confirmation = f.confirm();
    const refused = await intake(confirmation); expect(refused.intakeStatus).toBe(404);
    await intake(f.update);
    expect(await intake(confirmation)).toEqual(refused);
    expect((await intake(f.confirm())).lifecycleAction).toBe('open-request');
  });

  it('preserves an inactive-client refusal even if the client is later reactivated', async () => {
    const f = await fixture(); vi.mocked(TelegramBridgeDaemon.prototype.downloadFile).mockResolvedValueOnce(null);
    expect((await intake(f.update)).intakeStatus).toBe(503);
    await sql`UPDATE hawa.clients SET status='inactive' WHERE id=${f.clientId}::uuid`.execute(owner);
    const refused = await intake(f.update); expect(refused.intakeStatus).toBe(409);
    await sql`UPDATE hawa.clients SET status='active' WHERE id=${f.clientId}::uuid`.execute(owner);
    expect(await intake(f.update)).toEqual(refused);
    expect(DoclingParser.prototype.parse).not.toHaveBeenCalled(); expect(await tasks(f.clientId)).toHaveLength(0);
  });

  it('refuses ambiguous client lines and invalid requested sizes before download', async () => {
    const f = await fixture(); f.update.message.caption += `\nClient: ${f.code}`;
    expect((await intake(f.update)).intakeStatus).toBe(422);
    const g = await fixture(); g.update.message.caption += '\nSize: 20000x1080';
    expect((await intake(g.update)).intakeStatus).toBe(422);
    expect(TelegramBridgeDaemon.prototype.downloadFile).not.toHaveBeenCalled();
  });

  it('retries a saved source and its waiting confirmation after the parser becomes available', async () => {
    const f = await fixture(), c = f.confirm(); vi.stubEnv('HAWA_DOCLING_URL', '');
    expect((await intake(f.update)).intakeStatus).toBe(503);
    expect((await intake(c)).intakeStatus).toBe(503);
    vi.stubEnv('HAWA_DOCLING_URL', 'http://127.0.0.1:19091'); vi.stubEnv('HAWA_LIFECYCLE_CHATS', '');
    expect((await intake(f.update)).intakeStatus).toBe(200);
    expect((await intake(c)).lifecycleAction).toBe('open-request');
    expect(TelegramBridgeDaemon.prototype.downloadFile).toHaveBeenCalledTimes(1);
  });

  it('reconciles simultaneous copy confirmations and projections into one task with exact Desk copy', async () => {
    const f = await fixture(); await intake(f.update);
    const copy = '  نرخ ١٢٣\n_____\nپارێزراو  ', confirmation = f.confirm(copy);
    const opens = await Promise.all([intake(confirmation), intake(confirmation)]);
    expect(opens.map(v => v.intakeStatus)).toEqual([200, 200]);
    expect(opens[0].requestId).toBe(opens[1].requestId);
    expect((await Promise.all(opens.map(project))).map(v => v.status)).toEqual([200, 200]);
    const rows = await tasks(f.clientId); expect(rows).toHaveLength(1);
    const reader = createApp({ db, testAuth: { principal: scope } }); apps.push(reader);
    const response = await reader.request(`/v1/tasks/${rows[0].id}`); expect(response.status).toBe(200);
    const task = await response.json();
    expect(task).toMatchObject({ copyEn: '', copyCkb: copy,
      sourceDocument: { clientId: f.clientId, sourceSha256: hash(pdf) },
      reviewedSource: { confirmation: 'request_copy_reviewed', copySha256: hash(copy) } });
  });

  it('blocks missing and same-size corrupt bytes at confirmation and at projection', async () => {
    const f = await fixture(); await intake(f.update); const c = f.confirm(); const open = await intake(c);
    const stat = await blobStoreFor(db)!.stat(hash(pdf)); await chmod(stat.path, 0o644); await writeFile(stat.path, Buffer.alloc(pdf.length, 120));
    try {
      expect((await project(open)).status).toBe(503);
      const reader = createApp({ db, testAuth: { principal: scope } }); apps.push(reader);
      expect((await reader.request(`/v1/clients/${f.clientId}/source-files/${f.update.update_id}/content`)).status).toBe(503);
      const g = await fixture();
      // This second receipt must not acknowledge a same-size corrupt content-addressed file.
      const bad = await intake(g.update); expect(bad.intakeStatus).not.toBe(200);
      expect(await tasks(f.clientId)).toHaveLength(0);
    } finally { await writeFile(stat.path, pdf); }
    expect((await project(open)).status).toBe(200);
  });

  it('continues the same request from its captured revision and refuses a stale source', async () => {
    const f = await fixture(), requestId = randomUUID();
    const original = await persistChatIntake(db, { platform: 'telegram', sourceEventId: `seed-${requestId}`, sourceChannelId: String(f.chat),
      clientId: f.clientId, rawText: 'Original request', title: 'Original', designInstructions: 'Keep brand rules.', exactCopy: [{ text: 'Old copy' }], autoGenerate: false }, { outboxState: 'recorded' });
    const taskId = String(original.task.id), noticeId = next();
    await sql`INSERT INTO hawa.requests(request_id,tenant_id,root_task_id,current_task_id,owner,stage,rev,chat_id)
      VALUES (${requestId}::uuid,${tenantId}::uuid,${taskId}::uuid,${taskId}::uuid,'restate','manual',3,${String(f.chat)})`.execute(owner);
    await sql`UPDATE hawa.tasks SET request_id=${requestId}::uuid WHERE id=${taskId}::uuid`.execute(owner);
    await sql`INSERT INTO hawa.inbox_events(tenant_id,source_account_id,source_event_id,event_kind,payload,payload_hash,verified)
      VALUES (${tenantId}::uuid,'telegram_delivery',${`lc:${requestId}:3:office-revision-notify:send`},'telegram_message_sent',
      ${JSON.stringify({ messageId: noticeId })}::jsonb,${hash('notice')},true)`.execute(owner);
    f.update.message.caption = 'Use this updated source.\nSize: 1080x1920'; Object.assign(f.update.message, { reply_to_message: { message_id: noticeId } });
    expect((await intake(f.update)).intakeStatus).toBe(200);
    const c = f.confirm('  نرخ ١٢٣\n_____\nپارێزراو  '), revised = await intake(c);
    expect(revised, JSON.stringify(revised)).toMatchObject({ intakeStatus: 200, lifecycleAction: 'requester-revision', requestId, priorTaskId: taskId });
    const rows = await tasks(f.clientId); expect(rows).toHaveLength(2);
    const child = rows.find(row => row.id === revised.newTaskId)!;
    expect(savedDesignCopy(child.payload, 'fallback').copy).toEqual(['  نرخ ١٢٣\n_____\nپارێزراو  ']);
    expect(child.payload.variant).toEqual({ width: 1080, height: 1920 });
    expect((await intake(c)).newTaskId).toBe(revised.newTaskId);
    // Another file replying to the old revision is refused before a new download.
    const stale = structuredClone(f.update); stale.update_id = next(); stale.message.message_id = next();
    expect((await intake(stale)).intakeStatus).toBe(409);
  });
});
