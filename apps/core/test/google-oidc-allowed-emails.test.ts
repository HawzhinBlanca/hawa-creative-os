import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';

/**
 * ADR-294 addendum: office Google accounts enrolled from HAWA_GOOGLE_OIDC_ALLOWED_EMAILS (migration
 * 090). Google is mocked at the openid-client boundary only: the real provider, the real claim
 * admission, the real routes and the real enrolment functions run against the test database.
 */
const google = vi.hoisted(() => ({ claims: {} as Record<string, unknown>, lastState: '' }));
vi.mock('openid-client', () => ({
  discovery: vi.fn(async () => ({ issuer: 'https://accounts.google.com' })),
  buildAuthorizationUrl: vi.fn((_config: unknown, params: Record<string, string>) => {
    google.lastState = params.state;
    return new URL(`https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams(params)}`);
  }),
  authorizationCodeGrant: vi.fn(async (_config: unknown, callback: URL, checks: { expectedState: string }) => {
    // openid-client verifies signature, issuer, audience, expiry, state, nonce and PKCE; a wrong
    // state or code is a rejected grant.
    if (callback.searchParams.get('state') !== checks.expectedState || callback.searchParams.get('code') !== 'fixture') {
      throw new Error('invalid grant');
    }
    return { claims: () => google.claims };
  }),
  randomPKCECodeVerifier: () => `verifier-${'x'.repeat(43)}`,
  calculatePKCECodeChallenge: async () => 'challenge',
}));

const { createApp } = await import('../src/app.js');
const { googleOidcSettings, parseAllowedOfficeEmails } = await import('../src/services/google-oidc.js');

const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const appDb = createDb(process.env.TEST_DATABASE_URL!);
const tenantId = '00000000-0000-4000-a000-000000000001';
const run = randomUUID().slice(0, 8);
const adminEmail = `owner.${run}@gmail.com`;
const operatorEmail = `designer.${run}@gmail.com`;
const adminSubject = `1${Date.now()}1`;
const operatorSubject = `2${Date.now()}2`;
// A fixture client, not a credential.
const base: Record<string, string> = Object.fromEntries([
  ['HAWA_GOOGLE_OIDC_CLIENT_ID', 'test-client'],
  ['HAWA_GOOGLE_OIDC_CLIENT_SECRET', 'test-client-secret'],
  ['HAWA_GOOGLE_OIDC_REDIRECT_URI', 'https://desk.office.example/v1/auth/google/callback'],
]);
// Upper case in the list: emails compare case-insensitively.
const fullList = `${adminEmail.toUpperCase()}:administrator, ${operatorEmail}:operator`;

function newApp(env: Record<string, string>) {
  for (const [key, value] of Object.entries({ ...base, ...env })) vi.stubEnv(key, value);
  try {
    return createApp({ db: appDb, skipPaidModelProbe: true });
  } finally { vi.unstubAllEnvs(); }
}
type App = ReturnType<typeof newApp>;

async function signIn(app: App, claims: Record<string, unknown>) {
  google.claims = claims;
  const started = await app.request('/v1/auth/google/start');
  expect(started.status).toBe(302);
  const cookie = started.headers.get('set-cookie')?.match(/hawa_oidc_state=([^;]+)/)?.[1];
  const response = await app.request(`/v1/auth/google/callback?state=${encodeURIComponent(google.lastState)}&code=fixture`,
    { headers: { Cookie: `hawa_oidc_state=${cookie}` } });
  const token = response.headers.getSetCookie().join('; ').match(/hawa_session=([^;]+)/)?.[1];
  return { status: response.status, token, body: response.status === 303 ? null : await response.json() };
}

const gmail = (sub: string, email: string, extra: Record<string, unknown> = {}) =>
  ({ sub, email, email_verified: true, name: `Person ${sub}`, ...extra });
const bearer = (token: string | undefined) => ({ headers: { Authorization: `Bearer ${token}` } });
const userBySubject = async (subject: string) => (await sql<{ id: string; email: string; display_name: string }>`
  SELECT id,email::text,display_name FROM hawa.users WHERE external_subject=${subject}`.execute(owner)).rows;
const activeRoles = async (userId: string) => (await sql<{ role: string }>`SELECT role::text FROM hawa.tenant_memberships
  WHERE tenant_id=${tenantId}::uuid AND user_id=${userId}::uuid AND active ORDER BY role`.execute(owner)).rows.map((r) => r.role);
const audits = async (userId: string) => (await sql<{ action: string }>`SELECT action FROM hawa.audit_events
  WHERE resource_type='user' AND resource_id=${userId} AND action LIKE 'office_oidc.%' ORDER BY occurred_at`.execute(owner))
  .rows.map((r) => r.action);

const workspaceUserId = randomUUID();
const workspaceSubject = `ws-${randomUUID()}`;

afterAll(async () => {
  await Promise.all([owner.destroy(), appDb.destroy()]);
});

describe('HAWA_GOOGLE_OIDC_ALLOWED_EMAILS configuration', () => {
  it('parses email:role entries strictly and case-insensitively', () => {
    expect([...parseAllowedOfficeEmails(' Owner@Gmail.com:administrator , a.b+c@example.org:approver+operator ')]).toEqual([
      ['owner@gmail.com', ['administrator']], ['a.b+c@example.org', ['approver', 'operator']]]);
    expect(parseAllowedOfficeEmails('').size).toBe(0);
    for (const bad of ['owner@gmail.com', 'owner@gmail.com:', 'owner@gmail.com:reviewer', 'owner@gmail.com:requester',
      'owner@gmail.com:Administrator', 'not-an-email:operator', 'owner@gmail.com:operator,,x@gmail.com:operator',
      'owner@gmail.com:operator,OWNER@gmail.com:administrator', 'owner@gmail.com:operator+operator',
      'owner@gmail.com:operator;x@gmail.com:operator', ':administrator']) {
      expect(() => parseAllowedOfficeEmails(bad), bad).toThrow(/HAWA_GOOGLE_OIDC_ALLOWED_EMAILS entry/);
    }
  });

  it('makes hosted domains optional when emails are listed, and still refuses an incomplete configuration', () => {
    expect(googleOidcSettings({ ...base, HAWA_GOOGLE_OIDC_ALLOWED_EMAILS: 'owner@gmail.com:administrator' })?.hostedDomains).toEqual([]);
    expect(googleOidcSettings({ ...base })).toBeNull();
    expect(googleOidcSettings({ ...base, HAWA_GOOGLE_OIDC_CLIENT_SECRET: '', HAWA_GOOGLE_OIDC_ALLOWED_EMAILS: 'owner@gmail.com:administrator' })).toBeNull();
    expect(googleOidcSettings({ ...base, HAWA_GOOGLE_OIDC_REDIRECT_URI: 'http://desk.office.example/v1/auth/google/callback',
      HAWA_GOOGLE_OIDC_ALLOWED_EMAILS: 'owner@gmail.com:administrator' })).toBeNull();
  });

  it('refuses a malformed list at start: Core does not build', () => {
    for (const bad of ['owner@gmail.com:reviewer', 'owner@gmail.com', 'owner@gmail.com:operator,owner@gmail.com:operator']) {
      expect(() => newApp({ HAWA_GOOGLE_OIDC_ALLOWED_EMAILS: bad }), bad).toThrow(/HAWA_GOOGLE_OIDC_ALLOWED_EMAILS/);
    }
  });
});

describe('ADR-294 addendum: allow-listed Google sign-in', () => {
  it('enrols an allow-listed Gmail administrator on first sign-in, who can then administer customer accounts', async () => {
    expect(await userBySubject(adminSubject)).toEqual([]);
    const app = newApp({ HAWA_GOOGLE_OIDC_ALLOWED_EMAILS: fullList });
    expect(await (await app.request('/v1/auth/providers')).json()).toEqual({ googleWorkspace: true, trustedOffice: false });
    const first = await signIn(app, gmail(adminSubject, adminEmail));
    expect(first.status, JSON.stringify(first.body)).toBe(303);
    expect(first.token).toMatch(/^hawa_sess_/);
    const [user] = await userBySubject(adminSubject);
    expect(user).toMatchObject({ email: adminEmail, display_name: `Person ${adminSubject}` });
    expect(await activeRoles(user.id)).toEqual(['administrator']);
    expect(await audits(user.id)).toEqual(['office_oidc.enrolled']);
    const session = await app.request('/v1/auth/session', bearer(first.token));
    expect(await session.json()).toMatchObject({ user: { id: user.id, role: 'administrator', authMethod: 'google_oidc' } });
    const accounts = await app.request('/v1/office/customer-accounts', bearer(first.token));
    expect(accounts.status, await accounts.clone().text()).toBe(200);
    expect(await accounts.json()).toHaveProperty('accounts');
  });

  it('matches the same subject on a later sign-in without creating or re-auditing anything', async () => {
    const app = newApp({ HAWA_GOOGLE_OIDC_ALLOWED_EMAILS: fullList });
    const [before] = await userBySubject(adminSubject);
    const again = await signIn(app, gmail(adminSubject, adminEmail.toUpperCase()));
    expect(again.status).toBe(303);
    expect(await userBySubject(adminSubject)).toEqual([before]);
    expect(await audits(before.id)).toEqual(['office_oidc.enrolled']);
    expect((await app.request('/v1/office/customer-accounts', bearer(again.token))).status).toBe(200);
  });

  it('enforces the listed role: an operator signs in but cannot administer customer accounts', async () => {
    const app = newApp({ HAWA_GOOGLE_OIDC_ALLOWED_EMAILS: fullList });
    const signedIn = await signIn(app, gmail(operatorSubject, operatorEmail));
    expect(signedIn.status).toBe(303);
    const [user] = await userBySubject(operatorSubject);
    expect(await activeRoles(user.id)).toEqual(['operator']);
    expect(await (await app.request('/v1/auth/session', bearer(signedIn.token))).json())
      .toMatchObject({ user: { role: 'operator', authMethod: 'google_oidc' } });
    const accounts = await app.request('/v1/office/customer-accounts', bearer(signedIn.token));
    expect(accounts.status).toBe(403);
    expect(await accounts.json()).toEqual({ code: 'NAMED_ADMINISTRATOR_REQUIRED' });
  });

  it('never admits an unverified email, an unlisted Gmail, or a listed email under another Google account', async () => {
    const app = newApp({ HAWA_GOOGLE_OIDC_ALLOWED_EMAILS: fullList });
    const strangerSubject = `9${Date.now()}9`;
    const unverified = await signIn(app, gmail(strangerSubject, adminEmail, { email_verified: false }));
    expect(unverified.status).toBe(401);
    const stringly = await signIn(app, gmail(strangerSubject, adminEmail, { email_verified: 'true' }));
    expect(stringly.status).toBe(401);
    const unlisted = await signIn(app, gmail(strangerSubject, `stranger.${run}@gmail.com`));
    expect(unlisted.status).toBe(401);
    expect(unlisted.token).toBeUndefined();
    const takeover = await signIn(app, gmail(strangerSubject, adminEmail));
    expect(takeover.status).toBe(403);
    expect(takeover.token).toBeUndefined();
    expect(await userBySubject(strangerSubject)).toEqual([]);
  });

  it('keeps the Workspace hosted-domain path: provisioned members only, alongside the list', async () => {
    await sql`INSERT INTO hawa.users(id,email,display_name,external_subject)
      VALUES (${workspaceUserId}::uuid,${`reviewer.${run}@example.test`},'Workspace Reviewer',${workspaceSubject})`.execute(owner);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role,active)
      VALUES (${tenantId}::uuid,${workspaceUserId}::uuid,'approver',true)`.execute(owner);
    const app = newApp({ HAWA_GOOGLE_OIDC_HOSTED_DOMAINS: 'example.test', HAWA_GOOGLE_OIDC_ALLOWED_EMAILS: fullList });
    const member = await signIn(app, gmail(workspaceSubject, `reviewer.${run}@example.test`, { hd: 'example.test' }));
    expect(member.status).toBe(303);
    expect(await (await app.request('/v1/auth/session', bearer(member.token))).json())
      .toMatchObject({ user: { id: workspaceUserId, role: 'approver', authMethod: 'google_oidc' } });
    expect(await audits(workspaceUserId)).toEqual([]);
    const unprovisioned = await signIn(app, gmail(`ws-${randomUUID()}`, `new.${run}@example.test`, { hd: 'example.test' }));
    expect(unprovisioned.status).toBe(403);
    const otherDomain = await signIn(app, gmail(`ws-${randomUUID()}`, `x.${run}@other.test`, { hd: 'other.test' }));
    expect(otherDomain.status).toBe(401);
    // Without the list, the Workspace-only configuration behaves exactly as before.
    const workspaceOnly = newApp({ HAWA_GOOGLE_OIDC_HOSTED_DOMAINS: 'example.test' });
    expect((await signIn(workspaceOnly, gmail(workspaceSubject, `reviewer.${run}@example.test`, { hd: 'example.test' }))).status).toBe(303);
    // ...and removing the whole list revokes every account it enrolled.
    const [operator] = await userBySubject(operatorSubject);
    expect(await activeRoles(operator.id)).toEqual([]);
    expect((await audits(operator.id)).at(-1)).toBe('office_oidc.revoked');
  });

  it('re-syncs a changed role and revokes the sessions issued under the old one', async () => {
    const before = newApp({ HAWA_GOOGLE_OIDC_ALLOWED_EMAILS: fullList });
    const asOperator = await signIn(before, gmail(operatorSubject, operatorEmail));
    expect(asOperator.status).toBe(303);
    const [user] = await userBySubject(operatorSubject);
    const promoted = `${adminEmail}:administrator,${operatorEmail}:operator+approver`;
    const app = newApp({ HAWA_GOOGLE_OIDC_ALLOWED_EMAILS: promoted });
    const again = await signIn(app, gmail(operatorSubject, operatorEmail));
    expect(again.status).toBe(303);
    expect(await activeRoles(user.id)).toEqual(['approver', 'operator']);
    expect((await audits(user.id)).at(-1)).toBe('office_oidc.roles_changed');
    expect((await app.request('/v1/auth/session', bearer(asOperator.token))).status).toBe(401);
    expect(await (await app.request('/v1/auth/session', bearer(again.token))).json()).toMatchObject({ user: { role: 'approver' } });
  });

  it('refuses and revokes an enrolled email removed from the list, keeping its subject binding', async () => {
    const app = newApp({ HAWA_GOOGLE_OIDC_ALLOWED_EMAILS: fullList });
    const live = await signIn(app, gmail(adminSubject, adminEmail));
    expect(live.status).toBe(303);
    const [user] = await userBySubject(adminSubject);
    const withoutOwner = newApp({ HAWA_GOOGLE_OIDC_ALLOWED_EMAILS: `${operatorEmail}:operator` });
    const refused = await signIn(withoutOwner, gmail(adminSubject, adminEmail));
    expect(refused.status).toBe(401);
    expect(refused.token).toBeUndefined();
    expect(await userBySubject(adminSubject)).toEqual([user]);
    expect(await activeRoles(user.id)).toEqual([]);
    expect(await audits(user.id)).toContain('office_oidc.revoked');
    // The session issued while listed is revoked in PostgreSQL, so a fresh Core refuses it.
    expect((await withoutOwner.request('/v1/auth/session', bearer(live.token))).status).toBe(401);
    expect((await withoutOwner.request('/v1/office/customer-accounts', bearer(live.token))).status).toBe(401);
    // Even through a Workspace domain, a revoked enrolment has no active membership.
    const viaWorkspace = newApp({ HAWA_GOOGLE_OIDC_HOSTED_DOMAINS: 'gmail.com', HAWA_GOOGLE_OIDC_ALLOWED_EMAILS: `${operatorEmail}:operator` });
    expect((await signIn(viaWorkspace, gmail(adminSubject, adminEmail, { hd: 'gmail.com' }))).status).toBe(403);
    // Listed again, the same subject is reinstated.
    const reinstated = await signIn(newApp({ HAWA_GOOGLE_OIDC_ALLOWED_EMAILS: fullList }), gmail(adminSubject, adminEmail));
    expect(reinstated.status).toBe(303);
    expect(await activeRoles(user.id)).toEqual(['administrator']);
    expect((await audits(user.id)).at(-1)).toBe('office_oidc.reinstated');
  });

  it('lets only Core\'s system-automation context call the enrolment functions', async () => {
    const asAdmin = { tenantId, userId: '00000000-0000-4000-b000-000000000002', role: 'administrator' as const };
    await expect(withRlsContext(appDb, asAdmin, (trx) => sql`SELECT * FROM hawa.enrol_office_oidc_user(${tenantId}::uuid,
      ${'3333'},${`x.${run}@gmail.com`},'X',${['administrator']}::hawa.membership_role[])`.execute(trx))).rejects.toThrow(/system automation/);
    await expect(withRlsContext(appDb, asAdmin, (trx) => sql`SELECT hawa.reconcile_office_oidc_enrolments(${tenantId}::uuid,'[]'::jsonb)`
      .execute(trx))).rejects.toThrow(/system automation/);
    await expect(sql`SELECT count(*) FROM hawa.office_oidc_enrolments`.execute(appDb)).rejects.toThrow(/permission denied/);
    const system = { tenantId, userId: '00000000-0000-4000-b000-000000000011', role: 'operator' as const };
    for (const [subject, roles] of [['customer:abc', ['administrator']], ['4444', ['requester']], ['4444', []]] as const) {
      await expect(withRlsContext(appDb, system, (trx) => sql`SELECT * FROM hawa.enrol_office_oidc_user(${tenantId}::uuid,
        ${subject},${`y.${run}@gmail.com`},'Y',${[...roles]}::hawa.membership_role[])`.execute(trx)), subject).rejects.toThrow();
    }
    await expect(withRlsContext(appDb, system, (trx) => sql`SELECT * FROM hawa.enrol_office_oidc_user(${tenantId}::uuid,
      ${'5555'},${'automation@hawa.office'},'Z',${['administrator']}::hawa.membership_role[])`.execute(trx))).rejects.toThrow(/built-in identity/);
  });
});
