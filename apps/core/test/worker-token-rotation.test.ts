import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { acceptedServiceTokensOf, workerSigningSecretOf } from '../src/routes/lifecycle-internal.routes.js';

/**
 * Phase 4 operations finding 4 (ADR-129). Core accepted exactly one worker credential. A deploy that
 * changed HAWA_WORKER_TOKEN recreated Core and the new colour with the new value, while the colour
 * still draining kept the old one: its pinned Delivery, ChatInbox and DesignRun calls got 401, and
 * what Core signed for it (decisions, delivery claims) no longer verified there.
 *
 * Rotation is now two deploys. The first sets HAWA_WORKER_TOKEN to the new value and
 * HAWA_WORKER_TOKEN_PREVIOUS to the old one: Core accepts both and keeps signing with the old one,
 * which every running colour can verify. The second, once the old colour has drained, removes
 * HAWA_WORKER_TOKEN_PREVIOUS.
 */
const CURRENT = ['rotation', 'current', 'fixture', 'value'].join('_');
const PREVIOUS = ['rotation', 'previous', 'fixture', 'value'].join('_');
const INTAKE = '/v1/internal/telegram/intake';

function app() {
  const bridge = {
    dispatchOutboundMessage: vi.fn().mockResolvedValue({ success: true }),
    downloadFile: vi.fn().mockResolvedValue(null),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    handleCommand: vi.fn().mockReturnValue(null),
  };
  return createApp({ telegramBridge: bridge as any } as any);
}
const intakeBody = () => JSON.stringify({ v: 1, mode: 'legacy', update: { update_id: 800_000 + Math.floor(Math.random() * 1e6), message: { message_id: 1, date: 1, from: { id: 42, is_bot: false, first_name: 'O' }, chat: { id: 57_000_000 + Math.floor(Math.random() * 1e6), type: 'private' }, text: `Staff meeting ${randomUUID()}\n\nSunday 10:00` } } });
const post = (a: ReturnType<typeof app>, path: string, token: string, body = intakeBody()) =>
  a.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body });

describe('HAWA_WORKER_TOKEN_PREVIOUS during a worker token rotation', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('Core accepts the previous token on /v1/internal/* while it is set, and not after', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', CURRENT);
    vi.stubEnv('HAWA_WORKER_TOKEN_PREVIOUS', PREVIOUS);
    expect((await post(app(), INTAKE, PREVIOUS)).status).toBe(200);
    expect((await post(app(), INTAKE, CURRENT)).status).toBe(200);
    expect((await post(app(), INTAKE, 'another_value_of_sixteen_plus')).status).toBe(401);
    vi.stubEnv('HAWA_WORKER_TOKEN_PREVIOUS', '');
    expect((await post(app(), INTAKE, PREVIOUS)).status).toBe(401);
  });

  it('the delivery routes accept the previous token too', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', CURRENT);
    vi.stubEnv('HAWA_WORKER_TOKEN_PREVIOUS', PREVIOUS);
    const path = `/v1/internal/lifecycle/${randomUUID()}/delivery-finished`;
    const body = JSON.stringify({ outcome: 'delivered' });
    expect((await post(app(), path, PREVIOUS, body)).status).not.toBe(401);
    expect((await post(app(), path, 'another_value_of_sixteen_plus', body)).status).toBe(401);
  });

  it('a previous token that is too short, equals another key, or equals the current one is not accepted', () => {
    const base = { HAWA_WORKER_TOKEN: CURRENT, HAWA_BEARER_TOKEN: ['operator', 'fixture', 'key', 'value'].join('_') };
    expect(acceptedServiceTokensOf({ ...base, HAWA_WORKER_TOKEN_PREVIOUS: PREVIOUS })).toEqual([CURRENT, PREVIOUS]);
    expect(acceptedServiceTokensOf({ ...base, HAWA_WORKER_TOKEN_PREVIOUS: 'short' })).toEqual([CURRENT]);
    expect(acceptedServiceTokensOf({ ...base, HAWA_WORKER_TOKEN_PREVIOUS: base.HAWA_BEARER_TOKEN })).toEqual([CURRENT]);
    expect(acceptedServiceTokensOf({ ...base, HAWA_WORKER_TOKEN_PREVIOUS: CURRENT })).toEqual([CURRENT]);
    expect(acceptedServiceTokensOf({ HAWA_WORKER_TOKEN_PREVIOUS: PREVIOUS })).toEqual([]);
  });

  it('Core signs with the previous token while it is set, so a colour still running the old value verifies it', () => {
    expect(workerSigningSecretOf({ HAWA_WORKER_TOKEN: CURRENT, HAWA_WORKER_TOKEN_PREVIOUS: PREVIOUS })).toBe(PREVIOUS);
    expect(workerSigningSecretOf({ HAWA_WORKER_TOKEN: CURRENT })).toBe(CURRENT);
    expect(workerSigningSecretOf({ HAWA_WORKER_TOKEN: CURRENT, HAWA_WORKER_TOKEN_PREVIOUS: 'short' })).toBe(CURRENT);
    expect(workerSigningSecretOf({})).toBeNull();
  });

  it('every place Core signs for the worker uses the signing secret, not HAWA_WORKER_TOKEN directly', () => {
    // The Desk's request-owned decision and delivery sign in services/office-decisions.ts since the
    // ADR-040 addendum (the Desk routes and the office's Telegram turn share them).
    for (const file of ['routes/native-review.routes.ts', 'services/office-decisions.ts', 'services/lifecycle-delivery-projection.ts']) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
      expect(source, file).toMatch(/workerSigningSecretOf\(\)/);
      expect(source, file).not.toMatch(/process\.env\.HAWA_WORKER_TOKEN/);
    }
    const proof = readFileSync(new URL('../src/routes/lifecycle-design-proof.ts', import.meta.url), 'utf8');
    expect(proof).toMatch(/acceptedServiceTokensOf\(\)/);
  });
});
