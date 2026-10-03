/**
 * The Desk's "New task" as a RequestLifecycle request (ADR-287).
 *
 * Until ADR-287 the form saved a designer-owned task (`canva_manual`, outbox `MANUAL_DESK_OWNED`): no
 * draft was made unless someone pressed Generate, and 52 such requests sat in RECEIVED until they were
 * cancelled on 2026-10-02. A Desk request now takes the path every Telegram brief takes: drafts, office
 * review, approval and delivery, owned by the request's RequestLifecycle object.
 *
 * One transaction, in the office member's own scope first:
 *  1. the client (and project) is checked writable for them and its active brand DNA pinned, exactly as
 *     the manual intake did (manual-intake-scope.ts);
 *  2. the request's first projection is made by Core itself (projectLifecycleOpen with the Desk
 *     evidence): the task, its recorded `task.created`, the `requests` row and the replay receipt;
 *  3. the outbox command `office.request.open` carries the open event to the worker, which signs it to
 *     OfficeDecisionGateway; RequestLifecycle's own projection call then replays step 2's receipt
 *     (same key, same normalised brief) and starts the design run.
 * The Desk's Idempotency-Key names the command (`office-open:<key>`): a repeat with the same body
 * answers the same task, a different body under that key is refused.
 */
import { createHash, randomUUID } from 'node:crypto';
import { IdempotencyConflictError, sql, withRlsContext, type BlobStore, type Database, type Kysely } from '@hawa/db';
import { KAAE_CLIENT_ID } from '@hawa/integrations';
import { defaultCanvasFor } from '@hawa/creative';
import { DEFAULT_TENANT_ID } from '../core-context.js';
import { autoDraftAllowedFor, clientPackOf } from './client-packs.js';
import { chatAutoDraftsEnabled } from './chat-intake.js';
import { openDraft } from './lifecycle-open-draft.js';
import { projectLifecycleOpen } from './lifecycle-projection.js';
import { prepareManualIntake } from './manual-intake-scope.js';
import { deskChannelFor } from './office-desk-channel.js';

/** The workflow value the Desk's "New task" form sends. `canva_manual` stays the designer-owned path (PDF requests). */
export const OFFICE_REQUEST_WORKFLOW = 'office_request';

export class DeskRequestRefused extends Error {
  constructor(readonly status: 403 | 422, message: string) { super(message); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEXT_LIMITS = { title: 200, headlineEn: 2000, headlineCkb: 2000, copyEn: 20000, copyCkb: 20000,
  designInstructions: 4000, referenceAssets: 4000, description: 40000 } as const;

/** What the Desk saved, field by field: the request's evidence, kept on the task as `body`. */
export interface DeskRequestBody {
  workflow: typeof OFFICE_REQUEST_WORKFLOW;
  clientId: string;
  projectId?: string;
  title: string;
  headlineEn?: string;
  headlineCkb?: string;
  copyEn: string;
  copyCkb: string;
  designInstructions: string;
  referenceAssets: string;
  description: string;
  priority: string;
  source: { platform: 'hawa_desk'; externalId: string };
}

/** The submitted body, checked and reduced to the fields a Desk request has. */
export function deskRequestBody(raw: Record<string, unknown>): DeskRequestBody {
  const text = (key: keyof typeof TEXT_LIMITS, required = false): string | undefined => {
    const value = raw[key];
    if (value === undefined || value === null) {
      if (required) throw new DeskRequestRefused(422, `The request needs its ${key}`);
      return undefined;
    }
    if (typeof value !== 'string' || value.length > TEXT_LIMITS[key]) throw new DeskRequestRefused(422, `The request's ${key} is not text of at most ${TEXT_LIMITS[key]} characters`);
    return value;
  };
  if (typeof raw.clientId !== 'string' || !UUID.test(raw.clientId)) throw new DeskRequestRefused(422, 'Choose a registered client before saving this request');
  if (raw.projectId !== undefined && raw.projectId !== null && raw.projectId !== '' && (typeof raw.projectId !== 'string' || !UUID.test(raw.projectId)))
    throw new DeskRequestRefused(422, 'Choose a registered project in the selected client');
  const title = (text('title', true) as string).trim();
  if (!title) throw new DeskRequestRefused(422, 'The request needs a title');
  const body: DeskRequestBody = {
    workflow: OFFICE_REQUEST_WORKFLOW,
    clientId: raw.clientId.toLowerCase(),
    ...(typeof raw.projectId === 'string' && raw.projectId ? { projectId: raw.projectId.toLowerCase() } : {}),
    title,
    ...(text('headlineEn') !== undefined ? { headlineEn: text('headlineEn') } : {}),
    ...(text('headlineCkb') !== undefined ? { headlineCkb: text('headlineCkb') } : {}),
    copyEn: text('copyEn') ?? '',
    copyCkb: text('copyCkb') ?? '',
    designInstructions: text('designInstructions') ?? '',
    referenceAssets: text('referenceAssets') ?? '',
    description: text('description') ?? '',
    priority: typeof raw.priority === 'string' && raw.priority.length <= 20 ? raw.priority : 'routine',
    source: { platform: 'hawa_desk', externalId: typeof (raw.source as { externalId?: unknown } | undefined)?.externalId === 'string'
      ? String((raw.source as { externalId: string }).externalId).slice(0, 120) : 'operator-desk' },
  };
  const copy = deskCopyFields(body);
  if (!copy.length) throw new DeskRequestRefused(422, 'Type the exact words for the design (English or Kurdish) before saving');
  return body;
}

/** The copy, in the order the Studio reads a Desk request's fields (saved-design-copy.ts). */
function deskCopyFields(body: DeskRequestBody): Array<{ text: string; language: 'en' | 'ckb' }> {
  return ([['headlineEn', 'en'], ['copyEn', 'en'], ['headlineCkb', 'ckb'], ['copyCkb', 'ckb']] as const)
    .map(([key, language]) => ({ text: body[key], language }))
    .filter((field): field is { text: string; language: 'en' | 'ckb' } => typeof field.text === 'string' && Boolean(field.text.trim()));
}

/** The client's default canvas, as a Telegram brief for that client gets it (chat-campaign-intake.ts). */
function deskCanvas(clientId: string): { width: number; height: number } {
  const isKaae = clientId === KAAE_CLIENT_ID;
  const pack = isKaae ? undefined : clientPackOf(clientId);
  const canvas = pack ? defaultCanvasFor(pack) : undefined;
  return { width: canvas?.width ?? 1080, height: canvas?.height ?? (isKaae ? 1350 : 1080) };
}

/** The round-zero brief RequestLifecycle opens for a Desk request; `openDraft` must return it unchanged. */
export function deskRequestDraft(body: DeskRequestBody, requestId: string, userId: string) {
  const copy = deskCopyFields(body);
  const channel = deskChannelFor(userId);
  return {
    platform: 'hawa_desk' as const,
    sourceEventId: `lc-${requestId}-r0`,
    sourceChannelId: channel,
    rawText: copy.map((field) => field.text).join('\n\n'),
    title: body.title,
    designInstructions: [body.designInstructions.trim(), body.referenceAssets.trim() ? `Reference assets: ${body.referenceAssets.trim()}` : '']
      .filter(Boolean).join('\n\n'),
    exactCopy: copy.map((field, index) => ({ id: `copy_${index}`, role: index === 0 ? 'headline' : 'body', text: field.text,
      language: field.language, direction: field.language === 'ckb' ? 'rtl' : 'ltr', approved: true, protectedTokens: [] })),
    clientId: body.clientId,
    // The office's switch for automatic drafts and the client's own (onboarding) policy, as for a Telegram
    // brief; without them the request opens for a designer and the office is told (lifecycle-projection.ts).
    autoGenerate: chatAutoDraftsEnabled() && autoDraftAllowedFor(body.clientId),
    variant: deskCanvas(body.clientId),
    designStudio: true,
    ...(body.headlineEn !== undefined ? { headlineEn: body.headlineEn } : {}),
    ...(body.headlineCkb !== undefined ? { headlineCkb: body.headlineCkb } : {}),
    copyEn: body.copyEn,
    copyCkb: body.copyCkb,
  };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

export interface DeskRequestResult {
  created: boolean;
  requestId: string;
  task: Record<string, any>;
  clientDnaVersion: number;
}

/**
 * Admit a Desk request and open it on RequestLifecycle (see the file comment). `actor` is the signed-in
 * office member; the transaction starts in their scope, so a client they cannot write is refused before
 * anything is recorded.
 */
export async function openDeskRequest(db: Kysely<Database>, sourceStore: BlobStore | null,
  actor: { tenantId: string; userId: string; role: string }, idempotencyKey: string, raw: Record<string, unknown>): Promise<DeskRequestResult> {
  if (actor.tenantId !== DEFAULT_TENANT_ID) throw new DeskRequestRefused(403, 'Desk requests are opened for the office tenant only');
  if (!UUID.test(actor.userId)) throw new DeskRequestRefused(403, 'A Desk request is made by a signed-in office member');
  if (!idempotencyKey || idempotencyKey.length > 256) throw new DeskRequestRefused(422, 'A Desk request needs a stable request key');
  const body = deskRequestBody(raw);
  const bodyHash = createHash('sha256').update(canonical(body)).digest('hex');
  const commandKey = `office-open:${idempotencyKey}`;
  return withRlsContext(db, { tenantId: actor.tenantId, userId: actor.userId, role: actor.role }, async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`desk-request:${actor.tenantId}:${idempotencyKey}`}, 0))`.execute(trx);
    const prior = await trx.selectFrom('outbox_commands').select(['payload', 'aggregate_id'])
      .where('tenant_id', '=', actor.tenantId).where('idempotency_key', '=', commandKey).executeTakeFirst();
    if (prior) {
      const payload = prior.payload as { bodyHash?: string; requestId?: string; taskId?: string; clientDnaVersion?: number; userId?: string };
      if (payload.bodyHash !== bodyHash || payload.userId !== actor.userId.toLowerCase())
        throw new IdempotencyConflictError(`Idempotency conflict: key '${idempotencyKey}' already used with a different Desk request`);
      const task = await trx.selectFrom('tasks').selectAll().where('tenant_id', '=', actor.tenantId)
        .where('id', '=', String(payload.taskId)).executeTakeFirstOrThrow();
      return { created: false, requestId: String(payload.requestId), task, clientDnaVersion: Number(payload.clientDnaVersion) };
    }
    const scope = await prepareManualIntake(trx, { tenantId: actor.tenantId, clientId: body.clientId, projectId: body.projectId ?? null });
    const dnaVersion = Number(scope.clientDnaVersion);
    const requestId = randomUUID();
    const built = deskRequestDraft(body, requestId, actor.userId);
    const draft = openDraft(built, requestId);
    if (!draft || canonical(draft) !== canonical(built)) throw new DeskRequestRefused(422, 'The request could not be read as a design brief');
    const opened = await projectLifecycleOpen(trx, { requestId, tenantId: actor.tenantId, expectedRev: 0, rev: 1,
      key: `${requestId}:1:open`, draft }, sourceStore, { userId: actor.userId.toLowerCase(), dnaVersion, body: body as unknown as Record<string, unknown> });
    await trx.insertInto('outbox_commands').values({
      tenant_id: actor.tenantId, aggregate_type: 'request', aggregate_id: requestId, command_type: 'office.request.open',
      idempotency_key: commandKey,
      payload: { v: 1, requestId, taskId: opened.taskId, bodyHash, clientDnaVersion: dnaVersion, userId: actor.userId.toLowerCase(),
        event: { v: 1, eventId: `open:${requestId}`, requestId, tenantId: actor.tenantId, chatId: draft.sourceChannelId, draft } },
    }).execute();
    const task = await trx.selectFrom('tasks').selectAll().where('tenant_id', '=', actor.tenantId)
      .where('id', '=', opened.taskId).executeTakeFirstOrThrow();
    return { created: true, requestId, task, clientDnaVersion: dnaVersion };
  });
}
