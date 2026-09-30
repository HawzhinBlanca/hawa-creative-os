import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { parseLifecycleAlbumRef } from '@hawa/contracts';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';

const tenantId = '00000000-0000-4000-a000-000000000001';
const userId = '00000000-0000-4000-b000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const scope = { tenantId, userId, role: 'operator' as const };
const db = createDb(process.env.TEST_DATABASE_URL!);
const token = ['album', 'worker', 'fixture', 'token'].join('_');
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
let id = 810_000_000;
const photo = (n: number) => Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64'), Buffer.from([n])]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
afterEach(() => vi.unstubAllEnvs());
afterAll(() => db.destroy());
function setup() {
  const chat = ++id;
  vi.stubEnv('HAWA_WORKER_TOKEN', token);
  vi.stubEnv('AUTO_GENERATE_DAILY_CAP_GLOBAL', '100000');
  vi.stubEnv('AUTO_GENERATE_DAILY_CAP_PER_SENDER', '10000');
  const download = vi.fn(async (file: string) => photo(Number(file)));
  const app = createApp({ db, telegramBridge: { downloadFile: download,
    dispatchOutboundMessage: vi.fn(async () => ({ success: true })) } } as any);
  const part = (messageId: number, file: number, caption?: string, reply?: number) => ({
    update_id: ++id, message: { message_id: messageId, date: 1790000000,
      from: { id: 91000007, first_name: 'Requester' }, chat: { id: chat, type: 'private' },
      media_group_id: 'album-a', photo: [{ file_id: String(file) }],
      ...(caption ? { caption } : {}), ...(reply ? { reply_to_message: { message_id: reply } } : {}) },
  });
  const confirm = (reply: number) => ({ update_id: ++id,
    message: { message_id: ++id, date: 1790000000, from: { id: 91000007, first_name: 'Requester' },
      chat: { id: chat, type: 'private' }, text: '/use_album', reply_to_message: { message_id: reply } } });
  const intake = async (update: unknown, target = app) => {
    const res = await target.request('/v1/internal/telegram/intake', { method: 'POST', headers,
      body: JSON.stringify({ v: 1, mode: 'legacy', update }) });
    expect(res.status).toBe(200);
    return await res.json();
  };
  const tasks = () => withRlsContext(db, scope, async (trx) => (await sql<{ task_id: string }>`
    SELECT aggregate_id::text AS task_id FROM hawa.outbox_commands WHERE tenant_id = ${tenantId}::uuid
      AND command_type = 'task.created' AND payload->>'sourceChannelId' = ${String(chat)}`.execute(trx)).rows);
  return { chat, part, confirm, intake, tasks, app, download };
}
const caption = '/new KAAE members evening\n---\nDecember 4, 2026\nErbil';
async function project(app: ReturnType<typeof createApp>, decision: any, draft = decision.draft) {
  return app.request(`/v1/internal/lifecycle/${decision.requestId}/project`, { method: 'POST', headers,
    body: JSON.stringify({ v: 1, expectedRev: 0, rev: 1, key: `${decision.requestId}:1:open`,
      ops: [{ kind: 'createRequest', draft }] }) });
}
async function waiting(chat: number, notice: number) {
  const requestId = randomUUID();
  const created = await persistChatIntake(db, { platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: String(chat),
    rawText: 'KAAE members evening', title: 'KAAE members evening', clientId,
    designInstructions: 'Make the approved design', exactCopy: [{ text: 'December 4, 2026' }],
    autoGenerate: true, studioOptions: { tier: 'quality' } }, { outboxState: 'recorded' });
  const taskId = String(created.task.id);
  await withRlsContext(db, scope, async (trx) => {
    await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id, owner, stage, rev, chat_id)
      VALUES (${requestId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${taskId}::uuid, 'restate', 'manual', 3, ${String(chat)})`.execute(trx);
    await trx.updateTable('tasks').set({ request_id: requestId }).where('id', '=', taskId).execute();
    await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
      VALUES (${tenantId}::uuid, 'telegram_delivery', ${`lc:${requestId}:3:office-revision-notify:send`}, 'telegram_message_sent',
        ${JSON.stringify({ messageId: String(notice) })}::jsonb, 'test-sent-mark', true)`.execute(trx);
  });
  return { requestId, taskId };
}

describe('confirmed lifecycle photo albums', () => {
  it('bounds the reference manifest by type, count and actual byte totals', () => {
    const image = { sha256: 'a'.repeat(64), mediaType: 'image/jpeg', size: 20 * 1024 * 1024 };
    const manifest = { updateId: 1, sha256: 'b'.repeat(64), images: Array(5).fill(image) };
    expect(parseLifecycleAlbumRef(manifest)).not.toBeNull();
    expect(parseLifecycleAlbumRef({ ...manifest, images: Array(6).fill(image) })).toBeNull();
    // Two albums Telegram split from one set (ADR-148): up to twenty photos, never more.
    expect(parseLifecycleAlbumRef({ ...manifest, images: Array(20).fill({ ...image, size: 1 }) })).not.toBeNull();
    expect(parseLifecycleAlbumRef({ ...manifest, images: Array(21).fill({ ...image, size: 1 }) })).toBeNull();
    expect(parseLifecycleAlbumRef({ ...manifest, images: [{ ...image, size: image.size + 1 }, image] })).toBeNull();
    expect(parseLifecycleAlbumRef({ ...manifest, images: [{ ...image, mediaType: 'application/pdf' }, image] })).toBeNull();
  });

  it('refuses the eleventh part before downloading it and cannot submit the truncated album', async () => {
    const f = setup();
    for (let i = 1; i <= 10; i++) expect(await f.intake(f.part(200 + i, i, i === 1 ? caption : undefined)))
      .toMatchObject({ intakeStatus: 202 });
    expect(await f.intake(f.part(211, 11))).toMatchObject({ intakeStatus: 422 });
    expect(f.download).toHaveBeenCalledTimes(10);
    expect(await f.intake(f.confirm(201))).toMatchObject({ intakeStatus: 422 });
    expect(await f.tasks()).toHaveLength(0);
  });

  it.each(['photo', 'document'] as const)('collects out-of-order %s images without a task, then binds every ordered image to one replayable new request', async (carrier) => {
    const f = setup();
    const second = f.part(202, 2, caption);
    const first = f.part(201, 1);
    if (carrier === 'document') for (const update of [first, second]) {
      const message = update.message as Record<string, unknown>;
      const photo = update.message.photo[0];
      delete message.photo;
      message.document = { ...photo, file_name: 'original.png', mime_type: 'image/png',
        thumbnail: { file_id: 'not-the-original' } };
    }
    expect(await f.intake(second)).toMatchObject({ intakeStatus: 202, lifecycleAction: 'settle-later' });
    expect(await f.intake(first)).toMatchObject({ intakeStatus: 202 });
    expect(await f.tasks()).toHaveLength(0);
    expect(await f.intake(first)).toMatchObject({ intakeStatus: 202 });
    expect(f.download).toHaveBeenCalledTimes(2);
    for (const n of [1, 2]) expect((await sql<{ h: string }>`SELECT h FROM hawa.blob_reference_hashes() AS h
      WHERE h = ${sha(photo(n))}`.execute(db)).rows).toHaveLength(1);
    const confirmation = f.confirm(201);
    const decision = await f.intake(confirmation);
    expect(decision).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request', draft: {
      lifecycleAlbum: { updateId: confirmation.update_id, images: [{ sha256: sha(photo(1)) }, { sha256: sha(photo(2)) }] } } });
    expect(JSON.stringify(decision)).not.toContain(photo(1).toString('base64'));
    const forged = structuredClone(decision.draft);
    forged.lifecycleAlbum.images.reverse();
    expect((await project(f.app, decision, forged)).status).toBe(409);
    const projected = await project(f.app, decision);
    expect(projected.status).toBe(200);
    const result = await projected.json();
    expect(await f.tasks()).toHaveLength(1);
    const studio = new DesignStudioService(db);
    expect(await (studio as any).requestImages({ tenantId, actorId: userId }, result.taskId))
      .toEqual([1, 2].map((n) => `data:image/png;base64,${photo(n).toString('base64')}`));
    expect(await f.intake(confirmation, createApp({ db } as any))).toMatchObject({
      duplicate: true, requestId: decision.requestId, draft: decision.draft });
    expect((await project(f.app, decision)).status).toBe(200);
    expect(f.download).toHaveBeenCalledTimes(2);
    expect(await f.tasks()).toHaveLength(1);
  });

  it.each([true, false])('uses only the exact waiting request for a confirmed album (captionless=%s)', async (captionless) => {
    const f = setup();
    const first = await waiting(f.chat, 7001);
    const selected = await waiting(f.chat, 7002);
    await f.intake(f.part(201, 3, captionless ? undefined : 'Use these images for the revision', 7002));
    await f.intake(f.part(202, 4, undefined, 7002));
    const confirmation = f.confirm(202);
    const result = await f.intake(confirmation);
    expect(result).toMatchObject({ intakeStatus: 200, lifecycleAction: 'requester-revision',
      requestId: selected.requestId, priorTaskId: selected.taskId });
    expect(await f.tasks()).toHaveLength(3);
    const files = await withRlsContext(db, scope, (trx) => sql<{ task_id: string; sha256: string }>`SELECT task_id::text, sha256
      FROM hawa.task_files WHERE tenant_id = ${tenantId}::uuid
        AND task_id IN (${first.taskId}::uuid, ${selected.taskId}::uuid, ${result.newTaskId}::uuid)`.execute(trx));
    expect(files.rows).toHaveLength(2);
    expect(files.rows.every((file) => file.task_id === result.newTaskId)).toBe(true);
    const child = await withRlsContext(db, scope, (trx) => trx.selectFrom('outbox_commands').select('payload')
      .where('aggregate_id', '=', result.newTaskId).where('command_type', '=', 'task.created').executeTakeFirstOrThrow());
    expect(child.payload).toMatchObject({ exactCopy: [{ text: 'December 4, 2026' }] });
    expect(await f.intake(confirmation, createApp({ db } as any))).toMatchObject({ duplicate: true, newTaskId: result.newTaskId });
    expect(f.download).toHaveBeenCalledTimes(2);
  });

  it('refuses changed source, a second submission and late photos even after flag rollback', async () => {
    const f = setup();
    const first = f.part(201, 1, caption);
    await f.intake(first);
    await f.intake(f.part(202, 2));
    const confirm = f.confirm(201);
    const [a, b] = await Promise.all([f.intake(confirm), f.intake(confirm)]);
    expect(a.requestId).toBeTruthy();
    expect(b.requestId).toBe(a.requestId);
    expect(await f.intake({ ...first, message: { ...first.message, caption: 'changed' } })).toMatchObject({ intakeStatus: 409 });
    const changedKind = structuredClone(first);
    delete (changedKind.message as any).media_group_id;
    expect(await f.intake(changedKind)).toMatchObject({ intakeStatus: 409 });
    expect(await f.intake({ ...confirm, update_id: first.update_id })).toMatchObject({ intakeStatus: 409 });
    expect(await f.intake({ ...confirm, message: { ...confirm.message, message_id: 501 } })).toMatchObject({ intakeStatus: 409 });
    expect(await f.intake(f.confirm(202))).toMatchObject({ intakeStatus: 422, lifecycleAction: 'album-message' });
    const late = await f.intake(f.part(203, 3));
    expect(late).toMatchObject({ intakeStatus: 422 });
    expect(late.albumMessage).toContain('arrived after I had started your design');
    expect(f.download).toHaveBeenCalledTimes(2);
    expect(await f.tasks()).toHaveLength(0);
  });

  it('does not admit a partial album or forget a refused confirmation when more photos arrive', async () => {
    const f = setup();
    await f.intake(f.part(201, 1, caption));
    const early = f.confirm(201);
    expect(await f.intake(early)).toMatchObject({ intakeStatus: 422 });
    await f.intake(f.part(202, 2));
    expect(await f.intake(early)).toMatchObject({ intakeStatus: 422 });
    expect(await f.intake(f.confirm(201))).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request' });
  });

  it('blocks an entire album with unsupported media and keeps sender/topic scope separate', async () => {
    const f = setup();
    await f.intake(f.part(201, 1, caption));
    const wrongSender = f.confirm(201);
    wrongSender.message.from.id = 91000008;
    expect(await f.intake(wrongSender)).toMatchObject({ intakeStatus: 422 });
    const wrongTopic = f.confirm(201);
    (wrongTopic.message as any).message_thread_id = 22;
    expect(await f.intake(wrongTopic)).toMatchObject({ intakeStatus: 422 });
    const invalid = f.part(202, 2);
    delete (invalid.message as any).photo;
    (invalid.message as any).document = { file_id: 'pdf', mime_type: 'application/pdf' };
    expect(await f.intake(invalid)).toMatchObject({ intakeStatus: 422 });
    expect(await f.intake(f.confirm(201))).toMatchObject({ intakeStatus: 422 });
    expect(f.download).toHaveBeenCalledTimes(1);
    expect(await f.tasks()).toHaveLength(0);
  });

  it('keeps a failed download in the collection so confirmation cannot omit it', async () => {
    const f=setup();
    await f.intake(f.part(201,1,caption));
    const missing=f.part(202,2);
    f.download.mockRejectedValueOnce(new Error('Telegram offline'));
    expect(await f.intake(missing)).toMatchObject({intakeStatus:503,code:'PHOTO_UNAVAILABLE'});
    await f.intake(f.part(203,3));
    expect(await f.intake(f.confirm(201))).toMatchObject({intakeStatus:422});
    expect(await f.tasks()).toHaveLength(0);
    expect(await f.intake(missing)).toMatchObject({intakeStatus:202});
    const admitted=await f.intake(f.confirm(201));
    expect(admitted).toMatchObject({lifecycleAction:'open-request'});
    expect(admitted.draft.lifecycleAlbum.images).toHaveLength(3);
  });

  it('does not reinterpret an album update deliberately held by the earlier implementation', async () => {
    const f=setup();
    const update=f.part(201,1,caption);
    const digest=createHash('sha256').update(JSON.stringify(update)).digest('hex');
    await withRlsContext(db,scope,trx=>sql`INSERT INTO hawa.inbox_events
      (tenant_id,source_account_id,source_event_id,event_kind,payload,payload_hash,verified)
      VALUES(${tenantId}::uuid,'lifecycle_chat_routing',${String(update.update_id)},'lifecycle_media_not_admitted',
        ${JSON.stringify({code:'LIFECYCLE_MEDIA_NOT_ADMITTED',chatId:String(f.chat)})}::jsonb,${digest},true)`.execute(trx));
    expect(await f.intake(update)).toMatchObject({intakeStatus:422,lifecycleAction:'park-update'});
    expect(await f.intake(update)).toMatchObject({intakeStatus:422,lifecycleAction:'park-update'});
    expect(f.download).not.toHaveBeenCalled();
    expect(await f.tasks()).toHaveLength(0);
  });

  it('refuses mixed request replies and conflicting captions without starting a task', async () => {
    for (const captionsConflict of [false, true]) {
      const f = setup();
      await f.intake(f.part(201, 1, 'Use this reference', 8001));
      await f.intake(f.part(202, 2, captionsConflict ? 'Different instructions' : undefined, captionsConflict ? 8001 : 8002));
      expect(await f.intake(f.confirm(201))).toMatchObject({ intakeStatus: 422, lifecycleAction: 'album-message' });
      expect(await f.tasks()).toHaveLength(0);
    }
  });
});
