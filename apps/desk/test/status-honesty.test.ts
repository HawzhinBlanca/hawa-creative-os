import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../src/api/client.js';
import {
  read,
  describeTelegramBridge,
  describeWebhookMode,
  describeWebhookDelivery,
  describeProvider,
} from '../src/services/statusReport.js';
import { SettingsScreen } from '../src/screens/SettingsScreen.js';
import { OpsScreen } from '../src/screens/OpsScreen.js';
import { EvalScreen, statsFromReport } from '../src/screens/EvalScreen.js';

const DESK_SRC = path.resolve(__dirname, '../src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a status the Desk cannot read stays unknown', () => {
  it('read() turns a failure into unknown with the reason, and a success into known', async () => {
    expect(await read(async () => ({ botConfigured: true }))).toEqual({ state: 'known', value: { botConfigured: true } });
    expect(await read(async () => { throw new Error('fetch failed'); })).toEqual({ state: 'unknown', reason: 'fetch failed' });
    expect(await read(async () => { throw 'no message'; })).toEqual({ state: 'unknown', reason: 'the server did not answer' });
  });

  it('apiClient throws on a network error and on every non-2xx answer, with what the server said', async () => {
    const json = (body: unknown, status: number) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(apiClient.operations.failures()).rejects.toThrow('Network error: fetch failed');

    vi.stubGlobal('fetch', vi.fn(async () => json({ title: 'Authentication Required', detail: 'Sign in to Hawa first' }, 401)));
    await expect(apiClient.operations.failures()).rejects.toMatchObject({ status: 401, message: 'Sign in to Hawa first' });
    expect(await read(() => apiClient.operations.failures())).toEqual({ state: 'unknown', reason: 'Sign in to Hawa first' });

    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: false, description: 'Bad Gateway from Telegram' }, 502)));
    await expect(apiClient.telegram.status()).rejects.toMatchObject({ status: 502, message: 'Bad Gateway from Telegram' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream down', { status: 503 })));
    await expect(apiClient.operations.slo()).rejects.toMatchObject({ status: 503, message: 'upstream down' });

    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [] }, 200)));
    await expect(apiClient.operations.failures()).resolves.toEqual({ items: [] });
  });

  it('the Telegram row says unknown on error and never names a bot or a healthy state it did not read', () => {
    const view = describeTelegramBridge({ state: 'unknown', reason: 'fetch failed' });
    expect(view).toEqual({ tone: 'unknown', label: 'status unknown', detail: 'Could not read the Telegram adapter: fetch failed' });
    expect(JSON.stringify(view)).not.toMatch(/healthy|configured|@/);

    expect(describeTelegramBridge({ state: 'loading' }).label).toBe('checking…');
    expect(describeWebhookMode({ state: 'unknown', reason: 'fetch failed' })).toMatchObject({ tone: 'unknown', label: 'unknown' });
  });

  it('the Telegram row reports what Core returned, including a missing token and a degraded bridge', () => {
    expect(describeTelegramBridge({ state: 'known', value: { botConfigured: false, botUsername: 'office_bot', bridge: { mode: 'live_polling' } } }))
      .toEqual({ tone: 'warn', label: 'token missing', detail: '@office_bot · polling' });
    expect(describeTelegramBridge({ state: 'known', value: { botConfigured: true, bridge: { mode: 'live_polling', degraded: true, lastError: 'ETIMEDOUT' } } }))
      .toEqual({ tone: 'warn', label: 'degraded', detail: 'bot name not reported · polling · last error: ETIMEDOUT' });
    expect(describeTelegramBridge({ state: 'known', value: { botConfigured: true, botUsername: 'office_bot', bridge: { mode: 'webhook_push' } } }))
      .toEqual({ tone: 'ok', label: 'token configured', detail: '@office_bot · webhook delivery' });
    expect(describeWebhookMode({ state: 'known', value: { bridge: { webhookActive: true, webhookUrl: 'https://office.example/api/webhooks/telegram' } } }))
      .toMatchObject({ tone: 'ok', detail: 'Push delivery to https://office.example/api/webhooks/telegram' });
  });

  it('provider tiles say unknown on error; nothing is reported as configured, Gemini included', () => {
    const unknown = { state: 'unknown' as const, reason: 'HTTP 401: Authentication required' };
    for (const key of ['gemini', 'openai', 'anthropic', 'telegram']) {
      expect(describeProvider(unknown, key)).toEqual({ configured: false, text: 'status unknown' });
    }
    const known = { state: 'known' as const, value: { openai: { configured: true }, anthropic: { configured: false } } };
    expect(describeProvider(known, 'openai')).toEqual({ configured: true, text: '✓ Configured' });
    expect(describeProvider(known, 'anthropic')).toEqual({ configured: false, text: 'Not configured' });
    expect(describeProvider(known, 'gemini')).toEqual({ configured: false, text: 'not reported' });
  });
});

describe('the webhook check relays Telegram and never tests with a secret from the browser', () => {
  it('reports a failed check as unknown, not as delivered', () => {
    expect(describeWebhookDelivery({ state: 'unknown', reason: 'HTTP 403: Only an administrator may change Telegram delivery or inspect configuration' }))
      .toEqual({ tone: 'error', text: 'Delivery status unknown: HTTP 403: Only an administrator may change Telegram delivery or inspect configuration' });
    expect(describeWebhookDelivery({ state: 'known', value: { info: { ok: false, description: 'getaddrinfo ENOTFOUND api.telegram.org' } } }))
      .toEqual({ tone: 'error', text: 'Delivery status unknown: Telegram did not answer the check (getaddrinfo ENOTFOUND api.telegram.org).' });
  });

  it('reports Telegram\'s own delivery state: no webhook, a recorded error, or no errors', () => {
    expect(describeWebhookDelivery({ state: 'known', value: { info: { ok: true, result: { url: '', pending_update_count: 0 } } } }))
      .toEqual({ tone: 'warn', text: 'No webhook is registered with Telegram; updates arrive only by polling. 0 update(s) waiting.' });
    expect(describeWebhookDelivery({ state: 'known', value: { info: { ok: true, result: {
      url: 'https://office.example/api/webhooks/telegram', pending_update_count: 3,
      last_error_date: 1789000000, last_error_message: 'Wrong response from the webhook: 401 Unauthorized',
    } } } })).toEqual({ tone: 'error', text: `Telegram reports its most recent delivery error to https://office.example/api/webhooks/telegram at ${new Date(1789000000 * 1000).toISOString()}: Wrong response from the webhook: 401 Unauthorized. 3 update(s) waiting.` });
    expect(describeWebhookDelivery({ state: 'known', value: { info: { ok: true, result: { url: 'https://office.example/api/webhooks/telegram', pending_update_count: 0 } } } }))
      .toEqual({ tone: 'ok', text: 'Telegram reports a webhook at https://office.example/api/webhooks/telegram with no delivery errors. 0 update(s) waiting.' });
  });

  it('no Desk source sends the Telegram webhook secret header or posts to the webhook', () => {
    const offenders = sourceFiles(DESK_SRC).filter((file) => {
      const text = fs.readFileSync(file, 'utf8');
      return /x-telegram-bot-api-secret-token/i.test(text) || /['"`]\/api\/webhooks\//.test(text);
    });
    expect(offenders.map((f) => path.relative(DESK_SRC, f))).toEqual([]);
  });
});

describe('screens show nothing invented before Core has answered', () => {
  it('Settings starts as checking, with no invented bot, ADC or provider state', () => {
    const html = renderToStaticMarkup(React.createElement(SettingsScreen));
    expect(html).toContain('checking…');
    expect(html).toContain('Check webhook');
    expect(html).not.toMatch(/hawdesign_official_bot|\bADC\b|hawzhin88|Test webhook|Fallback Engine|token configured/);
  });

  it('no Desk source claims Google ADC or names an account, modals included', () => {
    // Nothing in Core uses Application Default Credentials; Gemini is configured by GEMINI_API_KEY only.
    const offenders = sourceFiles(DESK_SRC).filter((file) => /\bADC\b|hawzhin88/.test(fs.readFileSync(file, 'utf8')));
    expect(offenders.map((f) => path.relative(DESK_SRC, f))).toEqual([]);
  });

  it('Ops starts with no counts, no sample budgets and no invented component health', () => {
    const html = renderToStaticMarkup(React.createElement(OpsScreen));
    expect(html).toContain('Telemetry not read yet');
    expect(html).not.toMatch(/Connected to Core Telemetry|Live telemetry active|14m|Aster Pharmacy Network|KAAE \(Accreditation Agency\)|PITR WAL archiving current|18 active durable invocations/);
    expect(html).toMatch(/<b>—<\/b><span>critical incidents<\/span>/);
  });

  it('Eval starts with no scores, and reads scores only from a report', () => {
    const html = renderToStaticMarkup(React.createElement(EvalScreen));
    expect(html).not.toMatch(/134|\$0\.012|60 cases|% pass</);
    const cards = html.slice(html.indexOf('<div class="score"'), html.indexOf('cases passed</span>'));
    expect(cards.match(/<b>(.*?)<\/b>/g)).toEqual(['<b>—</b>', '<b>—</b>', '<b>—</b>', '<b>—</b>']);
    // Core returns no admission-gate results, so the screen admits no model.
    expect(html).toContain('Not reported. Core does not return admission-gate results');
    expect(html).not.toMatch(/passed all admission gates|Gemini 3\.8 Flash|GPT-5\.6 Sol/);

    expect(statsFromReport(undefined)).toEqual({ copyGuard: '—', recall: '—', overall: '—', testsPassed: null, totalTests: null });
    expect(statsFromReport({executionStatus:'stopped',overallPassRate:100}).overall).toBe('—');
    expect(statsFromReport({
      routing: { totalCases: 60, passedCases: 58 },
      retrieval: { totalCases: 20, passedCases: 20, passRate: 100 },
      copyGuard: { totalCases: 4, passedCases: 3, passRate: 75 },
      overallPassRate: 96.25,
    })).toEqual({ copyGuard: '75%', recall: '100%', overall: '96%', testsPassed: 81, totalTests: 84 });
  });
});
