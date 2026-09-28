import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { persistChatIntake, type ChatIntake } from '../src/services/chat-intake.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;
if (url && !/^\/hawa_(repair|tr_)/.test(new URL(url).pathname)) {
  throw new Error('Only disposable hawa_repair database admitted');
}

describe.skipIf(!url)('T7 Flag Scoping: DESIGN_PIPELINE_V3_CHATS', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const tenant = '00000000-0000-4000-a000-000000000001';
  const client = 'c1000000-0000-4000-8000-000000000002';
  const originalV3 = process.env.DESIGN_PIPELINE_V3;
  const originalV2 = process.env.DESIGN_STUDIO_V2;
  const originalChats = process.env.DESIGN_PIPELINE_V3_CHATS;

  beforeAll(async () => {
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES ('00000000-0000-4000-b000-000000000001','isolated-operator@example.test','Isolated operator') ON CONFLICT DO NOTHING`.execute(db);
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES (${client}::uuid,${tenant}::uuid,'kaae','KAAE') ON CONFLICT DO NOTHING`.execute(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(() => {
    process.env.DESIGN_PIPELINE_V3 = 'off';
    process.env.DESIGN_STUDIO_V2 = 'off';
  });

  afterEach(() => {
    process.env.DESIGN_PIPELINE_V3 = originalV3;
    process.env.DESIGN_STUDIO_V2 = originalV2;
    process.env.DESIGN_PIPELINE_V3_CHATS = originalChats;
  });

  it('keeps designStudio disabled for un-allowlisted chats when global flags are off', async () => {
    process.env.DESIGN_PIPELINE_V3_CHATS = '7191500129';
    const otherChat = '9999999999';

    const input: ChatIntake = {
      platform: 'telegram',
      sourceEventId: randomUUID(),
      sourceChannelId: otherChat,
      clientId: client,
      title: 'General announcement',
      rawText: 'Standard brief for non-test chat',
      designInstructions: 'Standard layout',
      exactCopy: [],
    };

    const result = await persistChatIntake(db, input);
    expect(result.created).toBe(true);

    const outbox = await withRlsContext(
      db,
      { tenantId: tenant, role: 'administrator' },
      (trx) =>
        trx
          .selectFrom('outbox_commands')
          .selectAll()
          .where('aggregate_id', '=', result.task.id)
          .where('command_type', '=', 'task.created')
          .executeTakeFirst()
    );

    expect(outbox).toBeDefined();
    expect(outbox?.payload?.designStudio).toBe(false);
  });

  it('enables designStudio for specifically allowlisted test chat even when global flags are off', async () => {
    const testChat = '7191500129';
    process.env.DESIGN_PIPELINE_V3_CHATS = testChat;

    const input: ChatIntake = {
      platform: 'telegram',
      sourceEventId: randomUUID(),
      sourceChannelId: testChat,
      clientId: client,
      title: 'VIP KAAE invitation test',
      rawText: 'Test brief from allowlisted test chat',
      designInstructions: 'Institutional layout',
      exactCopy: [],
    };

    const result = await persistChatIntake(db, input);
    expect(result.created).toBe(true);

    const outbox = await withRlsContext(
      db,
      { tenantId: tenant, role: 'administrator' },
      (trx) =>
        trx
          .selectFrom('outbox_commands')
          .selectAll()
          .where('aggregate_id', '=', result.task.id)
          .where('command_type', '=', 'task.created')
          .executeTakeFirst()
    );

    expect(outbox).toBeDefined();
    expect(outbox?.payload?.designStudio).toBe(true);
  });

  // ADR-052 and ADR-135: the pin comes from how a task was created (a committed lifecycle open or
  // not), never from a chat setting; HAWA_LIFECYCLE_CHATS no longer exists.
  it('keeps a legacy Telegram task on Core, and its pin cannot change', async () => {
    const chat = '7191500999';
    const input: ChatIntake = { platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: chat,
      clientId: client, title: 'Pinned delivery', rawText: 'One original brief',
      designInstructions: 'Simple layout', exactCopy: [] };
    const first = await persistChatIntake(db, input);
    expect(first.created).toBe(true);
    expect(first.task.delivery_executor_pin).toBe('core');
    const replay = await persistChatIntake(db, input);
    expect(replay.created).toBe(false);
    expect(replay.task.id).toBe(first.task.id);
    expect(replay.task.delivery_executor_pin).toBe('core');
    await expect(withRlsContext(db, { tenantId: tenant, role: 'administrator' }, (trx) =>
      sql`UPDATE hawa.tasks SET delivery_executor_pin = 'restate' WHERE id = ${first.task.id}::uuid`.execute(trx)))
      .rejects.toThrow('Task delivery executor pin is immutable');
  });

  it('replays an existing Telegram task on Core; a WhatsApp task is pinned to Core', async () => {
    const chat = '7191500888';
    const input: ChatIntake = { platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: chat,
      clientId: client, title: 'Existing delivery', rawText: 'Earlier original brief',
      designInstructions: 'Simple layout', exactCopy: [] };
    const old = await persistChatIntake(db, input);
    expect(old.task.delivery_executor_pin).toBe('core');
    expect((await persistChatIntake(db, input)).task.delivery_executor_pin).toBe('core');
    const whatsapp = await persistChatIntake(db, { ...input, platform: 'whatsapp', sourceEventId: randomUUID() });
    expect(whatsapp.task.delivery_executor_pin).toBe('core');
  });

  it('keeps later revision and answer rounds on the original executor', async () => {
    const chat = '7191500777';
    const base: ChatIntake = { platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: chat,
      clientId: client, title: 'Original request', rawText: 'Original request',
      designInstructions: 'Simple layout', exactCopy: [] };
    const old = await persistChatIntake(db, base);
    const revision = await persistChatIntake(db, { ...base, sourceEventId: randomUUID(),
      studioOptions: { parentTaskId: old.task.id } });
    expect(revision.task.delivery_executor_pin).toBe('core');
    const answer = await persistChatIntake(db, { ...base, sourceEventId: randomUUID(),
      studioOptions: { parentTaskId: old.task.id, answers: revision.task.id } });
    expect(answer.task.delivery_executor_pin).toBe('core');
    await expect(persistChatIntake(db, { ...base, sourceEventId: randomUUID(),
      studioOptions: { parentTaskId: old.task.id } }, { outboxState: 'recorded' }))
      .rejects.toThrow('legacy request cannot be claimed');
    await expect(persistChatIntake(db, { ...base, sourceEventId: randomUUID(), sourceChannelId: '7191500666',
      studioOptions: { parentTaskId: old.task.id } }))
      .rejects.toThrow('outside this request scope');
  });

  it('keeps a lifecycle-owned request pinned through revision and reference tasks', async () => {
    const chat = '7191500555';
    const base: ChatIntake = { platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: chat,
      clientId: client, title: 'Enrolled request', rawText: 'Enrolled request',
      designInstructions: 'Simple layout', exactCopy: [] };
    const original = await persistChatIntake(db, base, { outboxState: 'recorded' });
    const revision = await persistChatIntake(db, { ...base, sourceEventId: randomUUID(),
      studioOptions: { parentTaskId: original.task.id } });
    expect(revision.task.delivery_executor_pin).toBe('restate');
    const reference = await persistChatIntake(db, { ...base, sourceEventId: randomUUID(),
      studioOptions: { referenceFor: revision.task.id } });
    expect(reference.task.delivery_executor_pin).toBe('restate');
  });
});
