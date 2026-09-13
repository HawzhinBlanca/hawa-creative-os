import { createHash } from 'node:crypto';
import { type Kysely, type Database, TaskRepository, withRlsContext, sql } from '@hawa/db';

export interface ChatIntake {
  platform: 'telegram' | 'whatsapp';
  sourceEventId: string;
  sourceChannelId: string;
  rawText: string;
  rawJson?: unknown;
  clientId: string | null;
  title: string;
  headlineEn?: string;
  headlineCkb?: string;
  copyEn?: string;
  copyCkb?: string;
  designInstructions: string;
  exactCopy: unknown[];
  autoGenerate?: boolean;
}

/** Commit the verified original event and its task before broadcasting or acknowledging. */
export async function persistChatIntake(db: Kysely<Database>, input: ChatIntake) {
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const userId = '00000000-0000-4000-b000-000000000001';
  const idempotencyKey = `chat:${input.platform}:${input.sourceChannelId}:${input.sourceEventId}`;
  if (!input.sourceEventId || !input.sourceChannelId || !input.rawText.trim()) throw new Error('A stable source event, channel and original text are required');
  return withRlsContext(db, { tenantId, userId, role: 'operator' }, async trx => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${idempotencyKey}, 0))`.execute(trx);
    const payload = {
      sourcePlatform: input.platform, sourceEventId: input.sourceEventId, sourceChannelId: input.sourceChannelId,
      rawRequestText: input.rawText, headlineEn: input.headlineEn || null, headlineCkb: input.headlineCkb || null,
      copyEn: input.copyEn || null, copyCkb: input.copyCkb || null,
      designInstructions: input.designInstructions, exactCopy: input.exactCopy,
      clientId: input.clientId, workflow: 'canva',
      ...(input.autoGenerate?{autoGenerate:true}:{}),
    };
    // The request fingerprint excludes generated IDs/timestamps. Replays compare the actual request.
    const hash = createHash('sha256').update(JSON.stringify(input.rawJson ?? { text: input.rawText })).digest('hex');
    const sourceId = `${input.sourceChannelId}:${input.sourceEventId}`;
    const existing = await trx.selectFrom('inbox_events').select(['id', 'payload_hash'])
      .where('tenant_id', '=', tenantId).where('source_account_id', '=', input.platform)
      .where('source_event_id', '=', sourceId).executeTakeFirst();
    if (existing && existing.payload_hash !== hash) throw new Error('Source event already exists with different content');
    if (!existing) await trx.insertInto('inbox_events').values({
      tenant_id: tenantId, source_account_id: input.platform, source_event_id: sourceId,
      event_kind: `${input.platform}_update`, payload: input.rawJson ?? { text: input.rawText }, payload_hash: hash, verified: true,
    } as any).execute();
    const result = await new TaskRepository(db).createTaskAggregate({
      tenantId, userId, idempotencyKey, title: input.title, description: input.rawText,
      clientId: input.clientId, actorType: 'adapter', actorId: input.platform, payload, enqueueOutbox: true,
    }, trx);
    return { ...result, tenantId };
  });
}
