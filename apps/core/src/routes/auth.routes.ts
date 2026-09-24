import crypto from 'node:crypto';
import type { Context } from 'hono';
import { verifyTelegramMiniAppInitData } from '@hawa/integrations';
import type { RouteContext } from './types.js';
import { DEFAULT_TENANT_ID, OPERATOR_USER_ID } from '../core-context.js';

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
  } = ctx;
  const defaultTenantId = DEFAULT_TENANT_ID;
  const operatorUserId = OPERATOR_USER_ID;

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
    const same = (candidate: string, configured: string | undefined): boolean => {
      if (!configured) return false;
      const a = Buffer.from(candidate), b = Buffer.from(configured);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    };

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
  // address instead was written to every access log on the way. Only a bearer header earns a ticket
  // (registerRoute has already checked it); the ticket stands for that credential and nothing more.
  registerRoute('post', '/auth/stream-ticket', async (c: Context) => {
    const credential = bearerTokenOf?.(c);
    if (!credential || !streamTickets) {
      return problem(c, 401, 'Unauthorized', 'A stream ticket is issued only to a request signed with a bearer token');
    }
    const { ticket, expiresAt } = streamTickets.issue(credential);
    c.header('Cache-Control', 'no-store');
    return c.json({ ticket, expiresAt, expiresInSeconds: Math.round((expiresAt - Date.now()) / 1000) }, 201);
  });

  registerRoute('delete', '/auth/session', async (c: any) => {
    const authHeader = c.req.header('Authorization');
    if (authHeader && revokeSession) {
      const token = authHeader.replace(/^Bearer\s*/, '').trim();
      await revokeSession(token);
    }
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
    saveSession?.(sessionToken, {
      authenticated: true,
      tenantId: defaultTenantId,
      userId: operatorUserId,
      actorId: `tg_${userIdStr}`,
      role: 'operator',
      displayName,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });
    return c.json({
      ok: true,
      user: verification.value.user,
      authDate: verification.value.authDate,
      authenticated: true,
      sessionToken,
    });
  });
}
