import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext, blobStoreFromEnv, type BlobStore } from '@hawa/db';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';

/**
 * Production, 2026-09-29: a KAAE request opened from a six-photo Telegram album showed in the Desk
 * with no client name and no reference photos. GET /tasks/:id had no clientName field at all, and
 * nothing in the task API named the album photos stored as the task's reference_image task_files
 * (`referenceAssets` is the free-text "Reference notes" intake field, which Telegram never sets).
 *
 * The detail now carries the client's name (read under the caller's row-level security) and the
 * task's reference photos in the order the Studio uses them: the confirmed album's order when the
 * request carries one, stored order otherwise. Each photo's address is the existing authorised
 * GET /tasks/:taskId/files/:sha256 route.
 *
 * Runs as hawa_app (TEST_DATABASE_URL), row-level security as in production.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('GET /tasks/:id client name and reference photos (PostgreSQL)', () => {
  const db = createDb(url!);
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const operatorUserId = '00000000-0000-4000-b000-000000000001';
  const kaae = 'c1000000-0000-4000-8000-000000000002';
  const scope = { tenantId, userId: operatorUserId, role: 'operator' as const };
  const operator = { Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` };
  let store: BlobStore;
  let app: ReturnType<typeof createApp>;

  const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(2000), Buffer.from([0xff, 0xd9])]);
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

  const request = async (lifecycleAlbum?: unknown) =>
    (
      await persistChatIntake(db, {
        platform: 'telegram',
        sourceEventId: randomUUID(),
        sourceChannelId: String(6_000_000_000 + Math.floor(Math.random() * 999_999_999)),
        clientId: kaae,
        title: 'KAAE album request',
        rawText: 'KAAE members evening\n---\nDecember 4, 2026\nErbil',
        designInstructions: '',
        exactCopy: [{ id: 'copy_0', role: 'headline', text: 'KAAE members evening' }],
        autoGenerate: false,
        ...(lifecycleAlbum ? { lifecycleAlbum } : {}),
      } as any)
    ).task.id as string;

  /** The album's files as lifecycle-projection attachAlbum records them: one transaction, one created_at. */
  const attach = (taskId: string, hashes: string[]) =>
    withRlsContext(db, scope, async (trx) => {
      for (const h of hashes) {
        await sql`INSERT INTO hawa.task_files (tenant_id, task_id, sha256, role)
          VALUES (${tenantId}::uuid, ${taskId}::uuid, ${h}, 'reference_image')`.execute(trx);
      }
    });

  const detail = async (taskId: string) => {
    const res = await app.request(`/v1/tasks/${taskId}`, { headers: operator });
    expect(res.status).toBe(200);
    return res.json() as Promise<any>;
  };

  beforeAll(() => {
    store = blobStoreFromEnv(db);
    app = createApp({ db, blobStore: store } as any);
  });
  afterAll(() => db.destroy());

  it('names the client and lists all six album photos in the confirmed album order', async () => {
    const photos = Array.from({ length: 6 }, jpeg);
    const refs = [];
    for (const p of photos) refs.push(await store.put(p, 'image/jpeg'));
    // The album's message order, deliberately not the hashes' order (stored rows share one created_at).
    const albumOrder = [...refs].sort((a, b) => (a.sha256 < b.sha256 ? 1 : -1));
    const album = {
      updateId: 900_000 + Math.floor(Math.random() * 99_999),
      sha256: sha(Buffer.from(randomUUID())),
      images: albumOrder.map((r) => ({ sha256: r.sha256, mediaType: r.mediaType, size: r.size })),
    };
    const taskId = await request(album);
    await attach(taskId, refs.map((r) => r.sha256));

    const clientName = await withRlsContext(db, scope, async (trx) =>
      (await sql<{ name: string }>`SELECT name FROM hawa.clients WHERE id = ${kaae}::uuid`.execute(trx)).rows[0].name);
    expect(clientName).toBeTruthy();

    const task = await detail(taskId);
    expect(task.clientId).toBe(kaae);
    expect(task.clientName).toBe(clientName);
    expect(task.referenceImageCount).toBe(6);
    expect(task.referenceImages).toEqual(albumOrder.map((r) => ({
      sha256: r.sha256,
      mediaType: 'image/jpeg',
      size: r.size,
      url: `/v1/tasks/${taskId}/files/${r.sha256}`,
    })));
    // referenceAssets stays the free-text intake field it always was.
    expect(task.referenceAssets).toBe('');

    // Each photo's address is the authorised file route, which serves its bytes.
    const first = await app.request(task.referenceImages[0].url, { headers: operator });
    expect(first.status).toBe(200);
    expect(Buffer.from(await first.arrayBuffer()).equals(photos[refs.indexOf(albumOrder[0])])).toBe(true);
  });

  it('lists photos in stored order when the request carries no album, and none when it has none', async () => {
    const refs = [];
    for (let i = 0; i < 2; i++) refs.push(await store.put(jpeg(), 'image/jpeg'));
    const taskId = await request();
    await attach(taskId, refs.map((r) => r.sha256));
    const task = await detail(taskId);
    expect(task.referenceImageCount).toBe(2);
    expect(task.referenceImages.map((r: any) => r.sha256)).toEqual(refs.map((r) => r.sha256).sort());

    const bare = await detail(await request());
    expect(bare.clientName).toBe(task.clientName);
    expect(bare.referenceImages).toEqual([]);
    expect(bare.referenceImageCount).toBe(0);
  });

  it('shows another tenant\'s photo to nobody: the task is not found', async () => {
    const otherTenant = '00000000-0000-4000-a000-000000000005';
    const otherUser = '00000000-0000-4000-b000-000000000005';
    const otherClient = 'c1000000-0000-4000-8000-000000000005';
    const theirs = (await persistChatIntake(db, {
      platform: 'telegram', sourceEventId: randomUUID(),
      sourceChannelId: String(6_000_000_000 + Math.floor(Math.random() * 999_999_999)),
      tenantId: otherTenant, userId: otherUser, clientId: otherClient, title: 'Other tenant',
      rawText: 'Other', designInstructions: '', exactCopy: [{ id: 'copy_0', role: 'headline', text: 'Other' }],
      autoGenerate: false,
    } as any)).task.id as string;
    const ref = await store.put(jpeg(), 'image/jpeg');
    await withRlsContext(db, { tenantId: otherTenant, userId: otherUser, role: 'operator' }, (trx) =>
      sql`INSERT INTO hawa.task_files (tenant_id, task_id, sha256, role)
        VALUES (${otherTenant}::uuid, ${theirs}::uuid, ${ref.sha256}, 'reference_image')`.execute(trx));
    const res = await app.request(`/v1/tasks/${theirs}`, { headers: operator });
    expect(res.status).toBe(404);
  });
});
