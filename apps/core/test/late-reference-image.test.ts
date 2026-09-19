import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { persistChatIntake, findRequestAwaitingReference } from '../src/services/chat-intake.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;

// Telegram delivers a request's text and a photo sent with it as two messages. On 2026-09-19 the
// photo became a "revision" (task 936c5c6f) and a second full design run; it now joins the request.
describe.skipIf(!url)('a caption-less photo joins the request it followed', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const clientId = 'c1000000-0000-4000-8000-000000000002';
  const scope = { tenantId: '00000000-0000-4000-a000-000000000001', actorId: '00000000-0000-4000-b000-000000000001' };
  const photo = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHR8eHR0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
  afterAll(() => db.destroy());

  const request = async (channel: string, image?: string) =>
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
        ...(image ? { studioOptions: { referenceImageBase64: image } } : {}),
      })
    ).task.id as string;
  const enrolled = (channel: string) => ({ DESIGN_PIPELINE_V3_CHATS: channel }) as NodeJS.ProcessEnv;

  it('finds the latest v3 request in the chat, and nothing for an unenrolled chat or one with its own image', async () => {
    const channel = `late-ref-${randomUUID().slice(0, 8)}`;
    const taskId = await request(channel);
    expect(await findRequestAwaitingReference(db, { sourceChannelId: channel, env: enrolled(channel) })).toMatchObject({ taskId, clientId });
    expect(await findRequestAwaitingReference(db, { sourceChannelId: channel, env: {} as NodeJS.ProcessEnv })).toBeNull();
    const withImage = `late-ref-${randomUUID().slice(0, 8)}`;
    await request(withImage, photo);
    expect(await findRequestAwaitingReference(db, { sourceChannelId: withImage, env: enrolled(withImage) })).toBeNull();
    expect(await findRequestAwaitingReference(db, { sourceChannelId: channel, env: { ...enrolled(channel), HAWA_REFERENCE_MERGE_MINUTES: '0' } })).toBeNull();
  });

  it('stops once the design has reached layout generation, and the studio reads a photo that joined in time', async () => {
    const channel = `late-ref-${randomUUID().slice(0, 8)}`;
    const taskId = await request(channel);
    const service = new DesignStudioService(db, undefined, { apiKey: 'test-key', fetcher: (async () => { throw new Error('no calls'); }) as any });
    await withRlsContext(db, scope, (tx) =>
      sql`UPDATE hawa.design_studio_runs SET status='abandoned' WHERE tenant_id=${scope.tenantId}::uuid
        AND status NOT IN ('transferred','degraded','failed','abandoned')`.execute(tx)
    );
    const { run } = await service.createOrGetRun(scope, taskId, `k-${randomUUID().slice(0, 12)}`, { width: 1080, height: 1350, tier: 'standard' });
    expect(await findRequestAwaitingReference(db, { sourceChannelId: channel, env: enrolled(channel) })).not.toBeNull();

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

    await withRlsContext(db, scope, (tx) => sql`UPDATE hawa.design_studio_runs SET status='laying_out' WHERE id=${run.id}::uuid`.execute(tx));
    expect(await findRequestAwaitingReference(db, { sourceChannelId: channel, env: enrolled(channel) })).toBeNull();
    await withRlsContext(db, scope, (tx) => sql`UPDATE hawa.design_studio_runs SET status='abandoned' WHERE id=${run.id}::uuid`.execute(tx));
  });
});
