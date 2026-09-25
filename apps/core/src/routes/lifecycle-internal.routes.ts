/**
 * Core's internal API for the request lifecycle on Restate (architecture programme Phase 2, ADR-034,
 * PHASE2_DESIGN.md section 2.8). Slice 2.1 adds the two calls the worker's ChatInbox makes:
 *
 *   POST /v1/internal/telegram/intake  {v, update, mode: 'legacy'}  → {v, kind: 'handled', intakeStatus, …}
 *   POST /v1/internal/telegram/park    {v, update, reason, notifySender?} → {v, parked, alreadyParked}
 *
 * Intake is a thin wrapper around today's Telegram intake (routes/telegram-webhook.routes.ts): the
 * update goes to POST /api/webhooks/telegram in this process, with the webhook secret added here, and
 * the answer comes back as `intakeStatus`. So the worker's poller changes who asks Telegram and in
 * what order chats are served, and nothing about what intake does with an update; the same update
 * twice is one task, as it always was (intake's inbox row `<chat>:<update_id>`).
 *
 * Only the worker calls these, with HAWA_WORKER_TOKEN: a `service` principal that app.ts's
 * verifyRequestAuth accepts on /v1/internal/* and nowhere else, and those routes accept nothing else.
 *
 * Codes the worker waits on instead of counting an attempt (apps/worker/src/lifecycle/core-client.ts):
 * DATABASE_UNAVAILABLE, INTAKE_PAUSED (the office's kill switch) and NOT_CONFIGURED. A dead letter
 * made while the database is down or intake is switched off would help nobody: the update waits.
 */
import type { Context } from 'hono';
import { chaosPoint } from '@hawa/observability';
import { sql, withRlsContext } from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID, type DeliveryOutcome } from '@hawa/contracts';
import { parseCompleteRevisionRequest, parseOfficeApprovalProof } from '@hawa/domain';
import { DEFAULT_TENANT_ID } from '../core-context.js';
import { log, requestIdHeaders } from '../logging.js';
import { intakeRefused } from '../services/channel-kill-switches.js';
import { PARKED_UPDATE_NOTICE, parkTelegramUpdate, parkedUpdateChat } from '../services/polled-update-dispatch.js';
import { LifecycleProjectionConflict, projectLifecycleDesignOutcome, projectLifecycleOfficeDecision, projectLifecycleOpen } from '../services/lifecycle-projection.js';
import { projectLifecycleDeliveryFinish, projectLifecycleDeliveryStart } from '../services/lifecycle-delivery-projection.js';
import type { ChatIntake } from '../services/chat-intake.js';
import type { RouteContext } from './types.js';

/** /v1/internal/*, under any of the prefixes registerRoute mounts routes at. */
export function isInternalPath(path: string): boolean {
  return /^\/(?:api\/)?(?:v1\/)?internal(?:\/|$)/.test(path);
}

/** Keys the worker token must differ from: one of them would turn it into a second use of that key. */
const OTHER_KEYS = ['HAWA_API_KEY', 'HAWA_BEARER_TOKEN', 'HAWA_DESK_SECRET', 'HAWA_ADMIN_KEY', 'HAWA_REVIEWER_KEY', 'HAWA_ART_DIRECTOR_KEY', 'TELEGRAM_WEBHOOK_SECRET'] as const;
const MIN_TOKEN_LENGTH = 16;
let warnedAbout = '';

/**
 * HAWA_WORKER_TOKEN when it can be used: set, at least 16 characters, and equal to no other key Core
 * accepts. A worker token that is also the operator's key would make the operator a service and the
 * worker an operator; it is refused (and said once in the log), so /v1/internal/* stays closed.
 */
export function serviceTokenOf(env: Record<string, string | undefined> = process.env): string | null {
  const token = env.HAWA_WORKER_TOKEN?.trim();
  if (!token) return null;
  let fault = '';
  if (token.length < MIN_TOKEN_LENGTH) fault = `is shorter than ${MIN_TOKEN_LENGTH} characters`;
  const clash = OTHER_KEYS.find((k) => env[k]?.trim() === token);
  if (clash) fault = `is the same as ${clash}`;
  if (!fault) return token;
  if (warnedAbout !== fault) {
    warnedAbout = fault;
    log.error(`[core:internal] HAWA_WORKER_TOKEN ${fault}; /v1/internal/* refuses every caller until it is a key of its own`);
  }
  return null;
}

interface UpdateLike { update_id: number; [kind: string]: unknown }

/** The chat an update came from, for the chaos suite's point (the dead letter's own reading). */
const chatOf = (u: UpdateLike): string => parkedUpdateChat(u) ?? '';

const isUpdate = (u: unknown): u is UpdateLike =>
  Boolean(u) && typeof u === 'object' && Number.isSafeInteger((u as UpdateLike).update_id) && (u as UpdateLike).update_id > 0;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function openDraft(value: unknown, requestId: string): ChatIntake | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const d = value as Record<string, unknown>;
  if (d.platform !== 'telegram' || d.sourceEventId !== `lc-${requestId}-r0` ||
      typeof d.sourceChannelId !== 'string' || !/^-?\d{1,20}$/.test(d.sourceChannelId) ||
      typeof d.rawText !== 'string' || !d.rawText.trim() || d.rawText.length > 100_000 ||
      typeof d.title !== 'string' || !d.title.trim() || d.title.length > 500 ||
      typeof d.designInstructions !== 'string' || d.designInstructions.length > 100_000 ||
      !Array.isArray(d.exactCopy) || d.exactCopy.length > 500 || JSON.stringify(d.exactCopy).length > 100_000 ||
      !(d.clientId === null || (typeof d.clientId === 'string' && UUID.test(d.clientId))) ||
      (d.autoGenerate !== undefined && typeof d.autoGenerate !== 'boolean')) return null;
  const variant = d.variant;
  if (variant !== undefined && (!variant || typeof variant !== 'object' ||
      !Number.isInteger((variant as any).width) || !Number.isInteger((variant as any).height) ||
      (variant as any).width < 640 || (variant as any).width > 2400 ||
      (variant as any).height < 640 || (variant as any).height > 2400)) return null;
  if (d.designStudio !== undefined && typeof d.designStudio !== 'boolean') return null;
  const options = d.studioOptions;
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options) ||
      JSON.stringify(options).length > 2000 ||
      (Object.keys(options).some((key) => !['tier', 'imagery', 'previews', 'holdForSelection'].includes(key))) ||
      ((options as any).tier !== undefined && !['fast', 'quality'].includes((options as any).tier)) ||
      ((options as any).imagery !== undefined && !['none', 'abstract', 'photographic'].includes((options as any).imagery)) ||
      ((options as any).previews !== undefined && (!Number.isInteger((options as any).previews) || (options as any).previews < 1 || (options as any).previews > 4)) ||
      ((options as any).holdForSelection !== undefined && typeof (options as any).holdForSelection !== 'boolean'))) return null;
  // Select the contract explicitly. A worker payload cannot choose the database principal, tenant,
  // outbox owner or a second source through spare JSON fields.
  return {
    platform: 'telegram', sourceEventId: d.sourceEventId as string, sourceChannelId: d.sourceChannelId as string,
    rawText: d.rawText as string, title: d.title as string,
    designInstructions: d.designInstructions as string, exactCopy: d.exactCopy as unknown[],
    clientId: d.clientId as string | null,
    ...(d.autoGenerate !== undefined ? { autoGenerate: d.autoGenerate as boolean } : {}),
    ...(variant ? { variant: variant as { width: number; height: number } } : {}),
    ...(d.designStudio !== undefined ? { designStudio: d.designStudio as boolean } : {}),
    ...(options ? { studioOptions: options as ChatIntake['studioOptions'] } : {}),
  };
}

export function registerLifecycleInternalRoutes(ctx: RouteContext): void {
  const { app, db, problem, verifyRequestAuth, channelKillSwitches } = ctx;

  // Registered on /v1/internal/* only (not under every prefix, as registerRoute does): one address,
  // which nginx does not need to serve, for one caller.
  const internal = (path: string, handler: (c: Context) => Promise<Response>) =>
    app.post(`/v1/internal${path}`, async (c: Context) => {
      const auth = verifyRequestAuth(c);
      if (!auth.authenticated || auth.role !== 'service') return problem(c, 401, 'Authentication Required', 'This route takes the worker\'s credential only');
      return handler(c);
    });

  const readBody = async (c: Context): Promise<Record<string, unknown> | null> => {
    try {
      const body = await c.req.json();
      return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  internal('/telegram/intake', async (c) => {
    const body = await readBody(c);
    const update = body?.update;
    if (!isUpdate(update)) return problem(c, 400, 'Invalid update', 'The body must carry a Telegram update with a positive update_id');
    // 2.3 adds the lifecycle's decide mode; until then this route knows today's intake only, and an
    // older Core refuses a mode it does not have instead of treating it as legacy.
    const mode = body?.mode ?? 'legacy';
    if (mode !== 'legacy') return problem(c, 400, 'Unknown intake mode', `This Core runs intake in mode "legacy" only, not "${String(mode)}"`);

    const handled = (intakeStatus: number, extra: Record<string, unknown> = {}) =>
      c.json({ v: 1, kind: 'handled', intakeStatus, ...extra }, 200);

    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret) return handled(503, { code: 'NOT_CONFIGURED', detail: 'TELEGRAM_WEBHOOK_SECRET is not configured' });
    // Intake refuses while the office has switched Telegram off; the update waits in its chat for the
    // switch, as it waited in Telegram when Core polled. Asked here so the answer is not a retry.
    if (await intakeRefused(channelKillSwitches, 'telegram')) return handled(503, { code: 'INTAKE_PAUSED' });

    // Today's intake, in this process, as the Core poller handed updates to it (app.ts).
    const res = await app.request('/api/webhooks/telegram?generate=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': secret, ...requestIdHeaders() },
      body: JSON.stringify(update),
    });
    const answer = (await res.json().catch(() => ({}))) as { duplicate?: boolean; title?: string; task?: { id?: string }; tasks?: Array<{ id?: string }> };
    if (res.status === 503 && answer.title === 'Database Unavailable') return handled(503, { code: 'DATABASE_UNAVAILABLE' });
    // The switch thrown between the check above and intake's own.
    if (res.status === 503 && answer.title === 'Service Unavailable') return handled(503, { code: 'INTAKE_PAUSED' });
    if (res.status >= 400) log.warn(`[core:internal] intake answered update ${update.update_id} with HTTP ${res.status}: ${answer.title ?? ''}`);

    // Intake has decided and saved what it saves; the answer has not left yet (chaos suite point:
    // a Core killed here must not make the worker's retry a second task).
    await chaosPoint('core.intake.after-decision', { updateId: update.update_id, chat: chatOf(update), status: res.status });
    const taskIds = [...(answer.tasks ?? []), ...(answer.task ? [answer.task] : [])].map((t) => t?.id).filter((id): id is string => typeof id === 'string');
    return handled(res.status, { duplicate: answer.duplicate === true, ...(taskIds.length ? { taskIds: [...new Set(taskIds)] } : {}) });
  });

  internal('/telegram/park', async (c) => {
    const body = await readBody(c);
    const update = body?.update;
    if (!isUpdate(update)) return problem(c, 400, 'Invalid update', 'The body must carry a Telegram update with a positive update_id');
    const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'intake kept failing';
    if (!db) return problem(c, 503, 'Database Unavailable', 'There is no database to store the dead letter in');
    const scope = { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID };
    const sourceEventId = `parked-update-${update.update_id}`;
    try {
      // ChatInbox runs one update of a chat at a time, so a second park of this update is only the
      // worker asking again after an answer it did not get: it stores nothing and tells nobody again.
      const already = await withRlsContext(db, { ...scope, role: 'operator' }, async (trx) =>
        (await sql<{ one: number }>`SELECT 1 AS one FROM hawa.inbox_events WHERE tenant_id = ${scope.tenantId}::uuid
          AND source_account_id = 'telegram' AND source_event_id = ${sourceEventId}`.execute(trx)).rows.length > 0);
      if (!already) {
        const office = (process.env.TELEGRAM_ALLOWED_USERS || '').split(',').map((v) => v.trim()).find(Boolean);
        // The offset is the worker poller's: it moved past the update when Restate accepted it.
        await parkTelegramUpdate(db, scope, update, reason, { officeChatId: office });
        log.error(`[core:internal] update ${update.update_id} parked for an operator: ${reason}`);
        const chat = parkedUpdateChat(update);
        if (body?.notifySender !== false && chat && ctx.telegramBridge) {
          // Best effort, as before: the dead letter and the office alert are what must not be lost.
          await ctx.telegramBridge.dispatchOutboundMessage(chat, { text: PARKED_UPDATE_NOTICE })
            .then((sent) => { if (!sent.success) throw new Error(sent.error || 'send failed'); })
            .catch((err: unknown) => log.warn(`[core:internal] could not tell the sender that update ${update.update_id} was parked:`, err instanceof Error ? err.message : err));
        }
      }
      return c.json({ v: 1, parked: true, alreadyParked: already }, 200);
    } catch (err) {
      log.error(`[core:internal] update ${update.update_id} could not be parked:`, err instanceof Error ? err.message : err);
      return problem(c, 503, 'Database Unavailable', 'The dead letter could not be stored; ask again');
    }
  });

  // Phase 2.3's first projection. Its caller is the future RequestLifecycle handler, never a
  // browser. It is safe to expose before cutover: only the worker credential can reach it, and no
  // current ChatInbox path emits a lifecycle open. One transaction pins task/outbox ownership.
  internal('/lifecycle/:requestId/project', async (c) => {
    const requestId = c.req.param('requestId') ?? '';
    const body = await readBody(c);
    const ops = body?.ops;
    const first = Array.isArray(ops) && ops.length === 1 ? ops[0] as Record<string, unknown> : null;
    const draft = first?.kind === 'createRequest' ? openDraft(first.draft, requestId) : null;
    if (!UUID.test(requestId) || body?.v !== 1 || body.expectedRev !== 0 || body.rev !== 1 ||
        body.key !== `${requestId}:1:open` || !draft) {
      return problem(c, 400, 'Invalid lifecycle projection', 'Expected one versioned createRequest operation with a stable round-zero source');
    }
    if (!db) return problem(c, 503, 'Database Unavailable', 'The lifecycle projection requires a database');
    try {
      const result = await projectLifecycleOpen(db, {
        requestId, tenantId: DEFAULT_TENANT_ID, expectedRev: 0, rev: 1,
        key: body.key as string, draft,
      });
      return c.json({ v: 1, ...result }, 200);
    } catch (error) {
      if (error instanceof LifecycleProjectionConflict) {
        return c.json({ type: 'https://hawa.design/errors/409', title: 'Lifecycle Projection Conflict',
          status: 409, detail: error.message, instance: c.req.url, code: error.code }, 409);
      }
      log.error(`[core:internal] lifecycle open ${requestId} failed:`, error instanceof Error ? error.message : error);
      return problem(c, 503, 'Lifecycle Projection Unavailable', 'The projection did not commit; retry with the same key');
    }
  });

  internal('/lifecycle/:requestId/design-outcome', async (c) => {
    const requestId = c.req.param('requestId') ?? '';
    const body = await readBody(c);
    const op = Array.isArray(body?.ops) && body.ops.length === 1 ? body.ops[0] as Record<string, unknown> : null;
    const report = op?.report && typeof op.report === 'object' && !Array.isArray(op.report)
      ? op.report as Record<string, unknown> : null;
    const runId = op?.runId;
    const taskId = op?.taskId;
    const clean = (value: unknown) => typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value);
    if (!UUID.test(requestId) || body?.v !== 1 || body.expectedRev !== 1 || body.rev !== 2 ||
        op?.kind !== 'recordOutcome' || typeof taskId !== 'string' || !UUID.test(taskId) ||
        runId !== `dr-${taskId}` || body.key !== `${requestId}:2:designFinished:${runId}` ||
        !report || !clean(report.status) ||
        (report.code !== undefined && !clean(report.code)) ||
        (report.designId !== undefined && (typeof report.designId !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(report.designId))) ||
        (report.detail !== undefined && (typeof report.detail !== 'string' || report.detail.length > 500)) ||
        (report.runId !== undefined && (typeof report.runId !== 'string' || report.runId.length > 100)) ||
        (report.notifyRequester !== undefined && typeof report.notifyRequester !== 'boolean')) {
      return problem(c, 400, 'Invalid design outcome projection', 'Expected one versioned recordOutcome operation for the current round-zero design');
    }
    if (!db) return problem(c, 503, 'Database Unavailable', 'The lifecycle projection requires a database');
    try {
      const result = await projectLifecycleDesignOutcome(db, {
        requestId, tenantId: DEFAULT_TENANT_ID, taskId: taskId as string, runId: runId as string,
        expectedRev: 1, rev: 2, key: body.key as string,
        report: report as unknown as Parameters<typeof projectLifecycleDesignOutcome>[1]['report'],
      });
      return c.json({ v: 1, ...result }, 200);
    } catch (error) {
      if (error instanceof LifecycleProjectionConflict) {
        return c.json({ type: 'https://hawa.design/errors/409', title: 'Lifecycle Projection Conflict',
          status: 409, detail: error.message, instance: c.req.url, code: error.code }, 409);
      }
      log.error(`[core:internal] lifecycle design outcome ${requestId} failed:`, error instanceof Error ? error.message : error);
      return problem(c, 503, 'Lifecycle Projection Unavailable', 'The projection did not commit; retry with the same key');
    }
  });

  // The first versioned office transition records the decision, task transition, request revision
  // and replay receipt in one transaction. Approval also carries exact checked-export proof.
  internal('/lifecycle/:requestId/office-decision', async (c) => {
    const requestId = c.req.param('requestId') ?? '';
    const body = await readBody(c);
    const op = Array.isArray(body?.ops) && body.ops.length === 1 ? body.ops[0] as Record<string, unknown> : null;
    const actor = op?.actor && typeof op.actor === 'object' && !Array.isArray(op.actor)
      ? op.actor as Record<string, unknown> : null;
    const actionId = op?.actionId;
    const revisionRequest = op?.revisionRequest === undefined ? undefined : parseCompleteRevisionRequest(op.revisionRequest);
    const approvalProof = op?.approvalProof === undefined ? undefined : parseOfficeApprovalProof(op.approvalProof);
    const isApproval = op?.kind === 'recordOfficeApproval';
    if (!UUID.test(requestId) || body?.v !== 1 || body.expectedRev !== 2 || body.rev !== 3 ||
        (!isApproval && op?.kind !== 'recordOfficeRevision') || typeof op.taskId !== 'string' || !UUID.test(op.taskId) ||
        typeof op.revisionId !== 'string' || !UUID.test(op.revisionId) ||
        typeof actionId !== 'string' || !UUID.test(actionId) ||
        body.key !== `${requestId}:3:officeDecision:desk:${actionId}` ||
        !actor || typeof actor.userId !== 'string' || !UUID.test(actor.userId) ||
        typeof actor.role !== 'string' || actor.role.length > 60 ||
        typeof op.reason !== 'string' || !op.reason.trim() || op.reason.length > 2000 ||
        (op.revisionRequest !== undefined && (!revisionRequest || revisionRequest.comment !== op.reason.trim())) ||
        (isApproval && (!approvalProof || revisionRequest || !/^[a-f0-9]{64}$/.test(String(op.deskRequestFingerprint || '')))) ||
        (!isApproval && (op.approvalProof !== undefined || op.deskRequestFingerprint !== undefined))) {
      return problem(c, 400, 'Invalid office decision', 'Expected one versioned attributed review decision for the current draft');
    }
    if (!db) return problem(c, 503, 'Database Unavailable', 'The lifecycle projection requires a database');
    try {
      const result = await projectLifecycleOfficeDecision(db, {
        requestId, tenantId: DEFAULT_TENANT_ID, taskId: op.taskId as string,
        revisionId: op.revisionId as string, actionId: actionId as string,
        actor: { userId: actor.userId as string, role: actor.role as string },
        reason: (op.reason as string).trim(), expectedRev: 2, rev: 3, key: body.key as string,
        ...(revisionRequest ? { revisionRequest } : {}),
        ...(approvalProof ? { decision: 'approved', approvalProof,
          deskRequestFingerprint: op.deskRequestFingerprint as string } : {}),
      });
      return c.json({ v: 1, ...result }, 200);
    } catch (error) {
      if (error instanceof LifecycleProjectionConflict) {
        return c.json({ type: 'https://hawa.design/errors/409', title: 'Lifecycle Projection Conflict',
          status: 409, detail: error.message, instance: c.req.url, code: error.code }, 409);
      }
      log.error(`[core:internal] lifecycle office revision ${requestId} failed:`, error instanceof Error ? error.message : error);
      return problem(c, 503, 'Lifecycle Projection Unavailable', 'The office decision did not commit; retry with the same key');
    }
  });

  internal('/lifecycle/:requestId/delivery-start', async (c) => {
    const requestId = c.req.param('requestId') || '';
    const body = await readBody(c);
    const op = Array.isArray(body?.ops) && body.ops.length === 1 ? body.ops[0] as Record<string, unknown> : null;
    const actor = op?.actor && typeof op.actor === 'object' && !Array.isArray(op.actor)
      ? op.actor as Record<string, unknown> : null;
    const expectedRev = Number(body?.expectedRev);
    const rev = Number(body?.rev);
    if (!UUID.test(requestId) || body?.v !== 1 || !Number.isInteger(expectedRev) || expectedRev < 3 ||
        rev !== expectedRev + 1 || op?.kind !== 'startDelivery' ||
        !UUID.test(String(op.taskId || '')) || !UUID.test(String(op.revisionId || '')) ||
        !UUID.test(String(op.approvalId || '')) || !UUID.test(String(op.actionId || '')) ||
        body.key !== `${requestId}:${rev}:officeDecision:desk:${op.actionId}` ||
        !actor || !UUID.test(String(actor.userId || '')) || typeof actor.role !== 'string' ||
        typeof op.reason !== 'string' || !op.reason.trim() || op.reason.length > 2000) {
      return problem(c, 400, 'Invalid delivery start', 'Expected one versioned request-owned delivery action');
    }
    if (!db) return problem(c, 503, 'Database Unavailable', 'The lifecycle projection requires a database');
    try {
      const result = await projectLifecycleDeliveryStart(db, ctx.deliverableStore, {
        requestId, tenantId: DEFAULT_TENANT_ID, taskId: op.taskId as string,
        revisionId: op.revisionId as string, approvalId: op.approvalId as string,
        actionId: op.actionId as string,
        actor: { userId: actor.userId as string, role: actor.role }, reason: op.reason.trim(),
        expectedRev, rev, key: body.key as string,
      });
      return c.json({ v: 1, ...result }, 200);
    } catch (error) {
      if (error instanceof LifecycleProjectionConflict) return c.json({ status: 409, code: error.code,
        detail: error.message }, 409);
      log.error(`[core:internal] lifecycle delivery start ${requestId} failed:`, error);
      return problem(c, 503, 'Lifecycle Projection Unavailable', 'The delivery start did not commit; retry with the same key');
    }
  });

  internal('/lifecycle/:requestId/delivery-finished', async (c) => {
    const requestId = c.req.param('requestId') || '';
    const body = await readBody(c);
    const op = Array.isArray(body?.ops) && body.ops.length === 1 ? body.ops[0] as Record<string, unknown> : null;
    const outcome = op?.outcome as DeliveryOutcome | undefined;
    const expectedRev = Number(body?.expectedRev);
    const rev = Number(body?.rev);
    if (!UUID.test(requestId) || body?.v !== 1 || !Number.isInteger(expectedRev) || expectedRev < 4 ||
        rev !== expectedRev + 1 || op?.kind !== 'finishDelivery' ||
        !UUID.test(String(op.taskId || '')) || !UUID.test(String(op.approvalId || '')) ||
        typeof op.deliveryId !== 'string' || !Number.isInteger(op.run) || Number(op.run) < 1 ||
        body.key !== `${requestId}:${rev}:deliveryFinished:${op.deliveryId}` ||
        !outcome || !['delivered', 'chat_only', 'uncertain', 'failed'].includes(outcome.outcome) ||
        !Array.isArray(outcome.uncertain) || outcome.uncertain.length > 50 ||
        outcome.uncertain.some((item) => typeof item !== 'string' || item.length > 500) ||
        typeof outcome.archived !== 'boolean' || typeof outcome.sheetsConfirmed !== 'boolean' ||
        !Number.isInteger(outcome.filesSent) || outcome.filesSent < 0 ||
        (outcome.reason !== undefined && (typeof outcome.reason !== 'string' || outcome.reason.length > 2000))) {
      return problem(c, 400, 'Invalid delivery result', 'Expected one versioned workflow outcome');
    }
    if (!db) return problem(c, 503, 'Database Unavailable', 'The lifecycle projection requires a database');
    try {
      const result = await projectLifecycleDeliveryFinish(db, { requestId, tenantId: DEFAULT_TENANT_ID,
        taskId: op.taskId as string, approvalId: op.approvalId as string,
        deliveryId: op.deliveryId as string, run: op.run as number, outcome,
        expectedRev, rev, key: body.key as string });
      return c.json({ v: 1, ...result }, 200);
    } catch (error) {
      if (error instanceof LifecycleProjectionConflict) return c.json({ status: 409, code: error.code,
        detail: error.message }, 409);
      log.error(`[core:internal] lifecycle delivery result ${requestId} failed:`, error);
      return problem(c, 503, 'Lifecycle Projection Unavailable', 'The delivery result did not commit; retry with the same key');
    }
  });
}
