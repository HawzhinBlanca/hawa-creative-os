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
import { LATE_CHANGE_STAGES, type ChatInboxCore, type IntakeAnswer, type IntakeMode, type LateChangeStage } from './chat-inbox.js';
import type { TelegramUpdateLike } from './telegram-poller.js';
import { MAX_REQUEST_DELIVERABLES, planRequestDeliverables } from '@hawa/domain';

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
/**
 * The longest settle Core may ask for (ADR-143). ADR-160's wait for the rest of a cut caption is one
 * such settle; a Core test ties CUT_CAPTION_WAIT_MS to this, so neither changes alone.
 */
export const MAX_SETTLE_DELAY_MS = 10 * 60_000;
const WAIT_CODES = new Set(['DATABASE_UNAVAILABLE', 'INTAKE_PAUSED', 'NOT_CONFIGURED']);
const retryable = (status: number) => status >= 500 || status === 429 || status === 408;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** An office alert Core attached: absent, or a chat and words within Telegram's limit. */
const validAlert = (alert: { chatId?: unknown; text?: unknown } | null | undefined): boolean =>
  alert === undefined || (Boolean(alert) && typeof alert!.chatId === 'string' && Boolean(alert!.chatId) &&
    typeof alert!.text === 'string' && Boolean(alert!.text) && (alert!.text as string).length <= 4000);
/**
 * ADR-155 section 6: Core's intake alert for every office member. The first is `officeAlert`; a Core
 * from before this change sends only that one. Invalid entries refuse the whole answer, as an invalid
 * `officeAlert` does.
 */
function officeAlertsOf(alert: { chatId?: unknown; text?: unknown } | null | undefined, alerts: unknown):
  { officeAlerts?: Array<{ chatId: string; text: string }> } {
  if (alerts === undefined) return {};
  if (!Array.isArray(alerts) || alerts.length > 50 || !alerts.every((a) => a !== undefined && validAlert(a)) ||
      !alert || (alerts[0] as { chatId: string }).chatId !== alert.chatId) throw new Error('Core returned invalid office alerts');
  return { officeAlerts: alerts.map((a: { chatId: string; text: string }) => ({ chatId: a.chatId, text: a.text })) };
}
const isTimeout = (err: unknown) => err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');

export function createCoreClient(options: CoreClientOptions): ChatInboxCore & {
  overdueSettles(): Promise<Array<{ chatId: string; update: TelegramUpdateLike }>>;
} {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const headers = (update: TelegramUpdateLike) => ({
    Authorization: `Bearer ${options.token}`,
    'Content-Type': 'application/json',
    // Every line Core writes for this update carries the id the poller gave it.
    'x-request-id': `tg-${update.update_id}`,
  });

  return {
    async intake(update: TelegramUpdateLike, mode: IntakeMode, requestId?: string, call: { settle?: boolean } = {}): Promise<IntakeAnswer> {
      let res: Response;
      try {
        res = await doFetch(`${base}/v1/internal/telegram/intake`, {
          method: 'POST',
          headers: headers(update),
          // languageSiblings: this worker opens every request an open-request answer names (ADR-139).
          // briefHold: it schedules the settles a held brief or a saved album photo asks for (ADR-143);
          // settle: this call is such a settle, of an update Core has already saved.
          body: JSON.stringify({ v: 1, update, mode, ...(requestId ? { requestId } : {}), languageSiblings: true,
            maxDeliverables:MAX_REQUEST_DELIVERABLES,
            briefHold: true, ...(call.settle ? { settle: true } : {}) }),
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
        chatId?: string; questionId?: string; draft?: unknown; reason?: string; siblings?: unknown;deliverableCount?:unknown;
        albumMessage?: string; albumNoticeKey?: string; settle?: unknown;
        sourceMessage?: string; sourceNoticeKey?: string;
        chatAnswer?: { text?: unknown; parseMode?: unknown } | null;
        requestStage?: string; officeAlert?: { chatId?: unknown; text?: unknown } | null; officeAlerts?: unknown;
        notice?: { text?: unknown; parseMode?: unknown } | null; quiet?: unknown;
      };
      // The fields declared as text are checked, not assumed: a number or object where Core's answer
      // should carry text is refused, and the update waits (audit 2026-09-30, ADR-159).
      for (const key of ['code', 'title', 'lifecycleAction', 'requestId', 'newTaskId', 'directive', 'priorTaskId', 'rawText',
        'chatId', 'questionId', 'reason', 'albumMessage', 'albumNoticeKey', 'sourceMessage', 'sourceNoticeKey', 'requestStage'] as const) {
        if (body[key] !== undefined && body[key] !== null && typeof body[key] !== 'string') {
          throw new Error(`Core returned a non-text ${key} for update ${update.update_id}`);
        }
      }
      if (res.status === 200 && typeof body.intakeStatus === 'number') {
        const status = body.intakeStatus;
        if (!retryable(status)) {
          // ADR-145: words Core said beside its answer (a video's words were used; a file could not be opened).
          const notice = body.notice;
          if (notice !== undefined && (!notice || typeof notice.text !== 'string' || !notice.text || notice.text.length > 4000 ||
              (notice.parseMode !== undefined && notice.parseMode !== 'HTML')))
            throw new Error(`Core returned an invalid notice for update ${update.update_id}`);
          const base: Extract<IntakeAnswer, { kind: 'done' }> = { kind: 'done', intakeStatus: status, duplicate: body.duplicate === true,
            ...(notice ? { notice: { text: String(notice.text), ...(notice.parseMode === 'HTML' ? { parseMode: 'HTML' as const } : {}) } } : {}),
            // N5: Core answered this chat's sender outside the intake list already today.
            ...(status === 403 && body.quiet === true ? { quiet: true } : {}) };
          if (body.lifecycleAction === 'source-message') {
            if (!body.chatId || typeof body.sourceMessage !== 'string' || !body.sourceMessage || body.sourceMessage.length > 3000 ||
                typeof body.sourceNoticeKey !== 'string' || !/^source-review:[0-9]+$/.test(body.sourceNoticeKey))
              throw new Error(`Core returned an invalid source notice for update ${update.update_id}`);
            return { ...base, lifecycleAction: 'source-message', chatId: body.chatId,
              sourceMessage: body.sourceMessage, sourceNoticeKey: body.sourceNoticeKey };
          }
          if (body.lifecycleAction === 'chat-answer') {
            const answer = body.chatAnswer;
            const alert = body.officeAlert;
            if (!body.chatId || !answer || typeof answer.text !== 'string' || !answer.text || answer.text.length > 4000 ||
                (answer.parseMode !== undefined && answer.parseMode !== 'HTML') || !validAlert(alert))
              throw new Error(`Core returned an invalid chat answer for update ${update.update_id}`);
            return { ...base, lifecycleAction: 'chat-answer', chatId: body.chatId,
              chatAnswer: { text: answer.text, ...(answer.parseMode === 'HTML' ? { parseMode: 'HTML' as const } : {}) },
              ...(alert ? { officeAlert: { chatId: String(alert.chatId), text: String(alert.text) } } : {}),
              ...officeAlertsOf(alert, body.officeAlerts) };
          }
          if (body.lifecycleAction === 'settle-later') {
            const settle = body.settle as { kind?: unknown; delayMs?: unknown } | undefined;
            if (!body.chatId || !settle || (settle.kind !== 'album' && settle.kind !== 'brief' && settle.kind !== 'photo') ||
                !Number.isSafeInteger(settle.delayMs) || Number(settle.delayMs) < 0 || Number(settle.delayMs) > MAX_SETTLE_DELAY_MS)
              throw new Error(`Core returned an invalid settle for update ${update.update_id}`);
            return { ...base, lifecycleAction: 'settle-later', chatId: body.chatId,
              settle: { kind: settle.kind, delayMs: Number(settle.delayMs) } };
          }
          if (body.lifecycleAction === 'album-message') {
            if (!body.chatId || typeof body.albumMessage !== 'string' || !body.albumMessage ||
                body.albumMessage.length > 2000 || typeof body.albumNoticeKey !== 'string' ||
                !/^album-[a-z]+:[a-zA-Z0-9-]+$/.test(body.albumNoticeKey))
              throw new Error(`Core returned an invalid album notice for update ${update.update_id}`);
            return { ...base, lifecycleAction: 'album-message', chatId: body.chatId,
              albumMessage: body.albumMessage, albumNoticeKey: body.albumNoticeKey };
          }
          if (body.lifecycleAction === 'open-request') {
            const validDraft = (requestId: unknown, value: unknown): boolean => {
              const draft = value as Record<string, unknown> | undefined;
              return typeof requestId === 'string' && Boolean(requestId) && Boolean(draft) && draft!.platform === 'telegram' &&
                draft!.sourceEventId === `lc-${requestId}-r0` && draft!.sourceChannelId === body.chatId &&
                (draft!.autoGenerate === true || draft!.autoGenerate === false) &&
                typeof draft!.rawText === 'string' && typeof draft!.title === 'string';
            };
            const siblings = body.siblings === undefined ? [] : body.siblings;
            const message=update.message as {text?:string;caption?:string}|undefined;
            const requested=planRequestDeliverables(message?.text ?? message?.caption ?? '');
            if (!body.chatId || !validDraft(body.requestId, body.draft) || !Array.isArray(siblings) || siblings.length >= MAX_REQUEST_DELIVERABLES ||
                siblings.some((s) => !s || typeof s !== 'object' || s.requestId === body.requestId ||
                  !validDraft((s as { requestId?: unknown }).requestId, (s as { draft?: unknown }).draft)) ||
                new Set([body.requestId,...siblings.map(s=>s.requestId)]).size!==siblings.length+1 ||
                (body.deliverableCount!==undefined && body.deliverableCount!==siblings.length+1) ||
                requested.kind==='limit' || (requested.kind==='multiple' &&
                  (body.deliverableCount!==siblings.length+1 || siblings.length+1<requested.count))) {
              throw new Error(`Core returned an invalid lifecycle open for update ${update.update_id}`);
            }
            type Draft = Extract<IntakeAnswer, { kind: 'done' }>['draft'];
            return { ...base, lifecycleAction: 'open-request', requestId: body.requestId,
              chatId: body.chatId, draft: body.draft as Draft,
              ...(siblings.length ? { siblings: (siblings as Array<{ requestId: string; draft: unknown }>)
                .map((s) => ({ requestId: s.requestId, draft: s.draft as NonNullable<Draft> })) } : {}) };
          }
          if (body.lifecycleAction === 'new-brief-required' && body.chatId) {
            return { ...base, lifecycleAction: 'new-brief-required', chatId: body.chatId };
          }
          if (body.lifecycleAction === 'park-update') {
            if (body.code !== 'LIFECYCLE_MEDIA_NOT_ADMITTED' || !body.chatId || !body.reason) {
              throw new Error(`Core returned an invalid media hold for update ${update.update_id}`);
            }
            return { ...base, lifecycleAction: 'park-update', code: body.code,
              chatId: body.chatId, reason: body.reason };
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
          if (body.lifecycleAction === 'late-change') {
            const alert = body.officeAlert;
            const answer = body.chatAnswer;
            if (body.code !== 'LATE_REQUESTER_CHANGE' || !body.chatId || typeof body.requestId !== 'string' ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.requestId) ||
                !(LATE_CHANGE_STAGES as readonly string[]).includes(String(body.requestStage)) || !validAlert(alert) ||
                (answer !== undefined && (!answer || typeof answer.text !== 'string' || !answer.text ||
                  answer.text.length > 4000 || (answer.parseMode !== undefined && answer.parseMode !== 'HTML')))) {
              throw new Error(`Core returned an invalid late change for update ${update.update_id}`);
            }
            return { ...base, lifecycleAction: 'late-change', code: body.code, chatId: body.chatId,
              requestId: body.requestId, requestStage: body.requestStage as LateChangeStage,
              ...(alert ? { officeAlert: { chatId: String(alert.chatId), text: String(alert.text) } } : {}),
              ...officeAlertsOf(alert, body.officeAlerts),
              ...(answer ? { chatAnswer: { text: String(answer.text), ...(answer.parseMode === 'HTML' ? { parseMode: 'HTML' as const } : {}) } } : {}) };
          }
          if (body.lifecycleAction === 'request-choice-required' && body.chatId &&
              (body.code === 'AMBIGUOUS_REQUEST' || body.code === 'STALE_REQUEST_REPLY')) {
            return { ...base, lifecycleAction: 'request-choice-required',
              chatId: body.chatId, code: body.code };
          }
          if (body.lifecycleAction === 'revision-blocked' && body.chatId &&
              (body.code === 'DAILY_CAP_REACHED' || body.code === 'PARENT_BRIEF_MISSING' ||
                body.code === 'QUESTION_MISSING')) {
            const alert = body.officeAlert;
            if (!validAlert(alert)) throw new Error(`Core returned an invalid revision block for update ${update.update_id}`);
            return { ...base, lifecycleAction: 'revision-blocked',
              chatId: body.chatId, code: body.code,
              // ADR-145: the words the requester sent go to the office, which makes the change.
              ...(alert ? { officeAlert: { chatId: String(alert.chatId), text: String(alert.text) } } : {}),
              ...officeAlertsOf(alert, body.officeAlerts) };
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

    async overdueSettles(): Promise<Array<{ chatId: string; update: TelegramUpdateLike }>> {
      const res = await doFetch(`${base}/v1/internal/telegram/settle-sweep`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json', 'x-request-id': 'settle-sweep' },
        body: JSON.stringify({ v: 1 }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await res.json().catch(() => ({}))) as { v?: number; due?: unknown };
      if (!res.ok || body.v !== 1 || !Array.isArray(body.due)) throw new Error(`Core did not list overdue settles: HTTP ${res.status}`);
      return body.due.filter((item): item is { chatId: string; update: TelegramUpdateLike } =>
        Boolean(item) && typeof item.chatId === 'string' && /^-?\d{1,20}$/.test(item.chatId) &&
        Number.isSafeInteger(item.update?.update_id) && item.update.update_id > 0);
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
