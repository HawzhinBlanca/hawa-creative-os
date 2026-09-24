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
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { DEFAULT_TENANT_ID } from '../core-context.js';
import { log, requestIdHeaders } from '../logging.js';
import { intakeRefused } from '../services/channel-kill-switches.js';
import { PARKED_UPDATE_NOTICE, parkTelegramUpdate, parkedUpdateChat } from '../services/polled-update-dispatch.js';
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
}

