import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { blobStoreFromEnv, createDb, sql } from '@hawa/db';
import { findClientPack, type ClientPack } from '@hawa/creative';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { hardQaContextFor } from '../src/services/design-studio/stages/v3.stage.js';
import { computeDnaHash } from '../src/core-helpers.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { ensureClientPackRows } from '../src/services/client-pack-rows.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;
const tenantId = '00000000-0000-4000-a000-000000000001';

/**
 * Client packs with the database (ADR-127, ported from studio-v2's a5a50dad): every pack has its
 * client row, a request for a client being set up is saved against that client, and the studio
 * refuses it, naming what is missing, because it has no active Client DNA. It is never drafted with
 * another client's reference.
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

  // Review finding (2026-09-28): the tests above run as the database owner, so Core's start-up
  // insert was never exercised as hawa_app under RLS, where a failure is only logged and requests
  // routed to a new pack then fail to save on their client foreign key.
  it('adds the row as the application role under RLS, as Core does at start-up', async () => {
    const runtimeUrl = new URL(url || 'postgres://localhost/hawa_repair');
    runtimeUrl.searchParams.set('options', '-c role=hawa_app');
    const runtime = createDb(runtimeUrl.toString());
    try {
      const role = (await sql<{ r: string }>`SELECT current_user AS r`.execute(runtime)).rows[0].r;
      expect(role).toBe('hawa_app');
      const pack = synthetic();
      expect(await ensureClientPackRows(runtime, tenantId, [pack])).toEqual({ inserted: [pack.code], conflicts: [] });
      const row = (await sql<{ code: string; status: string }>`SELECT code, status FROM hawa.clients WHERE id = ${pack.id}::uuid`.execute(db)).rows[0];
      expect(row).toEqual({ code: pack.code, status: 'active' });
      // The conflict read runs under the same policy: a code held by another id is still seen.
      const impostor = { ...pack, id: randomUUID() };
      expect(await ensureClientPackRows(runtime, tenantId, [impostor])).toEqual({ inserted: [], conflicts: [`${pack.code} is row ${pack.id}, the pack says ${impostor.id}`] });
    } finally {
      await runtime.destroy();
    }
  });

  it('reports a code another row already holds, and leaves that row alone', async () => {
    const pack = synthetic();
    await ensureClientPackRows(db, tenantId, [pack]);
    const impostor = { ...pack, id: randomUUID() };
    const { inserted, conflicts } = await ensureClientPackRows(db, tenantId, [impostor]);
    expect(inserted).toEqual([]);
    expect(conflicts).toEqual([`${pack.code} is row ${pack.id}, the pack says ${impostor.id}`]);
  });

  it('has a row for every shipped client, so a routed request is saved, and the studio refuses it until its DNA exists', async () => {
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

    const studio = new DesignStudioService(db, undefined, { apiKey: 'test-key', fetcher: noCalls, staleRunMinutes: 0 });
    await expect(
      studio.createOrGetRun(scope, saved.task.id, `key-${randomUUID().slice(0, 16)}`, { width: 1280, height: 720, tier: 'standard' })
    ).rejects.toMatchObject({
      code: 'CLIENT_REFERENCE_REQUIRED',
      message: expect.stringContaining('ZAR Podcast is still being set up (missing: logo, palette, fonts, client-dna'),
    });
    const runs = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM hawa.design_studio_runs WHERE task_id = ${saved.task.id}::uuid`.execute(db)).rows[0];
    expect(runs.n).toBe(0);
  });

  it("tells a thumbnail client's stages the thumbnail playbook once its Client DNA exists (ported from 1d07664b)", async () => {
    await ensureClientPackRows(db, tenantId, [zar]);
    const logoRef = await blobStoreFromEnv(db).put(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'), 'image/png');
    const dna = { tenantId, clientId: zar.id, name: 'ZAR Podcast', code: 'zar-podcast', version: 1, status: 'active',
      defaultLocale: 'en', defaultDirection: 'ltr',
      colors: [{ name: 'Night', hex: '#101820', role: 'background' }, { name: 'White', hex: '#FFFFFF', role: 'text' }, { name: 'Red', hex: '#E10600', role: 'accent' }],
      fonts: [{ family: 'Inter', style: 'Regular', weight: 400, role: 'body', license: 'test', supportedLocales: ['en'] },
        { family: 'Noto Sans Arabic', style: 'Regular', weight: 400, role: 'body', license: 'test', supportedLocales: ['ckb', 'ar'] },
        { family: 'Inter', style: 'Bold', weight: 700, role: 'display', license: 'test', supportedLocales: ['en'] }],
      assets: [{ assetId: randomUUID(), name: 'ZAR logo', role: 'logo_primary', storageKey: `sha256:${logoRef.sha256}`, sha256: logoRef.sha256, mimeType: 'image/png', minimumWidthPx: 100, clearSpacePx: 20 }],
      guidelines: { voiceAndTone: 'Direct', prohibitedPhrases: [], requiredDisclaimers: [], layoutRules: [] },
      destinations: { googleSharedDriveId: 'test', productionFolderId: 'test', archiveFolderId: 'test', spreadsheetId: 'test', sheetId: 1 },
      approvalPolicy: { requiredRoles: ['art_director'], allowAutoApproval: false, autoApprovalEligibleTemplates: [] },
      updatedAt: new Date().toISOString() };
    await sql`INSERT INTO hawa.client_dna_versions(tenant_id,client_id,version,status,dna,content_hash,created_by)
      VALUES(${tenantId}::uuid,${zar.id}::uuid,1,'active',${JSON.stringify(dna)}::jsonb,${computeDnaHash(dna)},${scope.actorId}::uuid)`.execute(db);
    const saved = await persistChatIntake(db, {
      platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: `zar-${randomUUID().slice(0, 8)}`, clientId: zar.id,
      title: '[TEST] ZAR thumbnail', rawText: 'Thumbnail please.\n---\nWHY CITIES FLOOD\n\nEpisode 14', designInstructions: 'Thumbnail please.', exactCopy: [], variant: { width: 1280, height: 720 },
    });
    const studio = new DesignStudioService(db, undefined, { apiKey: 'test-key', fetcher: noCalls, staleRunMinutes: 0 });
    const { run } = await studio.createOrGetRun(scope, saved.task.id, `key-${randomUUID().slice(0, 16)}`, { width: 1280, height: 720, tier: 'standard' });
    const ctx = await (studio as any).createStageContext(scope, run, run.status, { maxUsd: 1, maxCalls: 4, spentUsd: 0, calls: 0 }, async () => {});
    expect(ctx.playbook).toBe('video-thumbnail');
    expect(ctx.promotedRules).toContain('VIDEO THUMBNAIL PLAYBOOK (this client\'s designs are video thumbnails, 1280x720)');
    expect(hardQaContextFor(ctx).playbook).toBe('video-thumbnail');
  });
});
