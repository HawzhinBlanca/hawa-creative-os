import { assert, describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import {
  createDb,
  IngressRepository,
  TaskRepository,
  CanvaBindingRepository,
  withRlsContext,
} from '@hawa/db';
import {
  TelegramActionTokenService,
  verifyTelegramMiniAppInitData,
} from '@hawa/integrations';
import crypto from 'node:crypto';

describe('CV-07: Telegram First-Class Adapter & Security Verification', () => {
  const connectionString =
    process.env.TEST_DATABASE_URL!;
  const db = createDb(connectionString);
  const tenantId = '00000000-0000-4000-a000-000000000008';
  const userId = '00000000-0000-4000-b000-000000000008';
  const clientId = '00000000-0000-4000-c000-000000000008';

  const taskRepo = new TaskRepository(db);
  const canvaRepo = new CanvaBindingRepository(db);
  const ingressRepo = new IngressRepository(db);

  const testSecret = 'test_tg_sec';
  const hmacSecret = 'test_hmac_sec';
  const botToken = '9988776655:AAFlkjasdflkjasdflkjasdflkj';

  const authorizedUserId = '77112233';
  const foreignUserId = '99999999';

  let app: any;
  let actionTokenService: TelegramActionTokenService;

  beforeEach(() => {
    process.env.TELEGRAM_WEBHOOK_SECRET = testSecret;
    process.env.HAWA_ACTION_HMAC_SECRET = hmacSecret;
    process.env.TELEGRAM_BOT_TOKEN = botToken;
    process.env.TELEGRAM_ALLOWED_USERS = `${authorizedUserId},55443322`;

    actionTokenService = new TelegramActionTokenService(hmacSecret);
    const mockTelegramBridge: any = {
      answerCallbackQuery: async () => true,
      dispatchOutboundMessage: async () => true,
      formatPublicationNotice: (data: any) => `Publication Notice: ${data.title} -> ${data.driveUrl}`,
      getStatus: () => ({ lastUpdateId: 0, processedCount: 0, mode: 'live_webhook', degraded: false }),
    };
    app = createApp({ db, telegramActionTokenService: actionTokenService, telegramBridge: mockTelegramBridge });
  });

  it('1. Real authorized office test event -> database -> Canva-linked task', async () => {
    const runId = Date.now();
    const sourceMessageId = `tg_msg_${runId}`;
    const idempotencyKey = `tg_task_create_${runId}`;

    // A. Authorized operator in Telegram sends a task command
    const res = await app.request('/api/ingress/unified', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.HAWA_ADMIN_KEY!}`,
      },
      body: JSON.stringify({
        tenantId,
        channel: 'telegram',
        sourceAccountId: 'office_main_bot',
        sourceEventId: `update_${runId}`,
        sourceChannelId: 'kaae_office_chat',
        sourceMessageId,
        senderExternalId: authorizedUserId,
        senderDisplayName: 'Office Director',
        text: '/task KAAE Ministry Accreditation Announcement',
        rawPayload: { text: '/task KAAE Ministry Accreditation Announcement', chat_type: 'supergroup' },
        verified: true,
        explicitClientId: clientId,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.acknowledged).toBe(true);
    expect(body.actionTaken).toBe('task_created');
    const taskId = body.taskId;
    expect(taskId).toBeDefined();

    // B. Link native Canva design in database within tenant boundary
    const canvaDesignId = `DAF_kaae_${runId}`;
    const binding = await withRlsContext(
      db,
      { tenantId, userId, role: 'administrator' },
      async (trx) => {
        return await canvaRepo.createBinding(
          {
            tenantId,
            taskId,
            clientId,
            canvaDesignId,
            canvaTeamId: 'team_kaae_erbil',
            canvaUserId: 'user_designer_1',
            editUrl: `https://www.canva.com/design/${canvaDesignId}/edit`,
            viewUrl: `https://www.canva.com/design/${canvaDesignId}/view`,
            directionName: 'primary',
          },
          trx
        );
      }
    );

    expect(binding).toBeDefined();
    expect(binding.canva_design_id).toBe(canvaDesignId);
  });

  // Cases 2-5 also sent each token's button press to the Telegram webhook, which refused it with
  // 422 "Desk review required". The webhook was removed by stage 2 of ADR-135; the tokens' own rules
  // stay here.
  it('2. Callback Action Tokens: verifies valid approval and omnichannel publication', async () => {
    const taskId = crypto.randomUUID();

    // Create an action token bound to task, rev_1, and authorized user
    const { callbackData } = actionTokenService.createToken({
      taskId,
      revisionId: 'rev_1',
      action: 'approve',
      actorId: authorizedUserId,
      secretKey: hmacSecret,
    });

    // Verify token directly verifies with valid cryptographic signature and parameters
    const verifyResult = actionTokenService.verifyAndConsumeToken(callbackData, {
      actorId: authorizedUserId,
      currentRevisionId: 'rev_1',
      secretKey: hmacSecret,
    });
    expect(verifyResult.ok).toBe(true); assert(verifyResult.ok);
    expect(verifyResult.payload?.taskId).toBe(taskId);
    expect(verifyResult.payload?.action).toBe('approve');
  });

  it('3. Callback Replay Attack Defense: rejects duplicate execution with REPLAY_DETECTED', async () => {
    const taskId = crypto.randomUUID();

    const { callbackData } = actionTokenService.createToken({
      taskId,
      revisionId: 'rev_1',
      action: 'approve',
      actorId: authorizedUserId,
      secretKey: hmacSecret,
    });

    // 1st Execution: Succeeds
    const res1 = actionTokenService.verifyAndConsumeToken(callbackData, {
      actorId: authorizedUserId,
      currentRevisionId: 'rev_1',
      secretKey: hmacSecret,
    });
    expect(res1.ok).toBe(true); assert(res1.ok);

    // 2nd Execution (Replay with same token / nonce): REJECTED with REPLAY_DETECTED
    const res2 = actionTokenService.verifyAndConsumeToken(callbackData, {
      actorId: authorizedUserId,
      currentRevisionId: 'rev_1',
      secretKey: hmacSecret,
    });
    expect(res2.ok).toBe(false); assert(!res2.ok);
    expect(res2.code).toBe('REPLAY_DETECTED');
  });

  it('4. Stale Token Defense: rejects expired callback action tokens with EXPIRED', async () => {
    const taskId = crypto.randomUUID();

    // Token with -1000ms expiration (already expired)
    const { callbackData } = actionTokenService.createToken({
      taskId,
      revisionId: 'rev_1',
      action: 'approve',
      actorId: authorizedUserId,
      expiresInMs: -1000,
      secretKey: hmacSecret,
    });

    const tokenRes = actionTokenService.verifyAndConsumeToken(callbackData, {
      actorId: authorizedUserId,
      currentRevisionId: 'rev_1',
      secretKey: hmacSecret,
    });
    expect(tokenRes.ok).toBe(false); assert(!tokenRes.ok);
    expect(tokenRes.code).toBe('EXPIRED');
  });

  it('5. Foreign/Unknown Actor Defense: unknown users cannot approve tasks', async () => {
    const taskId = crypto.randomUUID();

    // Token created for authorized user
    const { callbackData } = actionTokenService.createToken({
      taskId,
      revisionId: 'rev_1',
      action: 'approve',
      actorId: authorizedUserId,
      secretKey: hmacSecret,
    });

    // Foreign user attempts verification -> rejected UNAUTHORIZED_ACTOR
    const tokenRes = actionTokenService.verifyAndConsumeToken(callbackData, {
      actorId: foreignUserId,
      currentRevisionId: 'rev_1',
      secretKey: hmacSecret,
    });
    expect(tokenRes.ok).toBe(false); assert(!tokenRes.ok);
    expect(tokenRes.code).toBe('UNAUTHORIZED_ACTOR');
  });

  it('6. Stale Revision Defense: rejects approval minted for an older design revision', async () => {
    const taskId = 'task_stale_rev_test';
    const { callbackData } = actionTokenService.createToken({
      taskId,
      revisionId: 'rev_1_initial',
      action: 'approve',
      actorId: authorizedUserId,
      secretKey: hmacSecret,
    });

    // Verify token with current revision = 'rev_2_edited'
    const result = actionTokenService.verifyAndConsumeToken(callbackData, {
      actorId: authorizedUserId,
      currentRevisionId: 'rev_2_edited',
      secretKey: hmacSecret,
    });

    expect(result.ok).toBe(false); assert(!result.ok);
    if (!result.ok) {
      expect(result.code).toBe('STALE_REVISION');
      expect(result.error).toContain('current task revision is rev_2_edited');
    }
  });

  it('7. Telegram Mini App (Web App) Identity Verification via HMAC-SHA256', async () => {
    // Generate valid Telegram Web App initData
    const user = { id: parseInt(authorizedUserId, 10), first_name: 'Director', username: 'kaae_director' };
    const authDate = Math.floor(Date.now() / 1000);
    const queryId = 'AAFlkjasdf99';

    const params = new URLSearchParams();
    params.set('auth_date', String(authDate));
    params.set('query_id', queryId);
    params.set('user', JSON.stringify(user));

    const entries: string[] = [];
    params.forEach((v, k) => entries.push(`${k}=${v}`));
    entries.sort();
    const dataCheckString = entries.join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    params.set('hash', hash);

    const validInitData = params.toString();

    // A. Test API endpoint with valid Mini App initData
    const res = await app.request('/api/auth/telegram-miniapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: validInitData }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(true);
    expect(body.user.id).toBe(parseInt(authorizedUserId, 10));
    expect(body.sessionToken).toContain('tg_miniapp_sess_');
    // The token is random: it carries nothing of the user, and a second login gets another.
    expect(body.sessionToken).not.toContain(Buffer.from(JSON.stringify(body.user)).toString('base64url').slice(0, 12));
    const again = await (await app.request('/api/auth/telegram-miniapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: validInitData }) })).json();
    expect(again.sessionToken).not.toBe(body.sessionToken);

    // Verify session token can access protected authenticated endpoints
    const authSessionRes = await app.request('/api/auth/session', {
      headers: { Authorization: `Bearer ${body.sessionToken}` },
    });
    expect(authSessionRes.status).toBe(200);
    const authSessionBody = await authSessionRes.json();
    expect(authSessionBody.authenticated).toBe(true);
    expect(authSessionBody.user.role).toBe('operator');

    // B. Negative control: Tampered initData (hash mismatch)
    const tamperedInitData = validInitData.replace(hash, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    const resTampered = await app.request('/api/auth/telegram-miniapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: tamperedInitData }),
    });
    expect(resTampered.status).toBe(401);

    // C. Negative control: Foreign user in Mini App rejected with 403
    const foreignParams = new URLSearchParams();
    foreignParams.set('auth_date', String(authDate));
    foreignParams.set('user', JSON.stringify({ id: 99999999, first_name: 'Foreign' }));
    const foreignEntries: string[] = [];
    foreignParams.forEach((v, k) => foreignEntries.push(`${k}=${v}`));
    foreignEntries.sort();
    const foreignHash = crypto.createHmac('sha256', secretKey).update(foreignEntries.join('\n')).digest('hex');
    foreignParams.set('hash', foreignHash);

    const resForeign = await app.request('/api/auth/telegram-miniapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: foreignParams.toString() }),
    });
    expect(resForeign.status).toBe(403);
  });
});
