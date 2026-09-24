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
});
