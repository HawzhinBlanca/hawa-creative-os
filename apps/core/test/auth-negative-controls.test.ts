import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../src/app.js';

describe('Phase 0 Security & Authentication Negative Controls', () => {
  const originalEnv = { ...process.env };
  const testAdminKey = 'cfg_adm_9941';
  const testOperatorToken = 'cfg_op_1123';
  const testWebhookSecret = 'cfg_tg_5521';

  beforeAll(() => {
    process.env.HAWA_ADMIN_KEY = testAdminKey;
    process.env.HAWA_BEARER_TOKEN = testOperatorToken;
    process.env.TELEGRAM_WEBHOOK_SECRET = testWebhookSecret;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const app = createApp();

  describe('1. Literal String Secrets Denied (Zero Hardcoded Bypasses)', () => {
    const revokedLiteralSecrets = [
      'hawa_production_admin_key_entropy_9912',
      'hawa_live_session_token_2026',
      'kaae_office_secret_production_entropy_99f3b817',
      'hawa_production_desk_secret_entropy_8842',
      'test_art_director_token',
      'short_bypass',
      '',
    ];

    for (const secret of revokedLiteralSecrets) {
      it(`denies access with revoked literal token "${secret || '(empty)'}"`, async () => {
        const res = await app.request('/v1/tasks', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${secret}`,
          },
        });
        expect(res.status).toBe(401);
      });
    }
  });

  describe('2. Telegram Webhook Secret Hardening', () => {
    // The Telegram webhook was removed by stage 2 of ADR-135 (the worker polls and hands each update to
    // POST /v1/internal/telegram/intake with its own token). No secret, configured or revoked, reaches
    // an intake through it any more.
    it('has no Telegram webhook left for any secret to reach', async () => {
      for (const path of ['/api/webhooks/telegram', '/v1/webhooks/telegram', '/webhooks/telegram']) {
        for (const secret of [testWebhookSecret, 'kaae_office_secret_production_entropy_99f3b817', 'expected_office_secret']) {
          const res = await app.request(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
            body: JSON.stringify({ update_id: 101, message: { message_id: 1, chat: { id: 1, type: 'private' }, date: 1790000000, text: 'hello' } }),
          });
          expect(res.status, `${path} with ${secret}`).toBe(404);
        }
      }
    });

    it('rejects anonymous reads of client, task and operations data', async () => {
      for (const path of ['/v1/clients', '/v1/operations/failures', '/v1/tasks', '/v1/migration/ledger']) {
        const res = await app.request(path, { headers: { 'x-enforce-auth': '1' } });
        expect(res.status, path).toBe(401);
      }
      expect((await app.request('/v1/system/studio-status')).status).toBe(200);
    });

    it('never accepts the webhook secret as an operator credential for the API', async () => {
      const res = await app.request('/v1/tasks', {
        headers: { 'x-telegram-bot-api-secret-token': testWebhookSecret },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('3. System Providers Endpoint Protection', () => {
    it('rejects anonymous GET /v1/system/providers with 401', async () => {
      const res = await app.request('/v1/system/providers', { method: 'GET' });
      expect(res.status).toBe(401);
    });

    it('rejects anonymous POST /v1/system/providers with 401', async () => {
      const res = await app.request('/v1/system/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geminiApiKey: 'forged_key' }),
      });
      expect(res.status).toBe(401);
    });

    it('rejects operator-level POST /v1/system/providers with 401 (requires admin)', async () => {
      const res = await app.request('/v1/system/providers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${testOperatorToken}`,
        },
        body: JSON.stringify({ geminiApiKey: 'forged_key' }),
      });
      expect(res.status).toBe(401);
    });

    it('allows admin-level POST /v1/system/providers with valid admin credentials', async () => {
      const res = await app.request('/v1/system/providers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${testAdminKey}`,
        },
        body: JSON.stringify({ wahaEndpoint: 'http://127.0.0.1:3000' }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe('4. Telegram Adapter Management Authentication', () => {
    it('rejects anonymous requests to Telegram webhook endpoints with 401', async () => {
      // Webhook registration and "poll now" were removed by stage 2 of ADR-135 (the worker is the only poller).
      const resDelete = await app.request('/v1/adapters/telegram/webhook/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dropPendingUpdates: true }),
      });
      expect(resDelete.status).toBe(401);

      const resInfo = await app.request('/v1/adapters/telegram/webhook/info', {
        method: 'GET',
      });
      expect(resInfo.status).toBe(401);
    });

    it('rejects non-admin operator requests to Telegram webhook modification with 403', async () => {
      const resDelete = await app.request('/v1/adapters/telegram/webhook/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${testOperatorToken}`,
        },
        body: JSON.stringify({ dropPendingUpdates: true }),
      });
      expect(resDelete.status).toBe(403);
    });

    it('rejects anonymous access to /v1/search with 401', async () => {
      const res = await app.request('/v1/search?q=drustee', {
        headers: { 'x-enforce-auth': 'true' },
      });
      expect(res.status).toBe(401);
    });

    it('rejects anonymous access to /v1/campaigns/:taskId/dispatch-review with 401', async () => {
      const res = await app.request('/v1/campaigns/task-123/dispatch-review', {
        method: 'POST',
        headers: { 'x-enforce-auth': 'true', 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '+9647501234567' }),
      });
      expect(res.status).toBe(401);
    });

    // ADR-128: the query fallback is retired. The token reached nginx's error log whenever a stored
    // file was missing, and nothing the Desk ships sends it (AuthorizedImage uses the header; an <img>
    // sends the session cookie).
    it('refuses a session in the access_token query parameter on studio media endpoints', async () => {
      const sessionRes = await app.request('/v1/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: testOperatorToken, role: 'operator', displayName: 'Test Operator' }),
      });
      expect(sessionRes.status).toBe(201);
      const session = await sessionRes.json();
      const media = '/v1/tasks/00000000-0000-0000-0000-000000000001/canva/studio/00000000-0000-0000-0000-000000000002/candidates/00000000-0000-0000-0000-000000000003/preview.png';

      expect((await app.request(`${media}?access_token=${session.token}`)).status).toBe(401);
      // The same session opens the same picture through the header or the session cookie: past
      // authentication (404/503 without a database), never 401.
      expect((await app.request(media, { headers: { Authorization: `Bearer ${session.token}` } })).status).not.toBe(401);
      expect((await app.request(media, { headers: { Cookie: `hawa_session=${session.token}` } })).status).not.toBe(401);
    });

    it('rejects access_token query parameter on sensitive non-media routes', async () => {
      const res = await app.request(`/v1/adapters/telegram/webhook/delete?access_token=${testOperatorToken}`, {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    });
  });
});
