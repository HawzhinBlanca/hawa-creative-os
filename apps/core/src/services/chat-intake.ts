import { createHash } from 'node:crypto';
import { type Kysely, type Database, TaskRepository, withRlsContext, sql } from '@hawa/db';
import { CHANNEL_INGRESS_USER_ID } from '@hawa/contracts';

export interface ChatIntake {
  tenantId?: string;
  userId?: string;
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
  /** True if message contains only styling directives without factual copy */
  isInstructionOnly?: boolean;
  /** Requested artboard size; the durable worker drafts exactly this format. */
  variant?: { width: number; height: number };
  /** Studio v2 execution flag; defaults to process.env.DESIGN_STUDIO_V2 === 'on' */
  designStudio?: boolean;
  /** Optional studio generation parameters */
  studioOptions?: {
    tier?: 'fast' | 'quality';
    imagery?: 'none' | 'abstract' | 'photographic';
    previews?: number;
    holdForSelection?: boolean;
    parentTaskId?: string;
    revisionRound?: number;
    referenceImageBase64?: string;
    /** This task only carries a reference image for the named request; it has no design of its own. */
    referenceFor?: string;
  };
}

function canonicalStringify(obj: any): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
}

/**
 * Whether a chat is on the v3 pilot list, from DESIGN_PIPELINE_V3_CHATS.
 *
 * Extracted from the intake path so the owner's one-line environment change can be verified
 * without a database: the value is a comma-separated list of source channel ids, tolerant of
 * surrounding whitespace, and an unset or empty value enrols nobody.
 */
export function isV3PilotChat(
  sourceChannelId: string | undefined | null,
  raw: string | undefined = process.env.DESIGN_PIPELINE_V3_CHATS
): boolean {
  if (!raw || !sourceChannelId) return false;
  return raw
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .includes(sourceChannelId.trim());
}

/**
 * Whether work from this chat runs the v3 pipeline: every chat when DESIGN_PIPELINE_V3 is on,
 * otherwise only chats on the pilot list.
 *
 * Enrolling a chat used to route it into the studio and stop there — the studio's v3 branches read
 * the global flag, so a pilot chat silently ran v2, and the only way to get v3 at all was to switch
 * it on for every chat at once. The studio now records this decision on the run when it is created.
 */
export function runsPipelineV3(
  sourceChannelId: string | undefined | null,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.DESIGN_PIPELINE_V3 === 'on' || isV3PilotChat(sourceChannelId, env.DESIGN_PIPELINE_V3_CHATS);
}

/**
 * The request in this chat that a caption-less photo should join: the latest one saved within
 * `withinMinutes` (HAWA_REFERENCE_MERGE_MINUTES, default 5) that goes to the v3 studio, has no image
 * of its own, and whose design has not reached layout generation. Null when there is none, and the
 * photo is handled as before.
 */
export async function findRequestAwaitingReference(
  db: Kysely<Database>,
  opts: { sourceChannelId: string; tenantId?: string; withinMinutes?: number; env?: NodeJS.ProcessEnv }
): Promise<{ taskId: string; clientId: string; title: string } | null> {
  const env = opts.env || process.env;
  if (!runsPipelineV3(opts.sourceChannelId, env)) return null;
  const tenantId = opts.tenantId || '00000000-0000-4000-a000-000000000001';
  const minutes = opts.withinMinutes ?? Math.max(0, Number(env.HAWA_REFERENCE_MERGE_MINUTES || 5));
  if (!(minutes > 0)) return null;
  return withRlsContext(db, { tenantId, userId: CHANNEL_INGRESS_USER_ID, role: 'operator' }, async (trx) => {
    const row = (
      await sql<any>`SELECT t.id, t.client_id, t.title, o.payload
        FROM hawa.outbox_commands o JOIN hawa.tasks t ON t.id = o.aggregate_id AND t.tenant_id = o.tenant_id
        WHERE o.tenant_id = ${tenantId}::uuid AND o.command_type = 'task.created'
          AND o.payload->>'sourceChannelId' = ${opts.sourceChannelId}
          AND o.created_at > now() - make_interval(mins => ${minutes})
          AND COALESCE(o.payload->>'isInstructionOnly', 'false') <> 'true'
          AND t.client_id IS NOT NULL
        ORDER BY o.created_at DESC LIMIT 1`.execute(trx)
    ).rows[0];
    if (!row || row.payload?.designStudio !== true || row.payload?.studioOptions?.referenceImageBase64) return null;
    const run = (
      await sql<{ status: string }>`SELECT status FROM hawa.design_studio_runs
        WHERE tenant_id = ${tenantId}::uuid AND task_id = ${row.id}::uuid
        ORDER BY created_at DESC LIMIT 1`.execute(trx)
    ).rows[0];
    if (run && !['briefing', 'conceiving'].includes(run.status)) return null;
    return { taskId: String(row.id), clientId: String(row.client_id), title: String(row.title || 'your request') };
  });
}

/** Commit the verified original event and its task before broadcasting or acknowledging. */
export async function persistChatIntake(db: Kysely<Database>, input: ChatIntake) {
  const tenantId = input.tenantId || '00000000-0000-4000-a000-000000000001';
  // Channel messages are written by the Channel Ingress service identity, never by a person (ADR-027).
  const userId = input.userId || CHANNEL_INGRESS_USER_ID;
  const idempotencyKey = `chat:${input.platform}:${input.sourceChannelId}:${input.sourceEventId}`;
  if (!input.sourceEventId || !input.sourceChannelId || !input.rawText.trim()) throw new Error('A stable source event, channel and original text are required');
  return withRlsContext(db, { tenantId, userId, role: 'operator' }, async trx => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${idempotencyKey}, 0))`.execute(trx);
    // Automatic drafting spends a paid model call and a Canva import per request. Independently of
    // the sender allowlist, a sender and the office as a whole get a bounded number per day; beyond
    // it the request is still saved, but for the art director, and the sender is told why.
    let autoGenerate = Boolean(input.autoGenerate);
    let autoGenerateDeclined: 'SENDER_DAILY_CAP' | 'GLOBAL_DAILY_CAP' | undefined;
    if (autoGenerate) {
      const allowedUsers = (process.env.TELEGRAM_ALLOWED_USERS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      const isDirector = input.platform === 'telegram' && allowedUsers.includes(input.sourceChannelId);

      if (!isDirector) {
        const perSender = Math.max(0, Number(process.env.AUTO_GENERATE_DAILY_CAP_PER_SENDER || 5));
        const global = Math.max(0, Number(process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL || 200));
        const counts = (await sql<{ sender: string; total: string }>`
          SELECT count(*) FILTER (WHERE payload->>'sourcePlatform' = ${input.platform} AND payload->>'sourceChannelId' = ${input.sourceChannelId}) AS sender,
                 count(*) AS total
          FROM hawa.outbox_commands
          WHERE tenant_id = ${tenantId}::uuid AND command_type = 'task.created'
            AND created_at > now() - interval '1 day' AND payload->>'autoGenerate' = 'true'`.execute(trx)).rows[0];
        if (Number(counts?.sender || 0) >= perSender) autoGenerateDeclined = 'SENDER_DAILY_CAP';
        else if (Number(counts?.total || 0) >= global) autoGenerateDeclined = 'GLOBAL_DAILY_CAP';
        if (autoGenerateDeclined) autoGenerate = false;
      }
    }
    const isTestChatEnabled = isV3PilotChat(input.sourceChannelId);
    const designStudio = typeof input.designStudio === 'boolean'
      ? input.designStudio
      : (process.env.DESIGN_PIPELINE_V3 === 'on' || process.env.DESIGN_STUDIO_V2 === 'on' || isTestChatEnabled);
    const payload = {
      sourcePlatform: input.platform, sourceEventId: input.sourceEventId, sourceChannelId: input.sourceChannelId,
      rawRequestText: input.rawText, headlineEn: input.headlineEn || null, headlineCkb: input.headlineCkb || null,
      copyEn: input.copyEn || null, copyCkb: input.copyCkb || null,
      designInstructions: input.designInstructions, exactCopy: input.exactCopy,
      clientId: input.clientId, workflow: 'canva',
      designStudio,
      ...(input.isInstructionOnly ? { isInstructionOnly: true } : {}),
      ...(input.studioOptions ? { studioOptions: input.studioOptions } : {}),
      ...(autoGenerate?{autoGenerate:true}:{}),
      ...(autoGenerateDeclined?{autoGenerateDeclined}:{}),
      ...(input.variant && Number.isInteger(input.variant.width) && Number.isInteger(input.variant.height)
        ? { variant: { width: input.variant.width, height: input.variant.height } } : {}),
    };

    // The request fingerprint excludes generated IDs/timestamps. Replays compare the actual request.
    const hash = createHash('sha256').update(canonicalStringify(input.rawJson ?? { text: input.rawText })).digest('hex');
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
      // Script-level language record for this Kurdish office: Arabic-script requests are Sorani unless the art director corrects it.
      language: /[\u0600-\u06FF\u0750-\u077F]/.test(input.rawText) ? 'ckb' : 'en',
      clientId: input.clientId, actorType: 'adapter', actorId: input.platform, payload, enqueueOutbox: true,
    }, trx);
    return { ...result, tenantId, autoGenerateDeclined };
  });
}
