import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb } from '@hawa/db';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;

/**
 * An album arrives as one message per photo, about a second apart; the captioned one is the
 * request. The brief read the request's images when it started and could miss the later photos.
 */
describe.skipIf(!url)('a request sent as an album', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const scope = { tenantId: '00000000-0000-4000-a000-000000000001', actorId: '00000000-0000-4000-b000-000000000001' };
  const saved = { ...process.env };
  afterAll(async () => {
    process.env = saved;
    await db.destroy();
  });

  const save = (channel: string, album: string, extra: Record<string, unknown>) =>
    persistChatIntake(db, {
      platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: channel, clientId: 'c1000000-0000-4000-8000-000000000002',
      title: 'KAAE album', rawText: 'KAAE panel\n---\nSeptember 25, 2026', designInstructions: '', exactCopy: [],
      ...extra, studioOptions: { mediaGroupId: album, ...(extra.studioOptions as object) },
    } as any);

  it('waits until the album has been quiet before the brief reads its images', async () => {
    process.env.HAWA_ALBUM_QUIET_MS = '600';
    process.env.HAWA_ALBUM_SETTLE_MAX_MS = '5000';
    const channel = `album-${randomUUID().slice(0, 8)}`;
    const album = `g-${randomUUID().slice(0, 8)}`;
    const request = await save(channel, album, { designStudio: true });
    const service = new DesignStudioService(db, undefined, { apiKey: 'test-key' });
    const started = Date.now();
    const later = setTimeout(() => {
      void save(channel, album, { isInstructionOnly: true, studioOptions: { referenceFor: request.task.id } });
    }, 300);
    await (service as any).settleAlbum(scope, request.task.id);
    clearTimeout(later);
    const waited = Date.now() - started;
    // The late photo at ~300 ms plus the quiet period: not before ~900 ms, and well within the cap.
    expect(waited).toBeGreaterThanOrEqual(850);
    expect(waited).toBeLessThan(5000);
  });

  it('does not wait at all for a request that is not an album', async () => {
    const request = await persistChatIntake(db, {
      platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: `solo-${randomUUID().slice(0, 8)}`, clientId: 'c1000000-0000-4000-8000-000000000002',
      title: 'KAAE solo', rawText: 'KAAE solo', designInstructions: '', exactCopy: [], designStudio: true,
    });
    const service = new DesignStudioService(db, undefined, { apiKey: 'test-key' });
    const started = Date.now();
    await (service as any).settleAlbum(scope, request.task.id);
    expect(Date.now() - started).toBeLessThan(300);
  });
});
