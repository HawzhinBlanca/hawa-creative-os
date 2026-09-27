import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql } from '@hawa/db';
import { findClientPack, type ClientPack } from '@hawa/creative';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { ensureClientPackRows } from '../src/services/client-pack-rows.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;
const tenantId = '00000000-0000-4000-a000-000000000001';

/**
 * ADR-038 with the database: every pack has its client row, a request for a client being set up is
 * saved against that client, and the studio refuses it with what is missing instead of designing it
 * with KAAE's brand.
 */
describe.skipIf(!url)('client packs in PostgreSQL', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const scope = { tenantId, actorId: '00000000-0000-4000-b000-000000000001' };
  const zar = findClientPack('zar-podcast')!;
  const noCalls = (async () => {
    throw new Error('no model calls in this test');
  }) as unknown as typeof fetch;

  beforeAll(async () => {
    await sql`INSERT INTO hawa.users(id, email, display_name)
      VALUES(${scope.actorId}::uuid, 'isolated-operator@example.test', 'Test') ON CONFLICT DO NOTHING`.execute(db);
  });
  afterAll(() => db.destroy());

  const synthetic = (overrides: Partial<ClientPack> = {}): ClientPack => {
    const code = `pack-test-${randomUUID().slice(0, 8)}`;
    return { ...zar, id: randomUUID(), code, displayName: `Pack Test ${code}`, ...overrides };
  };

  it('adds a missing client row once, and never changes an existing one', async () => {
    const pack = synthetic();
    expect(await ensureClientPackRows(db, tenantId, [pack])).toEqual({ inserted: [pack.code], conflicts: [] });
    await sql`UPDATE hawa.clients SET name = 'Renamed by the office' WHERE id = ${pack.id}::uuid`.execute(db);
    expect(await ensureClientPackRows(db, tenantId, [pack])).toEqual({ inserted: [], conflicts: [] });
    const row = (await sql<{ name: string; code: string }>`SELECT name, code FROM hawa.clients WHERE id = ${pack.id}::uuid`.execute(db)).rows[0];
    expect(row).toEqual({ name: 'Renamed by the office', code: pack.code });
  });

  it('reports a code another row already holds, and leaves that row alone', async () => {
    const pack = synthetic();
    await ensureClientPackRows(db, tenantId, [pack]);
    const impostor = { ...pack, id: randomUUID() };
    const { inserted, conflicts } = await ensureClientPackRows(db, tenantId, [impostor]);
    expect(inserted).toEqual([]);
    expect(conflicts).toEqual([`${pack.code} is row ${pack.id}, the pack says ${impostor.id}`]);
  });

  it('has a row for every shipped client, so a routed request can be saved', async () => {
    await ensureClientPackRows(db, tenantId, [zar]);
    const saved = await persistChatIntake(db, {
      platform: 'telegram',
      sourceEventId: randomUUID(),
      sourceChannelId: `zar-${randomUUID().slice(0, 8)}`,
      clientId: zar.id,
      title: '[TEST] ZAR episode thumbnail',
      rawText: 'Thumbnail for ZAR Podcast episode 14\n\nWhy cities flood',
      designInstructions: '',
      exactCopy: [],
      variant: { width: 1280, height: 720 },
    });
    expect(saved.task.client_id).toBe(zar.id);

    // The studio refuses a client still being set up, naming what it lacks, rather than drafting it
    // with another client's reference pack and logo.
    const studio = new DesignStudioService(db, undefined, { apiKey: 'test-key', fetcher: noCalls, staleRunMinutes: 0 });
    await expect(
      studio.createOrGetRun(scope, saved.task.id, `key-${randomUUID().slice(0, 16)}`, { width: 1280, height: 720 })
    ).rejects.toMatchObject({ code: 'CLIENT_REFERENCE_REQUIRED', message: expect.stringContaining('ZAR Podcast is still being set up') });
  });
});
