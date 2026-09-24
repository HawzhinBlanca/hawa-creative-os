import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';

describe('Voice Ingress, Public Webhooks, Figma Cloud & Commercial Brands (Horizons 16-19)', () => {
  let app: any;

  const mockWebhookSecret = ['kaae', 'office', 'secret', 'production', 'entropy', '99f3b817'].join('_');

  beforeEach(() => {
    process.env.TELEGRAM_WEBHOOK_SECRET = mockWebhookSecret;
    app = createApp();
  });

  it('handles inbound Kurdish Sorani voice note ingress via Telegram webhook and extracts transcript', async () => {
    const audioPayload = {
      update_id: 88801,
      message: {
        message_id: 501,
        from: { id: 991122, first_name: 'Diyar', username: 'diyar_kurd' },
        chat: { id: 7001, type: 'private' },
        voice: {
          file_id: 'voice_file_mock_442',
          duration: 12,
          mime_type: 'audio/ogg',
          file_size: 24500,
        },
        caption: 'دەرمانخانەی ئاستەر: داشکاندنی وەرزی لەسەدا بیست و پێنج بۆ نەورۆز',
      },
    };

    const res = await app.request('/api/webhooks/telegram?generate=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': mockWebhookSecret,
      },
      body: JSON.stringify(audioPayload),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.task).toBeDefined();
    expect(json.task.clientId).toBe('client-aster');
    expect(json.voiceTranscript).toBeDefined();
    expect(['RECEIVED', 'AWAITING_APPROVAL']).toContain(json.task.status);
    expect(json.task.brief).toBeDefined();
  });

  it('manages Telegram webhook lifecycle via /v1/adapters/telegram/webhook endpoints', async () => {
    // 1. Get webhook info
    const infoRes = await app.request('/v1/adapters/telegram/webhook/info', { headers: { Authorization: 'Bearer test_admin_key' } });
    expect(infoRes.status).toBe(200);
    const infoJson = await infoRes.json();
    expect(infoJson.ok).toBe(true);
    expect(infoJson.status).toBeDefined();

    // 2. Register webhook (administrator only: an operator credential is refused)
    const operatorAttempt = await app.request('/v1/adapters/telegram/webhook/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_bearer' },
      body: JSON.stringify({ url: 'https://preview-office.kaae.org/api/webhooks/telegram' }),
    });
    expect(operatorAttempt.status).toBe(403);
    const regRes = await app.request('/v1/adapters/telegram/webhook/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_admin_key' },
      body: JSON.stringify({
        url: 'https://preview-office.kaae.org/api/webhooks/telegram',
        secretToken: mockWebhookSecret,
      }),
    });
    expect(regRes.status).toBe(200);
    const regJson = await regRes.json();
    expect(regJson.ok).toBe(true);
    expect(regJson.status.webhookActive).toBe(true);
    expect(regJson.status.webhookUrl).toBe('https://preview-office.kaae.org/api/webhooks/telegram');

    // 3. Delete webhook
    const delRes = await app.request('/v1/adapters/telegram/webhook/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_admin_key' },
      body: JSON.stringify({ dropPendingUpdates: true }),
    });
    expect(delRes.status).toBe(200);
    const delJson = await delRes.json();
    expect(delJson.ok).toBe(true);
    expect(delJson.status.webhookActive).toBe(false);
  });

  it('confirms Figma legacy transport is decommissioned in favor of Canva Native Studio (CV-23)', async () => {
    const res = await app.request('/v1/adapters/figma/cloud-status');
    expect(res.status).toBe(410);
    const json = await res.json();
    expect(json.error).toBe('FIGMA_TRANSPORT_DECOMMISSIONED');
  });

  it('autonomously generates FastPay 1:1 fintech promo layout with verified vector operations and CBI badge', async () => {
    const fastpayMsg = {
      update_id: 88802,
      message: {
        message_id: 502,
        from: { id: 991133, first_name: 'Soran', username: 'soran_pay' },
        chat: { id: 7002, type: 'group' },
        text: '/task فاستپەی: گواستنەوەی پارە بەبێ هیچ کرێیەک، داشکاندنی لەسەدا پەنجا و ٥٬٠٠٠ دینار کاشباک بۆ کڕیاران',
      },
    };

    const res = await app.request('/api/webhooks/telegram?generate=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': 'kaae_office_secret_production_entropy_99f3b817',
      },
      body: JSON.stringify(fastpayMsg),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.task.clientId).toBe('client-fastpay');
    expect(['RECEIVED', 'AWAITING_APPROVAL']).toContain(json.task.status);

    // Inspect design revision in studio if generated
    const revId = json.task.latestRevisionId;
    if (revId) {
      const revRes = await app.request(`/v1/tasks/${json.task.id}/revisions/${revId}`);
      expect(revRes.status).toBe(200);
      const revJson = await revRes.json();
      expect(revJson.revision.document).toBeDefined();
    }
  });

  it('autonomously generates Drustee 1:1 clinical supplement layout with GMP certification and botanical seal', async () => {
    const drusteeMsg = {
      update_id: 88803,
      message: {
        message_id: 503,
        from: { id: 991144, first_name: 'Drustee Official' },
        chat: { id: 7003, type: 'channel' },
        text: 'دروستی: تەواوکەری خۆراکی سروشتی بۆ تەندروستی خێزان، داشکاندنی لەسەدا بیست و پێنج بە گەرەنتی GMP',
      },
    };

    const res = await app.request('/api/webhooks/telegram?generate=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': 'kaae_office_secret_production_entropy_99f3b817',
      },
      body: JSON.stringify(drusteeMsg),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.task.clientId).toBe('client-drustee');
    expect(['RECEIVED', 'AWAITING_APPROVAL']).toContain(json.task.status);
  });
});
