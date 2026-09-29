import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { createChatCampaignIntake } from '../src/services/chat-campaign-intake.js';

describe('Voice Ingress, Public Webhooks, Figma Cloud & Commercial Brands (Horizons 16-19)', () => {
  let app: any;

  const mockWebhookSecret = ['kaae', 'office', 'secret', 'production', 'entropy', '99f3b817'].join('_');

  beforeEach(() => {
    process.env.TELEGRAM_WEBHOOK_SECRET = mockWebhookSecret;
    app = createApp();
  });

  it('manages Telegram webhook lifecycle via /v1/adapters/telegram/webhook endpoints', async () => {
    // 1. Get webhook info
    const infoRes = await app.request('/v1/adapters/telegram/webhook/info', { headers: { Authorization: 'Bearer test_admin_key' } });
    expect(infoRes.status).toBe(200);
    const infoJson = await infoRes.json();
    expect(infoJson.ok).toBe(true);
    expect(infoJson.status).toBeDefined();

    // 2. Registration was removed by stage 2 of ADR-135: a webhook would send every update past
    // RequestLifecycle and stop the worker's getUpdates, the only poller.
    const regRes = await app.request('/v1/adapters/telegram/webhook/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_admin_key' },
      body: JSON.stringify({ url: 'https://preview-office.kaae.org/api/webhooks/telegram', secretToken: mockWebhookSecret }),
    });
    expect(regRes.status).toBe(404);

    // 3. Delete webhook (kept: it clears a webhook set outside Hawa, which would stop the worker's poller)
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

  // ADR-135 stage 2: the legacy webhook these two cases posted to is gone; a new Telegram request is
  // the draft prepareChatCampaignDraft builds for the lifecycle, with the brand alias resolved to
  // its seeded client row. Voice intake is the lifecycle's (lifecycle-voice*.test.ts).
  const prepare = (text: string, senderName: string) =>
    createChatCampaignIntake({ telegramBridge: {} } as any).prepareChatCampaignDraft({
      platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: String(7000 + Math.floor(Math.random() * 1e6)),
      senderName, rawText: text, rawJson: { message: { text } }, autoGenerate: true, isInstructionOnly: false,
    });

  it('routes a Kurdish FastPay promo to FastPay', async () => {
    const draft = await prepare('فاستپەی: گواستنەوەی پارە بەبێ هیچ کرێیەک، داشکاندنی لەسەدا پەنجا و ٥٬٠٠٠ دینار کاشباک بۆ کڕیاران', 'Soran');
    expect(draft.clientId).toBe('c1000000-0000-4000-8000-000000000004');
    expect(draft.headlineCkb).toContain('فاستپەی');
  });

  it('routes a Kurdish Drustee supplement request to Drustee', async () => {
    const draft = await prepare('دروستی: تەواوکەری خۆراکی سروشتی بۆ تەندروستی خێزان، داشکاندنی لەسەدا بیست و پێنج بە گەرەنتی GMP', 'Drustee Official');
    expect(draft.clientId).toBe('c1000000-0000-4000-8000-000000000003');
  });
});
