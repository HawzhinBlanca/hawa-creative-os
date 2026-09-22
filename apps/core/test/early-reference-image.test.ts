import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { persistChatIntake } from '../src/services/chat-intake.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;

/**
 * Brand guidelines are sent first and the request after. On 2026-09-22 a client sent two reference
 * images at 10:03 and the brief at 10:05. Each image became a clientless task whose headline copy
 * was the synthetic caption "Apply the attached visual reference image…", queued for manual design,
 * and the brief was drafted without them.
 */
describe.skipIf(!url)('a reference image sent before the request', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const clientId = 'c1000000-0000-4000-8000-000000000002';
  const scope = { tenantId: '00000000-0000-4000-a000-000000000001', actorId: '00000000-0000-4000-b000-000000000001' };
  const photo = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHR8eHR0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
  const telegramSecret = ['early', 'reference', 'fixture', 'secret'].join('_');
  const saved = { ...process.env };
  beforeAll(() => {
    process.env.TELEGRAM_WEBHOOK_SECRET = telegramSecret;
  });
  afterAll(async () => {
    process.env = saved;
    await db.destroy();
  });

  const service = () => new DesignStudioService(db, undefined, { apiKey: 'test-key', fetcher: (async () => { throw new Error('no calls'); }) as any });

  const brief = async (channel: string) =>
    (
      await persistChatIntake(db, {
        platform: 'telegram',
        sourceEventId: randomUUID(),
        sourceChannelId: channel,
        clientId,
        title: 'KAAE: Her path, her power',
        rawText: 'HER PATH, HER POWER\n---\nSeptember 25, 2026',
        designInstructions: '',
        exactCopy: [],
        designStudio: true,
      })
    ).task.id as string;

  it('is saved as an instruction-only reference with no copy, and the sender is told what to do next', async () => {
    const channel = 80000000 + Math.floor(Math.random() * 1000000);
    process.env.DESIGN_PIPELINE_V3_CHATS = String(channel);
    const dispatch = vi.fn().mockResolvedValue({ success: true });
    const app = createApp({ db, telegramBridge: { dispatchOutboundMessage: dispatch, downloadFile: vi.fn() } as any });
    const res = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': telegramSecret },
      body: JSON.stringify({
        update_id: randomUUID(),
        referenceImageBase64: photo,
        message: { message_id: 1, from: { id: channel, is_bot: false, first_name: 'Sewa' }, chat: { id: channel, type: 'private' } },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.referenceAwaitingRequest).toBe(true);
    expect(body.task.client_id).toBeNull();
    expect(body.task.title).toMatch(/reference image \(awaiting request\)/);

    const created = await withRlsContext(db, { ...scope, role: 'operator' } as any, (trx) =>
      trx.selectFrom('task_events').select('data').where('task_id', '=', body.task.id).where('event_type', '=', 'task.created').executeTakeFirstOrThrow());
    const payload = (created.data as any).payload;
    expect(payload.exactCopy).toEqual([]);
    expect(payload.isInstructionOnly).toBe(true);
    expect(payload.autoGenerate).not.toBe(true);
    expect(payload.studioOptions.referenceImageBase64).toBe(photo);
    expect(JSON.stringify(payload.exactCopy)).not.toMatch(/Apply the attached/);

    const texts = dispatch.mock.calls.map((c) => String(c[1]?.text ?? '')).join('\n');
    expect(texts).toMatch(/Reference image saved/);
    expect(texts).not.toMatch(/queued for manual design/);

    // The request that follows two minutes later gets the image.
    const taskId = await brief(String(channel));
    expect(await (service() as any).attachedImage(scope, taskId)).toBe(photo);
  });

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

    // A second request from the same chat does not get it: the first request took it.
    const second = await brief(channel);
    expect(await (service() as any).attachedImage(scope, second)).toBeUndefined();

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
    // A photo belongs to the nearest request in time: a later request does not take it.
    const later = await brief(channel);
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
