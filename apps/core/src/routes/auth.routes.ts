import crypto from 'node:crypto';
import { parseDeskReviewParams, deskReviewPath } from '@hawa/contracts/desk-navigation';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { verifyTelegramMiniAppInitData } from '@hawa/integrations';
import { sql, withRlsContext } from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import type { RouteContext } from './types.js';
import { DEFAULT_TENANT_ID, OPERATOR_USER_ID } from '../core-context.js';
import { createGoogleOidcProvider, googleOidcSettings, oidcCodeChallenge, oidcCodeVerifier } from '../services/google-oidc.js';
import { serviceTokenOf } from './lifecycle-internal.routes.js';

export function registerAuthRoutes(ctx: RouteContext) {
  const {
    registerRoute,
    verifyRequestAuth,
    problem,
    ensureSessionLoaded,
    bearerTokenOf,
    saveSession,
    persistSession,
    revokeSession,
    streamTickets,
    options,
    telegramAllowedUsers,
    db,
  } = ctx;
  const defaultTenantId = DEFAULT_TENANT_ID;
  const operatorUserId = OPERATOR_USER_ID;
  const settings = googleOidcSettings();
  const googleOidc = options?.testAuth?.googleOidcProvider || (settings ? createGoogleOidcProvider(settings) : null);
  const oidcEnabled = Boolean(db && googleOidc);
  const oidcRls = { tenantId: defaultTenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' as const };

  registerRoute('get', '/auth/providers', (c: Context) => c.json({ googleWorkspace: oidcEnabled,
    trustedOffice: verifyRequestAuth(c).authMethod === 'trusted_office' }, 200));

  registerRoute('get', '/auth/google/start', async (c: Context) => {
    if (!db || !googleOidc) return problem(c, 503, 'Google Sign-In Unavailable', 'Office sign-in is not configured');
    const params = new URL(c.req.url).searchParams;
    const reviewTarget = parseDeskReviewParams(params);
    if (params.size && !reviewTarget) return problem(c, 422, 'Invalid Review Destination', 'Use a Desk task link to start sign-in');
    const state = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(32).toString('base64url');
    const verifier = oidcCodeVerifier();
    let destination: string;
    try {
      destination = await googleOidc.authorizationUrl({ state, nonce, codeChallenge: await oidcCodeChallenge(verifier) });
    } catch {
      return problem(c, 503, 'Google Sign-In Unavailable', 'The identity provider could not start sign-in');
    }
    const stateHash = crypto.createHash('sha256').update(state).digest('hex');
    await withRlsContext(db, oidcRls, (trx) => sql`INSERT INTO hawa.office_oidc_flows
      (state_hash,tenant_id,code_verifier,nonce,expires_at,return_task_id,return_revision_id)
      VALUES (${stateHash},${defaultTenantId}::uuid,${verifier},${nonce},now()+interval '5 minutes',
        ${reviewTarget?.taskId ?? null}::uuid,${reviewTarget?.revisionId ?? null}::uuid)`.execute(trx));
    setCookie(c, 'hawa_oidc_state', state, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 300 });
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    return c.redirect(destination, 302);
  });

  registerRoute('get', '/auth/google/callback', async (c: Context) => {
    if (!db || !googleOidc) return problem(c, 503, 'Google Sign-In Unavailable', 'Office sign-in is not configured');
    const callback = new URL(c.req.url);
    const state = callback.searchParams.get('state') || '';
    const cookieState = getCookie(c, 'hawa_oidc_state') || '';
    deleteCookie(c, 'hawa_oidc_state', { path: '/', secure: true, sameSite: 'Lax' });
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    const stateBytes = Buffer.from(state);
    const cookieBytes = Buffer.from(cookieState);
    if (!state || !cookieState || stateBytes.length !== cookieBytes.length ||
        !crypto.timingSafeEqual(stateBytes, cookieBytes)) {
      return problem(c, 403, 'Sign-In State Mismatch', 'Start sign-in again from Hawa Desk');
    }
    const stateHash = crypto.createHash('sha256').update(state).digest('hex');
    const flow = await withRlsContext(db, oidcRls, async (trx) => (await sql<{
      code_verifier: string; nonce: string; expires_at: Date; return_task_id: string | null; return_revision_id: string | null;
    }>`DELETE FROM hawa.office_oidc_flows WHERE state_hash=${stateHash} AND tenant_id=${defaultTenantId}::uuid
      RETURNING code_verifier,nonce,expires_at,return_task_id,return_revision_id`.execute(trx)).rows[0]);
    if (!flow || new Date(flow.expires_at).getTime() <= Date.now() || callback.searchParams.has('error')) {
      return problem(c, 401, 'Sign-In Expired', 'Start sign-in again from Hawa Desk');
    }
    let identity: Awaited<ReturnType<typeof googleOidc.exchange>>;
    try {
      identity = await googleOidc.exchange({ callbackQuery: callback.search,
        state, nonce: flow.nonce, codeVerifier: flow.code_verifier });
    } catch {
      return problem(c, 401, 'Google Identity Rejected', 'The identity provider could not verify this sign-in');
    }
    const user = await withRlsContext(db, oidcRls, async (trx) => (await sql<{
      id: string; display_name: string; disabled_at: Date | null;
    }>`SELECT * FROM hawa.lookup_office_oidc_user(${defaultTenantId}::uuid,${identity.subject})`
      .execute(trx)).rows[0]);
    if (!user || user.disabled_at) return problem(c, 403, 'Office Membership Required', 'This Google account is not enabled for Hawa Desk');
    const memberships = await withRlsContext(db, { tenantId: defaultTenantId, userId: user.id, role: 'requester' },
      async (trx) => (await sql<{ role: string }>`SELECT role::text FROM hawa.tenant_memberships
        WHERE tenant_id=${defaultTenantId}::uuid AND user_id=${user.id}::uuid AND active`.execute(trx)).rows);
    const role = ['administrator', 'approver', 'operator', 'designer', 'language_reviewer', 'client_dna_manager',
      'model_evaluator', 'auditor', 'requester'].find((candidate) => memberships.some((row) => row.role === candidate));
    if (!role) return problem(c, 403, 'Office Membership Required', 'This Google account has no active office membership');
    const token = `hawa_sess_${crypto.randomUUID().replace(/-/g, '')}`;
    const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
    const session = { authenticated: true, tenantId: defaultTenantId, userId: user.id,
      actorId: `oidc:${identity.subject}`, role, displayName: user.display_name,
      authMethod: 'google_oidc' as const, expiresAt, checkedAt: Date.now() };
    if (!persistSession || !(await persistSession(token, session))) {
      return problem(c, 503, 'Office Session Unavailable', 'The verified sign-in could not be recorded');
    }
    saveSession?.(token, session);
    setCookie(c, 'hawa_session', token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 8 * 60 * 60 });
    setCookie(c, 'hawa_csrf', crypto.createHash('sha256').update(`${token}:csrf`).digest('hex'),
      { secure: true, sameSite: 'Strict', path: '/', maxAge: 8 * 60 * 60 });
    return c.redirect(flow.return_task_id ? deskReviewPath({ taskId: flow.return_task_id,
      ...(flow.return_revision_id ? { revisionId: flow.return_revision_id } : {}) }) : '/', 303);
  });

  // Authenticated Session Endpoints (H01, FR-076, FR-078)
  registerRoute('get', '/auth/session', async (c: any) => {
    if (ensureSessionLoaded && bearerTokenOf) {
      await ensureSessionLoaded(bearerTokenOf(c));
    }
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'No active session or valid credentials found');
    }
    return c.json({
      authenticated: true,
      tenantId: auth.tenantId,
      user: {
        id: auth.userId,
        role: auth.role,
        displayName: (auth as any).displayName || (auth.role === 'administrator' ? 'Administrator' : auth.role === 'art_director' ? 'Art Director' : 'Primary Operator'),
        authMethod: auth.authMethod || 'shared_key',
      },
    }, 200);
  });

  registerRoute('post', '/auth/session', async (c: any) => {
    const body = await c.req.json().catch(() => ({}));
    const key = (body.token || body.key || body.apiKey || body.password || '').trim();

    const adminKey = process.env.HAWA_ADMIN_KEY;
    const operatorKey = process.env.HAWA_BEARER_TOKEN || process.env.HAWA_API_KEY || process.env.HAWA_DEV_TOKEN;
    const reviewerKey = process.env.HAWA_REVIEWER_KEY;
    const artDirectorKey = process.env.HAWA_ART_DIRECTOR_KEY;

    let resolvedRole: string | null = null;
    let resolvedUserId: string = '00000000-0000-4000-b000-000000000001';
    let resolvedDisplayName: string = 'Primary Operator';
    
    // Constant-time comparison: a wrong key costs the same whether it differs in the first or last byte.
    const same = (candidate: string, configured: string | null | undefined): boolean => {
      if (!configured) return false;
      const a = Buffer.from(candidate), b = Buffer.from(configured);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    };

    // The worker's credential is a service principal on /v1/internal/* and nothing else, so it never
    // becomes an office session, whatever other key it might also match (ADR-128).
    const serviceToken = serviceTokenOf();
    if (key && (same(key, serviceToken) || same(key, process.env.HAWA_DESIGN_WORKER_TOKEN) || same(key, process.env.HAWA_DESIGN_WORKER_TOKEN_PREVIOUS))) {
      return problem(c, 401, 'Unauthorized', 'Invalid credentials or access key');
    }

    // 1. Validate by secret key / token
    if (key) {
      if (same(key, adminKey)) {
        resolvedRole = 'administrator';
        resolvedUserId = '00000000-0000-4000-b000-000000000002';
        resolvedDisplayName = 'Administrator';
      } else if (same(key, reviewerKey) || same(key, artDirectorKey)) {
        resolvedRole = 'art_director';
        resolvedUserId = '00000000-0000-4000-b000-000000000002';
        resolvedDisplayName = 'Art Director';
      } else if (same(key, operatorKey) || same(key, process.env.HAWA_BEARER_TOKEN) || same(key, process.env.HAWA_API_KEY) || same(key, process.env.HAWA_DEV_TOKEN)) {
        resolvedRole = 'operator';
        resolvedUserId = '00000000-0000-4000-b000-000000000001';
        resolvedDisplayName = 'Primary Operator';
      } else if (options?.extraBearerTokens && options.extraBearerTokens[key]) {
        const entry = options.extraBearerTokens[key];
        if (typeof entry === 'string') {
          resolvedRole = entry;
          resolvedUserId = entry === 'administrator' ? '00000000-0000-4000-b000-000000000002' : '00000000-0000-4000-b000-000000000001';
          resolvedDisplayName = `Test ${entry}`;
        } else {
          resolvedRole = entry.role;
          resolvedUserId = entry.sub || '00000000-0000-4000-b000-000000000001';
          resolvedDisplayName = entry.email || `Test ${entry.role}`;
        }
      }
    }

    if (!resolvedRole) {
      return problem(c, 401, 'Unauthorized', 'Invalid credentials or access key');
    }

    const sessionToken = `hawa_sess_${crypto.randomUUID().replace(/-/g, '')}`;
    const sessionRecord = {
      authenticated: true,
      tenantId: '00000000-0000-4000-a000-000000000001',
      userId: resolvedUserId,
      actorId: `sess_${resolvedUserId.slice(0, 8)}`,
      role: resolvedRole,
      displayName: resolvedDisplayName,
      authMethod: 'shared_key' as const,
    };
    const issued = { ...sessionRecord, expiresAt: Date.now() + 24 * 60 * 60 * 1000, checkedAt: Date.now() };
    if (saveSession) saveSession(sessionToken, issued);
    const durable = persistSession ? await persistSession(sessionToken, issued) : false;

    return c.json({
      ok: true,
      token: sessionToken,
      durable,
      tenantId: '00000000-0000-4000-a000-000000000001',
      user: {
        id: resolvedUserId,
        role: resolvedRole,
        displayName: resolvedDisplayName,
      },
    }, 201);
  });

  // A one-use ticket that opens the event stream for 60 s (services/stream-tickets.ts, ADR-037). The
  // Desk's EventSource cannot send its bearer header, and the session token it put in the stream's
  // address instead was written to every access log on the way. An authenticated bearer or a cookie
  // session with a valid CSRF proof earns a ticket; it stands for that credential and nothing more.
  registerRoute('post', '/auth/stream-ticket', async (c: Context) => {
    const credential = verifyRequestAuth(c).authMethod === 'trusted_office' ? 'hawa_trusted_office' : bearerTokenOf?.(c);
    if (!credential || !streamTickets) {
      return problem(c, 401, 'Unauthorized', 'A stream ticket requires an authenticated office session');
    }
    const { ticket, expiresAt } = streamTickets.issue(credential);
    c.header('Cache-Control', 'no-store');
    return c.json({ ticket, expiresAt, expiresInSeconds: Math.round((expiresAt - Date.now()) / 1000) }, 201);
  });

  registerRoute('delete', '/auth/session', async (c: any) => {
    const token = bearerTokenOf?.(c);
    if (token && revokeSession) {
      await revokeSession(token);
    }
    deleteCookie(c, 'hawa_session', { path: '/', secure: true, sameSite: 'Lax' });
    deleteCookie(c, 'hawa_csrf', { path: '/', secure: true, sameSite: 'Strict' });
    return c.json({ ok: true }, 200);
  });

  // Telegram Mini App Identity Verification (FR-071)
  registerRoute('post', '/auth/telegram-miniapp', async (c: any) => {
    const body = await c.req.json().catch(() => ({}));
    const initData = body.initData;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      return problem(c, 503, 'Service Unavailable', 'Telegram bot token is not configured');
    }
    const verification = verifyTelegramMiniAppInitData(initData, botToken);
    if (!verification.ok) {
      return problem(c, 401, 'Unauthorized', verification.error);
    }
    const userIdStr = String(verification.value.user.id);
    if (telegramAllowedUsers.length > 0 && !telegramAllowedUsers.includes(userIdStr)) {
      return problem(c, 403, 'Forbidden', `Telegram user ${userIdStr} is not an authorized office operator`);
    }
    // A random token. It used to be the Telegram user record in base64, so anyone who knew an office
    // member's Telegram id, name, username and language could compute their operator session for the
    // 24 hours after they opened the Mini App.
    const sessionToken = `tg_miniapp_sess_${crypto.randomBytes(32).toString('base64url')}`;
    const displayName = [verification.value.user.first_name, verification.value.user.last_name].filter(Boolean).join(' ') || `Telegram User ${userIdStr}`;
    const session = {
      authenticated: true,
      tenantId: defaultTenantId,
      userId: operatorUserId,
      actorId: `tg_${userIdStr}`,
      role: 'operator',
      displayName,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    };
    saveSession?.(sessionToken, session);
    // Written to hawa.desk_sessions like a Desk sign-in (SPLIT_PLAN G1): the session lived only in
    // this process's map, so a restart or a second Core signed the office member out.
    const durable = persistSession ? await persistSession(sessionToken, session) : false;
    return c.json({
      ok: true,
      durable,
      user: verification.value.user,
      authDate: verification.value.authDate,
      authenticated: true,
      sessionToken,
    });
  });
}
