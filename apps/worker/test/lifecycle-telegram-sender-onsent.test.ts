import { describe, expect, it } from 'vitest';
import * as restate from '@restatedev/restate-sdk';
import type { LifecycleMessage, SendResult } from '@hawa/contracts';
import { FakeObjectContext } from '../../../packages/testkit/src/fake-restate-context.js';
import type { TelegramSender as BridgeLike, TelegramSendResult } from '../src/delivery-notification.js';
import { createTelegramSender, type TelegramSenderDeps } from '../src/lifecycle/telegram-sender.js';

/**
 * TelegramSender's part in the request lifecycle (slice 2.3 part B; PHASE2_DESIGN.md 2.6): a message
 * sent with `onSent` is reported back to its RequestLifecycle (messageSent, keyed sent:<key>), which
 * is what starts a draft's reminders; the requester's buttons go with the text; a tapped button is
 * answered. Courtesy messages here, so no send marks (Postgres) are involved.
 */
const CHAT = '9300101';
const at = Date.UTC(2026, 8, 27, 7, 0, 0);

function bridgeAnswering(answer: TelegramSendResult) {
  const calls: Array<{ method: string; chatId?: string; body?: unknown }> = [];
  const bridge: BridgeLike = {
    async dispatchOutboundMessage(chatId, message) { calls.push({ method: 'sendMessage', chatId: String(chatId), body: message }); return answer; },
    async dispatchOutboundDocument() { throw new Error('no documents here'); },
    async answerCallbackQuery(id, text) { calls.push({ method: 'answerCallbackQuery', body: { id, text } }); return true; },
  };
  return { bridge, calls };
}

const deps = (bridge: BridgeLike): TelegramSenderDeps => ({
  db: undefined,
  botToken: () => ['onsent', 'test', 'bot'].join('_'),
  bridge: () => bridge,
  readExportBytes: async () => null,
  officeChatId: () => '9000001',
});

async function send(bridge: BridgeLike, m: LifecycleMessage) {
  const service = createTelegramSender(deps(bridge));
  const ctx = new FakeObjectContext({ key: m.chatId, clock: () => at });
  const handler = (service as unknown as { object: { send: (c: restate.ObjectContext, m: LifecycleMessage) => Promise<SendResult> } }).object.send;
  const result = await handler(ctx as unknown as restate.ObjectContext, m);
  return { result, ctx };
}

const draft = (overrides: Partial<LifecycleMessage> = {}): LifecycleMessage => ({
  v: 1, key: 'req-1:2:msg:0', chatId: CHAT, kind: 'text', text: 'Your draft is ready.', class: 'courtesy', taskId: 'task-1',
  replyMarkup: { inline_keyboard: [[{ text: 'Looks good', callback_data: 'rq:ok:task-1' }]] },
  onSent: { requestId: 'req-1', what: 'draft', taskId: 'task-1' },
  ...overrides,
});

describe('TelegramSender and the request lifecycle', () => {
  it('a message sent with onSent reports messageSent to its RequestLifecycle, once, with the journaled time', async () => {
    const { bridge, calls } = bridgeAnswering({ success: true, messageId: '812' });
    const { result, ctx } = await send(bridge, draft());
    expect(result).toEqual({ outcome: 'sent', messageId: '812' });
    expect(calls[0].body).toMatchObject({ text: 'Your draft is ready.', reply_markup: { inline_keyboard: [[{ text: 'Looks good', callback_data: 'rq:ok:task-1' }]] } });
    expect(ctx.sends.map((s) => [s.service, s.key, s.handler, s.idempotencyKey, s.arg])).toEqual([
      ['RequestLifecycle', 'req-1', 'messageSent', 'sent:req-1:2:msg:0', { v: 1, eventId: 'sent:req-1:2:msg:0', key: 'req-1:2:msg:0', what: 'draft', taskId: 'task-1', messageId: '812', at }],
    ]);
  });

  it('one that may have arrived is reported as uncertain; one Telegram refused is not reported', async () => {
    const uncertain = await send(bridgeAnswering({ success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN: socket hang up' }).bridge, draft());
    expect(uncertain.result.outcome).toBe('uncertain');
    expect(uncertain.ctx.sends.map((s) => (s.arg as { uncertain?: boolean }).uncertain)).toEqual([true]);

    const refused = await send(bridgeAnswering({ success: false, error: 'TELEGRAM_REJECTED_403' }).bridge, draft());
    expect(refused.result.outcome).toBe('refused');
    expect(refused.ctx.sends).toEqual([]);
  });

  it('a message without onSent reports nothing', async () => {
    const { ctx } = await send(bridgeAnswering({ success: true }).bridge, draft({ onSent: undefined }));
    expect(ctx.sends).toEqual([]);
  });

  it('a tapped button is answered, as a courtesy', async () => {
    const { bridge, calls } = bridgeAnswering({ success: true });
    const { result } = await send(bridge, { v: 1, key: 'cb:cbq-9', chatId: CHAT, kind: 'callback_answer', callbackQueryId: 'cbq-9', class: 'courtesy' });
    expect(result).toEqual({ outcome: 'sent' });
    expect(calls).toEqual([{ method: 'answerCallbackQuery', body: { id: 'cbq-9', text: undefined } }]);
    const missing = await send(bridge, { v: 1, key: 'cb:none', chatId: CHAT, kind: 'callback_answer', class: 'courtesy' });
    expect(missing.result.outcome).toBe('refused');
  });
});
