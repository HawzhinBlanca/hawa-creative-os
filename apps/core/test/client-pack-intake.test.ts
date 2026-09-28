import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';

/**
 * Client packs at intake (ADR-127, ported from studio-v2's a5a50dad). A client still being set up
 * is named and saved on its own canvas, but not drafted automatically; a message naming two clients
 * is left for the office; KAAE is read exactly as before.
 */
const ZAR = 'c1000000-0000-4000-8000-000000000011';
const KAAE = 'c1000000-0000-4000-8000-000000000002';

async function send(text: string) {
  const dispatch = vi.fn().mockResolvedValue({ success: true });
  const app = createApp({ telegramBridge: { dispatchOutboundMessage: dispatch } as any });
  const chatId = `pack-routing-${randomUUID()}`;
  const res = await app.request('/api/webhooks/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET! },
    body: JSON.stringify({
      update_id: `pack-routing-${randomUUID()}`,
      message: { message_id: 7, from: { id: 42, first_name: 'Office' }, chat: { id: chatId }, text },
    }),
  });
  return { status: res.status, body: await res.json(), replies: dispatch.mock.calls.map((c) => String(c[1]?.text ?? '')).join('\n') };
}

describe('intake routes by client pack', () => {
  it('names a thumbnail client, saves it on a YouTube canvas, and drafts nothing while it is being set up', async () => {
    const { body, replies } = await send('Thumbnail for ZAR Podcast episode 14\n\nGuest: Dr. Ahmed Karim\nWhy cities flood');
    expect(body.task.clientId).toBe(ZAR);
    expect(replies).toContain('ZAR Podcast');
    expect(replies).toContain('1280×720 (16:9)');
    expect(replies).toContain('still being set up');
    expect(replies).not.toContain('Preparing your Canva draft');
  });

  it('keeps KAAE exactly as before: named, 4:5, no set-up note', async () => {
    const { body, replies } = await send('KAAE announcement\n\nAccreditation visit to Salahaddin University, 3 October');
    expect(body.task.clientId).toBe(KAAE);
    expect(replies).toContain('KAAE (Accreditation)');
    expect(replies).toContain('1080×1350 (4:5)');
    expect(replies).not.toContain('still being set up');
  });

  it('leaves a message that names two clients for the office to assign', async () => {
    const { body, replies } = await send('Halwest News interview about KAAE\n\nThumbnail please');
    expect(body.task.clientId).toBeNull();
    expect(replies).toContain('No client was named');
  });

  it('does not take an everyday word for a client', async () => {
    const { body } = await send('Poster about the zar exchange rate in Erbil\n\nToday only');
    expect(body.task.clientId).toBeNull();
  });
});
