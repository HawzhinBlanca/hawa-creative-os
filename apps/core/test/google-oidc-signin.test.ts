import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql } from '@hawa/db';
import { createApp } from '../src/app.js';
import { googleOidcSettings, officeIdentityFromClaims, type OfficeOidcIdentity, type OfficeOidcProvider } from '../src/services/google-oidc.js';

const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const appDb = createDb(process.env.TEST_DATABASE_URL!);
const tenantId = '00000000-0000-4000-a000-000000000001';
const userId = randomUUID();
const subject = `google-${randomUUID()}`;
let identity: OfficeOidcIdentity = {
  subject, email: `reviewer-${userId}@example.test`, displayName: 'Named Reviewer', hostedDomain: 'example.test',
};
let lastStart: { state: string; nonce: string; codeChallenge: string } | null = null;
const provider: OfficeOidcProvider = {
  async authorizationUrl(input) {
    lastStart = input;
    return `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(input.state)}`;
  },
  async exchange(input) {
    if (!lastStart || input.state !== lastStart.state || input.nonce !== lastStart.nonce ||
        !input.codeVerifier || !input.callbackQuery.includes('code=fixture')) throw new Error('Invalid code flow');
    return identity;
  },
};

beforeAll(async () => {
  await sql`INSERT INTO hawa.users(id,email,display_name,external_subject)
    VALUES (${userId}::uuid,${identity.email},'Named Reviewer',${subject})`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role,active)
    VALUES (${tenantId}::uuid,${userId}::uuid,'approver',true)`.execute(owner);
});
afterAll(async () => {
  await sql`DELETE FROM hawa.desk_sessions WHERE user_id=${userId}::uuid`.execute(owner);
  await sql`DELETE FROM hawa.tenant_memberships WHERE user_id=${userId}::uuid`.execute(owner);
  await sql`DELETE FROM hawa.users WHERE id=${userId}::uuid`.execute(owner);
  await Promise.all([owner.destroy(), appDb.destroy()]);
});

function newApp() {
  return createApp({ db: appDb, testAuth: { googleOidcProvider: provider }, skipPaidModelProbe: true });
}

async function start(app: ReturnType<typeof newApp>, query = '') {
  const response = await app.request(`/v1/auth/google/start${query}`);
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toContain('accounts.google.com');
  expect(lastStart?.codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
  const stateCookie = response.headers.get('set-cookie')?.match(/hawa_oidc_state=([^;]+)/)?.[1];
  expect(stateCookie).toBeTruthy();
  return { state: lastStart!.state, cookie: `hawa_oidc_state=${stateCookie}` };
}

describe('ADR-064 named Google Workspace sign-in', () => {
  it('returns to the exact review task across a fresh Core callback and ignores callback redirect injection', async () => {
    const taskId = randomUUID();
    const revisionId = randomUUID();
    const flow = await start(newApp(), `?task=${taskId}&revision=${revisionId}`);
    const response = await newApp().request(`/v1/auth/google/callback?state=${flow.state}&code=fixture&task=${randomUUID()}&returnTo=https://outside.test`,
      { headers: { Cookie: flow.cookie } });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/#/work?task=${taskId}&revision=${revisionId}`);
  });

  it('refuses malformed review destinations before creating an OAuth flow', async () => {
    const app = newApp();
    for (const query of ['?task=https://outside.test', `?revision=${randomUUID()}`,
      `?task=${randomUUID()}&task=${randomUUID()}`, `?returnTo=https://outside.test`]) {
      expect((await app.request(`/v1/auth/google/start${query}`)).status, query).toBe(422);
    }
  });

  it('rejects incomplete, insecure or unscoped provider configuration', () => {
    expect(googleOidcSettings({})).toBeNull();
    expect(googleOidcSettings({ HAWA_GOOGLE_OIDC_CLIENT_ID: 'id', HAWA_GOOGLE_OIDC_CLIENT_SECRET: 'secret',
      HAWA_GOOGLE_OIDC_REDIRECT_URI: 'http://office.test/v1/auth/google/callback',
      HAWA_GOOGLE_OIDC_HOSTED_DOMAINS: 'example.test' })).toBeNull();
    expect(googleOidcSettings({ HAWA_GOOGLE_OIDC_CLIENT_ID: 'id', HAWA_GOOGLE_OIDC_CLIENT_SECRET: 'secret',
      HAWA_GOOGLE_OIDC_REDIRECT_URI: 'https://office.test/v1/auth/google/callback',
      HAWA_GOOGLE_OIDC_HOSTED_DOMAINS: 'example.test' })?.hostedDomains).toEqual(['example.test']);
  });

  it('requires the verified email and Workspace hosted-domain claims after token validation', () => {
    const settings = googleOidcSettings({ HAWA_GOOGLE_OIDC_CLIENT_ID: 'id', HAWA_GOOGLE_OIDC_CLIENT_SECRET: 'secret',
      HAWA_GOOGLE_OIDC_REDIRECT_URI: 'https://office.test/v1/auth/google/callback',
      HAWA_GOOGLE_OIDC_HOSTED_DOMAINS: 'example.test' })!;
    const claims = { sub: subject, email: identity.email, email_verified: true,
      hd: 'example.test', name: 'Named Reviewer' };
    expect(officeIdentityFromClaims(claims, settings).subject).toBe(subject);
    for (const changed of [{ ...claims, email_verified: false }, { ...claims, hd: 'outside.test' },
      { ...claims, hd: undefined }, { ...claims, sub: '' }, { ...claims, email: undefined }]) {
      expect(() => officeIdentityFromClaims(changed, settings)).toThrow('configured, verified Workspace');
    }
  });

  it('issues a durable cookie session only for a pre-provisioned, active named member and revokes it', async () => {
    vi.stubEnv('HAWA_GOOGLE_OIDC_CLIENT_ID', 'test-client');
    vi.stubEnv('HAWA_GOOGLE_OIDC_CLIENT_SECRET', 'test-client-secret');
    vi.stubEnv('HAWA_GOOGLE_OIDC_REDIRECT_URI', 'https://desk.office.example/v1/auth/google/callback');
    vi.stubEnv('HAWA_GOOGLE_OIDC_HOSTED_DOMAINS', 'example.test');
    const app = newApp();
    vi.unstubAllEnvs();
    expect(await (await app.request('/v1/auth/providers')).json()).toEqual({ googleWorkspace: true, trustedOffice: false });
    const flow = await start(app);
    const callback = await app.request(`/v1/auth/google/callback?state=${encodeURIComponent(flow.state)}&code=fixture`,
      { headers: { Cookie: flow.cookie } });
    expect(callback.status, callback.status === 303 ? '' : JSON.stringify(await callback.clone().json())).toBe(303);
    const cookies = callback.headers.getSetCookie().join('; ');
    const token = cookies.match(/hawa_session=([^;]+)/)?.[1];
    const csrf = cookies.match(/hawa_csrf=([^;]+)/)?.[1];
    expect(token).toMatch(/^hawa_sess_/);
    expect(csrf).toMatch(/^[a-f0-9]{64}$/);
    expect(cookies).toContain('HttpOnly');
    expect(cookies).toContain('Secure');
    const authCookie = `hawa_session=${token}; hawa_csrf=${csrf}`;
    const session = await app.request('/v1/auth/session', { headers: { Cookie: authCookie } });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ user: { id: userId, role: 'approver', authMethod: 'google_oidc' } });
    expect((await app.request('/v1/auth/stream-ticket', { method: 'POST', headers: { Cookie: authCookie } })).status).toBe(403);
    expect((await app.request('http://app:3000/v1/auth/stream-ticket', { method: 'POST',
      headers: { Cookie: authCookie, 'x-hawa-csrf': csrf!, Origin: 'https://desk.office.example' } })).status).toBe(201);
    expect((await app.request('http://app:3000/v1/auth/stream-ticket', { method: 'POST',
      headers: { Cookie: authCookie, 'x-hawa-csrf': csrf!, Origin: 'https://foreign.example' } })).status).toBe(403);
    expect((await app.request('/v1/auth/session', { method: 'DELETE',
      headers: { Cookie: authCookie, 'x-hawa-csrf': csrf! } })).status).toBe(200);
    expect((await app.request('/v1/auth/session', { headers: { Cookie: authCookie } })).status).toBe(401);
    expect((await app.request(`/v1/auth/google/callback?state=${encodeURIComponent(flow.state)}&code=fixture`,
      { headers: { Cookie: flow.cookie } })).status).toBe(401);
  });

  it('rejects a callback without the matching browser state, then refuses unprovisioned identity', async () => {
    const app = newApp();
    const flow = await start(app);
    const mismatched = await app.request(`/v1/auth/google/callback?state=${flow.state}&code=fixture`);
    expect(mismatched.status).toBe(403);
    expect(await mismatched.text()).not.toContain('code=fixture');
    identity = { ...identity, subject: `unknown-${randomUUID()}` };
    try {
      const callback = await app.request(`/v1/auth/google/callback?state=${flow.state}&code=fixture`,
        { headers: { Cookie: flow.cookie } });
      expect(callback.status).toBe(403);
    } finally { identity = { ...identity, subject }; }
  });

  it('refuses a disabled user and an inactive tenant membership', async () => {
    const app = newApp();
    await sql`UPDATE hawa.users SET disabled_at=now() WHERE id=${userId}::uuid`.execute(owner);
    try {
      const flow = await start(app);
      const denied = await app.request(`/v1/auth/google/callback?state=${flow.state}&code=fixture`,
        { headers: { Cookie: flow.cookie } });
      expect(denied.status).toBe(403);
      expect(denied.headers.get('set-cookie')).not.toContain('hawa_session=');
    } finally {
      await sql`UPDATE hawa.users SET disabled_at=NULL WHERE id=${userId}::uuid`.execute(owner);
    }
    await sql`UPDATE hawa.tenant_memberships SET active=false WHERE user_id=${userId}::uuid`.execute(owner);
    try {
      const flow = await start(app);
      const denied = await app.request(`/v1/auth/google/callback?state=${flow.state}&code=fixture`,
        { headers: { Cookie: flow.cookie } });
      expect(denied.status).toBe(403);
    } finally {
      await sql`UPDATE hawa.tenant_memberships SET active=true WHERE user_id=${userId}::uuid`.execute(owner);
    }
  });
});
