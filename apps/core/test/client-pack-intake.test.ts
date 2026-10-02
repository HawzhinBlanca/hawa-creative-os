import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createChatCampaignIntake } from '../src/services/chat-campaign-intake.js';

/**
 * Client packs at intake (ADR-127, ported from studio-v2's a5a50dad). A client still being set up
 * is named and saved on its own canvas, but not drafted automatically; a message naming two clients
 * is left for the office; KAAE is read exactly as before.
 *
 * ADR-135 stage 2: Telegram intake is the lifecycle's alone, and a new request is the draft
 * prepareChatCampaignDraft builds (lifecycle-internal.routes.ts). The legacy webhook's acknowledgement
 * text went with the legacy route; the routing, canvas and automatic-draft decisions are the draft's.
 */
const ZAR = 'c1000000-0000-4000-8000-000000000011';
const KAAE = 'c1000000-0000-4000-8000-000000000002';

function send(text: string) {
  return createChatCampaignIntake({ telegramBridge: {} } as any).prepareChatCampaignDraft({
    platform: 'telegram', sourceEventId: `pack-routing-${randomUUID()}`, sourceChannelId: `pack-routing-${randomUUID()}`,
    senderName: 'Office', rawText: text, rawJson: { message: { text } }, autoGenerate: true, isInstructionOnly: false,
  });
}

describe('intake routes by client pack', () => {
  it('names a thumbnail client, saves it on a YouTube canvas, and drafts nothing while it is being set up', async () => {
    const draft = await send('Thumbnail for ZAR Podcast episode 14\n\nGuest: Dr. Ahmed Karim\nWhy cities flood');
    expect(draft.clientId).toBe(ZAR);
    expect(draft.variant).toEqual({ width: 1280, height: 720 });
    expect(draft.autoGenerate).toBe(false);
  });

  it('keeps KAAE exactly as before: named, 4:5, drafted automatically', async () => {
    const draft = await send('KAAE announcement\n\nAccreditation visit to Salahaddin University, 3 October');
    expect(draft.clientId).toBe(KAAE);
    expect(draft.variant).toEqual({ width: 1080, height: 1350 });
    expect(draft.autoGenerate).toBe(true);
  });

  it('leaves a message that names two clients for the office to assign', async () => {
    const draft = await send('Halwest News interview about KAAE\n\nThumbnail please');
    expect(draft.clientId).toBeNull();
    expect(draft.autoGenerate).toBe(false);
  });

  it('does not take an everyday word for a client', async () => {
    const draft = await send('Poster about the zar exchange rate in Erbil\n\nToday only');
    expect(draft.clientId).toBeNull();
  });

  // Live 2026-10-02 (canary chat): a packed client's request was labelled with the sender's first name
  // ("Canary: Spring Concert"). The label is the client's short name, else the sender's.
  it('labels a packed client\'s request with the client, never the sender', async () => {
    const draft = await send('Could you design a Canary Test poster for our Spring Concert? It\'s on 20 October 2026 at 6:00 PM in the Main Hall, Erbil.');
    expect(draft.clientId).toBe('c1000000-0000-4000-8000-000000000099');
    expect(draft.title).toMatch(/^Canary Test: Spring Concert/);
    const zar = await send('Thumbnail for ZAR Podcast episode 14\n\nGuest: Dr. Ahmed Karim\nWhy cities flood');
    expect(zar.title).not.toMatch(/^Office: /);
  });

  it('keeps the sender as the label when no client is known', async () => {
    const draft = await send('Poster about the zar exchange rate in Erbil\n\nToday only');
    expect(draft.clientId).toBeNull();
    expect(draft.title).toMatch(/^Office: /);
  });
});
