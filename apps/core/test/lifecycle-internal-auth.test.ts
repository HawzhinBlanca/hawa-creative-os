import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';

/**
 * The worker's credential (Phase 2.1, PHASE2_DESIGN.md section 5 "Worker token = operator token").
 * The worker called Core with HAWA_BEARER_TOKEN, the operator's own key. The internal lifecycle API
 * takes HAWA_WORKER_TOKEN instead, as a `service` principal, and only there: that token opens nothing
 * else, and nothing else, the operator's and administrator's keys included, opens /v1/internal/*.
 */
const WORKER = ['worker', 'token', 'fixture'].join('_');
const INTAKE = '/v1/internal/telegram/intake';

function app(options: Record<string, unknown> = {}) {
  const bridge = {
    dispatchOutboundMessage: vi.fn().mockResolvedValue({ success: true }),
    downloadFile: vi.fn().mockResolvedValue(null),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    handleCommand: vi.fn().mockReturnValue(null),
  };
  return createApp({ telegramBridge: bridge as any, ...options } as any);
}
const body = () => JSON.stringify({ v: 1, mode: 'legacy', update: { update_id: 700_000 + Math.floor(Math.random() * 1e6), message: { message_id: 1, date: 1, from: { id: 42, is_bot: false, first_name: 'O' }, chat: { id: 56_000_000 + Math.floor(Math.random() * 1e6), type: 'private' }, text: `Staff meeting ${randomUUID()}\n\nSunday 10:00` } } });
const call = (a: ReturnType<typeof app>, path: string, headers: Record<string, string>, method = 'POST') =>
  a.request(path, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(method === 'POST' ? { body: body() } : {}) });

describe('HAWA_WORKER_TOKEN and /v1/internal/*', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('the worker token is accepted on /v1/internal/* as a service principal', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const res = await call(app(), INTAKE, { Authorization: `Bearer ${WORKER}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ v: 1, kind: 'handled' });
  });

  it('every other credential is refused there: operator, API and Desk keys, administrator, art director', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    vi.stubEnv('HAWA_API_KEY', ['api', 'key', 'fixture'].join('_'));
    vi.stubEnv('HAWA_DESK_SECRET', ['desk', 'secret', 'fixture'].join('_'));
    const a = app();
    for (const token of [process.env.HAWA_BEARER_TOKEN!, process.env.HAWA_API_KEY!, process.env.HAWA_DESK_SECRET!, process.env.HAWA_ADMIN_KEY!, process.env.HAWA_ART_DIRECTOR_KEY!, 'nonsense']) {
      expect((await call(a, INTAKE, { Authorization: `Bearer ${token}` })).status, `token ${token.slice(0, 6)}…`).toBe(401);
    }
    expect((await call(a, INTAKE, {})).status).toBe(401);
    // The Telegram webhook secret authenticates webhook deliveries only.
    expect((await call(a, INTAKE, { 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET! })).status).toBe(401);
  });

  it('a test harness principal or a role header does not open /v1/internal/* either', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    expect((await call(app({ testAuth: { principal: { role: 'administrator' }, roleHeader: true } }), INTAKE, { 'x-user-role': 'service' })).status).toBe(401);
    expect((await call(app({ bypassAuthWithoutDb: true }), INTAKE, {})).status).toBe(401);
  });

  it('the worker token opens nothing outside /v1/internal/*', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const a = app();
    for (const path of ['/v1/tasks', '/api/v1/tasks', '/tasks', '/v1/clients', '/v1/system/providers']) {
      expect((await call(a, path, { Authorization: `Bearer ${WORKER}` }, 'GET')).status, path).toBe(401);
    }
    expect((await call(a, '/v1/operations/kill-switch', { Authorization: `Bearer ${WORKER}` })).status).toBe(401);
  });

  it('without HAWA_WORKER_TOKEN, /v1/internal/* refuses everyone', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', '');
    const a = app();
    expect((await call(a, INTAKE, { Authorization: 'Bearer ' })).status).toBe(401);
    expect((await call(a, INTAKE, { Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` })).status).toBe(401);
  });

  it('a worker token that is also another key is refused, so the operator key never becomes a service key', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', process.env.HAWA_BEARER_TOKEN!);
    expect((await call(app(), INTAKE, { Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` })).status).toBe(401);
  });
});
