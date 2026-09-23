import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { PNG } from '@hawa/creative';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import {
  ComparisonError,
  addJudge,
  addPair,
  cleanPng,
  createStudy,
  getStudy,
  listStudies,
  lockStudy,
  orderPairsForJudge,
  parsePreregistration,
  preferredArm,
  readPairImage,
  resolveJudge,
  shownLeftFor,
  sniffImage,
  studyResults,
  summariseStudy,
  wilsonInterval,
  type Arm,
  type Choice,
  type JudgmentFact,
} from '../src/services/comparison-study.js';

/**
 * The blinded comparison of Hawa with the office's designer: decided by people who cannot tell which
 * design is which. These tests hold the statistics to published values, the judge's view to "no arm,
 * no task, no label, no file name", and the study's plan and pairs to "fixed once judging starts".
 */

// ---- Fixtures ----

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** Inserts a tEXt chunk after IHDR, the way design tools record the program and the author. */
function withTextChunk(png: Buffer, key: string, value: string): Buffer {
  const type = Buffer.from('tEXt', 'latin1');
  const data = Buffer.from(`${key}\0${value}`, 'latin1');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([png.subarray(0, 33), length, type, data, crc, png.subarray(33)]);
}

function withChunk(png: Buffer, typeName: string, data: Buffer): Buffer {
  const type = Buffer.from(typeName, 'latin1');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([png.subarray(0, 33), length, type, data, crc, png.subarray(33)]);
}

function makePng(width: number, height: number, rgb: [number, number, number], software?: string): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = rgb[0];
    png.data[i * 4 + 1] = rgb[1];
    png.data[i * 4 + 2] = rgb[2];
    png.data[i * 4 + 3] = 255;
  }
  const bytes = PNG.sync.write(png);
  return software ? withTextChunk(bytes, 'Software', software) : bytes;
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10]), Buffer.from('Exif\0\0Canon EOS R5', 'latin1')]);

const PREREGISTRATION = {
  sample: '50 real office requests from the past month, chosen before anything is made.',
  judges: 'The requesters who sent the briefs and 3 designers from outside the office; every pair judged by at least 4.',
  analysis: 'Share of decisive judgements preferring Hawa with a Wilson 95% interval; the tie rate beside it.',
  threshold: 0.5,
  minDecisive: 194,
  minJudgesPerPair: 4,
  plannedPairs: 50,
};

// ---- Pure: statistics, order, sides, images ----

describe('the comparison statistics', () => {
  it('give the Wilson 95% interval of published and independently computed values', () => {
    // Newcombe (1998), Statistics in Medicine 17:857, Table I, method 3; the rest from SciPy's
    // binomtest(...).proportion_ci(method="wilson").
    const cases: Array<[number, number, number, number]> = [
      [81, 263, 0.2553, 0.3662],
      [15, 148, 0.0624, 0.1605],
      [0, 20, 0, 0.1611],
      [1, 29, 0.0061, 0.1718],
      [117, 194, 0.532887, 0.669296],
      [97, 194, 0.430328, 0.569672],
    ];
    for (const [x, n, low, high] of cases) {
      const ci = wilsonInterval(x, n)!;
      const places = String(low).split('.')[1]?.length ?? 4;
      expect(ci.low, `${x}/${n} low`).toBeCloseTo(low, Math.max(4, places) - 1);
      expect(ci.high, `${x}/${n} high`).toBeCloseTo(high, Math.max(4, places) - 1);
    }
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(wilsonInterval(3, 2)).toBeNull();
  });

  it('derive the preferred arm from the side picked and the arm shown there', () => {
    expect(preferredArm('hawa', 'left')).toBe('hawa');
    expect(preferredArm('hawa', 'right')).toBe('designer');
    expect(preferredArm('designer', 'left')).toBe('designer');
    expect(preferredArm('designer', 'right')).toBe('hawa');
    expect(preferredArm('hawa', 'none')).toBeNull();
  });

  // 50 pairs × 4 judges: 117 prefer Hawa, 77 the designer, 6 no preference = 194 decisive, the protocol's sample.
  const pairs = Array.from({ length: 50 }, (_, i) => ({ id: `pair-${i}`, label: `P${String(i + 1).padStart(2, '0')}` }));
  const facts: JudgmentFact[] = [];
  pairs.forEach((pair, p) => {
    for (let j = 0; j < 4; j++) {
      const index = p * 4 + j;
      const wanted: Arm | null = index < 117 ? 'hawa' : index < 194 ? 'designer' : null;
      const shownLeft: Arm = index % 2 === 0 ? 'hawa' : 'designer';
      const choice: Choice = wanted === null ? 'none' : wanted === shownLeft ? 'left' : 'right';
      facts.push({ pairId: pair.id, judgeId: `judge-${j}`, judgeKind: j < 2 ? 'requester' : 'designer', judgeRevoked: false, shownLeft, choice, seenBefore: j === 0 && p < 10 });
    }
  });

  it('report the share of decisive judgements for Hawa, its interval, the tie rate, and every split', () => {
    const r = summariseStudy({ status: 'judging', preregistration: PREREGISTRATION, pairs, facts });
    expect(r.primary).toMatchObject({ judgements: 200, decisive: 194, hawa: 117, designer: 77, none: 6 });
    expect(r.primary.hawaShare).toBeCloseTo(117 / 194, 10);
    expect(r.primary.interval!.low).toBeCloseTo(0.532887, 5);
    expect(r.primary.tieRate).toBeCloseTo(6 / 200, 10);
    expect(r.byJudgeKind.requester.judgements + r.byJudgeKind.designer.judgements).toBe(200);
    expect(r.byJudgeKind.requester.judgements).toBe(100);
    expect(r.seenBefore.judgements).toBe(10);
    expect(r.excludingSeenBefore.judgements).toBe(190);
    expect(r.excludingSeenBefore.hawa + r.seenBefore.hawa).toBe(117);
    expect(r.position).toEqual({ shown: 200, hawaShownLeft: 100, decisive: 194, leftChosen: facts.filter((f) => f.choice === 'left').length });
    expect(r.perPair[0]).toMatchObject({ label: 'P01', judgements: 4, hawa: 4, designer: 0, majority: 'hawa' });
    expect(r.perPair[49]).toMatchObject({ label: 'P50', none: 4, majority: 'none' });
    expect(r.perPair.find((p) => p.hawa === 1 && p.designer === 3)?.majority).toBe('designer');
  });

  it('let the claim hold only above the threshold, on the complete pre-registered sample, once closed', () => {
    const judging = summariseStudy({ status: 'judging', preregistration: PREREGISTRATION, pairs, facts });
    expect(judging.claim).toMatchObject({ lowerBoundAboveThreshold: true, sampleComplete: true, closed: false, holds: false });
    expect(judging.claim.verdict).toContain('Not decided yet');
    const closed = summariseStudy({ status: 'closed', preregistration: PREREGISTRATION, pairs, facts });
    expect(closed.claim).toMatchObject({ holds: true, decisive: 194, minDecisive: 194, pairsBelowMinJudges: 0 });
    expect(closed.claim.verdict).toBe('Hawa is preferred: the lower bound of the 95% interval (53.3%) is above 50.0%, on the complete pre-registered sample.');
    // 97 of 194: the interval straddles one half, so nothing is shown, however the study ends.
    const even = facts.map((f, i) => (i >= 97 && i < 117 ? { ...f, choice: (f.choice === 'left' ? 'right' : 'left') as Choice } : f));
    const notShown = summariseStudy({ status: 'closed', preregistration: PREREGISTRATION, pairs, facts: even });
    expect(notShown.primary.hawa).toBe(97);
    expect(notShown.claim.holds).toBe(false);
    expect(notShown.claim.verdict).toContain('Not shown');
    // Short of the sample: a pair with 3 judgements, and 193 decisive.
    const short = summariseStudy({ status: 'closed', preregistration: PREREGISTRATION, pairs, facts: facts.slice(1) });
    expect(short.claim).toMatchObject({ sampleComplete: false, holds: false, pairsBelowMinJudges: 1 });
    expect(short.claim.verdict).toContain('193 of 194 decisive judgements; 1 pair has fewer than 4 judgements');
    expect(summariseStudy({ status: 'judging', preregistration: PREREGISTRATION, pairs, facts: [] }).claim.verdict).toBe('No decisive judgements yet.');
    // Fewer pairs than pre-registered: the claim cannot hold, however the picks go.
    const fewer = summariseStudy({ status: 'closed', preregistration: { ...PREREGISTRATION, plannedPairs: 51 }, pairs, facts });
    expect(fewer.claim).toMatchObject({ sampleComplete: false, holds: false });
    expect(fewer.claim.verdict).toContain('50 of 51 pre-registered pairs');
  });

  it('count a revoked judge in the primary outcome and show how many that is', () => {
    const revoked = facts.map((f) => (f.judgeId === 'judge-3' ? { ...f, judgeRevoked: true } : f));
    const r = summariseStudy({ status: 'closed', preregistration: PREREGISTRATION, pairs, facts: revoked });
    expect(r.primary.judgements).toBe(200);
    expect(r.fromRevokedJudges).toBe(50);
  });
});

describe('a judge’s order and sides', () => {
  const ids = Array.from({ length: 60 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const judges = ['11111111-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000002', '11111111-0000-4000-8000-000000000003'];

  it('are the same on every call, differ between judges, and put Hawa left about half the time', () => {
    const pairs = ids.map((id) => ({ id }));
    const first = orderPairsForJudge(judges[0], pairs).map((p) => p.id);
    expect(orderPairsForJudge(judges[0], [...pairs].reverse()).map((p) => p.id)).toEqual(first);
    expect(orderPairsForJudge(judges[1], pairs).map((p) => p.id)).not.toEqual(first);
    for (const id of ids) expect(shownLeftFor(judges[0], id)).toBe(shownLeftFor(judges[0], id));
    const hawaLeft = judges.flatMap((j) => ids.map((id) => shownLeftFor(j, id))).filter((a) => a === 'hawa').length;
    expect(hawaLeft).toBeGreaterThan(60);
    expect(hawaLeft).toBeLessThan(120);
    // Different judges see the same pair on different sides.
    expect(ids.some((id) => shownLeftFor(judges[0], id) !== shownLeftFor(judges[1], id))).toBe(true);
  });
});

describe('an uploaded design', () => {
  it('reaches judges as a fresh PNG without the text chunks that name its maker', () => {
    const tagged = makePng(12, 9, [200, 40, 40], 'Adobe Photoshop 26.1 (Office Designer)');
    expect(tagged.includes(Buffer.from('Photoshop'))).toBe(true);
    const clean = cleanPng(tagged, 'test design');
    expect(sniffImage(clean.png)).toBe('png');
    expect(clean.png.includes(Buffer.from('tEXt'))).toBe(false);
    expect(clean.png.includes(Buffer.from('Photoshop'))).toBe(false);
    expect([clean.width, clean.height]).toEqual([12, 9]);
    expect(clean.sha256).toBe(createHash('sha256').update(clean.png).digest('hex'));
    const pixels = PNG.sync.read(clean.png);
    expect([...pixels.data.subarray(0, 4)]).toEqual([200, 40, 40, 255]);
    // The same pixels from another tool give the same bytes: the encoder does not tell arms apart.
    expect(cleanPng(makePng(12, 9, [200, 40, 40], 'Canva'), 'x').sha256).toBe(clean.sha256);
  });

  it('is refused as a JPEG, as something else, or as a canvas past the pixel limit, with a reason', () => {
    const refusal = (bytes: Buffer) => {
      try {
        cleanPng(bytes, "designer's design");
      } catch (err) {
        return err as ComparisonError;
      }
      throw new Error('accepted');
    };
    const jpeg = refusal(JPEG);
    expect(jpeg.status).toBe(415);
    expect(jpeg.message).toContain('JPEG');
    expect(jpeg.message).toContain('Only PNG is accepted');
    expect(refusal(Buffer.from('GIF89a-not-a-design')).status).toBe(415);
    const huge = Buffer.from(makePng(2, 2, [0, 0, 0]));
    huge.writeUInt32BE(9000, 16);
    huge.writeUInt32BE(9000, 20);
    expect(refusal(huge).status).toBe(413);
    // 16-bit: a small file can declare a huge decode (2026-09-24 review), and no design needs it.
    const deep = Buffer.from(makePng(2, 2, [0, 0, 0]));
    deep[24] = 16;
    expect(refusal(deep)).toMatchObject({ status: 415 });
    expect(refusal(deep).message).toContain('16-bit');
    // A wide-gamut profile would show the designer's colours shifted; sRGB is accepted.
    const p3 = withChunk(makePng(2, 2, [0, 0, 0]), 'iCCP', Buffer.concat([Buffer.from('Display P3\0\0', 'latin1'), Buffer.alloc(8)]));
    expect(refusal(p3).message).toContain('colour profile other than sRGB');
    const srgb = withChunk(makePng(2, 2, [9, 9, 9]), 'iCCP', Buffer.concat([Buffer.from('sRGB IEC61966-2.1\0\0', 'latin1'), Buffer.alloc(8)]));
    expect(cleanPng(srgb, 'x').png.includes(Buffer.from('iCCP'))).toBe(false);
    expect(refusal(withChunk(makePng(2, 2, [0, 0, 0]), 'cHRM', Buffer.alloc(32))).status).toBe(415);
  });

  it('needs a written pre-registration, with the protocol’s numbers by default', () => {
    expect(() => parsePreregistration({})).toThrow(/sample/);
    expect(() => parsePreregistration({ ...PREREGISTRATION, threshold: 0.4 })).toThrow(/threshold/);
    const { threshold, minDecisive, minJudgesPerPair, plannedPairs, ...written } = PREREGISTRATION;
    expect(parsePreregistration(written)).toMatchObject({ threshold: 0.5, minDecisive: 194, minJudgesPerPair: 4, plannedPairs: 50 });
    expect([threshold, minDecisive, minJudgesPerPair, plannedPairs]).toEqual([0.5, 194, 4, 50]);
  });
});

// ---- PostgreSQL, as the application role: routes, row-level security, triggers ----

const url = process.env.HAWA_ISOLATED_RUNTIME_DB;

describe.skipIf(!url)('a blinded comparison study (PostgreSQL, application role)', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const otherTenant = '00000000-0000-4000-a000-000000000002';
  const userId = '00000000-0000-4000-b000-000000000001';
  const kaae = 'c1000000-0000-4000-8000-000000000002';
  const operator = { tenantId, userId, role: 'operator' as const };
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    app = createApp({ db });
  });
  afterAll(() => db.destroy());

  const ADMIN = 'test_admin_key';
  const call = async (method: string, path: string, body?: unknown, bearer: string | null = ADMIN) => {
    const res = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = res.headers.get('content-type') || '';
    const bytes = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      headers: res.headers,
      bytes,
      text: bytes.toString('utf8'),
      json: type.includes('json') ? JSON.parse(bytes.toString('utf8')) : undefined,
    };
  };
  const b64 = (buf: Buffer) => buf.toString('base64');

  /** A task whose final design was exported as PNG, as the Canva export store holds it. */
  const taskWithExport = async (png: Buffer | null) => {
    const taskId = randomUUID();
    await withRlsContext(db, operator, async (trx) => {
      await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, state) VALUES (${taskId}::uuid, ${tenantId}::uuid, ${kaae}::uuid, 'Comparison source', 'human_review')`.execute(trx);
      if (!png) return;
      const opId = randomUUID();
      await sql`INSERT INTO hawa.canva_remote_operations (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata)
        VALUES (${opId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaae}::uuid, ${userId}, ${'cmp_' + opId.slice(0, 8)}, 'h', 'export', 'retrieved', 'DAGcompare01', 1, '{"format":"png"}'::jsonb)`.execute(trx);
      await sql`INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaae}::uuid, ${opId}::uuid, 'png', ${createHash('sha256').update(png).digest('hex')}, ${png})`.execute(trx);
    });
    return taskId;
  };

  it('runs from pre-registration to results, blinded, with the plan and pairs fixed once judging starts', async () => {
    // Only the art director, creative director or an administrator runs a study.
    expect((await call('POST', '/v1/comparisons', { name: 'x', preregistration: PREREGISTRATION }, 'test_bearer')).status).toBe(403);
    expect((await call('GET', '/v1/comparisons', undefined, null)).status).toBe(401);
    expect((await call('POST', '/v1/comparisons', { name: 'No plan' })).status).toBe(400);

    const created = await call('POST', '/v1/comparisons', { name: `Office designer, September ${randomUUID().slice(0, 6)}`, preregistration: PREREGISTRATION });
    expect(created.status).toBe(201);
    const study = created.json;
    expect(study).toMatchObject({ status: 'draft', pairs: 0, judges: 0, lockedAt: null });
    expect(study.preregistrationSha256).toMatch(/^[0-9a-f]{64}$/);
    const id: string = study.id;

    // Pairs: uploads with the maker's name in their metadata, and one taken from a task's export.
    const W = 40;
    const H = 50;
    const p1 = await call('POST', `/v1/comparisons/${id}/pairs`, {
      hawaPngBase64: b64(makePng(W, H, [220, 30, 30], 'Canva')),
      designerPngBase64: `data:image/png;base64,${b64(makePng(W, H, [30, 30, 220], 'Adobe Photoshop (Office Designer)'))}`,
    });
    expect(p1.status).toBe(201);
    expect(p1.json).toMatchObject({ label: 'P01', width: W, height: H, taskId: null });
    const jpeg = await call('POST', `/v1/comparisons/${id}/pairs`, { hawaPngBase64: b64(makePng(W, H, [1, 2, 3])), designerPngBase64: b64(JPEG) });
    expect(jpeg.status).toBe(415);
    expect(jpeg.json.detail).toContain('Only PNG is accepted');
    const sizes = await call('POST', `/v1/comparisons/${id}/pairs`, { hawaPngBase64: b64(makePng(W, H, [1, 2, 3])), designerPngBase64: b64(makePng(W * 2, H * 2, [3, 2, 1])) });
    expect(sizes.status).toBe(422);
    expect(sizes.json.detail).toContain('same size');
    const exported = makePng(W, H, [120, 20, 160], 'Canva');
    const sourceTask = await taskWithExport(exported);
    const p2 = await call('POST', `/v1/comparisons/${id}/pairs`, { fromTask: true, taskId: sourceTask, designerPngBase64: b64(makePng(W, H, [240, 160, 20])) });
    expect(p2.status).toBe(201);
    expect(p2.json).toMatchObject({ label: 'P02', taskId: sourceTask, hawaSha256: cleanPng(exported, 'x').sha256 });
    const noExport = await call('POST', `/v1/comparisons/${id}/pairs`, { fromTask: true, taskId: await taskWithExport(null), designerPngBase64: b64(makePng(W, H, [9, 9, 9])) });
    expect(noExport.status).toBe(422);
    expect((await call('POST', `/v1/comparisons/${id}/pairs`, { label: 'P01', hawaPngBase64: b64(makePng(W, H, [5, 5, 5])), designerPngBase64: b64(makePng(W, H, [6, 6, 6])) })).status).toBe(409);
    const p3 = await call('POST', `/v1/comparisons/${id}/pairs`, { label: 'X-9', hawaPngBase64: b64(makePng(W, H, [20, 160, 60])), designerPngBase64: b64(makePng(W, H, [250, 250, 250])) });
    expect(p3.status).toBe(201);
    const pairIds: string[] = [p1.json.id, p2.json.id, p3.json.id];

    // No judges yet: judging cannot start.
    expect((await call('POST', `/v1/comparisons/${id}/lock`)).status).toBe(422);
    const tokens: Record<string, string> = {};
    for (const [name, kind] of [['Requester A', 'requester'], ['Requester B', 'requester'], ['Outside designer C', 'designer']] as const) {
      const added = await call('POST', `/v1/comparisons/${id}/judges`, { name, kind });
      expect(added.status).toBe(201);
      expect(added.json.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(added.json.link.path).toBe(`/api/judge/${added.json.token}`);
      tokens[name] = added.json.token;
    }
    expect((await call('POST', `/v1/comparisons/${id}/judges`, { name: 'Nobody', kind: 'client' })).status).toBe(400);

    // The office's view: no image bytes, no token and no token hash.
    const detail = await call('GET', `/v1/comparisons/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.json.pairList.map((p: { label: string }) => p.label)).toEqual(['P01', 'P02', 'X-9']);
    for (const token of Object.values(tokens)) {
      expect(detail.text).not.toContain(token);
      expect(detail.text).not.toContain(createHash('sha256').update(token).digest('hex'));
    }
    expect(detail.text.length).toBeLessThan(5000);
    const judgeId = (name: string): string => detail.json.judgeList.find((j: { name: string }) => j.name === name).id;

    const locked = await call('POST', `/v1/comparisons/${id}/lock`);
    expect(locked.status).toBe(200);
    expect(locked.json).toMatchObject({ status: 'judging' });
    expect(locked.json.lockedAt).toBeTruthy();
    expect((await call('POST', `/v1/comparisons/${id}/lock`)).status).toBe(409);
    // Judges are fixed once judging starts, as pre-registered.
    const lateJudge = await call('POST', `/v1/comparisons/${id}/judges`, { name: 'Late', kind: 'designer' });
    expect(lateJudge.status).toBe(409);
    expect(lateJudge.json.detail ?? lateJudge.json.message ?? JSON.stringify(lateJudge.json)).toContain('judges are fixed');

    // Locked: no new pairs, from the route or straight into the table.
    const late = await call('POST', `/v1/comparisons/${id}/pairs`, { hawaPngBase64: b64(makePng(W, H, [1, 1, 1])), designerPngBase64: b64(makePng(W, H, [2, 2, 2])) });
    expect(late.status).toBe(409);
    const png = makePng(W, H, [3, 3, 3]);
    const png2 = makePng(W, H, [4, 4, 4]);
    await expect(
      withRlsContext(db, operator, (trx) =>
        sql`INSERT INTO hawa.comparison_pairs (study_id, tenant_id, label, width, height, hawa_png, designer_png, hawa_sha256, designer_sha256)
          VALUES (${id}::uuid, ${tenantId}::uuid, 'P99', ${W}, ${H}, ${png}, ${png2}, ${createHash('sha256').update(png).digest('hex')}, ${createHash('sha256').update(png2).digest('hex')})`.execute(trx))
    ).rejects.toThrow(/cannot change once judging has started/);
    await expect(
      withRlsContext(db, operator, (trx) => sql`UPDATE hawa.comparison_studies SET preregistration = '{"threshold":0.4}'::jsonb WHERE id = ${id}::uuid`.execute(trx))
    ).rejects.toThrow(/pre-registration of a locked comparison study cannot change/);

    // ---- Requester A judges every pair ----
    const tokenA = tokens['Requester A'];
    const judgeA = judgeId('Requester A');
    const page = await call('GET', `/api/judge/${tokenA}`, undefined, null);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const policy = page.headers.get('content-security-policy') || '';
    const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1];
    expect(nonce).toBeTruthy();
    expect(policy).toContain("connect-src 'self'");
    expect(page.text).toContain(`<script nonce="${nonce}">`);
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    for (const words of ['Left is better', 'Right is better', 'No preference', 'I received one of these designs myself', 'Which design is better?']) expect(page.text).toContain(words);
    // Blind: nothing on the page or in its answers names an arm, a task, a label or a file.
    const blind = (s: string) => {
      const scrubbed = s.split(tokenA).join('TOKEN');
      expect(scrubbed).not.toMatch(/hawa|designer|canva|photoshop|P0\d|X-9|\.png/i);
      expect(scrubbed).not.toContain(sourceTask);
    };
    blind(page.text);
    expect(page.text).not.toMatch(/<script[^>]+src=|<link[^>]+href=|https?:\/\//);
    // The zoom overlay is display: flex; without this rule the hidden attribute lost and it covered the page on load.
    expect(page.text).toContain('[hidden] { display: none !important; }');

    const seenOrder: string[] = [];
    const choices: Record<string, Choice> = {};
    const plan: Choice[] = ['left', 'right', 'none'];
    for (let i = 0; i < 3; i++) {
      const next = await call('GET', `/api/judge/${tokenA}/next`, undefined, null);
      expect(next.status).toBe(200);
      blind(next.text);
      expect(Object.keys(next.json).sort()).toEqual(['judged', 'left', 'pairId', 'right', 'status', 'total']);
      expect(next.json).toMatchObject({ status: 'judging', judged: i, total: 3 });
      expect(next.json.left).toBe(`/api/judge/${tokenA}/image/${next.json.pairId}/left`);
      // A reload shows the same pair, on the same sides.
      const again = await call('GET', `/api/judge/${tokenA}/next`, undefined, null);
      expect(again.json).toEqual(next.json);
      const pairId: string = next.json.pairId;
      seenOrder.push(pairId);
      const left = await call('GET', next.json.left, undefined, null);
      const right = await call('GET', next.json.right, undefined, null);
      expect(left.status).toBe(200);
      expect(left.headers.get('content-type')).toBe('image/png');
      expect(left.headers.get('content-disposition')).toBe('inline; filename="design.png"');
      expect(left.bytes.includes(Buffer.from('tEXt'))).toBe(false);
      // The server put this judge's stable choice of arm on each side.
      const hawa = (await call('GET', `/v1/comparisons/${id}/pairs/${pairId}/hawa.png`)).bytes;
      const designer = (await call('GET', `/v1/comparisons/${id}/pairs/${pairId}/designer.png`)).bytes;
      const leftArm = shownLeftFor(judgeA, pairId);
      expect(left.bytes.equals(leftArm === 'hawa' ? hawa : designer)).toBe(true);
      expect(right.bytes.equals(leftArm === 'hawa' ? designer : hawa)).toBe(true);
      expect((await call('GET', `/api/judge/${tokenA}/image/${pairId}/left`, undefined, null)).bytes.equals(left.bytes)).toBe(true);

      const pick = await call('POST', `/api/judge/${tokenA}/judgments`, { pairId, choice: plan[i], seenBefore: i === 0 }, null);
      expect(pick.status).toBe(201);
      expect(pick.json).toEqual({ ok: true, already: false });
      choices[pairId] = plan[i];
      // A second tap, even a different one, changes nothing: the first answer stands.
      const twice = await call('POST', `/api/judge/${tokenA}/judgments`, { pairId, choice: plan[i] === 'left' ? 'right' : 'left' }, null);
      expect(twice.status).toBe(200);
      expect(twice.json).toEqual({ ok: true, already: true });
    }
    expect(seenOrder).toEqual(orderPairsForJudge(judgeA, pairIds.map((pid) => ({ id: pid }))).map((p) => p.id));
    const doneA = await call('GET', `/api/judge/${tokenA}/next`, undefined, null);
    expect(doneA.json).toEqual({ status: 'done', judged: 3, total: 3 });
    expect((await call('POST', `/api/judge/${tokenA}/judgments`, { pairId: pairIds[0], choice: 'hawa' }, null)).status).toBe(400);
    expect((await call('GET', `/v1/comparisons/${id}/pairs/${pairIds[0]}/other.png`)).status).toBe(404);

    // ---- Requester B picks left on every pair; its own order ----
    const tokenB = tokens['Requester B'];
    const judgeB = judgeId('Requester B');
    const orderB: string[] = [];
    for (;;) {
      const next = await call('GET', `/api/judge/${tokenB}/next`, undefined, null);
      if (next.json.status !== 'judging') break;
      orderB.push(next.json.pairId);
      expect((await call('POST', `/api/judge/${tokenB}/judgments`, { pairId: next.json.pairId, choice: 'left' }, null)).status).toBe(201);
    }
    expect(orderB).toEqual(orderPairsForJudge(judgeB, pairIds.map((pid) => ({ id: pid }))).map((p) => p.id));

    // ---- B loses the link: a new one on the same judge record; the old one stops; B resumes, counted once ----
    const reissued = await call('POST', `/v1/comparisons/${id}/judges/${judgeB}/link`);
    expect(reissued.status).toBe(201);
    const newTokenB: string = reissued.json.token;
    expect(newTokenB).not.toBe(tokenB);
    expect((await call('GET', `/api/judge/${tokenB}/next`, undefined, null)).status).toBe(404);
    expect((await call('GET', `/api/judge/${newTokenB}/next`, undefined, null)).json).toEqual({ status: 'done', judged: 3, total: 3 });
    expect((await call('POST', `/api/judge/${newTokenB}/judgments`, { pairId: pairIds[0], choice: 'right' }, null)).json).toEqual({ ok: true, already: true });

    // ---- Revoking C: the link stops working everywhere, as if it had never existed ----
    const tokenC = tokens['Outside designer C'];
    const revoked = await call('DELETE', `/v1/comparisons/${id}/judges/${judgeId('Outside designer C')}`);
    expect(revoked.status).toBe(200);
    expect(revoked.json.already).toBe(false);
    expect((await call('GET', `/api/judge/${tokenC}`, undefined, null)).status).toBe(404);
    expect((await call('GET', `/api/judge/${tokenC}/next`, undefined, null)).status).toBe(404);
    expect((await call('GET', `/api/judge/${tokenC}/image/${pairIds[0]}/left`, undefined, null)).status).toBe(404);
    expect((await call('POST', `/api/judge/${tokenC}/judgments`, { pairId: pairIds[0], choice: 'left' }, null)).status).toBe(404);
    expect(await resolveJudge(db, tokenC)).toBeNull();
    for (const bad of ['nonsense', 'A'.repeat(43), `${tokenA}x`]) {
      expect((await call('GET', `/api/judge/${bad}`, undefined, null)).status).toBe(404);
      expect((await call('GET', `/v1/judge/${bad}/next`, undefined, null)).status).toBe(404);
    }

    // ---- Results: exactly what the picks say, through each judge's own sides ----
    const expected = { hawa: 0, designer: 0, none: 0 };
    for (const [pid, choice] of Object.entries(choices)) {
      const arm = preferredArm(shownLeftFor(judgeA, pid), choice);
      expected[arm ?? 'none'] += 1;
    }
    for (const pid of pairIds) expected[preferredArm(shownLeftFor(judgeB, pid), 'left')!] += 1;
    // While judging, only progress: the share, interval and verdict are withheld until the study closes.
    const running = await call('GET', `/v1/comparisons/${id}/results`);
    expect(running.status).toBe(200);
    expect(running.json).toMatchObject({ withheld: true, judgements: 6, decisive: 5, none: 1 });
    expect(running.json.primary).toBeUndefined();
    for (const withheld of ['primary', 'claim', 'byJudgeKind', 'excludingSeenBefore', 'seenBefore', 'position']) expect(running.json).not.toHaveProperty(withheld);
    expect(Object.keys(running.json.perPair[0]).sort()).toEqual(['judgements', 'label', 'pairId']);
    expect((await call('POST', `/v1/comparisons/${id}/close`)).status).toBe(200);
    const results = await call('GET', `/v1/comparisons/${id}/results`);
    expect(results.status).toBe(200);
    expect(results.json.withheld).toBe(false);
    expect(results.json.primary).toMatchObject({ judgements: 6, decisive: 5, none: 1, hawa: expected.hawa, designer: expected.designer });
    expect(results.json.primary.tieRate).toBeCloseTo(1 / 6, 10);
    const ci = wilsonInterval(expected.hawa, 5)!;
    expect(results.json.primary.interval.low).toBeCloseTo(ci.low, 10);
    expect(results.json.byJudgeKind.requester.judgements).toBe(6);
    expect(results.json.byJudgeKind.designer.judgements).toBe(0);
    expect(results.json.seenBefore.judgements).toBe(1);
    expect(results.json.excludingSeenBefore.judgements).toBe(5);
    expect(results.json.position).toMatchObject({ shown: 6, decisive: 5 });
    expect(results.json.perPair.map((p: { label: string }) => p.label)).toEqual(['P01', 'P02', 'X-9']);
    expect(results.json.claim).toMatchObject({ holds: false, closed: true, sampleComplete: false });
    expect(results.json.preregistration).toEqual(PREREGISTRATION);

    // ---- Closing: no more picks, no more images; the results stand ----
    expect((await call('POST', `/v1/comparisons/${id}/close`)).status).toBe(409);
    expect((await call('GET', `/api/judge/${newTokenB}/next`, undefined, null)).json).toEqual({ status: 'closed', judged: 3, total: 3 });
    expect((await call('GET', `/api/judge/${newTokenB}/image/${pairIds[0]}/left`, undefined, null)).status).toBe(404);
    const afterClose = await call('POST', `/api/judge/${newTokenB}/judgments`, { pairId: pairIds[0], choice: 'right' }, null);
    expect(afterClose.status).toBe(409);
    expect((await call('POST', `/v1/comparisons/${id}/judges`, { name: 'Late', kind: 'designer' })).status).toBe(409);
    expect((await call('GET', `/v1/comparisons/${id}/results`)).json.primary.judgements).toBe(6);

    // ---- Another tenant sees none of it ----
    const other = { tenantId: otherTenant, userId, role: 'administrator', actorId: 'other_admin' };
    expect((await listStudies(db, other)).some((s) => s.id === id)).toBe(false);
    await expect(getStudy(db, other, id)).rejects.toMatchObject({ status: 404 });
    await expect(studyResults(db, other, id)).rejects.toMatchObject({ status: 404 });
    expect(await readPairImage(db, other, id, pairIds[0], 'hawa')).toBeNull();
    await expect(addJudge(db, other, id, { name: 'Intruder', kind: 'designer' })).rejects.toMatchObject({ status: 404 });
  });

  it('keeps each tenant’s judges to their own tenant, and the office of one tenant cannot open another’s study', async () => {
    const other = { tenantId: otherTenant, userId, role: 'administrator', actorId: 'other_admin' };
    const study = await createStudy(db, other, { name: 'Other office', preregistration: PREREGISTRATION });
    await addPair(db, other, study.id, { hawaPng: makePng(8, 8, [1, 100, 1]), designerPng: makePng(8, 8, [100, 1, 1]) });
    await addPair(db, other, study.id, { hawaPng: makePng(8, 8, [1, 1, 100]), designerPng: makePng(8, 8, [100, 100, 1]) });
    const { token } = await addJudge(db, other, study.id, { name: 'Their requester', kind: 'requester' });
    await lockStudy(db, other, study.id);
    expect(await resolveJudge(db, token)).toMatchObject({ tenantId: otherTenant, studyId: study.id });
    // Their judge sees their pairs; this tenant's administrator sees nothing of the study.
    expect((await call('GET', `/api/judge/${token}/next`, undefined, null)).json).toMatchObject({ status: 'judging', total: 2 });
    expect((await call('GET', `/v1/comparisons/${study.id}`)).status).toBe(404);
    expect((await call('GET', `/v1/comparisons/${study.id}/results`)).status).toBe(404);
    expect((await call('GET', '/v1/comparisons')).json.studies.some((s: { id: string }) => s.id === study.id)).toBe(false);
    // Row-level security, not the route, is what hides it: the application role reads no row of it as this tenant.
    const rows = await withRlsContext(db, operator, async (trx) =>
      (await sql<{ n: number }>`SELECT (SELECT count(*) FROM hawa.comparison_studies WHERE id = ${study.id}::uuid)
        + (SELECT count(*) FROM hawa.comparison_pairs WHERE study_id = ${study.id}::uuid)
        + (SELECT count(*) FROM hawa.comparison_judges WHERE study_id = ${study.id}::uuid) AS n`.execute(trx)).rows[0]);
    expect(Number(rows.n)).toBe(0);
  });
});
