/**
 * Where an intake decision goes (architecture programme Phase 2, slice 2.3; PHASE2_DESIGN.md 2.2):
 * the one-way sends that route one Telegram update's decision to RequestLifecycle and TelegramSender,
 * each with the idempotency key that makes a second route of the same update a no-op.
 *
 * The worker's ChatInbox routes decisions with these sends. Core makes the same sends itself, through
 * Restate's ingress, when the update did not come through a ChatInbox that routes (Core's own poller
 * after a rollback to it, a webhook, or a ChatInbox built before slice 2.3 part C): one list of sends,
 * so both routes name the same events with the same keys and Restate keeps whichever came first.
 */
import type { AnswerEvent, IntakeDecision, OpenEvent, OutboundMessage, RequesterDecisionEvent } from '@hawa/contracts';
import { requestIdFor } from './request-lifecycle.js';

/** A Telegram update as far as routing reads it. */
export interface RoutableUpdate {
  update_id: number;
  [kind: string]: unknown;
}

export type RoutedSend =
  | { service: 'RequestLifecycle'; key: string; handler: 'open'; payload: OpenEvent; idempotencyKey: string }
  | { service: 'RequestLifecycle'; key: string; handler: 'answer'; payload: AnswerEvent; idempotencyKey: string }
  | { service: 'RequestLifecycle'; key: string; handler: 'requesterDecision'; payload: RequesterDecisionEvent; idempotencyKey: string }
  | { service: 'TelegramSender'; key: string; handler: 'send'; payload: OutboundMessage; idempotencyKey: string };

const DEFAULT_TENANT_ID = '00000000-0000-4000-a000-000000000001';

/** Who sent the update or pressed the button, for the lifecycle's record. */
export function updateSenderOf(update: RoutableUpdate): string {
  const u = update as { callback_query?: { from?: { id?: unknown } }; message?: { from?: { id?: unknown } } };
  const id = u.callback_query?.from?.id ?? u.message?.from?.id;
  return id === undefined || id === null ? '' : String(id);
}

/**
 * The sends of one decision, in order: the requests it opens or the event it hands to a request,
 * then the messages it carries. Keys are the update's (`tg:<chat>:<update>`) or the request's open
 * key (`open:<requestId>`); a message's own key is its idempotency key.
 */
export function routedSendsOf(chat: string, update: RoutableUpdate, decision: IntakeDecision): RoutedSend[] {
  const updateId = update.update_id;
  const eventId = `tg:${chat}:${updateId}`;
  const actorId = updateSenderOf(update);
  const sends: RoutedSend[] = [];
  switch (decision.kind) {
    case 'new_request':
      for (const r of decision.requests) {
        const requestId = requestIdFor(chat, updateId, r.index);
        sends.push({
          service: 'RequestLifecycle', key: requestId, handler: 'open', idempotencyKey: `open:${requestId}`,
          payload: {
            v: 1, eventId: `open:${requestId}`, requestId, tenantId: decision.tenantId ?? DEFAULT_TENANT_ID, chatId: chat,
            origin: { kind: 'telegram', chatId: chat, updateId }, draft: r.draft,
          },
        });
      }
      break;
    case 'answer':
      sends.push({
        service: 'RequestLifecycle', key: decision.requestId, handler: 'answer', idempotencyKey: eventId,
        payload: {
          v: 1, eventId, questionId: decision.questionId, answer: decision.answer, actorId,
          ...(decision.callbackQueryId ? { callbackQueryId: decision.callbackQueryId } : {}),
        },
      });
      break;
    case 'requester': {
      const size = decision.action === 'sst' || decision.action === 'ssq' || decision.action === 'sls';
      sends.push({
        service: 'RequestLifecycle', key: decision.requestId, handler: 'requesterDecision', idempotencyKey: eventId,
        payload: {
          v: 1, eventId, taskId: decision.taskId, kind: size ? 'size' : (decision.action as 'ok' | 'chg' | 'dsg'), actorId: decision.actorId || actorId,
          ...(size ? { sizeAction: decision.action } : {}),
          ...(decision.callbackQueryId ? { callbackQueryId: decision.callbackQueryId } : {}),
        },
      });
      break;
    }
    case 'change':
      sends.push({
        service: 'RequestLifecycle', key: decision.requestId, handler: 'requesterDecision', idempotencyKey: eventId,
        payload: {
          v: 1, eventId, taskId: decision.replyToTaskId, kind: 'change', directive: decision.directive, actorId,
          ...(decision.photoFileIds?.length ? { photoFileIds: decision.photoFileIds } : {}),
        },
      });
      break;
    default:
      break;
  }
  const messages = 'messages' in decision && Array.isArray(decision.messages) ? decision.messages : [];
  for (const m of messages) {
    if (m?.key && m.chatId) sends.push({ service: 'TelegramSender', key: String(m.chatId), handler: 'send', idempotencyKey: m.key, payload: { ...m, v: 1 } });
  }
  return sends;
}
