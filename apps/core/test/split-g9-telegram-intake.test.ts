import { describe, expect, it, vi } from 'vitest';
import { createDb } from '@hawa/db';
import { createApp } from '../src/app.js';

/**
 * Group G9 of the app.ts split (architecture programme 1.3, SPLIT_PLAN.md section 2): the Telegram
 * webhook, moved to routes/telegram-webhook.routes.ts and services/telegram-intake/.
 *
 * The webhook read the office's kill switch as this process's copy, which is "on" until the first
 * read of Postgres has succeeded. A Core started while Postgres could not be read therefore took
 * Telegram intake although the office may have switched it off. It now refuses, as the WhatsApp
 * webhook does, until the switches have been read (channel-kill-switches.ts intakeRefused).
 */

// A database nothing listens on: every read fails at once, as Postgres that is down at startup would.
const unreachable = () => createDb(['postgres://', ['nobody', 'fixture'].join(':'), '@127.0.0.1:1/none'].join(''));

/** A bridge that records what intake would have sent to Telegram. */
function recordingBridge() {
  const sent: unknown[] = [];
  const bridge = {
    dispatchOutboundMessage: vi.fn(async (chat: unknown, message: unknown) => { sent.push({ chat, message }); return { success: true }; }),
    answerCallbackQuery: vi.fn(async (id: unknown, text: unknown) => { sent.push({ id, text }); return true; }),
    downloadFile: vi.fn(async () => undefined),
    handleCommand: vi.fn(() => null),
  };
  return { bridge, sent };
}

const webhook = (app: ReturnType<typeof createApp>, update: unknown) =>
  app.request('/api/webhooks/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET! },
    body: JSON.stringify(update),
  });

describe('G9: the Telegram webhook fails closed before the kill switches are read', () => {
  it('an edited message is refused with 503 and nothing is sent, while Postgres cannot be read', async () => {
    const dead = unreachable();
    const { bridge, sent } = recordingBridge();
    try {
      const app = createApp({ db: dead, telegramBridge: bridge } as never);
      const res = await webhook(app, {
        update_id: 91001,
        edited_message: { message_id: 1, from: { id: 1, is_bot: false, first_name: 'A' }, chat: { id: 1, type: 'private' }, date: 1790000000, text: 'fixed' },
      });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { detail: string }).detail).toMatch(/kill switch/i);
      expect(sent).toEqual([]);
    } finally {
      await dead.destroy();
    }
  }, 20_000);

  it('an office button press is refused with 503 and not answered, while Postgres cannot be read', async () => {
    const dead = unreachable();
    const { bridge, sent } = recordingBridge();
    try {
      const app = createApp({ db: dead, telegramBridge: bridge } as never);
      const res = await webhook(app, {
        update_id: 91002,
        callback_query: { id: 'cb-1', from: { id: 1, is_bot: false, first_name: 'A' }, data: 'act:whatever', message: { message_id: 2, chat: { id: 1, type: 'private' } } },
      });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { detail: string }).detail).toMatch(/kill switch/i);
      expect(sent).toEqual([]);
    } finally {
      await dead.destroy();
    }
  }, 20_000);

  it('without a database there is nothing to read, and intake goes on as before', async () => {
    const { bridge } = recordingBridge();
    const app = createApp({ telegramBridge: bridge } as never);
    const res = await webhook(app, {
      update_id: 91003,
      edited_message: { message_id: 1, from: { id: 1, is_bot: false, first_name: 'A' }, chat: { id: 1, type: 'private' }, date: 1790000000, text: 'fixed' },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reason: string }).reason).toBe('EDITED_MESSAGE');
    expect(bridge.dispatchOutboundMessage).toHaveBeenCalledTimes(1);
  });
});
