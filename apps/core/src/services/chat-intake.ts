import { createHash } from 'node:crypto';
import { log } from '../logging.js';
import type { StudioImagery, StudioTier } from '@hawa/domain';
import { type Kysely, type Database, TaskRepository, withRlsContext, sql } from '@hawa/db';
import { CHANNEL_INGRESS_USER_ID, isReservedCanaryChatId, type BlobRef, type LifecycleAlbumRef, type LifecycleSourceRef, type ReviewedSourceEvidence } from '@hawa/contracts';

export interface ChatIntake {
  tenantId?: string;
  userId?: string;
  platform: 'telegram' | 'whatsapp' | 'hawzhin_web';
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
  /** Core-retained image for a lifecycle open; only its verified blob reference enters Restate. */
  lifecycleImage?: BlobRef & { updateId: number };
  lifecycleAlbum?: LifecycleAlbumRef;
  customerWebPhotos?: import('@hawa/contracts').CustomerPhotoManifest;
  lifecycleSource?: LifecycleSourceRef;
  /** Server-authored only after verification of the immutable source confirmation. */
  reviewedSource?: ReviewedSourceEvidence;
  /**
   * ADR-232: how the copy was taken from a request written as a sentence, and why (the office reads it
   * on the task's creation event). Server-authored at intake; absent when the copy was used as given.
   */
  copyExtraction?: import('./request-copy-extraction.js').CopyExtractionReceipt;
  /** Optional studio generation parameters */
  studioOptions?: {
    /** The Studio's names, or the older intake names the Studio maps (parseStudioTier, ADR-159). */
    tier?: StudioTier | 'fast' | 'quality';
    imagery?: StudioImagery | 'abstract' | 'photographic';
    previews?: number;
    holdForSelection?: boolean;
    parentTaskId?: string;
    revisionRound?: number;
    referenceImageBase64?: string;
    /** This task only carries a reference image for the named request; it has no design of its own. */
    referenceFor?: string;
    /** Telegram's media_group_id: the album the request's photo came in, so the album's other photos join it. */
    mediaGroupId?: string;
    /** For a revision: the change asked for, which the studio makes to the parent's design. */
    revisionDirective?: string;
    /**
     * ADR-233: a new design of the same request (a redo, or changes sent while the first draft was made),
     * never an edit of the parent's design. Exclusive with `parentTaskId`; the words are art direction.
     */
    freshFrom?: { parentTaskId: string; kind: 'redo' | 'pending_changes'; directive: string };
    /** The directive carries the requester's answer to a question about it: none is asked again. */
    clarified?: boolean;
    /** The same design as the parent's, in another size (the variant): a format, not a change. */
    reformat?: string;
    /** The task whose question this revision answers: its photos join this one, and it counts as answered. */
    answers?: string;
    /** On an album part (referenceFor): the caption this photo of the album carried, which is the change asked for. */
    albumCaption?: string;
  };
}

/** What a photo sent with no words is read as. A change that is only this has no words of its own. */
export const PICTURE_ONLY_DIRECTIVE = 'Apply the attached visual reference image as a design style, layout, and composition guide.';

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
 * A request that carries the same copy in English and in Kurdish, one graphic per language: the
 * English copy under a line such as "Here is the text to add on each of the Kurdish and English
 * graphics:" above the divider, the Kurdish copy below it. On 2026-09-19 (task 89c242f2) the
 * English copy was taken for instructions, and one Kurdish design was made; the owner wants one
 * graphic per language. Returns each graphic's request text in the shape intake already reads
 * (instructions, a divider, that graphic's copy), or null for any other request.
 */
export function splitBilingualRequest(rawText: string): { en: string; ckb: string } | null {
  const text = String(rawText || '').replace(/\r\n/g, '\n');
  const divider = text.match(/\n\s*([_\-=*]{3,})\s*\n/);
  if (!divider || divider.index === undefined) return null;
  const above = text.slice(0, divider.index);
  const below = text.slice(divider.index + divider[0].length).trim();
  const arabic = /[\u0600-\u06FF\u0750-\u077F]/;
  const marker = above.match(/^[^\n]*\b(?:text|copy|content|wording)\b[^\n]*:\s*$/im);
  if (!marker || marker.index === undefined) return null;
  const english = above.slice(marker.index + marker[0].length).trim();
  const instructions = above.slice(0, marker.index).trim();
  if (!english || arabic.test(english) || !/[A-Za-z]/.test(english)) return null;
  // The Kurdish side is Kurdish copy (Latin tokens such as "K-12" or "kaae.org" inside it are fine).
  const kurdishParagraphs = below.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (!kurdishParagraphs.length || !kurdishParagraphs.every((p) => arabic.test(p))) return null;
  const note = (lang: string, other: string) =>
    `This graphic carries the ${lang} copy only; a separate graphic carries the ${other} copy.`;
  return {
    en: `${instructions}\n${note('English', 'Kurdish')}\n_____\n${english}`,
    ckb: `${instructions}\n${note('Kurdish', 'English')}\n_____\n${below}`,
  };
}

/**
 * AUTO_GENERATE_CHAT_DESIGNS=true lets a chat request (Telegram or WhatsApp) be drafted automatically:
 * a paid model call and a Canva import each. Anything else saves it for the art director, as
 * .env.production.example documents. Until ADR-159 only WhatsApp read it and every Telegram brief
 * was drafted whatever it said; production sets it to true (see the ADR), so nothing changes there.
 */
export function chatAutoDraftsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.AUTO_GENERATE_CHAT_DESIGNS === 'true';
}

/**
 * A daily ceiling on automatic drafts: a whole number, or the default when unset. Anything else
 * (a typo like "20 " is fine, "twenty" or "5 a day" is not) fails closed as 0, so no automatic
 * draft is made until it is corrected. It used to become NaN, and every comparison with NaN is
 * false: a mistyped cap switched the cap off (audit 2026-09-30, ADR-159).
 */
export function dailyDraftCap(name: string, fallback: number, env: Record<string, string | undefined> = process.env): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) return Number(raw);
  log.error(`[chat-intake] ${name} is not a whole number; no automatic drafts until it is corrected.`);
  return 0;
}

/**
 * ADR-240: how many automatic designs the nightly canary's chat may start in any six and a half days
 * (HAWA_CANARY_AUTOMATIC_DESIGNS_PER_WEEK). 0, the default, makes every canary request a designer's:
 * the real path, with no paid call and no Canva write. 1 lets the first canary brief of every seventh
 * night be designed for real; each later brief, change round or retry of that request is a designer's.
 * Anything but a whole number from 0 to 7 is 0. The window is shorter than a week so a canary run at
 * the same hour each night is admitted every seventh night, whatever the minutes between runs.
 */
export function canaryAutomaticDesignsPerWeek(env: Record<string, string | undefined> = process.env): number {
  const raw = env.HAWA_CANARY_AUTOMATIC_DESIGNS_PER_WEEK?.trim();
  if (raw === undefined || raw === '') return 0;
  if (/^[0-7]$/.test(raw)) return Number(raw);
  log.error('[chat-intake] HAWA_CANARY_AUTOMATIC_DESIGNS_PER_WEEK is not a whole number from 0 to 7; the canary gets no automatic design.');
  return 0;
}

/** Commit the verified original event and its task before broadcasting or acknowledging. */
export async function persistChatIntake(
  db: Kysely<Database>,
  input: ChatIntake,
  options: { outboxState?: 'pending' | 'recorded';detailsRequired?:true;
    customer?: {accountId:string;userId:string;dnaVersion:number;body:import('../customer/customer-requests.js').CustomerDesignRequest} } = {},
) {
  const tenantId = input.tenantId || '00000000-0000-4000-a000-000000000001';
  // Channel messages are written by the Channel Ingress service identity, never by a person (ADR-027).
  const userId = input.userId || CHANNEL_INGRESS_USER_ID;
  if ((input.platform==='hawzhin_web') !== Boolean(options.customer)) throw new Error('A web task requires its Core-verified ownership receipt');
  const idempotencyKey = `chat:${input.platform}:${input.sourceChannelId}:${input.sourceEventId}`;
  if (!input.sourceEventId || !input.sourceChannelId || !input.rawText.trim()) throw new Error('A stable source event, channel and original text are required');
  return withRlsContext(db, { tenantId, userId, role: 'operator' }, async trx => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${idempotencyKey}, 0))`.execute(trx);
    // Automatic drafting spends a paid model call and a Canva import per request. Independently of
    // the sender allowlist, a sender and the office as a whole get a bounded number per day; beyond
    // it the request is still saved, but for the art director, and the sender is told why.
    let autoGenerate = Boolean(input.autoGenerate) && !options.detailsRequired;
    let autoGenerateDeclined: 'SENDER_DAILY_CAP' | 'GLOBAL_DAILY_CAP' | 'DELIVERABLE_DETAILS_REQUIRED' | undefined =
      options.detailsRequired ? 'DELIVERABLE_DETAILS_REQUIRED' : undefined;
    const priorAdmission=await trx.selectFrom('outbox_commands').select('payload').where('tenant_id','=',tenantId)
      .where('idempotency_key','=',idempotencyKey).where('command_type','=','task.created').executeTakeFirst();
    if (priorAdmission) {
      // Admission is immutable evidence, not recomputed policy. A replay after the allowance was
      // used must retain its actual automatic/manual outcome and must not report a new decline.
      autoGenerate=priorAdmission.payload.autoGenerate===true;
      const reason=priorAdmission.payload.autoGenerateDeclined;
      autoGenerateDeclined=reason==='SENDER_DAILY_CAP'||reason==='GLOBAL_DAILY_CAP'||reason==='DELIVERABLE_DETAILS_REQUIRED' ? reason : undefined;
    }
    // ADR-240: the nightly canary's chat (an id no Telegram chat can have) has its own allowance, counted
    // before anything else: every automatic design of its requests, the first, a change round or a
    // retry, is admitted here, so the canary never starts more paid rounds than it is allowed.
    const canary = input.platform === 'telegram' && isReservedCanaryChatId(input.sourceChannelId);
    if (autoGenerate && !priorAdmission && canary) {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`auto-draft-admission:${tenantId}`}, 0))`.execute(trx);
      const used = Number((await sql<{ n: string }>`SELECT count(*) AS n FROM hawa.outbox_commands
        WHERE tenant_id = ${tenantId}::uuid AND command_type = 'task.created'
          AND payload->>'sourcePlatform' = 'telegram' AND payload->>'sourceChannelId' = ${input.sourceChannelId}
          AND created_at > now() - interval '6 days 12 hours' AND payload->>'autoGenerate' = 'true'`.execute(trx)).rows[0]?.n || 0);
      if (used >= canaryAutomaticDesignsPerWeek()) { autoGenerateDeclined = 'SENDER_DAILY_CAP'; autoGenerate = false; }
    } else if (autoGenerate && !priorAdmission && input.platform!=='hawzhin_web') {
      const allowedUsers = (process.env.TELEGRAM_ALLOWED_USERS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      const isDirector = input.platform === 'telegram' && allowedUsers.includes(input.sourceChannelId);

      if (!isDirector) {
        // Several lifecycles may project concurrently. The office-wide allowance is admitted once
        // under the same transaction as the counted outbox row; per-event locks cannot protect it.
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`auto-draft-admission:${tenantId}`}, 0))`.execute(trx);
        const perSender = dailyDraftCap('AUTO_GENERATE_DAILY_CAP_PER_SENDER', 5);
        const global = dailyDraftCap('AUTO_GENERATE_DAILY_CAP_GLOBAL', 200);
        const counts = (await sql<{ sender: string; total: string }>`
          SELECT count(*) FILTER (WHERE payload->>'sourcePlatform' = ${input.platform} AND payload->>'sourceChannelId' = ${input.sourceChannelId}) AS sender,
                 count(*) FILTER(WHERE COALESCE(payload->>'sourcePlatform','')<>'hawzhin_web') +
                   (SELECT count(*) FROM hawa.customer_web_requests w WHERE w.tenant_id=${tenantId}::uuid
                     AND w.created_at>now()-interval '1 day') AS total
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
      ...(options.customer ? {body:options.customer.body,clientDnaVersion:options.customer.dnaVersion,
        reviewedSource:{confirmation:'request_copy_reviewed',origin:'customer_exact_copy',localesConfirmedByRequester:true}} : {}),
      sourcePlatform: input.platform, sourceEventId: input.sourceEventId, sourceChannelId: input.sourceChannelId,
      ...(options.outboxState === 'recorded' ? { lifecycleOwner: 'restate' } : {}),
      rawRequestText: input.rawText, headlineEn: input.headlineEn || null, headlineCkb: input.headlineCkb || null,
      copyEn: input.copyEn || null, copyCkb: input.copyCkb || null,
      designInstructions: input.designInstructions, exactCopy: input.exactCopy,
      ...(input.customerWebPhotos ? {customerWebPhotos:input.customerWebPhotos} : {}),
      ...(input.lifecycleAlbum ? { lifecycleAlbum: input.lifecycleAlbum } : {}),
      ...(input.reviewedSource ? { reviewedSource: input.reviewedSource } : {}),
      ...(input.copyExtraction ? { copyExtraction: input.copyExtraction } : {}),
      clientId: input.clientId, workflow: 'canva',
      // ADR-240: the nightly canary's request, so the Desk and reports can leave it out.
      ...(canary ? { canary: true } : {}),
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
    // A revision, answer, reformat or reference belongs to the original request even when
    // the chat flag changes between rounds. Resolve the predecessor in the same scoped transaction.
    const predecessorIds = [...new Set([
      input.studioOptions?.parentTaskId, input.studioOptions?.answers, input.studioOptions?.referenceFor,
      input.studioOptions?.freshFrom?.parentTaskId,
    ].filter((id): id is string => Boolean(id)))];
    // ADR-135 stage 2: the only production callers are RequestLifecycle's projection (outboxState
    // 'recorded') and WhatsApp intake; no path creates a Telegram task outside the lifecycle any more.
    let predecessorPin: 'core' | 'restate' | undefined;
    for (const predecessorId of predecessorIds) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(predecessorId)) {
        throw new Error('Invalid predecessor task ID');
      }
      const predecessor = (await sql<{ delivery_executor_pin: 'core' | 'restate'; request_id: string | null; state: string }>`
        SELECT t.delivery_executor_pin, t.request_id::text AS request_id, t.state::text AS state FROM hawa.tasks t
        JOIN hawa.outbox_commands o ON o.tenant_id = t.tenant_id AND o.aggregate_id = t.id
          AND o.command_type = 'task.created'
        WHERE t.tenant_id = ${tenantId}::uuid AND t.id = ${predecessorId}::uuid
          AND o.payload->>'sourcePlatform' = ${input.platform}
          AND o.payload->>'sourceChannelId' = ${input.sourceChannelId}
          AND t.client_id IS NOT DISTINCT FROM ${input.clientId || null}::uuid
        LIMIT 1`.execute(trx)).rows[0];
      if (!predecessor) throw new Error('Predecessor task is outside this request scope');
      if (predecessorPin && predecessorPin !== predecessor.delivery_executor_pin) {
        throw new Error('Predecessor tasks belong to different delivery executors');
      }
      predecessorPin = predecessor.delivery_executor_pin;
    }
    if (options.outboxState === 'recorded' && predecessorPin === 'core') {
      throw new Error('A legacy request cannot be claimed by the lifecycle executor');
    }
    const result = await new TaskRepository(db).createTaskAggregate({
      tenantId, userId: options.customer?.userId ?? userId,
      ...(options.customer ? {customerAccountId:options.customer.accountId} : {}), idempotencyKey, title: input.title, description: input.rawText,
      // Script-level language record for this Kurdish office: Arabic-script requests are Sorani unless the art director corrects it.
      language: options.customer?.body.exactCopy[0].language ?? (/[\u0600-\u06FF\u0750-\u077F]/.test(input.rawText) ? 'ckb' : 'en'),
      clientId: input.clientId, actorType: 'adapter', actorId: input.platform, payload, enqueueOutbox: true,
      outboxState: options.outboxState,
      // Only a committed lifecycle open can claim the Restate executor. A live chat flag is
      // admission policy, not task ownership; legacy fallback stays Core-owned.
      deliveryExecutorPin: predecessorPin ?? (options.outboxState === 'recorded' ? 'restate' : 'core'),
    }, trx);
    return { ...result, tenantId, autoGenerateDeclined };
  });
}
