import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_TEXT_LIMIT,
  TelegramBridgeDaemon,
  fitTelegramText,
} from '../src/telegram-bridge.js';

/**
 * Telegram refuses a message over 4096 characters ("message is too long") and a caption over 1024.
 * Until 2026-09-23 the long message was refused, retried as plain text, refused again, and the
 * caller ignored success:false, so the requester heard nothing.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A 5000-character HTML message: bold titles, escaped entities, a link, one line per item. */
function longHtml(): string {
  const lines = ['<b>Delivery summary</b>'];
  for (let i = 0; lines.join('\n').length < 5000; i++) {
    lines.push(`<b>Item ${i}</b> — R&amp;D note &lt;draft&gt; <a href="https://example.test/${i}">open</a> <i>ok</i>`);
  }
  return lines.join('\n').slice(0, 5000);
}

/** Tags opened and not closed, the way Telegram's HTML parser would see them. */
function unbalanced(html: string): string[] {
  const open: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
    if (!m[1]) open.push(m[2]);
    else if (open[open.length - 1] === m[2]) open.pop();
    else return [`mismatched </${m[2]}>`];
  }
  return open;
}

describe('fitTelegramText', () => {
  it('leaves a message within the limit untouched', () => {
    expect(fitTelegramText('<b>short</b>', TELEGRAM_TEXT_LIMIT, 'HTML')).toBe('<b>short</b>');
  });

  it('cuts HTML at a line break, never inside a tag or entity, and says it was shortened', () => {
    const html = longHtml();
    expect(html.length).toBe(5000);
    const fitted = fitTelegramText(html, TELEGRAM_TEXT_LIMIT, 'HTML');
    expect(fitted.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(fitted.endsWith('\n…(shortened)')).toBe(true);
    const body = fitted.slice(0, -'\n…(shortened)'.length);
    expect(html.startsWith(body)).toBe(true);
    expect(html[body.length]).toBe('\n');
    expect(unbalanced(body)).toEqual([]);
    expect(body).not.toMatch(/&[a-z]*$/);
  });

  it('closes a tag the cut leaves open, and still fits', () => {
    const html = `<pre>${'x'.repeat(3000)}\n${'y'.repeat(3000)}</pre>`;
    const fitted = fitTelegramText(html, TELEGRAM_TEXT_LIMIT, 'HTML');
    expect(fitted.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(fitted).toBe(`<pre>${'x'.repeat(3000)}</pre>\n…(shortened)`);
  });

  it('backs out of a tag or entity when there is no line break to cut at', () => {
    // The plain cut would fall at 1011 characters: inside the <a ...> tag, then inside &amp;.
    const insideTag = `${'a'.repeat(999)} &amp; <a href="https://example.test/long">link</a> tail`;
    expect(fitTelegramText(insideTag, TELEGRAM_CAPTION_LIMIT, 'HTML')).toBe(`${'a'.repeat(999)} &amp; \n…(shortened)`);
    const insideEntity = `${'a'.repeat(1008)} &amp; more text after the entity`;
    expect(fitTelegramText(insideEntity, TELEGRAM_CAPTION_LIMIT, 'HTML')).toBe(`${'a'.repeat(1008)} \n…(shortened)`);
  });

  it('never splits an emoji', () => {
    const fitted = fitTelegramText('😀'.repeat(3000), TELEGRAM_TEXT_LIMIT);
    expect(fitted.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(fitted.replace('\n…(shortened)', '')).toMatch(/^(😀)+$/u);
  });
});

describe('TelegramBridgeDaemon sends long text shortened instead of losing it', () => {
  it('sends a 5000-character HTML message cut to 4096, and the plain retry within it too', async () => {
    const sent: Array<{ text: string; parse_mode?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      sent.push(body);
      if (body.text.length > TELEGRAM_TEXT_LIMIT) {
        return Response.json({ ok: false, error_code: 400, description: 'Bad Request: message is too long' }, { status: 400 });
      }
      if (body.parse_mode) {
        // Force the plain-text retry, to check it is cut as well.
        return Response.json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, { status: 400 });
      }
      return Response.json({ ok: true, result: { message_id: 9, chat: { id: 123 } } });
    }));

    const bridge = new TelegramBridgeDaemon({ botToken: 'test' });
    const res = await bridge.dispatchOutboundMessage(123, { text: longHtml(), parse_mode: 'HTML' });

    expect(res).toEqual({ success: true, messageId: '9' });
    expect(sent).toHaveLength(2);
    expect(sent[0].parse_mode).toBe('HTML');
    for (const body of sent) expect(body.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(bridge.getSentMessages()[0].text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
  });

  it('keeps an HTML document caption within 1024 without cutting a tag', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true, result: { message_id: 7, chat: { id: 123 } } }));
    const caption = `<b>${'Design '.repeat(200)}</b>`;
    const bridge = new TelegramBridgeDaemon({ botToken: 'test' });
    await bridge.dispatchOutboundDocument(123, new Uint8Array([1]), 'a.png', { caption, parseMode: 'HTML' });
    const form = fetch.mock.calls[0][1]?.body as FormData;
    const sentCaption = String(form.get('caption'));
    expect(sentCaption.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
    expect(unbalanced(sentCaption)).toEqual([]);
  });

  it('cuts a long photo caption on the plain fallback too', async () => {
    const captions: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      captions.push(String((init?.body as FormData).get('caption')));
      return captions.length === 1
        ? Response.json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, { status: 400 })
        : Response.json({ ok: true, result: { message_id: 8, chat: { id: 123 } } });
    }));
    const bridge = new TelegramBridgeDaemon({ botToken: 'test' });
    const res = await bridge.dispatchOutboundPhoto(123, Buffer.from('png'), 'Caption line\n'.repeat(200));
    expect(res).toEqual({ success: true, messageId: '8' });
    expect(captions).toHaveLength(2);
    expect(captions[1].length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
  });
});
