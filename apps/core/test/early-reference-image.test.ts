import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb } from '@hawa/db';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { persistChatIntake } from '../src/services/chat-intake.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;

/**
 * Brand guidelines are sent first and the request after. On 2026-09-22 a client sent two reference
 * images at 10:03 and the brief at 10:05. Each image became a clientless task whose headline copy
 * was the synthetic caption "Apply the attached visual reference image…", queued for manual design,
 * and the brief was drafted without them.
 *
 * ADR-135 stage 2 deleted the legacy webhook that saved a lone photo as an instruction-only reference
 * (its case went with it); the studio still finds such a reference, as saved below.
 */
describe.skipIf(!url)('a reference image sent before the request', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const clientId = 'c1000000-0000-4000-8000-000000000002';
  const scope = { tenantId: '00000000-0000-4000-a000-000000000001', actorId: '00000000-0000-4000-b000-000000000001' };
  const photo = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHR8eHR0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
  afterAll(async () => {
    await db.destroy();
  });

  const service = () => new DesignStudioService(db, undefined, { apiKey: 'test-key', fetcher: (async () => { throw new Error('no calls'); }) as any });

  const brief = async (channel: string, rawText = 'HER PATH, HER POWER\n---\nSeptember 25, 2026') =>
    (
      await persistChatIntake(db, {
        platform: 'telegram',
        sourceEventId: randomUUID(),
        sourceChannelId: channel,
        clientId,
        title: 'KAAE: Her path, her power',
        rawText,
        designInstructions: '',
        exactCopy: [],
        designStudio: true,
      })
    ).task.id as string;
  const different = 'ANOTHER EVENT\n---\nOctober 2, 2026';

  it('is the reference for a request that follows it, and not for one in another chat or long after', async () => {
    const channel = `early-ref-${randomUUID().slice(0, 8)}`;
    const orphan = await persistChatIntake(db, {
      platform: 'telegram',
      sourceEventId: randomUUID(),
      sourceChannelId: channel,
      clientId: null,
      title: 'Sewa: reference image (awaiting request)',
      rawText: 'Apply the attached visual reference image as a design style, layout, and composition guide.',
      designInstructions: '',
      exactCopy: [],
      isInstructionOnly: true,
      autoGenerate: false,
      studioOptions: { referenceImageBase64: photo },
    });
    expect(orphan.task.client_id).toBeNull();

    const taskId = await brief(channel);
    expect(await (service() as any).attachedImage(scope, taskId)).toBe(photo);

    const elsewhere = await brief(`other-${randomUUID().slice(0, 8)}`);
    expect(await (service() as any).attachedImage(scope, elsewhere)).toBeUndefined();

    // A different request from the same chat does not get it: the first request took it.
    const second = await brief(channel, different);
    expect(await (service() as any).attachedImage(scope, second)).toBeUndefined();
    // The same words re-sent are the same request, and carry its image.
    const resent = await brief(channel);
    expect(await (service() as any).attachedImage(scope, resent)).toBe(photo);

    // Outside the window it is not this request's reference (events are append-only, so the
    // window is closed instead of the event being aged).
    const window = process.env.HAWA_REFERENCE_MERGE_MINUTES_BEFORE;
    process.env.HAWA_REFERENCE_MERGE_MINUTES_BEFORE = '0';
    try {
      expect(await (service() as any).attachedImage(scope, taskId)).toBeUndefined();
    } finally {
      if (window === undefined) delete process.env.HAWA_REFERENCE_MERGE_MINUTES_BEFORE;
      else process.env.HAWA_REFERENCE_MERGE_MINUTES_BEFORE = window;
    }
  });

  it('a photo sent shortly after the request, with no other request in between, is its photo too', async () => {
    const channel = `after-ref-${randomUUID().slice(0, 8)}`;
    const taskId = await brief(channel);
    await persistChatIntake(db, {
      platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: channel, clientId: null,
      title: 'Sewa: reference image (awaiting request)', rawText: 'reference', designInstructions: '', exactCopy: [],
      isInstructionOnly: true, autoGenerate: false, studioOptions: { referenceImageBase64: photo },
    });
    expect(await (service() as any).attachedImage(scope, taskId)).toBe(photo);
    // A photo belongs to the nearest request in time: a later, different request does not take it.
    // The later request must come later than the photo came after its own: on a slow CI runner the
    // first brief's transaction took longer than the gap to the next insert, and the photo went to
    // the later request (studio-v2 CI, 2026-09-29).
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const later = await brief(channel, different);
    expect(await (service() as any).attachedImage(scope, taskId)).toBe(photo);
    expect(await (service() as any).attachedImage(scope, later)).toBeUndefined();
  });

  it('the 2026-09-22 shape is still found: a clientless task with the synthetic caption as copy', async () => {
    const channel = `legacy-ref-${randomUUID().slice(0, 8)}`;
    await persistChatIntake(db, {
      platform: 'telegram',
      sourceEventId: randomUUID(),
      sourceChannelId: channel,
      clientId: null,
      title: 'Sewa Kader: Apply the attached visual reference image as …',
      rawText: 'Apply the attached visual reference image as a design style, layout, and composition guide.',
      designInstructions: '',
      exactCopy: [{ id: 'copy_0', role: 'headline', text: 'Apply the attached visual reference image as a design style, layout, and composition guide.' }],
      designStudio: true,
      studioOptions: { referenceImageBase64: photo },
    });
    const taskId = await brief(channel);
    expect(await (service() as any).attachedImage(scope, taskId)).toBe(photo);
  });
});
