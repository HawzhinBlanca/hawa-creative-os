import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApp } from '../src/app.js';

describe('production authentication cannot be self-issued', () => {
  beforeEach(() => { vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('HAWA_ADMIN_KEY', ''); vi.stubEnv('HAWA_REVIEWER_KEY', ''); vi.stubEnv('HAWA_ART_DIRECTOR_KEY', ''); vi.stubEnv('HAWA_BEARER_TOKEN', ''); vi.stubEnv('HAWA_API_KEY', ''); });
  afterEach(() => vi.unstubAllEnvs());
  it.each(['admin@hawa.office', 'artdirector@hawa.office', 'operator@hawa.office'])('does not authenticate a typed email: %s', email => {
    return createApp().request('/auth/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, role: 'administrator' }) }).then(async response => {
      expect(response.status).toBe(401); expect((await response.json()).token).toBeUndefined();
    });
  });
  it.each(['hawa_test_suite_operator_bearer_token','test_art_director_bearer','test_bearer','hawa_admin_sec_2026_99f3b817'])('rejects shipped test/default key %s', async token => {
    const app = createApp();
    expect((await app.request('/v1/tasks/00000000-0000-4000-a000-000000000001/editor-url', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await app.request('/auth/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: token }) })).status).toBe(401);
  });
  it('configured operator credential does not become an admin from a requested role', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'isolated-operator-secret');
    const response = await createApp().request('/auth/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'isolated-operator-secret', email: 'admin@hawa.office', role: 'administrator' }) });
    expect(response.status).toBe(201); expect((await response.json()).user.role).toBe('operator');
  });
});
