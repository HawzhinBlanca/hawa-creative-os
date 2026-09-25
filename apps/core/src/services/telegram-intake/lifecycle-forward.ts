/**
 * Core routes an intake decision itself, through Restate's ingress, when the update did not come
 * through a ChatInbox that routes (review of slice 2.3 part C):
 *  - Core's own poller (the 2.1 rollback, HAWA_TELEGRAM_POLLER=core) or a real webhook: a button,
 *    answer or change aimed at a request the lifecycle owns was refused 409, which is final for the
 *    poller, and the requester heard nothing;
 *  - a ChatInbox built before 2.3C (the blue colour during a rollback), which reads a decision as
 *    "done": the update was never routed, and its decision record made every retry the same.
 * The sends are the ones ChatInbox makes (routedSendsOf in @hawa/domain), with the same idempotency
 * keys, so an update routed by both reaches RequestLifecycle once. Restate's one-way send
 * (`/<service>/<key>/<handler>/send`) answers as soon as the invocation is enqueued; nothing here waits
 * for the lifecycle.
 */
import type { IntakeDecision } from '@hawa/contracts';
import { routedSendsOf, type RoutableUpdate } from '@hawa/domain';
import { log } from '../../logging.js';

export type ForwardResult =
  | { ok: true; sends: number }
  /** `configured: false`: Core has no RESTATE_INGRESS_URL, so it cannot route at all. */
  | { ok: false; configured: boolean; reason: string };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Sends the decision's events and messages to Restate's ingress, in order; stops at the first failure. */
export async function forwardDecision(
  chat: string,
  update: RoutableUpdate,
  decision: IntakeDecision,
  options: { env?: Record<string, string | undefined>; fetch?: FetchLike } = {}
): Promise<ForwardResult> {
  const env = options.env ?? process.env;
  const ingress = (env.RESTATE_INGRESS_URL || '').trim().replace(/\/+$/, '');
  if (!ingress) return { ok: false, configured: false, reason: 'RESTATE_INGRESS_URL is not set' };
  const doFetch = options.fetch ?? fetch;
  const sends = routedSendsOf(chat, update, decision);
  for (const send of sends) {
    const url = `${ingress}/${send.service}/${encodeURIComponent(send.key)}/${send.handler}/send`;
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': send.idempotencyKey },
        body: JSON.stringify(send.payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
        return { ok: false, configured: true, reason: `Restate answered HTTP ${res.status} for ${send.service}.${send.handler} ${send.idempotencyKey}: ${detail}` };
      }
    } catch (err) {
      return { ok: false, configured: true, reason: `Restate did not answer for ${send.service}.${send.handler} ${send.idempotencyKey}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  log.info(`[TelegramIngress] update ${update.update_id} of chat ${chat} routed by Core to the request lifecycle (${decision.kind}, ${sends.length} send(s))`);
  return { ok: true, sends: sends.length };
}

/** What the requester is told when their update about a lifecycle request could not be passed on. */
export const LIFECYCLE_UNROUTED_NOTICE =
  '⚠️ <b>Your message about this design could not be passed on right now.</b>\n\n' +
  '<i>Please send it again in a few minutes. If it keeps happening, the office will follow up.</i>';
export const LIFECYCLE_UNROUTED_TOAST = 'Your tap could not be passed on right now. Please try again in a few minutes.';

interface NoticeBridge {
  answerCallbackQuery(id: string, text?: string, showAlert?: boolean): Promise<unknown>;
  dispatchOutboundMessage(chatId: string, message: { text: string; parse_mode?: 'HTML' }): Promise<{ success: boolean; error?: string }>;
}

export type UnroutedOutcome =
  | { outcome: 'routed'; sends: number }
  /** Restate did not take it: ask again later (the poller retries, and parks after its attempts). */
  | { outcome: 'retry'; reason: string }
  /** Core cannot route at all (no ingress): refused, and the requester was told. */
  | { outcome: 'refused'; reason: string };

/**
 * Routes a decision for a caller that does not route (Core's own poller, a webhook, a ChatInbox built
 * before 2.3C). When Core cannot reach Restate at all, a message-only decision (a notice to the
 * requester) is sent through Core's own bridge, and an event for a request is refused with the
 * requester told, rather than dropped in silence.
 */
export async function routeForCaller(
  bridge: NoticeBridge | undefined,
  chat: string,
  update: RoutableUpdate,
  decision: IntakeDecision,
  options: { env?: Record<string, string | undefined>; fetch?: FetchLike } = {}
): Promise<UnroutedOutcome> {
  const forwarded = await forwardDecision(chat, update, decision, options);
  if (forwarded.ok) return { outcome: 'routed', sends: forwarded.sends };
  if (forwarded.configured) {
    log.error(`[TelegramIngress] update ${update.update_id} of chat ${chat} could not be routed to the request lifecycle; it is asked again: ${forwarded.reason}`);
    return { outcome: 'retry', reason: forwarded.reason };
  }
  const messages = 'messages' in decision && Array.isArray(decision.messages) ? decision.messages : [];
  if (decision.kind === 'handled') {
    for (const m of messages) {
      if (m.kind === 'text' && m.text && m.chatId) {
        await bridge?.dispatchOutboundMessage(String(m.chatId), { text: m.text, ...(m.parseMode ? { parse_mode: m.parseMode } : {}) }).catch(() => undefined);
      }
    }
    return { outcome: 'routed', sends: 0 };
  }
  log.error(`[TelegramIngress] update ${update.update_id} of chat ${chat} targets a request the lifecycle owns, and Core cannot reach Restate (${forwarded.reason}); refused, and the requester told`);
  const callback = (update as { callback_query?: { id?: unknown } }).callback_query;
  if (callback?.id) await bridge?.answerCallbackQuery(String(callback.id), LIFECYCLE_UNROUTED_TOAST, true).catch(() => undefined);
  else if (chat) await bridge?.dispatchOutboundMessage(chat, { text: LIFECYCLE_UNROUTED_NOTICE, parse_mode: 'HTML' }).catch(() => undefined);
  return { outcome: 'refused', reason: forwarded.reason };
}
