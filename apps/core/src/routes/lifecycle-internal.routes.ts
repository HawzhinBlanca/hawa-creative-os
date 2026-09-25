/**
 * Core's internal API for the request lifecycle on Restate (architecture programme Phase 2, ADR-034,
 * PHASE2_DESIGN.md section 2.8). Slice 2.1 adds the two calls the worker's ChatInbox makes:
 *
 *   POST /v1/internal/telegram/intake  {v, update, mode: 'legacy'}  → {v, kind: 'handled', intakeStatus, …}
 *     (slice 2.3 adds mode 'lifecycle', the chat's state, and `routesDecisions` from a ChatInbox that
 *     routes; the answer may then be {v, kind: 'decision', decision, chat?})
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
import { SYSTEM_AUTOMATION_USER_ID, type ChatIntakeState, type IntakeAnswerBody, type IntakeDecision, type PendingClarification } from '@hawa/contracts';
import { DEFAULT_TENANT_ID } from '../core-context.js';
import { log, requestIdHeaders } from '../logging.js';
import { intakeRefused } from '../services/channel-kill-switches.js';
import { PARKED_UPDATE_NOTICE, parkTelegramUpdate, parkedUpdateChat } from '../services/polled-update-dispatch.js';
import { readDecisionRecord, runWithDecideSession, writeDecisionRecord, type IntakeDecideSession, type IntakeMode } from '../services/telegram-intake/decide-mode.js';
import { routeForCaller } from '../services/telegram-intake/lifecycle-forward.js';
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

/**
 * The chat state ChatInbox sent, as far as intake reads it: a clarification with its words and when it
 * was asked, and the albums answered. Anything else is dropped rather than trusted.
 */
export function readChatState(raw: unknown): ChatIntakeState {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: ChatIntakeState = {};
  const p = r.pendingClarification as Partial<PendingClarification> | undefined;
  if (p && typeof p === 'object' && typeof p.rawText === 'string' && p.rawText.trim() && Number.isFinite(p.askedAt)) {
    out.pendingClarification = {
      rawText: p.rawText.slice(0, 20000), askedAt: Number(p.askedAt), updateId: Number.isSafeInteger(p.updateId) ? Number(p.updateId) : 0,
      ...(typeof p.taskId === 'string' && /^[0-9a-f-]{36}$/i.test(p.taskId) ? { taskId: p.taskId } : {}),
    };
  }
  if (r.albumsAcked && typeof r.albumsAcked === 'object') {
    const albums = Object.entries(r.albumsAcked as Record<string, unknown>).filter(([k, v]) => k.length <= 64 && Number.isFinite(v)).slice(-100);
    if (albums.length) out.albumsAcked = Object.fromEntries(albums.map(([k, v]) => [k, Number(v)]));
  }
  return out;
}

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
    // 'legacy': today's intake, except that an update aimed at a request the lifecycle owns is
    // answered as a decision to route. 'lifecycle' (slice 2.3): new requests are decided, not saved.
    const mode = body?.mode ?? 'legacy';
    if (mode !== 'legacy' && mode !== 'lifecycle') return problem(c, 400, 'Unknown intake mode', `This Core runs intake in mode "legacy" or "lifecycle", not "${String(mode)}"`);

    const handled = (intakeStatus: number, extra: Record<string, unknown> = {}) =>
      c.json({ v: 1, kind: 'handled', intakeStatus, ...extra }, 200);
    const chat = chatOf(update);
    // A ChatInbox from slice 2.3 part C on says it routes decisions (`routesDecisions`; mode
    // 'lifecycle' is only ever asked by one). An older one reads a decision as "done" and routes
    // nothing, so for it Core routes the decision itself, through Restate's ingress with the keys
    // ChatInbox would use, and answers `handled` (review of 2.3C).
    const callerRoutes = mode === 'lifecycle' || body?.routesDecisions === true;
    const routedByCore = async (decision: IntakeDecision): Promise<Response> => {
      const routed = await routeForCaller(ctx.telegramBridge, chat, update, decision);
      if (routed.outcome === 'routed') return handled(200, { routedByCore: decision.kind });
      // Retryable for the older client: counted, and parked (the office alerted) after its attempts.
      if (routed.outcome === 'retry') return handled(503, { code: 'LIFECYCLE_UNREACHABLE' });
      return handled(409, { code: 'LIFECYCLE_OWNED' });
    };

    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret) return handled(503, { code: 'NOT_CONFIGURED', detail: 'TELEGRAM_WEBHOOK_SECRET is not configured' });
    // Intake refuses while the office has switched Telegram off; the update waits in its chat for the
    // switch, as it waited in Telegram when Core polled. Asked here so the answer is not a retry.
    if (await intakeRefused(channelKillSwitches, 'telegram')) return handled(503, { code: 'INTAKE_PAUSED' });

    // The same update decided before (the worker lost the answer, or was killed): the decision is
    // answered from its record, and nothing is transcribed or classified again.
    if (db && chat) {
      const recorded = await readDecisionRecord(db, chat, update.update_id).catch((err: unknown) => {
        log.warn(`[core:internal] could not read the decision record of update ${update.update_id}:`, err instanceof Error ? err.message : err);
        return undefined;
      });
      if (recorded === undefined) return handled(503, { code: 'DATABASE_UNAVAILABLE' });
      if (recorded) {
        if (!callerRoutes) return routedByCore(recorded.decision);
        return c.json({ v: 1, kind: 'decision', intakeStatus: 200, decision: recorded.decision, replayed: true, ...(recorded.chat ? { chat: recorded.chat } : {}) } satisfies IntakeAnswerBody, 200);
      }
    }

    // Today's intake, in this process, as the Core poller handed updates to it (app.ts), inside the
    // decide session its stages read (services/telegram-intake/decide-mode.ts).
    const session: IntakeDecideSession = { mode: mode as IntakeMode, chat: mode === 'lifecycle' ? readChatState(body?.chat) : {} };
    const res = await runWithDecideSession(session, async () => app.request('/api/webhooks/telegram?generate=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': secret, ...requestIdHeaders() },
      body: JSON.stringify(update),
    }));
    // "Clarify sets the waiting question; every other decision clears it" (PHASE2_DESIGN.md 2.2): a
    // button, an answer or a command after the question means the requester moved on, and a later
    // "new" or "revise" must not reach back to words sent an hour ago.
    if (session.decision?.kind !== 'clarify') delete session.chat.pendingClarification;
    const chatState = mode === 'lifecycle' ? { chat: session.chat } : {};
    if (session.legacyBecause) log.info(`[core:internal] update ${update.update_id} of lifecycle chat ${chat} read on Core's own path: ${session.legacyBecause}`);

    if (session.decision) {
      // The decision is written before it is answered: paid transcription and classification are
      // not made again for it (PHASE2_DESIGN.md section 5).
      if (db && chat) {
        try {
          await writeDecisionRecord(db, chat, update.update_id, session.decision, mode === 'lifecycle' ? session.chat : undefined);
        } catch (err) {
          log.warn(`[core:internal] the decision for update ${update.update_id} could not be recorded; the update waits:`, err instanceof Error ? err.message : err);
          return handled(503, { code: 'DATABASE_UNAVAILABLE' });
        }
      }
      await chaosPoint('core.intake.after-decision', { updateId: update.update_id, chat, status: 200, decision: session.decision.kind });
      if (!callerRoutes) return routedByCore(session.decision);
      return c.json({ v: 1, kind: 'decision', intakeStatus: 200, decision: session.decision, ...chatState } satisfies IntakeAnswerBody, 200);
    }
    const answer = (await res.json().catch(() => ({}))) as { duplicate?: boolean; title?: string; task?: { id?: string }; tasks?: Array<{ id?: string }> };
    if (res.status === 503 && answer.title === 'Database Unavailable') return handled(503, { code: 'DATABASE_UNAVAILABLE' });
    // The switch thrown between the check above and intake's own.
    if (res.status === 503 && answer.title === 'Service Unavailable') return handled(503, { code: 'INTAKE_PAUSED' });
    if (res.status >= 400) log.warn(`[core:internal] intake answered update ${update.update_id} with HTTP ${res.status}: ${answer.title ?? ''}`);

    // Intake has decided and saved what it saves; the answer has not left yet (chaos suite point:
    // a Core killed here must not make the worker's retry a second task).
    await chaosPoint('core.intake.after-decision', { updateId: update.update_id, chat, status: res.status });
    const taskIds = [...(answer.tasks ?? []), ...(answer.task ? [answer.task] : [])].map((t) => t?.id).filter((id): id is string => typeof id === 'string');
    // The chat's state goes back only when the update is done with; a retried one keeps the old.
    const done = res.status < 500 && res.status !== 408 && res.status !== 429;
    return handled(res.status, { duplicate: answer.duplicate === true, ...(taskIds.length ? { taskIds: [...new Set(taskIds)] } : {}), ...(done ? chatState : {}) });
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

