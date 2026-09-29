import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb } from '@hawa/db';
import { createApp } from '../src/app.js';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { persistChatIntake } from '../src/services/chat-intake.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;

// Telegram delivers a request's text and a photo sent with it as two messages. On 2026-09-19 the
// photo became a "revision" (task 936c5c6f) and a second full design run; it now joins the request.
// ADR-135 stage 2 deleted the legacy lookup of the request a photo joins (findRequestAwaitingReference)
// with the legacy webhook; the studio still reads a photo saved as the request's reference.
describe.skipIf(!url)('a caption-less photo joins the request it followed', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const clientId = 'c1000000-0000-4000-8000-000000000002';
  const scope = { tenantId: '00000000-0000-4000-a000-000000000001', actorId: '00000000-0000-4000-b000-000000000001' };
  const photo = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHR8eHR0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
  afterAll(() => db.destroy());

  const request = async (channel: string) =>
    (
      await persistChatIntake(db, {
        platform: 'telegram',
        sourceEventId: randomUUID(),
        sourceChannelId: channel,
        clientId,
        title: 'KAAE: Standards launch',
        rawText: 'Launch announcement\n---\nStandards Framework 2.0',
        designInstructions: '',
        exactCopy: [],
        designStudio: true,
      })
    ).task.id as string;

  it('the studio reads a photo that joined the request, and the photo\'s own task sends no manual-design notice', async () => {
    const channel = `late-ref-${randomUUID().slice(0, 8)}`;
    const taskId = await request(channel);
    const service = new DesignStudioService(db, undefined, { apiKey: 'test-key', fetcher: (async () => { throw new Error('no calls'); }) as any });
    const joined = await persistChatIntake(db, {
      platform: 'telegram',
      sourceEventId: randomUUID(),
      sourceChannelId: channel,
      clientId,
      title: 'KAAE: Standards launch (reference image)',
      rawText: 'Apply the attached visual reference image as a design style, layout, and composition guide.',
      designInstructions: '',
      exactCopy: [],
      isInstructionOnly: true,
      studioOptions: { referenceFor: taskId, referenceImageBase64: photo },
    });
    expect(await (service as any).attachedImage(scope, taskId)).toBe(photo);

    // No "queued for manual design" notice for the photo's own task.
    const app = createApp({ db });
    const res = await app.request(`/v1/tasks/${joined.task.id}/notifications/canva-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` },
      body: JSON.stringify({ status: 'MANUAL_DESIGN_REQUIRED' }),
    });
    expect(await res.json()).toMatchObject({ notified: false, reason: 'REFERENCE_FOR_ANOTHER_REQUEST' });
  });
});
