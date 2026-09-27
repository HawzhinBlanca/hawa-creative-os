import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createDb, sql, withRlsContext, blobStoreFromEnv, DesignStudioRepository, type BlobStore } from '@hawa/db';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { addJudge, addPair, createStudy, lockStudy, revokeJudge } from '../src/services/comparison-study.js';
import { PNG } from '@hawa/creative';
import fs from 'node:fs';
import { readPreferringStore } from '../src/services/blob-store-context.js';

/**
 * Serving stored files (ADR-035 section 2.4, FILESTORE_DESIGN.md sections 3 and 7). Every route
 * authorises on the referencing row under row-level security, never on the hash: another tenant's row,
 * a hash the row no longer names, or a hash the task never had is 404, with no accel header. In accel
 * mode Core answers an empty 200 with X-Accel-Redirect; in stream mode it sends the same bytes.
 *
 * GET /tasks/:id carries no data: URI: its preview is the export's own /v1/ address.
 *
 * Runs as hawa_app (TEST_DATABASE_URL), row-level security as in production, with this file's own
 * blob directory (packages/db/test-support/test-database-clone.ts).
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('serving stored files (ADR-035)', () => {
  const db = createDb(url!);
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const operatorUserId = '00000000-0000-4000-b000-000000000001';
  const kaae = 'c1000000-0000-4000-8000-000000000002';
  const otherTenant = '00000000-0000-4000-a000-000000000005';
  const otherUser = '00000000-0000-4000-b000-000000000005';
  const otherClient = 'c1000000-0000-4000-8000-000000000005';
  let store: BlobStore;
  let app: ReturnType<typeof createApp>;

  /** A real PNG of the given size and colour (the store checks the bytes are the type they claim). */
  const png = (w: number, h: number, rgb: [number, number, number]) => {
    const p = new PNG({ width: w, height: h });
    for (let i = 0; i < w * h; i++) p.data.set([...rgb, 255], i * 4);
    return PNG.sync.write(p);
  };
  const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(3000), Buffer.from([0xff, 0xd9])]);
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

  const request = async (tenant: string, user: string, client: string, studioOptions?: Record<string, unknown>) =>
    (
      await persistChatIntake(db, {
        platform: 'telegram',
        sourceEventId: randomUUID(),
        sourceChannelId: String(8_000_000_000 + Math.floor(Math.random() * 999_999_999)),
        tenantId: tenant,
        userId: user,
        clientId: client,
        title: 'Blob serving',
        rawText: 'Members evening\n---\nDecember 4, 2026',
        designInstructions: '',
        exactCopy: [{ id: 'copy_0', role: 'headline', text: 'Members evening' }],
        autoGenerate: false,
        ...(studioOptions ? { studioOptions } : {}),
      } as any)
    ).task.id as string;

  /** A Canva export of the task as the bridge records it; returns the export's id. */
  const exportOf = async (tenant: string, user: string, client: string, taskId: string, bytes: Buffer, format = 'png') =>
    withRlsContext(db, { tenantId: tenant, userId: user, role: 'operator' }, async (trx) => {
      const opId = randomUUID();
      const exportId = randomUUID();
      await sql`INSERT INTO hawa.canva_remote_operations (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata, created_at, updated_at)
        VALUES (${opId}::uuid, ${tenant}::uuid, ${taskId}::uuid, ${client}::uuid, ${user}, ${'req_' + randomUUID().slice(0, 8)}, 'h', 'export', 'retrieved', ${'D' + randomUUID().slice(0, 8)}, 1, ${JSON.stringify({ format })}::jsonb, now(), now())`.execute(trx);
      await sql`INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content, created_at)
        VALUES (${exportId}::uuid, ${tenant}::uuid, ${taskId}::uuid, ${client}::uuid, ${opId}::uuid, ${format}, ${sha(bytes)}, ${bytes}, now())`.execute(trx);
      return exportId;
    });

  const withAccel = async <T>(fn: () => Promise<T>): Promise<T> => {
    const before = process.env.HAWA_BLOB_ACCEL_PREFIX;
    process.env.HAWA_BLOB_ACCEL_PREFIX = '/_blobs/';
    try {
      return await fn();
    } finally {
      if (before === undefined) delete process.env.HAWA_BLOB_ACCEL_PREFIX;
      else process.env.HAWA_BLOB_ACCEL_PREFIX = before;
    }
  };

  const get = async (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });

  beforeAll(async () => {
    store = blobStoreFromEnv(db);
    delete process.env.HAWA_BLOB_ACCEL_PREFIX;
    app = createApp({ db, blobStore: store, testAuth: { principal: { role: 'operator' }, roleHeader: true } } as any);
  });
  afterAll(async () => {
    await db.destroy();
  });

  describe('GET /tasks/:id and the export route', () => {
    it('carries no data: URI; its preview is the export\'s /v1/ address, served with immutable headers', async () => {
      const photo = jpeg();
      const taskId = await request(tenantId, operatorUserId, kaae, { referenceImageBase64: `data:image/jpeg;base64,${photo.toString('base64')}` });
      const preview = png(600, 400, [12, 90, 200]);
      const exportId = await exportOf(tenantId, operatorUserId, kaae, taskId, preview);

      const res = await get(`/v1/tasks/${taskId}`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain('data:');
      expect(Buffer.byteLength(text)).toBeLessThan(8 * 1024);
      const task = JSON.parse(text);
      expect(task.latestRevision.previewUrl).toBe(`/v1/tasks/${taskId}/exports/${exportId}/content`);
      expect(task.latestRevision.sha256).toBe(sha(preview));
      expect(task.latestRevision.byteSize).toBe(preview.length);

      const content = await get(task.latestRevision.previewUrl);
      expect(content.status).toBe(200);
      expect(content.headers.get('Content-Type')).toBe('image/png');
      expect(content.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
      expect(content.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(content.headers.get('X-Content-SHA256')).toBe(sha(preview));
      expect(Buffer.from(await content.arrayBuffer()).equals(preview)).toBe(true);
      const again = await get(task.latestRevision.previewUrl, { 'If-None-Match': content.headers.get('ETag')! });
      expect(again.status).toBe(304);
    });

    it('refuses another tenant\'s export, and an export of another task, with 404', async () => {
      const mine = await request(tenantId, operatorUserId, kaae);
      const theirs = await request(otherTenant, otherUser, otherClient);
      const theirExport = await exportOf(otherTenant, otherUser, otherClient, theirs, png(10, 10, [1, 2, 3]));
      expect((await get(`/v1/tasks/${theirs}/exports/${theirExport}/content`)).status).toBe(404);
      const myExport = await exportOf(tenantId, operatorUserId, kaae, mine, png(10, 10, [4, 5, 6]));
      const other = await request(tenantId, operatorUserId, kaae);
      expect((await get(`/v1/tasks/${other}/exports/${myExport}/content`)).status).toBe(404);
      expect((await get(`/v1/tasks/${mine}/exports/not-a-uuid/content`)).status).toBe(404);
      expect((await get(`/v1/tasks/${mine}/exports/${myExport}/content`)).status).toBe(200);
    });
  });

  describe('GET /tasks/:taskId/files/:sha256', () => {
    it('serves a task\'s reference photo after authorising on its task_files row: accel and stream', async () => {
      const taskId = await request(tenantId, operatorUserId, kaae);
      const photo = jpeg();
      const ref = await store.put(photo, 'image/jpeg');
      await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, (trx) =>
        sql`INSERT INTO hawa.task_files (tenant_id, task_id, sha256, role) VALUES (${tenantId}::uuid, ${taskId}::uuid, ${ref.sha256}, 'reference_image')`.execute(trx)
      );
      const path = `/v1/tasks/${taskId}/files/${ref.sha256}`;

      const accel = await withAccel(() => get(path));
      expect(accel.status).toBe(200);
      expect(accel.headers.get('X-Accel-Redirect')).toBe(`/_blobs/sha256/${ref.sha256.slice(0, 2)}/${ref.sha256}.jpg`);
      expect(accel.headers.get('Content-Type')).toBe('image/jpeg');
      expect(accel.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
      expect((await accel.arrayBuffer()).byteLength).toBe(0);

      const stream = await get(path);
      expect(stream.status).toBe(200);
      expect(stream.headers.get('X-Accel-Redirect')).toBeNull();
      expect(Buffer.from(await stream.arrayBuffer()).equals(photo)).toBe(true);
    });

    it('404s another tenant\'s file, a hash the task never had, and a malformed hash, with no accel header', async () => {
      const mine = await request(tenantId, operatorUserId, kaae);
      const theirs = await request(otherTenant, otherUser, otherClient);
      const photo = jpeg();
      const ref = await store.put(photo, 'image/jpeg');
      await withRlsContext(db, { tenantId: otherTenant, userId: otherUser, role: 'operator' }, (trx) =>
        sql`INSERT INTO hawa.task_files (tenant_id, task_id, sha256, role) VALUES (${otherTenant}::uuid, ${theirs}::uuid, ${ref.sha256}, 'reference_image')`.execute(trx)
      );
      await withAccel(async () => {
        for (const path of [
          `/v1/tasks/${theirs}/files/${ref.sha256}`, // another tenant's task
          `/v1/tasks/${mine}/files/${ref.sha256}`, // a hash this task never had (another tenant's)
          `/v1/tasks/${mine}/files/${'0'.repeat(64)}`, // no such file at all
          `/v1/tasks/${mine}/files/..%2F..%2Fetc`, // not a hash
        ]) {
          const res = await get(path);
          expect(res.status, path).toBe(404);
          expect(res.headers.get('X-Accel-Redirect'), path).toBeNull();
        }
      });
    });
  });

  describe('studio candidate pictures', () => {
    /** A run with one candidate for the task, its pictures written through the repository (dual-write). */
    const candidate = async (tenant: string, user: string, client: string, taskId: string, repo: DesignStudioRepository, pictures: { preview: Buffer; composite?: Buffer; art?: Buffer }) => {
      const runId = randomUUID();
      const candidateId = randomUUID();
      await withRlsContext(db, { tenantId: tenant, userId: user, role: 'operator' }, (trx) =>
        sql`INSERT INTO hawa.design_studio_runs (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, tier, status, budget, stages)
          VALUES (${runId}::uuid, ${tenant}::uuid, ${taskId}::uuid, ${client}::uuid, ${user}::uuid, ${'blob-' + runId}, 'h', '{}', 'standard', 'briefing', '{}', '{}')`.execute(trx)
      );
      await repo.insertCandidate({
        id: candidateId,
        runId,
        tenantId: tenant,
        ordinal: 0,
        concept: { name: 'Blob' },
        previewPng: pictures.preview,
        previewSha256: sha(pictures.preview),
        compositePng: pictures.composite ?? null,
        artPng: pictures.art ?? null,
        artSha256: pictures.art ? sha(pictures.art) : null,
      });
      return { runId, candidateId };
    };

    it('writes each picture to the store and its hash to the row, keeping the bytes (release A dual-write)', async () => {
      const taskId = await request(tenantId, operatorUserId, kaae);
      const repo = new DesignStudioRepository(db, store);
      const preview = png(40, 30, [200, 10, 10]);
      const composite = png(40, 30, [10, 200, 10]);
      const art = png(40, 30, [10, 10, 200]);
      const { candidateId } = await candidate(tenantId, operatorUserId, kaae, taskId, repo, { preview, composite, art });
      const row = await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) =>
        (await sql<any>`SELECT preview_sha256, composite_sha256, art_sha256, preview_png, composite_png, art_png FROM hawa.design_studio_candidates WHERE id = ${candidateId}::uuid`.execute(trx)).rows[0]
      );
      expect(row.preview_sha256).toBe(sha(preview));
      expect(row.composite_sha256).toBe(sha(composite));
      expect(row.art_sha256).toBe(sha(art));
      for (const [bytes, hash] of [[preview, row.preview_sha256], [composite, row.composite_sha256], [art, row.art_sha256]] as const) {
        expect((await store.read(hash, { verify: true })).equals(bytes)).toBe(true);
      }
      expect(Buffer.from(row.preview_png).equals(preview)).toBe(true);
      expect(Buffer.from(row.composite_png).equals(composite)).toBe(true);

      // Readers prefer the store: a candidate whose row bytes differ (a stripped row would have none)
      // is read from its file.
      const read = await repo.getCandidateById(candidateId, tenantId);
      expect(Buffer.from(read!.composite_png!).equals(composite)).toBe(true);
    });

    it('the evidence route gives immutable /:kind/<sha>.png addresses, served from the store; a stale hash and another tenant\'s candidate are 404', async () => {
      const taskId = await request(tenantId, operatorUserId, kaae);
      const repo = new DesignStudioRepository(db, store);
      const preview = png(50, 20, [120, 30, 30]);
      const composite = png(50, 20, [30, 120, 30]);
      const { runId, candidateId } = await candidate(tenantId, operatorUserId, kaae, taskId, repo, { preview, composite });

      const evidence = await (await get(`/v1/tasks/${taskId}/canva/studio/${runId}`)).json();
      const c = evidence.candidates.find((x: any) => x.id === candidateId);
      expect(c.previewUrl).toBe(`/v1/tasks/${taskId}/canva/studio/${runId}/candidates/${candidateId}/preview/${sha(preview)}.png`);
      expect(c.compositeUrl).toBe(`/v1/tasks/${taskId}/canva/studio/${runId}/candidates/${candidateId}/composite/${sha(composite)}.png`);
      expect(c.artUrl).toBeNull();

      const stream = await get(c.previewUrl);
      expect(stream.status).toBe(200);
      expect(stream.headers.get('Content-Type')).toBe('image/png');
      expect(stream.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
      expect(stream.headers.get('X-Content-SHA256')).toBe(sha(preview));
      expect(Buffer.from(await stream.arrayBuffer()).equals(preview)).toBe(true);

      const accel = await withAccel(() => get(c.compositeUrl));
      expect(accel.status).toBe(200);
      expect(accel.headers.get('X-Accel-Redirect')).toBe(`/_blobs/sha256/${sha(composite).slice(0, 2)}/${sha(composite)}.png`);
      expect((await accel.arrayBuffer()).byteLength).toBe(0);

      // The old address still answers for one release, never cached.
      const old = await get(`/v1/tasks/${taskId}/canva/studio/${runId}/candidates/${candidateId}/preview.png`);
      expect(old.status).toBe(200);
      expect(old.headers.get('Cache-Control')).toBe('no-store');

      // Rendered again: the old hash names nothing any more.
      const rerendered = png(50, 20, [90, 90, 90]);
      await repo.updateCandidate(candidateId, tenantId, { previewPng: rerendered, previewSha256: sha(rerendered) });
      await withAccel(async () => {
        const stale = await get(c.previewUrl);
        expect(stale.status).toBe(404);
        expect(stale.headers.get('X-Accel-Redirect')).toBeNull();
      });
      expect((await get(`/v1/tasks/${taskId}/canva/studio/${runId}/candidates/${candidateId}/preview/${sha(rerendered)}.png`)).status).toBe(200);
      expect((await get(`/v1/tasks/${taskId}/canva/studio/${runId}/candidates/${candidateId}/preview/not-a-hash.png`)).status).toBe(404);

      // Another tenant's candidate, asked for by its own ids and hash.
      const theirTask = await request(otherTenant, otherUser, otherClient);
      const theirs = await candidate(otherTenant, otherUser, otherClient, theirTask, new DesignStudioRepository(db, store), { preview: png(8, 8, [7, 7, 7]) });
      await withAccel(async () => {
        const res = await get(`/v1/tasks/${theirTask}/canva/studio/${theirs.runId}/candidates/${theirs.candidateId}/preview/${sha(png(8, 8, [7, 7, 7]))}.png`);
        expect(res.status).toBe(404);
        expect(res.headers.get('X-Accel-Redirect')).toBeNull();
      });
      // A candidate of this tenant under another run's address.
      expect((await get(`/v1/tasks/${taskId}/canva/studio/${theirs.runId}/candidates/${candidateId}/preview/${sha(rerendered)}.png`)).status).toBe(404);
    });

    it('a new art picture whose put failed, or no art at all, never leaves the old art\'s hash on the row', async () => {
      const taskId = await request(tenantId, operatorUserId, kaae);
      const oldArt = png(30, 30, [250, 0, 0]);
      const { candidateId } = await candidate(tenantId, operatorUserId, kaae, taskId, new DesignStudioRepository(db, store), { preview: png(30, 30, [1, 1, 1]), art: oldArt });
      // The same store, except that every put fails (a full disk).
      const failing = Object.create(store) as BlobStore;
      failing.put = async () => {
        throw new Error('no space left on device');
      };
      const repo = new DesignStudioRepository(db, failing);
      const artHash = async () =>
        withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) =>
          (await sql<any>`SELECT art_sha256 FROM hawa.design_studio_candidates WHERE id = ${candidateId}::uuid`.execute(trx)).rows[0].art_sha256 as string | null
        );

      // A directed edit carries the parent's art bytes without their hash.
      const newArt = png(30, 30, [0, 250, 0]);
      await repo.updateCandidate(candidateId, tenantId, { artPng: newArt });
      expect(await artHash()).toBe(sha(newArt));
      expect(Buffer.from((await repo.getCandidateById(candidateId, tenantId))!.art_png!).equals(newArt)).toBe(true);

      await new DesignStudioRepository(db, store).updateCandidate(candidateId, tenantId, { artPng: oldArt });
      expect(await artHash()).toBe(sha(oldArt));
      await repo.updateCandidate(candidateId, tenantId, { artPng: null });
      expect(await artHash()).toBeNull();
      expect((await new DesignStudioRepository(db, store).getCandidateById(candidateId, tenantId))!.art_png).toBeFalsy();
    });

    it('a stored file whose bytes no longer hash to its name is never read: the row\'s bytes are used', async () => {
      const taskId = await request(tenantId, operatorUserId, kaae);
      const repo = new DesignStudioRepository(db, store);
      const composite = png(33, 17, [3, 140, 77]);
      const { candidateId } = await candidate(tenantId, operatorUserId, kaae, taskId, repo, { preview: png(33, 17, [9, 9, 9]), composite });
      // The same size, other bytes: the size check alone does not see it.
      const file = store.pathOf({ sha256: sha(composite), mediaType: 'image/png' });
      const corrupt = Buffer.from(composite);
      corrupt[corrupt.length - 5] ^= 0xff;
      fs.chmodSync(file, 0o644);
      fs.writeFileSync(file, corrupt);
      const read = await repo.getCandidateById(candidateId, tenantId);
      expect(Buffer.from(read!.composite_png!).equals(composite)).toBe(true);
      expect((await readPreferringStore(store, sha(composite), composite))!.equals(composite)).toBe(true);
      expect(await readPreferringStore(store, sha(composite), null)).toBeNull();
    });

    it('in stream mode a stored file gone from disk is answered with the row\'s bytes, not a 500', async () => {
      const taskId = await request(tenantId, operatorUserId, kaae);
      const preview = png(21, 13, [44, 1, 200]);
      const { runId, candidateId } = await candidate(tenantId, operatorUserId, kaae, taskId, new DesignStudioRepository(db, store), { preview });
      const file = store.pathOf({ sha256: sha(preview), mediaType: 'image/png' });
      fs.chmodSync(file, 0o644);
      fs.rmSync(file);
      const res = await get(`/v1/tasks/${taskId}/canva/studio/${runId}/candidates/${candidateId}/preview/${sha(preview)}.png`);
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(preview)).toBe(true);
    });

    it('a candidate from before the store (bytes only) is still served, at its hash address only when the bytes match', async () => {
      const taskId = await request(tenantId, operatorUserId, kaae);
      const legacy = png(20, 20, [1, 50, 99]);
      const { runId, candidateId } = await candidate(tenantId, operatorUserId, kaae, taskId, new DesignStudioRepository(db, null), { preview: legacy });
      const base = `/v1/tasks/${taskId}/canva/studio/${runId}/candidates/${candidateId}`;
      const res = await get(`${base}/preview/${sha(legacy)}.png`);
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(legacy)).toBe(true);
      expect((await get(`${base}/preview/${'a'.repeat(64)}.png`)).status).toBe(404);
    });
  });

  describe('comparison pictures', () => {
    it('stores both arms and serves them from the store to the office, with no-store', async () => {
      const office = { tenantId, userId: operatorUserId, role: 'administrator', actorId: 'admin_1' };
      const study = await createStudy(db, office, {
        name: `Blob study ${randomUUID().slice(0, 6)}`,
        preregistration: {
          sample: '2 office requests chosen before anything is made.',
          judges: 'One designer from outside the office.',
          analysis: 'Share of decisive judgements preferring Hawa with a Wilson 95% interval.',
          threshold: 0.5,
          minDecisive: 2,
          minJudgesPerPair: 1,
          plannedPairs: 2,
        },
      });
      const hawa = png(16, 16, [1, 100, 1]);
      const designer = png(16, 16, [100, 1, 1]);
      const pair = await addPair(db, office, study.id, { hawaPng: hawa, designerPng: designer }, { blobStore: store });
      expect((await store.stat(pair.hawaSha256))?.onDisk).toBe(true);
      expect((await store.stat(pair.designerSha256))?.onDisk).toBe(true);

      const asOffice = { 'x-user-role': 'administrator' };
      const hawaRes = await get(`/v1/comparisons/${study.id}/pairs/${pair.id}/hawa.png`, asOffice);
      expect(hawaRes.status).toBe(200);
      expect(hawaRes.headers.get('Cache-Control')).toBe('private, no-store');
      expect(hawaRes.headers.get('X-Content-SHA256')).toBe(pair.hawaSha256);
      const served = Buffer.from(await hawaRes.arrayBuffer());
      // The stored bytes are the cleaned PNG, whose hash the pair records.
      expect(sha(served)).toBe(pair.hawaSha256);
      const accel = await withAccel(() => get(`/v1/comparisons/${study.id}/pairs/${pair.id}/designer.png`, asOffice));
      expect(accel.headers.get('X-Accel-Redirect')).toBe(`/_blobs/sha256/${pair.designerSha256.slice(0, 2)}/${pair.designerSha256}.png`);
      expect(accel.headers.get('Cache-Control')).toBe('private, no-store');
    });

    const judgingStudy = async () => {
      const office = { tenantId, userId: operatorUserId, role: 'administrator', actorId: 'admin_1' };
      const study = await createStudy(db, office, {
        name: `Blob judge study ${randomUUID().slice(0, 6)}`,
        preregistration: {
          sample: '2 office requests chosen before anything is made.',
          judges: 'One designer from outside the office.',
          analysis: 'Share of decisive judgements preferring Hawa with a Wilson 95% interval.',
          threshold: 0.5,
          minDecisive: 2,
          minJudgesPerPair: 1,
          plannedPairs: 2,
        },
      });
      const first = await addPair(db, office, study.id, { hawaPng: png(12, 12, [5, 90, 5]), designerPng: png(12, 12, [90, 5, 5]) }, { blobStore: store });
      await addPair(db, office, study.id, { hawaPng: png(12, 12, [5, 5, 90]), designerPng: png(12, 12, [90, 90, 5]) }, { blobStore: store });
      const { judge, token } = await addJudge(db, office, study.id, { name: 'Outside designer', kind: 'designer' });
      await lockStudy(db, office, study.id);
      return { office, study, pair: first, judge, token };
    };

    it('a judge\'s picture keeps its no-referrer and noindex headers in accel mode, has no hash, and a revoked judge gets 404 with no redirect', async () => {
      const { office, study, pair, judge, token } = await judgingStudy();
      const path = `/api/judge/${token}/image/${pair.id}/left`;
      // nginx drops an upstream Referrer-Policy and X-Robots-Tag across X-Accel-Redirect, and its
      // /_blobs/ location sets another referrer policy: Core sends a judge's (small) picture itself.
      const ok = await withAccel(() => get(path));
      expect(ok.status).toBe(200);
      expect(ok.headers.get('X-Accel-Redirect')).toBeNull();
      expect(ok.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(ok.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
      expect(ok.headers.get('Content-Disposition')).toBe('inline; filename="design.png"');
      expect(ok.headers.get('X-Content-SHA256')).toBeNull();
      expect(ok.headers.get('ETag')).toBeNull();
      expect(Buffer.from(await ok.arrayBuffer()).subarray(0, 4).toString('hex')).toBe('89504e47');

      await revokeJudge(db, office, study.id, judge.id);
      const revoked = await withAccel(() => get(path));
      expect(revoked.status).toBe(404);
      expect(revoked.headers.get('X-Accel-Redirect')).toBeNull();
    });

    it('in stream mode a pair picture gone from disk is answered with the row\'s bytes, not a 500', async () => {
      const { study, pair } = await judgingStudy();
      const file = store.pathOf({ sha256: pair.hawaSha256, mediaType: 'image/png' });
      fs.chmodSync(file, 0o644);
      fs.rmSync(file);
      const res = await get(`/v1/comparisons/${study.id}/pairs/${pair.id}/hawa.png`, { 'x-user-role': 'administrator' });
      expect(res.status).toBe(200);
      expect(sha(Buffer.from(await res.arrayBuffer()))).toBe(pair.hawaSha256);
    });
  });
});
