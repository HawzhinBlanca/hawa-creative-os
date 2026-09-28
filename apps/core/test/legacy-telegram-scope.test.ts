import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { persistChatIntake, type ChatIntake } from '../src/services/chat-intake.js';
import { LegacyTelegramRequestRefused, runLegacyTelegramIntake } from '../src/services/legacy-telegram-scope.js';

/**
 * The backstop of ADR-135: every legacy Telegram task is written by persistChatIntake, and in the
 * old intake's finish-only scope it may only continue an open legacy request of the same chat.
 * Against the per-file test database as hawa_app.
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

const chatId = () => String(64_000_000 + Math.floor(Math.random() * 9_000_000));
const input = (chat: string, extra: Partial<ChatIntake> = {}): ChatIntake => ({
  platform: 'telegram', sourceEventId: `ev-${randomUUID()}`, sourceChannelId: chat,
  rawText: 'KAAE spring lecture\n---\nMarch 3, 2026', title: 'KAAE spring lecture', clientId,
  designInstructions: 'Lecture announcement', exactCopy: [{ text: 'March 3, 2026' }], autoGenerate: false, ...extra,
});
const refusal = async (work: Promise<unknown>) => {
  try { await work; return null; } catch (error) {
    if (error instanceof LegacyTelegramRequestRefused) return error.reason;
    throw error;
  }
};
const setState = (id: string, state: string) =>
  sql`UPDATE hawa.tasks SET state = ${state}::hawa.task_state WHERE id = ${id}::uuid`.execute(owner);
const countInChat = async (chat: string) => Number((await withRlsContext(db, scope, (trx) => sql<{ n: string }>`SELECT count(*) AS n
  FROM hawa.outbox_commands WHERE command_type = 'task.created' AND payload->>'sourceChannelId' = ${chat}`.execute(trx))).rows[0].n);

describe('persistChatIntake in the legacy intake\'s finish-only scope', () => {
  it('refuses a new Telegram request, and saves nothing', async () => {
    const chat = chatId();
    expect(await refusal(runLegacyTelegramIntake(true, () => persistChatIntake(db, input(chat))))).toBe('NEW_REQUEST');
    expect(await countInChat(chat)).toBe(0);
  });

  it('continues an open legacy request with its pin, and refuses a finished one', async () => {
    const chat = chatId();
    const root = String((await persistChatIntake(db, input(chat))).task.id);
    await setState(root, 'human_review');
    const revision = await runLegacyTelegramIntake(true, () => persistChatIntake(db,
      input(chat, { studioOptions: { parentTaskId: root, revisionRound: 1 } })));
    expect(revision.task.delivery_executor_pin).toBe('core');
    for (const state of ['complete', 'rejected', 'cancelled']) {
      await setState(root, state);
      expect(await refusal(runLegacyTelegramIntake(true, () => persistChatIntake(db,
        input(chat, { studioOptions: { parentTaskId: root, revisionRound: 1 } }))))).toBe('REQUEST_CLOSED');
    }
    expect(await countInChat(chat)).toBe(2);
  });

  it('never extends a request RequestLifecycle owns', async () => {
    const chat = chatId();
    const requestId = randomUUID();
    const owned = String((await persistChatIntake(db, input(chat, { sourceEventId: `lc-${requestId}-r0` }),
      { outboxState: 'recorded' })).task.id);
    await withRlsContext(db, scope, async (trx) => {
      await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id, parent_request_id,
        owner, stage, rev, chat_id) VALUES (${requestId}::uuid, ${tenantId}::uuid, ${owned}::uuid, ${owned}::uuid,
        null, 'restate', 'manual', 3, ${chat})`.execute(trx);
      await sql`UPDATE hawa.tasks SET request_id = ${requestId}::uuid WHERE id = ${owned}::uuid`.execute(trx);
    });
    expect(await refusal(runLegacyTelegramIntake(true, () => persistChatIntake(db,
      input(chat, { studioOptions: { referenceFor: owned } }))))).toBe('LIFECYCLE_OWNED');
  });

  it('replays a saved event, and leaves WhatsApp, lifecycle opens and callers outside the scope alone', async () => {
    const chat = chatId();
    const first = input(chat);
    const saved = await persistChatIntake(db, first);
    const replay = await runLegacyTelegramIntake(true, () => persistChatIntake(db, first));
    expect(String(replay.task.id)).toBe(String(saved.task.id));
    expect(await refusal(runLegacyTelegramIntake(true, () => persistChatIntake(db, input(chat, { platform: 'whatsapp' }))))).toBeNull();
    expect(await refusal(runLegacyTelegramIntake(true, () => persistChatIntake(db, input(chat), { outboxState: 'recorded' })))).toBeNull();
    expect(await refusal(runLegacyTelegramIntake(false, () => persistChatIntake(db, input(chat))))).toBeNull();
  });
});
