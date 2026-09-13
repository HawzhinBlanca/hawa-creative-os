import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import {
  createDb,
  IngressRepository,
  TaskRepository,
  CanvaBindingRepository,
  withRlsContext,
} from '@hawa/db';
import {
  TelegramBridgeDaemon,
  TelegramActionTokenService,
  verifyTelegramMiniAppInitData,
  MemoryTelegramOffsetStorage,
  type TelegramUpdate,
} from '@hawa/integrations';
import crypto from 'node:crypto';

describe('CV-07: Telegram First-Class Adapter & Security Verification', () => {
  const connectionString =
    process.env.TEST_DATABASE_URL ||
    'postgresql://hawa_app:hawa_app_secure_runtime_pass_2026@127.0.0.1:54332/hawa_test';
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
        'Authorization': `Bearer ${process.env.HAWA_BEARER_TOKEN || 'hawa_test_suite_operator_bearer_token'}`,
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
            actorId: userId,
          },
          trx
        );
      }
    );

    expect(binding).toBeDefined();
    expect(binding.canva_design_id).toBe(canvaDesignId);

    // C. Format preview card with Canva deep link and cryptographically bound action tokens
    const bridge = new TelegramBridgeDaemon({
      actionTokenService,
      allowedUserIds: [authorizedUserId],
    });

    const card = bridge.formatTaskPreviewCard(
      {
        id: taskId,
        title: 'KAAE Ministry Accreditation Announcement',
        status: 'AWAITING_APPROVAL',
        clientName: 'KAAE',
        revisionId: 'rev_1',
        actorId: authorizedUserId,
        canvaDocumentId: canvaDesignId,
        canvaUrl: binding.edit_url,
      },
      hmacSecret
    );

    expect(card.text).toContain('KAAE Ministry Accreditation Announcement');
    expect(card.text).toContain(`Canva Binding:* \`${canvaDesignId}\``);
    expect(card.reply_markup?.inline_keyboard).toBeDefined();
  });

  it('2. Callback Action Tokens: verifies valid approval and omnichannel publication', async () => {
    const runId = Date.now();
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
    expect(verifyResult.ok).toBe(true);
    expect(verifyResult.payload?.taskId).toBe(taskId);
    expect(verifyResult.payload?.action).toBe('approve');

    // Send callback query webhook request: strictly gated to Desk review with 422
    const res = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': testSecret,
      },
      body: JSON.stringify({
        update_id: 10001 + runId % 10000,
        callback_query: {
          id: `cb_${runId}`,
          from: { id: parseInt(authorizedUserId, 10), first_name: 'Authorized', is_bot: false },
          message: { message_id: 8891, chat: { id: 450405554, type: 'private' } },
          data: callbackData,
        },
      }),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.title).toBe('Desk review required');
    expect(body.detail).toContain('Desk review bound to a captured revision');
  });

  it('3. Callback Replay Attack Defense: rejects duplicate execution with REPLAY_DETECTED', async () => {
    const runId = Date.now();
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
    expect(res1.ok).toBe(true);

    // 2nd Execution (Replay with same token / nonce): REJECTED with REPLAY_DETECTED
    const res2 = actionTokenService.verifyAndConsumeToken(callbackData, {
      actorId: authorizedUserId,
      currentRevisionId: 'rev_1',
      secretKey: hmacSecret,
    });
    expect(res2.ok).toBe(false);
    expect(res2.code).toBe('REPLAY_DETECTED');

    // Chat webhook boundary defense: rejects callback queries with 422 Desk review required
    const hookRes = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': testSecret,
      },
      body: JSON.stringify({
        update_id: 20002 + runId % 10000,
        callback_query: {
          id: `cb_replay_${runId}`,
          from: { id: parseInt(authorizedUserId, 10), first_name: 'Authorized', is_bot: false },
          message: { message_id: 8893, chat: { id: 450405554, type: 'private' } },
          data: callbackData,
        },
      }),
    });
    expect(hookRes.status).toBe(422);
    const hookBody = await hookRes.json();
    expect(hookBody.title).toBe('Desk review required');
  });

  it('4. Stale Token Defense: rejects expired callback action tokens with EXPIRED', async () => {
    const runId = Date.now();
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
    expect(tokenRes.ok).toBe(false);
    expect(tokenRes.code).toBe('EXPIRED');

    const res = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': testSecret,
      },
      body: JSON.stringify({
        update_id: Math.floor(Math.random() * 100000000) + 30001,
        callback_query: {
          id: `cb_expired_${runId}`,
          from: { id: parseInt(authorizedUserId, 10), first_name: 'Authorized', is_bot: false },
          message: { message_id: 8894, chat: { id: 450405554, type: 'private' } },
          data: callbackData,
        },
      }),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.title).toBe('Desk review required');
  });

  it('5. Foreign/Unknown Actor Defense: unknown users cannot approve tasks', async () => {
    const runId = Date.now();
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
    expect(tokenRes.ok).toBe(false);
    expect(tokenRes.code).toBe('UNAUTHORIZED_ACTOR');

    // Foreign user clicks button in webhook -> rejected with 422 Desk review required
    const res = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': testSecret,
      },
      body: JSON.stringify({
        update_id: Math.floor(Math.random() * 100000000) + 40001,
        callback_query: {
          id: `cb_foreign_${runId}`,
          from: { id: parseInt(foreignUserId, 10), first_name: 'Intruder', is_bot: false },
          message: { message_id: 8895, chat: { id: 450405554, type: 'private' } },
          data: callbackData,
        },
      }),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.title).toBe('Desk review required');
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

    expect(result.ok).toBe(false);
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

  it('8. Polling Mode Offset Persistence and Truthful Outage Recovery', async () => {
    const offsetStorage = new MemoryTelegramOffsetStorage();
    await offsetStorage.setOffset(4500);

    const bridge = new TelegramBridgeDaemon({
      botToken: 'mock_token',
      offsetStorage,
    });

    // Simulate update processing with offset persistence
    const update1: TelegramUpdate = {
      update_id: 4501,
      message: {
        message_id: 101,
        chat: { id: 12345, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'Test update 1',
        from: { id: 12345, is_bot: false, first_name: 'Test' },
      },
    };

    const res1 = await bridge.processUpdate(update1);
    expect(res1.processed).toBe(true);

    // Verify offset storage was updated
    const savedOffset = await offsetStorage.getOffset();
    expect(savedOffset).toBe(4501);

    // Verify status inspection truthfully reports mode and offset
    const status = bridge.getStatus();
    expect(status.lastUpdateId).toBe(4501);
    expect(status.processedCount).toBe(1);
    expect(status.mode).toBe('live_polling');
    expect(status.degraded).toBe(false);
  });
});
