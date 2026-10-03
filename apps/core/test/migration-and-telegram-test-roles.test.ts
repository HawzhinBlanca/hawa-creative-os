import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';

/**
 * Bug hunt 3: the historical-migration routes and GET /system/providers/test-telegram took any
 * signed-in role. Neither has a Desk caller; no provider is called here (no Telegram token is set,
 * and a refused role is answered before any fetch).
 */
const app = createAppWithClientFixtures({ testAuth: { principal: { role: 'art_director' }, roleHeader: true } });
const as = (role: string, method = 'GET', body?: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json', 'x-user-role': role, Authorization: 'Bearer role-header-test' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const doc = { documentId: 'doc-1', taskId: 'task-1', clientId: 'client-drustee', sourceFormat: 'psd' };
const writes: Array<[string, unknown]> = [
  ['/v1/migration/archive', doc],
  ['/v1/migration/migrate', doc],
  ['/v1/migration/reopen-sample', { canvaDesignId: 'DAF1', targetRole: 'title', updatedText: 'x' }],
  ['/v1/migration/rollback-sample', { documentId: 'doc-1' }],
];

afterEach(() => vi.unstubAllEnvs());

describe('historical migration routes (bug hunt 3)', () => {
  it.each(['requester', 'auditor', 'designer', 'approver', 'art_director', 'creative_director'])('%s cannot change the migration ledger', async (role) => {
    for (const [path, body] of writes) expect((await app.request(path, as(role, 'POST', body))).status, path).toBe(403);
  });
  it.each(['requester', 'designer', 'approver', 'art_director'])('%s cannot read the migration ledger', async (role) => {
    for (const path of ['/v1/migration/ledger', '/v1/migration/reconciliation']) expect((await app.request(path, as(role))).status, path).toBe(403);
  });
  it('an operator or administrator still can, and an auditor can read', async () => {
    for (const role of ['operator', 'administrator']) {
      for (const [path, body] of writes) expect((await app.request(path, as(role, 'POST', body))).status, `${role} ${path}`).not.toBe(403);
    }
    for (const role of ['operator', 'administrator', 'auditor']) {
      expect((await app.request('/v1/migration/ledger', as(role))).status, role).toBe(200);
      expect((await app.request('/v1/migration/reconciliation', as(role))).status, role).toBe(200);
    }
  });
});

describe('GET /system/providers/test-telegram (bug hunt 3)', () => {
  it.each(['operator', 'requester', 'auditor', 'designer', 'art_director'])('%s cannot make Core call Telegram', async (role) => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      expect((await app.request('/v1/system/providers/test-telegram', as(role))).status).toBe(403);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { fetcher.mockRestore(); }
  });
  it('an administrator may (no token here, so nothing is sent)', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    const res = await app.request('/v1/system/providers/test-telegram', as('administrator'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, message: 'Telegram bot token is not configured' });
  });
});
