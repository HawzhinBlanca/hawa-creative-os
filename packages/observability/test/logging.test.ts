import { afterEach, describe, expect, it } from 'vitest';
import {
  acceptRequestId,
  bindLogContext,
  captureLogs,
  createLogger,
  getLogContext,
  redactLogValue,
  requestIdHeaders,
  runWithLogContext,
} from '../src/index.js';

// Fixture secrets are built from parts so no scanner mistakes them for real ones.
const accessToken = ['sess', 'a1b2c3d4e5f6a7b8c9d0'].join('_');
const botToken = ['123456789', 'AAH-fixture_bot_token_value_0123456789'].join(':');
const apiKey = ['sk', 'fixture0123456789abcdefghij'].join('-');
const password = ['hunter', '2', 'fixture'].join('');

let capture: ReturnType<typeof captureLogs> | null = null;
afterEach(() => {
  capture?.restore();
  capture = null;
});

describe('the log context', () => {
  it('follows the work across awaits, timers and parallel branches, and stays apart between units of work', async () => {
    capture = captureLogs();
    const log = createLogger('core');
    const one = runWithLogContext({ requestId: 'req-one', tenantId: 't-1' }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      bindLogContext({ taskId: 'task-1' });
      await Promise.all([
        (async () => { await Promise.resolve(); log.info('branch a'); })(),
        new Promise<void>((r) => setImmediate(() => { log.warn('branch b'); r(); })),
      ]);
    });
    const two = runWithLogContext({ requestId: 'req-two' }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      log.error('other request');
    });
    await Promise.all([one, two]);
    log.info('outside');

    const byMsg = Object.fromEntries(capture.lines.map((l) => [l.msg, l]));
    expect(byMsg['branch a']).toMatchObject({ service: 'core', requestId: 'req-one', tenantId: 't-1', taskId: 'task-1', level: 'info' });
    expect(byMsg['branch b']).toMatchObject({ requestId: 'req-one', taskId: 'task-1', level: 'warn' });
    expect(byMsg['other request']).toMatchObject({ requestId: 'req-two', level: 'error' });
    expect(byMsg['other request'].taskId).toBeUndefined();
    expect(byMsg['outside'].requestId).toBeUndefined();
  });

  it('inherits the outer fields in a nested context and gives the header only inside one', async () => {
    expect(requestIdHeaders()).toEqual({});
    await runWithLogContext({ requestId: 'req-outer', tenantId: 't-9' }, async () => {
      await runWithLogContext({ chatId: '4242' }, async () => {
        expect(getLogContext()).toEqual({ requestId: 'req-outer', tenantId: 't-9', chatId: '4242' });
        expect(requestIdHeaders()).toEqual({ 'x-request-id': 'req-outer' });
      });
      expect(getLogContext()?.chatId).toBeUndefined();
    });
    expect(bindLogContext({ taskId: 'nowhere' })).toBe(false);
  });

  it('accepts only a plain request id from outside', () => {
    expect(acceptRequestId('tg-12345')).toBe('tg-12345');
    expect(acceptRequestId('a\nforged line')).toBeUndefined();
    expect(acceptRequestId('x'.repeat(129))).toBeUndefined();
    expect(acceptRequestId(undefined)).toBeUndefined();
  });
});

describe('the log serializer', () => {
  it('strips secret-named keys at any depth, and secrets inside strings and query strings', () => {
    const cleaned = JSON.stringify(redactLogValue({
      access_token: accessToken,
      headers: { Authorization: `Bearer ${accessToken}`, 'x-telegram-bot-api-secret-token': accessToken },
      nested: [{ botToken, clientSecret: apiKey, db_password: password, inputTokens: 1234 }],
      url: `/v1/events/stream?tenant=1&access_token=${accessToken}&x=2`,
      telegram: `https://api.telegram.org/bot${botToken}/sendMessage`,
      dsn: `postgres://hawa_app:${password}@postgres:5432/hawa`,
      note: `calling with ${apiKey}`,
    }));
    for (const secret of [accessToken, botToken, apiKey, password]) expect(cleaned).not.toContain(secret);
    const parsed = JSON.parse(cleaned);
    expect(parsed.access_token).toBe('[REDACTED]');
    expect(parsed.nested[0].inputTokens).toBe(1234);
    expect(parsed.url).toBe('/v1/events/stream?tenant=1&access_token=[REDACTED]&x=2');
  });

  it('applies to every written line: message, fields and errors', () => {
    capture = captureLogs();
    const log = createLogger('worker');
    const err = Object.assign(new Error(`fetch https://api.telegram.org/bot${botToken}/getMe failed`), { token: accessToken });
    log.error(`[x] GET /v1/stream?access_token=${accessToken} failed:`, err, { authorization: `Bearer ${accessToken}` });
    log.info({ password, taskId: 'task-7' }, 'fields first');
    const written = JSON.stringify(capture.lines);
    for (const secret of [accessToken, botToken, password]) expect(written).not.toContain(secret);
    const [first, second] = capture.lines;
    expect(first.msg).toBe('[x] GET /v1/stream?access_token=[REDACTED] failed:');
    expect((first as any).err.type).toBe('Error');
    expect((first as any).err.token).toBe('[REDACTED]');
    expect((first as any).detail.authorization).toBe('[REDACTED]');
    expect(second).toMatchObject({ msg: 'fields first', taskId: 'task-7', password: '[REDACTED]' });
  });
});
