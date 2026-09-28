import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { persistChatIntake, type ChatIntake } from '../src/services/chat-intake.js';

/**
 * GET /v1/operations/legacy-path (ADR-135): how the lead learns, without SQL on production, whether
 * anything is still on the old Telegram path, so stage 2 of the retirement may merge. Against this
 * file's own test database, so every count below is this file's.
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const scope = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' as const };
const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
afterAll(async () => {
  await db.destroy();
  await owner.destroy();
});

const chatId = () => String(65_000_000 + Math.floor(Math.random() * 9_000_000));
const input = (chat: string, extra: Partial<ChatIntake> = {}): ChatIntake => ({
  platform: 'telegram', sourceEventId: `ev-${randomUUID()}`, sourceChannelId: chat,
  rawText: 'KAAE spring lecture\n---\nMarch 3, 2026', title: 'KAAE spring lecture', clientId,
  designInstructions: 'Lecture announcement', exactCopy: [{ text: 'March 3, 2026' }], autoGenerate: false, ...extra,
});
const setState = (id: string, state: string) =>
  sql`UPDATE hawa.tasks SET state = ${state}::hawa.task_state WHERE id = ${id}::uuid`.execute(owner);
const read = async (headers: Record<string, string>) => {
  const res = await createApp({ db } as any).request('/v1/operations/legacy-path', { headers });
  return { status: res.status, body: await res.json() };
};
const admin = { Authorization: 'Bearer test_admin_key' };

describe('GET /v1/operations/legacy-path', () => {
  it('answers administrators only', async () => {
    expect((await read({})).status).toBe(401);
    expect((await read({ Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` })).status).toBe(403);
    expect((await read(admin)).status).toBe(200);
  });

  it('counts open legacy Telegram tasks, queued Core sends and legacy workflow runs, and nothing that stays', async () => {
    const empty = await read(admin);
    expect(empty.body).toMatchObject({ openTasks: { total: 0, chats: 0, items: [] }, pendingRequesterSends: 0,
      failedRequesterSends: 0, legacyWorkflowDeliveriesRunning: 0, newestLegacyTaskCreatedAt: null, stage2Ready: true });

    // Two open legacy tasks in one chat, one finished one in another.
    const chatA = chatId();
    const received = String((await persistChatIntake(db, input(chatA))).task.id);
    const review = String((await persistChatIntake(db, input(chatA))).task.id);
    await setState(review, 'human_review');
    const chatB = chatId();
    const finished = String((await persistChatIntake(db, input(chatB))).task.id);
    await setState(finished, 'complete');
    // What stays is never counted: a WhatsApp task, and a request RequestLifecycle owns.
    await persistChatIntake(db, input(chatId(), { platform: 'whatsapp' }));
    const requestId = randomUUID();
    const owned = String((await persistChatIntake(db, input(chatB, { sourceEventId: `lc-${requestId}-r0` }),
      { outboxState: 'recorded' })).task.id);
    await withRlsContext(db, scope, async (trx) => {
      await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id, parent_request_id,
        owner, stage, rev, chat_id) VALUES (${requestId}::uuid, ${tenantId}::uuid, ${owned}::uuid, ${owned}::uuid,
        null, 'restate', 'manual', 3, ${chatB})`.execute(trx);
      await sql`UPDATE hawa.tasks SET request_id = ${requestId}::uuid WHERE id = ${owned}::uuid`.execute(trx);
    });

    const open = await read(admin);
    expect(open.body.openTasks).toMatchObject({ total: 2, byState: { received: 1, human_review: 1 }, byPin: { core: 2 }, chats: 1 });
    expect(open.body.openTasks.items.map((i: { id: string }) => i.id).sort()).toEqual([received, review].sort());
    expect(open.body.newestLegacyTaskCreatedAt).not.toBeNull();
    expect(open.body.stage2Ready).toBe(false);

    await setState(received, 'cancelled');
    await setState(review, 'rejected');
    expect((await read(admin)).body).toMatchObject({ openTasks: { total: 0 }, stage2Ready: true });

    // A requester file send Core queued after completing a task keeps stage 2 waiting until it ends.
    const send = randomUUID();
    await sql`INSERT INTO hawa.outbox_commands (id, tenant_id, aggregate_type, aggregate_id, command_type, idempotency_key, payload, state)
      VALUES (${send}::uuid, ${tenantId}::uuid, 'task', ${finished}::uuid, 'notify.published', ${`legacy-path-${send}`}, '{}'::jsonb, 'pending')`.execute(owner);
    expect((await read(admin)).body).toMatchObject({ pendingRequesterSends: 1, stage2Ready: false });
    await sql`UPDATE hawa.outbox_commands SET state = 'failed' WHERE id = ${send}::uuid`.execute(owner);
    expect((await read(admin)).body).toMatchObject({ pendingRequesterSends: 0, failedRequesterSends: 1, stage2Ready: true });

    // A legacy Delivery workflow run (reportTo 'core') in flight. Foreign keys are skipped for this
    // one row: the count reads only the publication's executor columns and its task.
    await owner.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await sql`INSERT INTO hawa.publications (tenant_id, task_id, design_revision_id, approval_id, publication_key,
          package_manifest, package_sha256, state, executor, executor_run, executor_finished_run)
        VALUES (${tenantId}::uuid, ${finished}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${`legacy-path-${randomUUID()}`},
          '{}'::jsonb, ${'0'.repeat(64)}, 'pending', 'restate', 1, 0)`.execute(trx);
    });
    expect((await read(admin)).body).toMatchObject({ legacyWorkflowDeliveriesRunning: 1, stage2Ready: false });
  });
});
