import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramBridgeDaemon, type TelegramUpdate } from '../src/telegram-bridge.js';
import { KAAE_CLIENT_ID } from '../src/waha-ingress.js';

describe('Telegram Live Ingress & Bidirectional Polling Bridge', () => {
  let bridge: TelegramBridgeDaemon;

  beforeEach(() => {
    bridge = new TelegramBridgeDaemon({
      botToken: 'mock_test_token',
      targetIngressUrl: 'http://127.0.0.1:8080/api/webhooks/telegram',
    });
    bridge.clearSentMessages();
  });

  it('normalizes Kurdish incoming update with full sender metadata', () => {
    const update: TelegramUpdate = {
      update_id: 10001,
      message: {
        message_id: 55,
        from: {
          id: 998877,
          is_bot: false,
          first_name: 'Hawzhin',
          username: 'hawzhin_official',
        },
        chat: {
          id: 998877,
          type: 'private',
        },
        date: 1725792000,
        text: 'کەمپینی فەرمیی باوەڕپێدانی زانکۆکانی کەی ئەی ئەی ئی ٢٠٢٦',
      },
    };

    const envelope = bridge.normalizeUpdate(update);
    expect(envelope).not.toBeNull();
    expect(envelope?.source.platform).toBe('telegram');
    expect(envelope?.source.senderId).toBe('998877');
    expect(envelope?.source.senderName).toBe('Hawzhin');
    expect(envelope?.source.username).toBe('hawzhin_official');
    expect(envelope?.content.text).toBe('کەمپینی فەرمیی باوەڕپێدانی زانکۆکانی کەی ئەی ئەی ئی ٢٠٢٦');
  });

  it('tracks offset and processes incoming updates in pollOnce', async () => {
    const mockUpdates: TelegramUpdate[] = [
      {
        update_id: 105,
        message: {
          message_id: 1,
          from: { id: 111, is_bot: false, first_name: 'Reporter' },
          chat: { id: 111, type: 'private' },
          date: 1725792000,
          text: '/status',
        },
      },
      {
        update_id: 106,
        message: {
          message_id: 2,
          from: { id: 222, is_bot: false, first_name: 'Partner' },
          chat: { id: 222, type: 'private' },
          date: 1725792005,
          text: 'New campaign request',
        },
      },
    ];

    // Mock global fetch for getUpdates
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      if (typeof url === 'string' && url.includes('getUpdates')) {
        return {
          ok: true,
          json: async () => ({ ok: true, result: mockUpdates }),
        } as any;
      }
      return { ok: true, json: async () => ({ ok: true }) } as any;
    });

    const received: TelegramUpdate[] = [];
    const count = await bridge.pollOnce(async (u) => {
      received.push(u);
    });

    expect(count).toBe(2);
    expect(received.length).toBe(2);
    expect(bridge.getStatus().lastUpdateId).toBe(106);

    fetchSpy.mockRestore();
  });

  it('formats review card with AWAITING_APPROVAL and valid Desk link', () => {
    const card = bridge.formatTaskPreviewCard({
      id: 'task-kaae-2026',
      docId: 'doc-kaae-announcement',
      title: 'KAAE 2026 Institutional Quality Accreditation',
      copy: 'دەستپێکردنی خولی باوەڕپێدانی زانکۆکان بۆ ساڵی ٢٠٢٦',
      status: 'AWAITING_APPROVAL',
      clientName: 'KAAE (Accreditation)',
      deskBaseUrl: 'http://127.0.0.1:8080',
    });

    expect(card.text).toContain('Task Ready for Operator Review');
    expect(card.text).toContain('KAAE (Accreditation)');
    expect(card.text).toContain('http://127.0.0.1:8080/review?doc=doc-kaae-announcement&taskId=task-kaae-2026&mode=review');
    expect(card.reply_markup.inline_keyboard[0][0].text).toBe('✅ Approve & Publish');
    expect(card.reply_markup.inline_keyboard[0][0].callback_data).toContain('approve:task-kaae-2026:');
    expect(card.reply_markup.inline_keyboard[0][1].text).toBe('✏️ Request Revision');
    expect(card.reply_markup.inline_keyboard[0][1].callback_data).toContain('revision:task-kaae-2026:');
    expect(card.reply_markup.inline_keyboard[1][0].text).toBe('⚡ Open Desk Studio');
  });
});
