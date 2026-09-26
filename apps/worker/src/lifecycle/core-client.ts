/**
 * The worker's calls to Core's internal lifecycle API (architecture programme Phase 2.1,
 * apps/core/src/routes/lifecycle-internal.routes.ts), authenticated with HAWA_WORKER_TOKEN: a
 * credential Core accepts on /v1/internal/* and nowhere else, never the operator's bearer.
 *
 * It also decides what each answer means for ChatInbox (chat-inbox.ts):
 *  - intake answered (HTTP 200 with intake's own status): 2xx and 4xx are final; 5xx, 408 and 429
 *    are a retryable answer, journaled and counted towards the dead letter, unless Core says why it
 *    cannot take anything now (its database is down, the office switched intake off, it is not
 *    configured), which is a wait;
 *  - Core answered with an error of its own: a 5xx is retryable, except "Database Unavailable" (503),
 *    which waits; a 4xx (token refused, a route an older Core does not have) is a fault of this
 *    deployment, not of the update, and waits for it to be fixed rather than dead-letter a message;
 *  - Core did not answer at all (refused, reset, not resolvable): a wait. Only an intake that took
 *    longer than `timeoutMs` counts as this update's retryable failure.
 * "Wait" is a thrown error: Restate retries the step and does not journal it.
 */
import type { ChatInboxCore, IntakeAnswer, IntakeMode } from './chat-inbox.js';
import type { TelegramUpdateLike } from './telegram-poller.js';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CoreClientOptions {
  /** Core's address on the internal network, e.g. http://core:3001. */
  baseUrl: string;
  /** HAWA_WORKER_TOKEN. */
  token: string;
  fetch?: FetchLike;
  /** How long one intake call may take (a 20 MB download and its reading included). */
  timeoutMs?: number;
}

/** Codes Core's intake route gives when it cannot take any update now; the update waits. */
const WAIT_CODES = new Set(['DATABASE_UNAVAILABLE', 'INTAKE_PAUSED', 'NOT_CONFIGURED']);
const retryable = (status: number) => status >= 500 || status === 429 || status === 408;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isTimeout = (err: unknown) => err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');

export function createCoreClient(options: CoreClientOptions): ChatInboxCore {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const headers = (update: TelegramUpdateLike) => ({
    Authorization: `Bearer ${options.token}`,
    'Content-Type': 'application/json',
    // Every line Core writes for this update carries the id the poller gave it.
    'x-request-id': `tg-${update.update_id}`,
  });

  return {
    async intake(update: TelegramUpdateLike, mode: IntakeMode, requestId?: string): Promise<IntakeAnswer> {
      let res: Response;
      try {
        res = await doFetch(`${base}/v1/internal/telegram/intake`, {
          method: 'POST',
          headers: headers(update),
          body: JSON.stringify({ v: 1, update, mode, ...(requestId ? { requestId } : {}) }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 8 * 60_000),
        });
      } catch (err) {
        if (isTimeout(err)) return { kind: 'retry', reason: `intake did not answer within ${Math.round((options.timeoutMs ?? 480_000) / 1000)} s` };
        throw new Error(`Core is unreachable, update ${update.update_id} waits: ${errorText(err)}`);
      }
      const body = (await res.json().catch(() => ({}))) as {
        intakeStatus?: number; code?: string; duplicate?: boolean; title?: string;
        lifecycleAction?: string; requestId?: string; newTaskId?: string;
        round?: number; directive?: string; priorTaskId?: string; rawText?: string;
        chatId?: string; questionId?: string; draft?: unknown;
      };
      if (res.status === 200 && typeof body.intakeStatus === 'number') {
        const status = body.intakeStatus;
        if (!retryable(status)) {
          const base: Extract<IntakeAnswer, { kind: 'done' }> = { kind: 'done', intakeStatus: status, duplicate: body.duplicate === true };
          if (body.lifecycleAction === 'open-request') {
            const draft = body.draft as Record<string, unknown> | undefined;
            if (!body.requestId || !body.chatId || !draft || draft.platform !== 'telegram' ||
                draft.sourceEventId !== `lc-${body.requestId}-r0` ||
                draft.sourceChannelId !== body.chatId ||
                (draft.autoGenerate !== true && draft.autoGenerate !== false) ||
                typeof draft.rawText !== 'string' || typeof draft.title !== 'string') {
              throw new Error(`Core returned an invalid lifecycle open for update ${update.update_id}`);
            }
            return { ...base, lifecycleAction: 'open-request', requestId: body.requestId,
              chatId: body.chatId, draft: draft as Extract<IntakeAnswer, { kind: 'done' }>['draft'] };
          }
          if (body.lifecycleAction === 'new-brief-required' && body.chatId) {
            return { ...base, lifecycleAction: 'new-brief-required', chatId: body.chatId };
          }
          if ((body.lifecycleAction === 'requester-revision' ||
               (body.lifecycleAction === 'requester-answer' && body.questionId)) &&
              body.requestId && body.newTaskId &&
              typeof body.round === 'number' && body.directive && body.priorTaskId) {
            return { ...base, lifecycleAction: body.lifecycleAction,
              requestId: body.requestId, newTaskId: body.newTaskId, round: body.round,
              directive: body.directive, priorTaskId: body.priorTaskId,
              ...(body.chatId ? { chatId: body.chatId } : {}),
              ...(body.lifecycleAction === 'requester-answer' && body.questionId
                ? { questionId: body.questionId } : {}),
              ...(body.rawText !== undefined ? { rawText: body.rawText } : {}) };
          }
          if (body.lifecycleAction === 'request-choice-required' && body.chatId &&
              (body.code === 'AMBIGUOUS_REQUEST' || body.code === 'STALE_REQUEST_REPLY')) {
            return { ...base, lifecycleAction: 'request-choice-required',
              chatId: body.chatId, code: body.code };
          }
          if (body.lifecycleAction === 'revision-blocked' && body.chatId &&
              (body.code === 'DAILY_CAP_REACHED' || body.code === 'PARENT_BRIEF_MISSING' ||
                body.code === 'QUESTION_MISSING')) {
            return { ...base, lifecycleAction: 'revision-blocked',
              chatId: body.chatId, code: body.code };
          }
          return base;
        }
        if (body.code && WAIT_CODES.has(body.code)) throw new Error(`intake waits: ${body.code} (HTTP ${status})`);
        return { kind: 'retry', reason: `intake answered HTTP ${status}` };
      }
      if (res.status === 503 && body.title === 'Database Unavailable') throw new Error(`intake waits: Core answered 503 Database Unavailable`);
      if (res.status >= 500) return { kind: 'retry', reason: `Core answered HTTP ${res.status}` };
      throw new Error(`Core refused the worker's intake call with HTTP ${res.status} (${body.title ?? 'no reason'}); update ${update.update_id} waits until this deployment is fixed`);
    },

    async park(update: TelegramUpdateLike, reason: string): Promise<void> {
      const res = await doFetch(`${base}/v1/internal/telegram/park`, {
        method: 'POST',
        headers: headers(update),
        body: JSON.stringify({ v: 1, update, reason, notifySender: true }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`Core did not store the dead letter for update ${update.update_id}: HTTP ${res.status}`);
    },
  };
}
