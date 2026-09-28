import { describe, it, expect, vi, afterEach } from 'vitest';
import { escapeTelegramHtml, escapeTelegramMarkdown, TelegramBridgeDaemon } from '../src/telegram-bridge.js';

describe('escapeTelegramHtml', () => {
  it('neutralises every character Telegram HTML parse mode treats specially', () => {
    expect(escapeTelegramHtml('Tom & Jerry <script>alert("x")</script>')).toBe('Tom &amp; Jerry &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });
  it('tolerates missing values and non-strings', () => {
    expect(escapeTelegramHtml(undefined)).toBe('');
    expect(escapeTelegramHtml(null)).toBe('');
    expect(escapeTelegramHtml(42)).toBe('42');
  });
});

describe('escapeTelegramMarkdown', () => {
  it('neutralises special markdown syntax characters', () => {
    expect(escapeTelegramMarkdown('Project_Title *Draft* `code` [link]')).toBe('Project\\_Title \\*Draft\\* \\`code\\` \\[link]');
  });
  it('tolerates empty and non-string inputs', () => {
    expect(escapeTelegramMarkdown(undefined)).toBe('');
    expect(escapeTelegramMarkdown(null)).toBe('');
    expect(escapeTelegramMarkdown(100)).toBe('100');
  });
});

describe('TelegramBridgeDaemon outbound resilience', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries dispatchOutboundMessage as plain text when markdown entity parse fails', async () => {
    const bridge = new TelegramBridgeDaemon({ botToken: 'test_token' });
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      callCount++;
      const body = JSON.parse(init?.body as string);
      if (callCount === 1) {
        // First attempt with parse_mode: 'Markdown' fails with entity parse error
        expect(body.parse_mode).toBe('Markdown');
        return Response.json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, { status: 400 });
      }
      // Second retry attempt omits parse_mode
      expect(body.parse_mode).toBeUndefined();
      return Response.json({ ok: true, result: { message_id: 8841, chat: { id: 12345 } } });
    }));

    const res = await bridge.dispatchOutboundMessage(12345, {
      text: 'Malformed *unclosed markdown',
      parse_mode: 'Markdown',
    });

    expect(res.success).toBe(true);
    expect(res.messageId).toBe('8841');
    expect(callCount).toBe(2);
  });

  it('reports truthful error in dispatchOutboundPhoto when token is unconfigured or request fails', async () => {
    const unconfigured = new TelegramBridgeDaemon({});
    const unconfiguredRes = await unconfigured.dispatchOutboundPhoto(12345, Buffer.from('test'));
    expect(unconfiguredRes.success).toBe(false);
    expect(unconfiguredRes.error).toBe('TELEGRAM_NOT_CONFIGURED');

    const configured = new TelegramBridgeDaemon({ botToken: 'test_token' });
    vi.stubGlobal('fetch', vi.fn(async () => {
      return Response.json({ ok: false, error_code: 500, description: 'Internal server error' }, { status: 500 });
    }));

    const failedRes = await configured.dispatchOutboundPhoto(12345, Buffer.from('test'));
    expect(failedRes.success).toBe(false);
    expect(failedRes).toEqual({ success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' });
  });
});
