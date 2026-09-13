import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/app.js';
import {
  createDb,
  TaskRepository,
  CanvaBindingRepository,
  withRlsContext,
} from '@hawa/db';
import {
  WahaAdapter,
  WahaIngressHandler,
  computeWahaPayloadHash,
  type MessageEnvelope,
  type OutboundNotification,
} from '@hawa/integrations';
import crypto from 'node:crypto';

describe('CV-08: WhatsApp (WAHA) with Honest Boundaries & Office Isolation', () => {
  const connectionString =
    process.env.TEST_DATABASE_URL ||
    'postgresql://hawa_app:hawa_app_secure_runtime_pass_2026@127.0.0.1:54332/hawa_test';
  const db = createDb(connectionString);
  const tenantId = '00000000-0000-4000-a000-000000000008';
  const userId = '00000000-0000-4000-b000-000000000008';
  const clientId = '00000000-0000-4000-c000-000000000008';

  const taskRepo = new TaskRepository(db);
  const canvaRepo = new CanvaBindingRepository(db);

  const testWebhookSecret = 'test-waha-sec';
  const allowedOfficeGroup = '120363024847291039@g.us';
  const dedicatedOfficeAccount = 'office_waha_session_1';

  let app: any;

  beforeEach(() => {
    process.env.WAHA_WEBHOOK_SECRET = testWebhookSecret;
    process.env.WAHA_ALLOWED_GROUPS = allowedOfficeGroup;
    process.env.WAHA_OFFICE_SESSION = dedicatedOfficeAccount;
    process.env.WAHA_KILL_SWITCH = 'false';
    app = createApp({ db });
  });

  afterEach(() => {
    delete process.env.WAHA_WEBHOOK_SECRET;
    delete process.env.WAHA_ALLOWED_GROUPS;
    delete process.env.WAHA_OFFICE_SESSION;
    delete process.env.WAHA_KILL_SWITCH;
  });

  it('1. Real office group test event -> database -> Canva-linked task', async () => {
    const runId = Date.now();
    const observedMsgId = `waha_obs_msg_${runId}`;
    const rawPayload = {
      event: 'message',
      session: dedicatedOfficeAccount,
      payload: {
        id: observedMsgId,
        from: allowedOfficeGroup,
        participant: '9647501234567@c.us',
        pushname: 'Office Lead Designer',
        body: 'پۆستەری نوێی ئەکادیمیای کەی ئەی ئەی ئی بۆ باوەڕپێدانی نێودەوڵەتی',
        timestamp: Math.floor(runId / 1000),
      },
    };

    const payloadText = JSON.stringify(rawPayload);
    const rawBytes = new TextEncoder().encode(payloadText);
    const expectedHash = crypto.createHash('sha256').update(rawBytes).digest('hex');

    // A. Verify WhatsApp webhook ingress endpoint with HMAC signature and Kurdish normalization
    const hmacSig = crypto
      .createHmac('sha256', testWebhookSecret)
      .update(rawBytes)
      .digest('hex');

    const webhookRes = await app.request('/api/webhooks/whatsapp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-waha-signature': `sha256=${hmacSig}`,
      },
      body: payloadText,
    });

    expect(webhookRes.status).toBe(201);
    const webhookData = await webhookRes.json();
    expect(webhookData.ok).toBe(true);
    expect(webhookData.task).toBeDefined();
    expect(webhookData.task.sourcePlatform).toBe('whatsapp');
    expect(webhookData.rawPayloadHash).toBe(expectedHash);

    // B. Route office group event through Unified Ingress Service to PostgreSQL hawa_test database
    const ingressRes = await app.request('/api/ingress/unified', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.HAWA_BEARER_TOKEN || 'hawa_test_suite_operator_bearer_token'}`,
      },
      body: JSON.stringify({
        tenantId,
        channel: 'waha',
        sourceAccountId: dedicatedOfficeAccount,
        sourceEventId: `waha_event_${runId}`,
        sourceChannelId: allowedOfficeGroup,
        sourceMessageId: observedMsgId,
        senderExternalId: '9647501234567@c.us',
        senderDisplayName: 'Office Lead Designer',
        text: '/task KAAE Ministry Accreditation Announcement',
        rawPayload,
        verified: true,
        explicitClientId: clientId,
      }),
    });

    expect(ingressRes.status).toBe(201);
    const ingressData = await ingressRes.json();
    expect(ingressData.acknowledged).toBe(true);
    expect(ingressData.actionTaken).toBe('task_created');
    const taskId = ingressData.taskId;
    expect(taskId).toBeDefined();

    // Verify task persisted in PostgreSQL hawa_test database under tenant boundary
    const persistedTask = await withRlsContext(
      db,
      { tenantId, userId, role: 'administrator' },
      async (trx) => {
        return taskRepo.findById(taskId, tenantId, trx);
      }
    );
    expect(persistedTask).toBeDefined();
    expect(persistedTask?.id).toBe(taskId);

    // C. Bind native Canva design to this office group WhatsApp task
    const canvaDesignId = `canva_des_waha_${runId}`;
    const binding = await withRlsContext(
      db,
      { tenantId, userId, role: 'administrator' },
      async (trx) => {
        return canvaRepo.createBinding(
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

    expect(binding.canva_design_id).toBe(canvaDesignId);
    expect(binding.task_id).toBe(taskId);
  });

  it('2. Replaces length-based hash with true cryptographic SHA-256 payload hashing', async () => {
    // Two distinct payloads with the exact same length (50 characters)
    const payloadA = 'A'.repeat(50);
    const payloadB = 'B'.repeat(50);
    expect(payloadA.length).toBe(payloadB.length);

    // Old flawed logic would have produced identical `waha_hash_50` for both!
    const legacyHashA = `waha_hash_${payloadA.length}`;
    const legacyHashB = `waha_hash_${payloadB.length}`;
    expect(legacyHashA).toBe(legacyHashB); // Proves the old flaw

    // New cryptographic hashing:
    const hashA = computeWahaPayloadHash(payloadA);
    const hashB = computeWahaPayloadHash(payloadB);

    // Must be distinct 64-character SHA-256 hex strings
    expect(hashA).not.toBe(hashB);
    expect(hashA.length).toBe(64);
    expect(hashB.length).toBe(64);
    expect(hashA).toBe(crypto.createHash('sha256').update(payloadA).digest('hex'));
    expect(hashB).toBe(crypto.createHash('sha256').update(payloadB).digest('hex'));
  });

  it('3. Group allowlist enforcement: admits allowlisted office group, rejects unauthorized group', async () => {
    const runId = Date.now();

    // A. Reject unauthorized group
    const roguePayload = {
      event: 'message',
      payload: {
        id: `waha_rogue_${runId}`,
        from: 'unauthorized_stranger_group@g.us',
        participant: '9647509999999@c.us',
        pushname: 'Rogue Actor',
        body: 'Spam invite',
      },
    };
    const rogueBytes = new TextEncoder().encode(JSON.stringify(roguePayload));
    const rogueSig = crypto.createHmac('sha256', testWebhookSecret).update(rogueBytes).digest('hex');

    const rogueRes = await app.request('/api/webhooks/whatsapp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-waha-signature': `sha256=${rogueSig}`,
      },
      body: JSON.stringify(roguePayload),
    });

    expect(rogueRes.status).toBe(403);
    const rogueData = await rogueRes.json();
    expect(rogueData.title).toBe('Forbidden');
    expect(rogueData.detail).toContain('not in the office allowlist');

    // B. Direct 1:1 client chat is admitted without group restriction
    const directPayload = {
      event: 'message',
      payload: {
        id: `waha_direct_${runId}`,
        from: '9647501234567@c.us',
        pushname: 'Drustee Direct',
        body: 'داواکاری ڕاستەوخۆ بۆ دیزاینی فەرمی',
      },
    };
    const directBytes = new TextEncoder().encode(JSON.stringify(directPayload));
    const directSig = crypto.createHmac('sha256', testWebhookSecret).update(directBytes).digest('hex');

    const directRes = await app.request('/api/webhooks/whatsapp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-waha-signature': `sha256=${directSig}`,
      },
      body: JSON.stringify(directPayload),
    });

    expect(directRes.status).toBe(201);
    const directData = await directRes.json();
    expect(directData.ok).toBe(true);
  });

  it('4. WAHA session health probe: WORKING, SCAN_QR_CODE, STOPPED, OFFLINE', async () => {
    const ctx = {
      requestId: 'req_waha_test_health',
      tenantId,
      actor: { type: 'system' as const, id: 'sys' },
    };

    // Case A: WORKING session
    const mockWorkingFetch = async () =>
      new Response(
        JSON.stringify({
          name: 'default',
          status: 'WORKING',
          me: { id: '9647501112233@c.us', pushName: 'Hawa Office Bot' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );

    const workingAdapter = new WahaAdapter({
      baseUrl: 'http://waha.internal:3000',
      apiKey: 'test-key',
      enabled: true,
      allowedGroupJids: [allowedOfficeGroup],
      dedicatedOfficeAccount,
      httpClient: mockWorkingFetch as any,
    });

    const workingHealth = await workingAdapter.health(ctx);
    expect(workingHealth.ok).toBe(true);
    expect(workingHealth.value.state).toBe('healthy');
    expect(workingHealth.value.detail.sessionState).toBe('WORKING');
    expect(workingHealth.value.detail.dedicatedAccount).toBe(dedicatedOfficeAccount);

    // Case B: SCAN_QR_CODE session (re-authentication required)
    const mockQrFetch = async () =>
      new Response(
        JSON.stringify({
          name: 'default',
          status: 'SCAN_QR_CODE',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );

    const qrAdapter = new WahaAdapter({
      baseUrl: 'http://waha.internal:3000',
      apiKey: 'test-key',
      enabled: true,
      allowedGroupJids: [allowedOfficeGroup],
      dedicatedOfficeAccount,
      httpClient: mockQrFetch as any,
    });

    const qrHealth = await qrAdapter.health(ctx);
    expect(qrHealth.ok).toBe(true);
    expect(qrHealth.value.state).toBe('reauth_required');
    expect(qrHealth.value.detail.qrRequired).toBe(true);
    expect(qrHealth.value.detail.fallbackChannel).toBe('desk');
    expect(qrHealth.value.detail.fallbackInstructions).toContain('Hawa Desk intake');

    // Case C: STOPPED session
    const mockStoppedFetch = async () =>
      new Response(
        JSON.stringify({
          name: 'default',
          status: 'STOPPED',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );

    const stoppedAdapter = new WahaAdapter({
      baseUrl: 'http://waha.internal:3000',
      apiKey: 'test-key',
      enabled: true,
      httpClient: mockStoppedFetch as any,
    });

    const stoppedHealth = await stoppedAdapter.health(ctx);
    expect(stoppedHealth.ok).toBe(true);
    expect(stoppedHealth.value.state).toBe('unavailable');
    expect(stoppedHealth.value.detail.sessionState).toBe('STOPPED');

    // Case D: OFFLINE (server down / network timeout)
    const mockOfflineFetch = async () => {
      throw new Error('Connection refused: 127.0.0.1:3000');
    };

    const offlineAdapter = new WahaAdapter({
      baseUrl: 'http://127.0.0.1:3000',
      apiKey: 'test-key',
      enabled: true,
      httpClient: mockOfflineFetch as any,
    });

    const offlineHealth = await offlineAdapter.health(ctx);
    expect(offlineHealth.ok).toBe(true);
    expect(offlineHealth.value.state).toBe('unavailable');
    expect(offlineHealth.value.detail.sessionState).toBe('OFFLINE');
    expect(offlineHealth.value.detail.fallbackInstructions).toContain('Intake diverted to Hawa Desk');
  });

  it('5. QR disconnect drill: preserves tasks, alerts with fallback instructions, does not fabricate delivery', async () => {
    const ctx = {
      requestId: 'req_qr_drill',
      tenantId,
      actor: { type: 'system' as const, id: 'sys' },
    };

    // When WAHA session is disconnected (SCAN_QR_CODE)
    const mockQrFetch = async () =>
      new Response(
        JSON.stringify({
          error: 'Session is not connected',
          status: 'SCAN_QR_CODE',
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );

    const adapter = new WahaAdapter({
      baseUrl: 'http://waha.internal:3000',
      apiKey: 'key',
      enabled: true,
      allowedGroupJids: [allowedOfficeGroup],
      httpClient: mockQrFetch as any,
    });

    const notification: OutboundNotification = {
      destination: {
        accountId: dedicatedOfficeAccount,
        channelId: allowedOfficeGroup,
      },
      type: 'review_ready',
      text: 'دیزاین ئامادەیە بۆ پێداچوونەوە',
    };

    const notifyResult = await adapter.notify(ctx, notification);

    // Must NOT claim delivered: true!
    expect(notifyResult.ok).toBe(false);
    if (!notifyResult.ok) {
      expect(notifyResult.error.code).toBe('WAHA_DISPATCH_FAILED');
      expect(notifyResult.error.retryable).toBe(true);
      expect(notifyResult.error.safeAction).toContain('Preserve outbox command for retry');
    }
  });

  it('6. Office kill switch drill: halts outbound immediately, preserves tasks in outbox, returns 503 on inbound', async () => {
    const ctx = {
      requestId: 'req_kill_drill',
      tenantId,
      actor: { type: 'system' as const, id: 'sys' },
    };

    // A. Verify adapter behavior when disabled
    const disabledAdapter = new WahaAdapter({
      baseUrl: 'http://waha.internal:3000',
      apiKey: 'key',
      enabled: false, // Kill switch active
      allowedGroupJids: [allowedOfficeGroup],
    });

    // Inbound rejection
    const inboundRes = await disabledAdapter.verifyAndNormalize({
      headers: new Headers(),
      rawBody: new TextEncoder().encode('{"id":"123"}'),
      receivedAt: new Date().toISOString(),
    });
    expect(inboundRes.ok).toBe(false);
    if (!inboundRes.ok) {
      expect(inboundRes.error.code).toBe('WAHA_ADAPTER_DISABLED');
      expect(inboundRes.error.safeAction).toContain('canonical Hawa Desk intake');
    }

    // Outbound rejection
    const outboundRes = await disabledAdapter.notify(ctx, {
      destination: { accountId: 'acc', channelId: allowedOfficeGroup },
      type: 'task_created',
      text: 'Halted notification',
    });
    expect(outboundRes.ok).toBe(false);
    if (!outboundRes.ok) {
      expect(outboundRes.error.code).toBe('WAHA_KILL_SWITCH_ACTIVE');
      expect(outboundRes.error.retryable).toBe(true);
      expect(outboundRes.error.message).toContain('task preserved in outbox');
    }

    // B. Verify HTTP endpoint /api/webhooks/whatsapp returns 503 when WAHA_KILL_SWITCH=true
    process.env.WAHA_KILL_SWITCH = 'true';
    const httpRes = await app.request('/api/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'message',
        payload: { id: 'waha_kill_test', from: allowedOfficeGroup, body: 'Hello' },
      }),
    });
    expect(httpRes.status).toBe(503);
    const httpData = await httpRes.json();
    expect(httpData.detail).toContain('disabled by office kill switch');
    expect(httpData.detail).toContain('Hawa Desk');

    // Health endpoint reflects kill switch
    const healthRes = await app.request('/api/waha/health');
    expect(healthRes.status).toBe(200);
    const healthData = await healthRes.json();
    expect(healthData.state).toBe('unavailable');
    expect(healthData.detail.killSwitchActive).toBe(true);
  });

  it('7. Honest outbound reconciliation: detects session gaps, reports outage without invented receipts', async () => {
    const ctx = {
      requestId: 'req_reconcile_test',
      tenantId,
      actor: { type: 'system' as const, id: 'sys' },
    };

    // Mock WAHA session offline during reconciliation
    const mockOfflineFetch = async () => {
      throw new Error('Network timeout contacting WAHA session');
    };

    const adapter = new WahaAdapter({
      baseUrl: 'http://waha.internal:3000',
      apiKey: 'key',
      enabled: true,
      httpClient: mockOfflineFetch as any,
    });

    const reconcileRes = await adapter.reconcile(ctx, {
      limit: 10,
      since: '2026-09-11T20:00:00.000Z',
    });

    expect(reconcileRes.ok).toBe(true);
    expect(reconcileRes.value.complete).toBe(false);
    expect(reconcileRes.value.detectedGaps.length).toBeGreaterThan(0);
    expect(reconcileRes.value.detectedGaps[0].reason).toContain('OFFLINE');

    // Case B: Mock WAHA session healthy
    const mockHealthyFetch = async () =>
      new Response(
        JSON.stringify({
          status: 'WORKING',
          me: { id: 'office@c.us' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );

    const healthyAdapter = new WahaAdapter({
      baseUrl: 'http://waha.internal:3000',
      apiKey: 'key',
      enabled: true,
      httpClient: mockHealthyFetch as any,
    });

    const healthyReconcile = await healthyAdapter.reconcile(ctx, {
      limit: 10,
      since: '2026-09-11T20:00:00.000Z',
    });

    expect(healthyReconcile.ok).toBe(true);
    expect(healthyReconcile.value.complete).toBe(true);
    expect(healthyReconcile.value.detectedGaps.length).toBe(0);
  });
});
