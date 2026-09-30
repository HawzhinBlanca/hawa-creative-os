/**
 * The owner's first request on the natural-language release (2026-09-29 19:24:53Z): an album of six
 * field-visit photos whose caption is the brief of a KAAE report cover. The sweep opened it, the
 * Studio wrote the brief ($0.15) and then failed at 'laying_out' with BUDGET_EXHAUSTED ("no candidate
 * passed hard QA") although nothing had been laid out: the layout call's advance reservation was
 * larger than what the run had left under its $2 cap (ADR-142).
 *
 * Reproduced end to end here with the same stage inputs, against fake providers at production-tier
 * prices: six Telegram-sized photos (1280x960 JPEG, as Telegram delivers a photo), the owner's exact
 * words, the album settled by the worker's settle call, the request projected, and the Studio run
 * resumed stage by stage until it transfers a draft that places the photos.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import type { CanvaConnectService } from '../src/services/canva-connect-service.js';
import { projectLifecycleDesignOutcome } from '../src/services/lifecycle-projection.js';
import { projectLifecycleOfficeRetry } from '../src/services/lifecycle-office-retry.js';

const tenantId = '00000000-0000-4000-a000-000000000001';
const userId = '00000000-0000-4000-b000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const scope = { tenantId, userId, role: 'operator' as const };
const studioScope = { tenantId, actorId: userId };
const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const token = ['report', 'cover', 'fixture', 'token'].join('_');
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
let id = 870_000_000;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A Telegram photo: 1280x960 JPEG. Six distinct files (a trailing byte after the image's end marker). */
const telegramPhoto = readFileSync(new URL('./fixtures/telegram-photo-1280.jpg', import.meta.url));
const photo = (n: number) => Buffer.concat([telegramPhoto, Buffer.from([n])]);

/** The owner's words, exactly as sent (the paste may have been cut after "toward"; kept as given). */
export const OWNER_BRIEF = `Design a professional report cover for KAAE using only the provided field-visit photos and the provided text. Arrange the supplied photos in a clean, structured collage across the upper and middle sections. Use KAAE’s navy blue, yellow, and white brand colors, with a dark navy overlay or gradient toward the lower section to create a clear text area. Place the KAAE logo near the top and use a thin yellow border as a framing element. Keep the provided title, subtitle, supporting text, and website exactly as written, without rewriting or shortening them. Use bold white and yellow typography with clear hierarchy. The overall design should feel modern, formal, institutional, educational, and suitable for an official KAAE report cover. Do not generate new photos or replace the supplied ones and you don’t have to use all the photos, choose the best ones based on your design.

Here is the text and the photos:

KAAE K-12 Pilot Study
Field Visit Report

Insights from KAAE school field visits and next steps toward`;

afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await db.destroy(); await owner.destroy(); });

function album() {
  const chat = ++id;
  vi.stubEnv('HAWA_WORKER_TOKEN', token);
  vi.stubEnv('AUTO_GENERATE_DAILY_CAP_GLOBAL', '100000');
  vi.stubEnv('AUTO_GENERATE_DAILY_CAP_PER_SENDER', '10000');
  const download = vi.fn(async (file: string) => photo(Number(file)));
  const app = createApp({ db, telegramBridge: { downloadFile: download,
    dispatchOutboundMessage: vi.fn(async () => ({ success: true })) } } as any);
  const from = { id: 91000029, first_name: 'Owner' };
  const part = (messageId: number, file: number, caption?: string) => ({
    update_id: ++id, message: { message_id: messageId, date: 1790000000, from, chat: { id: chat, type: 'private' },
      media_group_id: `album-${chat}`, photo: [{ file_id: String(file) }], ...(caption ? { caption } : {}) },
  });
  const intake = async (update: unknown, extra: Record<string, unknown> = {}) => {
    const res = await app.request('/v1/internal/telegram/intake', { method: 'POST', headers,
      body: JSON.stringify({ v: 1, mode: 'legacy', update, languageSiblings: true, ...extra }) });
    expect(res.status).toBe(200);
    return await res.json();
  };
  const project = async (decision: any) => app.request(`/v1/internal/lifecycle/${decision.requestId}/project`, {
    method: 'POST', headers, body: JSON.stringify({ v: 1, expectedRev: 0, rev: 1, key: `${decision.requestId}:1:open`,
      ops: [{ kind: 'createRequest', draft: decision.draft }] }) });
  const backdate = (interval: string) => sql`UPDATE hawa.inbox_events SET received_at = received_at - ${interval}::interval
    WHERE tenant_id = ${tenantId}::uuid AND payload->>'chatId' = ${String(chat)}
      AND source_account_id IN ('lifecycle_album_part', 'lifecycle_album_pending', 'lifecycle_brief_held')`.execute(owner);
  const sweep = async () => (await (await app.request('/v1/internal/telegram/settle-sweep', { method: 'POST', headers,
    body: JSON.stringify({ v: 1 }) })).json()).due.filter((d: any) => d.chatId === String(chat));
  return { chat, part, intake, project, backdate, sweep, app };
}

/** Opens the owner's album as the production sweep did, and returns the projected task. */
async function openOwnersAlbum(via: 'settle' | 'sweep') {
  const f = album();
  const parts = [1, 2, 3, 4, 5, 6].map((n) => f.part(300 + n, n, n === 1 ? OWNER_BRIEF : undefined));
  for (const p of parts) await f.intake(p, via === 'settle' ? { briefHold: true } : {});
  let update: unknown = parts[5];
  if (via === 'sweep') {
    // Saved before ADR-143 (no timer); the worker's sweep finds it once it is overdue.
    await f.backdate('3 hours');
    const due = await f.sweep();
    expect(due).toEqual([{ chatId: String(f.chat), update: parts[5] }]);
    update = due[0].update;
  }
  const opened = await f.intake(update, { settle: true, briefHold: true });
  expect(opened).toMatchObject({ lifecycleAction: 'open-request',
    draft: { lifecycleAlbum: { images: [1, 2, 3, 4, 5, 6].map((n) => ({ sha256: sha(photo(n)) })) } } });
  const projected = await f.project(opened);
  expect(projected.status).toBe(200);
  const taskId = String((await projected.json()).taskId);
  return { ...f, taskId, requestId: opened.requestId as string };
}

const referenceFiles = (taskId: string) => withRlsContext(db, scope, async (trx) => (await sql<{ sha256: string }>`
  SELECT sha256 FROM hawa.task_files WHERE tenant_id = ${tenantId}::uuid AND task_id = ${taskId}::uuid
    AND role = 'reference_image' ORDER BY sha256`.execute(trx)).rows.map((r) => r.sha256));

describe('the owner\'s album of six photos reaches its design (2026-09-29)', () => {
  it.each(['settle', 'sweep'] as const)('an album opened by its %s carries all six photos to the task and the Studio', async (via) => {
    const { taskId } = await openOwnersAlbum(via);
    expect(await referenceFiles(taskId)).toEqual([1, 2, 3, 4, 5, 6].map((n) => sha(photo(n))).sort());
    const task = (await withRlsContext(db, scope, (trx) => trx.selectFrom('tasks').select(['client_id'])
      .where('id', '=', taskId).executeTakeFirstOrThrow()));
    expect(task.client_id).toBe(clientId);
    const images: string[] = await (new DesignStudioService(db) as any).requestImages(studioScope, taskId);
    expect(images).toEqual([1, 2, 3, 4, 5, 6].map((n) => `data:image/jpeg;base64,${photo(n).toString('base64')}`));
  });

  it('a request-owned album whose stored photos no longer match its manifest stops the design instead of designing without them', async () => {
    const { taskId } = await openOwnersAlbum('settle');
    await sql`DELETE FROM hawa.task_files WHERE task_id = ${taskId}::uuid AND sha256 = ${sha(photo(6))}`.execute(owner);
    const calls: Array<{ schema: string }> = [];
    // The single-shot planner a failed v2 run falls back to would design the request without its photos.
    const planner = { generate: vi.fn(async () => ({ status: 'planned', planId: randomUUID() })) };
    const service = new DesignStudioService(db, undefined, { apiKey: 'test-key', fetcher: fakeProvider(calls) as any, defaultTier: 'standard', planner } as any);
    const { run } = await service.createOrGetRun(studioScope, taskId, `key-${randomUUID().slice(0, 16)}`, { width: 1080, height: 1350, tier: 'standard' });
    const result = await service.resume(studioScope, taskId, run.id);
    expect(result.status).toBe('failed');
    expect(result.diagnostic).toMatch(/The request's photos cannot be used: The task files differ from the confirmed album/);
    expect(calls).toEqual([]);
    expect(planner.generate).not.toHaveBeenCalled();
  });
});

/**
 * Three distinct report-cover layouts in the generator's normalised form: the photos as a collage
 * across the upper and middle sections, the copy stacked in the lower third, the logo at the top.
 * One text element per copy block the request carries, in order.
 */
function coverLayouts(copyCount: number, photoCount: number) {
  const text = (align: 'center' | 'left', x: number, width: number) => Array.from({ length: copyCount }, (_, i) => ({
    copyIndex: i, role: i === 0 ? 'title' : i === 1 ? 'subtitle' : 'body',
    x, y: 0.6 + i * 0.1, width, height: 0.085,
    fontSize: i === 0 ? 0.034 : i === 1 ? 0.02 : 0.014, lineHeight: i === 0 ? 1.25 : i === 1 ? 1.35 : 1.5,
    letterSpacing: null, fontFamily: i === 0 ? 'Cinzel' : 'Verdana', color: i === 1 ? '#F7B500' : '#FFFFFF',
    align, bold: i === 0, italic: false, rtl: false,
  }));
  const grid = (cols: number, x0: number, y0: number, w: number, h: number) => Array.from({ length: photoCount }, (_, i) => ({
    photoIndex: i, role: 'inset', radiusFraction: 0,
    x: x0 + (i % cols) * (w + 0.015), y: y0 + Math.floor(i / cols) * (h + 0.012), width: w, height: h,
  }));
  const base = { typeScale: { base: 15, ratio: 1.333 }, grid: { margin: 0.074, columns: 12, gutter: 0.018, baseline: 0.006 },
    background: { color: '#0B1F3A' }, art: null, shapes: [] };
  return [
    { ...base, id: 'c1', conceptTitle: 'Collage Monolith', compositionArchetype: 'monolith_centered',
      logo: { x: 0.407, y: 0.05, width: 0.185, height: 0.06 }, photos: grid(3, 0.074, 0.15, 0.274, 0.195),
      text: text('center', 0.074, 0.852) },
    { ...base, id: 'c2', conceptTitle: 'Editorial Collage', compositionArchetype: 'asymmetric_editorial',
      logo: { x: 0.074, y: 0.05, width: 0.185, height: 0.06 }, photos: grid(2, 0.074, 0.14, 0.42, 0.13),
      text: text('left', 0.111, 0.78) },
    { ...base, id: 'c3', conceptTitle: 'Banner Collage', compositionArchetype: 'split_statutory_banner',
      logo: { x: 0.741, y: 0.05, width: 0.185, height: 0.06 }, photos: grid(6, 0.074, 0.3, 0.13, 0.14),
      text: text('center', 0.12, 0.76) },
  ];
}

/** Production-tier fake provider: every answer carries usage, so each receipt is priced as production prices it. */
function fakeProvider(calls: Array<{ schema: string; reservation?: number }>) {
  const reply = (body: any, data: unknown, usage: { prompt_tokens: number; completion_tokens: number }) => ({
    ok: true, status: 200, headers: { get: () => `req_${randomUUID().slice(0, 8)}` },
    json: async () => ({ id: `chatcmpl-${randomUUID().slice(0, 12)}`, model: body.model,
      choices: [{ message: { content: JSON.stringify(data) } }], usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } }),
  });
  return vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const schema: string = body.response_format?.json_schema?.name ?? 'none';
    calls.push({ schema });
    const text = JSON.stringify(body.messages);
    const copyCount = (text.match(/\[Index \d+ - /g) || []).length || (text.match(/- Block \d+ \[role/g) || []).length;
    const imageCount = body.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).filter((part: any) => part.type === 'image_url').length;
    if (schema === 'CreativeBrief') {
      // $0.15323 at production prices, the brief the owner's run paid for.
      return reply(body, {
        occasion: 'KAAE K-12 pilot study field visit report', audience: 'Education officials and partners', formality: 5,
        toneWords: ['Formal', 'Institutional', 'Educational'], readingOrder: Array.from({ length: copyCount }, (_, i) => i),
        roles: Array.from({ length: copyCount }, (_, i) => ({ copyIndex: i, role: i === 0 ? 'title' : i === 1 ? 'subtitle' : 'body', importance: 5 - Math.min(i, 3) })),
        must: ['Use only the supplied photos', 'Keep the text exactly as written'], mustNot: ['No generated photos'],
        imageryStrategy: 'none', imageryRationale: 'The supplied photos are the imagery', kurdishLeads: false, riskFlags: [],
        referenceRole: 'none', referenceNotes: '',
        imageRoles: Array.from({ length: imageCount }, (_, index) => ({ index, role: 'content_photo', notes: `Field visit photo ${index + 1}` })),
      }, { prompt_tokens: 10323, completion_tokens: 1000 });
    }
    if (schema === 'art_direction_concepts') {
      // ADR-170: a brief with photos is art-directed. The slots are left to the brief's roles.
      const c = (id: string, recipe: string, hero: number, texture: number | null) => ({ id, conceptNote: id, recipe, typicality: 0.5,
        heroPhotoIndex: hero, texturePhotoIndex: texture, cutoutPhotoIndex: null, slots: [], titleAccentWords: null,
        fadeShare: null, surfaceTone: 'navy', frame: 'inset', align: 'start' });
      return reply(body, { concepts: [c('fade', 'hero_fade_report', 0, 4), c('scrim', 'scrim_caption', 5, null), c('card', 'hero_card', 3, null)] },
        { prompt_tokens: 14000, completion_tokens: 2500 });
    }
    if (schema === 'layout_v3_candidates') {
      const photos = (text.match(/"kind\\":\\"content_photo\\"/g) || []).length;
      return reply(body, { layouts: coverLayouts(copyCount, photos) }, { prompt_tokens: 14000, completion_tokens: 9000 });
    }
    if (schema === 'DesignCritiqueReport') return reply(body, { overallAssessment: 'Balanced and legible.', comments: [] }, { prompt_tokens: 3000, completion_tokens: 400 });
    if (schema === 'PairwiseDimensionVerdict') {
      const dims = ['hierarchy', 'composition', 'typographic_craft', 'brand_fit', 'legibility'];
      return reply(body, { dimensions: Object.fromEntries(dims.map((d) => [d, { winner: 'A', rationale: 'position' }])),
        majorityWinner: 'A', summary: 'A' }, { prompt_tokens: 3000, completion_tokens: 300 });
    }
    return reply(body, {}, { prompt_tokens: 1000, completion_tokens: 100 });
  });
}

describe('the owner\'s report cover is laid out within the run\'s limit (ADR-142)', () => {
  it('six photos and the owner\'s brief at production prices: the layout call is admitted and a draft placing the photos is transferred', async () => {
    const env = { tier: process.env.HAWA_MODEL_TIER, v3: process.env.DESIGN_PIPELINE_V3 };
    process.env.HAWA_MODEL_TIER = 'production';
    // ADR-142 boundary uses its original Astra prices; ADR-149 separately checks Sol counted images.
    for (const role of ['TEXT', 'LAYOUT', 'CRITIQUE']) vi.stubEnv(`HAWA_MODEL_${role}`, 'gpt-6-astra');
    process.env.DESIGN_PIPELINE_V3 = 'on';
    try {
      const { taskId } = await openOwnersAlbum('sweep');
      const calls: Array<{ schema: string }> = [];
      const fetcher = fakeProvider(calls);
      const canva = { importEditableDesign: vi.fn().mockResolvedValue({ operationId: randomUUID(), status: 'submitted', designId: 'DAFCOVER01' }) } as unknown as CanvaConnectService;
      const service = new DesignStudioService(db, canva, { apiKey: 'test-key', fetcher: fetcher as any, defaultTier: 'standard' });
      const { run } = await service.createOrGetRun(studioScope, taskId, `key-${randomUUID().slice(0, 16)}`, { width: 1080, height: 1350, tier: 'standard' });
      expect(run.budget).toMatchObject({ maxUsd: 2, maxCalls: 24 });
      let result: any = { status: run.status };
      for (let i = 0; i < 20 && !['transferred', 'failed', 'degraded'].includes(result.status); i++) {
        result = await service.resume(studioScope, taskId, run.id);
      }
      const final = (await sql<any>`SELECT status, diagnostic, budget, stages FROM hawa.design_studio_runs WHERE id=${run.id}::uuid`.execute(owner)).rows[0];
      expect({ status: final.status, diagnostic: final.diagnostic }).toEqual({ status: 'transferred', diagnostic: final.diagnostic });
      expect(final.diagnostic ?? '').not.toMatch(/BUDGET_EXHAUSTED/);

      const ledger = (await sql<{ stage: string; reserved: string; usd: string }>`SELECT stage, (reservation->>'usd') AS reserved, usd_estimate::text AS usd
        FROM hawa.design_studio_calls WHERE run_id = ${run.id}::uuid ORDER BY started_at`.execute(owner)).rows;
      const brief = ledger.find((c) => c.stage === 'briefing')!;
      const layout = ledger.find((c) => c.stage === 'laying_out')!;
      expect(Number(brief.usd)).toBeCloseTo(0.15323, 5);
      // The call the owner's run could not admit: its reservation now fits what the brief left.
      // Measured: $2.13 under policy v2 (two tokens a byte), $1.61 under v3.
      expect(Number(layout.reserved)).toBeLessThan(2 - 0.15323);
      expect(Number(layout.reserved)).toBeLessThan(1.7);
      expect(Number(final.budget.spentUsd)).toBeLessThan(2);

      // ADR-180 (owner, 2026-09-30: "office house style"): "you don't have to use all the photos, choose
      // the best ones" states no count, so the recorded half-the-photos guess does not bind the art
      // director. Under ADR-171 it did, and this brief shipped as a three-photo collage. The design is
      // one hero (and at most a blended texture); the rest are recorded for office review.
      const winner = (await sql<any>`SELECT layouts FROM hawa.design_studio_candidates WHERE run_id = ${run.id}::uuid AND status = 'winner'`.execute(owner)).rows[0];
      const layouts = typeof winner.layouts === 'string' ? JSON.parse(winner.layouts) : winner.layouts;
      const shipped = layouts.at(-1);
      expect(final.stages.brief.photoSelection).toMatchObject({ mode: 'choose', minimum: 3 });
      expect(shipped.artDirection?.recipe).toMatch(/^(hero_fade_report|scrim_caption|hero_card|hero_plate)$/);
      expect(shipped.photos.length).toBeGreaterThanOrEqual(1);
      expect(shipped.photos.length).toBeLessThanOrEqual(2);
      expect([...shipped.photos.map((p: any) => p.photoIndex), ...final.stages.qa.omittedPhotos].sort()).toEqual([0, 1, 2, 3, 4, 5]);
      // No heavy box behind the logo: its ground was read on the pixels and recorded.
      expect(shipped.artDirection?.logoGround?.treatment).toMatch(/^(none|scrim|tab)$/);
      expect((canva as any).importEditableDesign).toHaveBeenCalledTimes(1);
    } finally {
      for (const [k, v] of [['HAWA_MODEL_TIER', env.tier], ['DESIGN_PIPELINE_V3', env.v3]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  }, 180_000);

  it('a layout request larger than the run has left fails with its own diagnostic, sends nothing, and never claims QA refused a candidate', async () => {
    const env = { tier: process.env.HAWA_MODEL_TIER, v3: process.env.DESIGN_PIPELINE_V3 };
    process.env.HAWA_MODEL_TIER = 'production';
    for (const role of ['TEXT', 'LAYOUT', 'CRITIQUE']) vi.stubEnv(`HAWA_MODEL_${role}`, 'gpt-6-astra');
    process.env.DESIGN_PIPELINE_V3 = 'on';
    try {
      const { taskId, requestId } = await openOwnersAlbum('settle');
      const calls: Array<{ schema: string }> = [];
      // A run limit of $1: the brief ($0.81 reserved, $0.15 spent) is admitted, the layout ($1.61) is not.
      const service = new DesignStudioService(db, undefined, { apiKey: 'test-key', fetcher: fakeProvider(calls) as any, defaultTier: 'standard', maxUsd: 1 });
      const { run } = await service.createOrGetRun(studioScope, taskId, `key-${randomUUID().slice(0, 16)}`, { width: 1080, height: 1350, tier: 'standard' });
      let result: any = { status: run.status };
      for (let i = 0; i < 6 && !['transferred', 'failed', 'degraded'].includes(result.status); i++) {
        result = await service.resume(studioScope, taskId, run.id);
      }
      expect(result).toMatchObject({ status: 'failed', stage: 'laying_out', code: 'STUDIO_RUN_LIMIT_TOO_SMALL' });
      // ADR-170: the art-direction call reserves 6,000 output tokens where three full layouts reserved
      // 16,000, so the same request now needs about $1.03 rather than $1.61, still over what is left.
      expect(result.diagnostic).toMatch(/^STUDIO_RUN_LIMIT_TOO_SMALL at stage laying_out: the next model request needs a \$1\.0\d advance reservation and the run has \$0\.8\d of its \$1 limit left \(\$0\.15 spent\)\. Nothing was sent for it and no layout was made\./);
      expect(result.diagnostic).not.toMatch(/hard QA/);
      expect(calls.map((c) => c.schema)).toEqual(['CreativeBrief']);
      const stored = (await sql<any>`SELECT status, diagnostic FROM hawa.design_studio_runs WHERE id=${run.id}::uuid`.execute(owner)).rows[0];
      expect(stored).toEqual({ status: 'failed', diagnostic: result.diagnostic });
      // A resume of the settled run answers with the same diagnostic, which the worker reads as the same code.
      const again = await service.resume(studioScope, taskId, run.id);
      expect(again).toMatchObject({ status: 'failed', diagnostic: result.diagnostic });

      // The office's retry (ADR-142) designs the same task again: the request records the failed outcome,
      // the retry moves it back to designing, and the worker's attempt run starts a new Studio run under
      // its own key. With the run limit that fits the request, it transfers a draft.
      const firstRun = `dr-${taskId}`;
      await projectLifecycleDesignOutcome(db, { requestId, tenantId, taskId, runId: firstRun, expectedRev: 1, rev: 2,
        key: `${requestId}:2:designFinished:${firstRun}`, report: { status: 'DESIGN_FAILED', code: 'STUDIO_RUN_LIMIT_TOO_SMALL' } });
      const actionId = randomUUID();
      const retried = await projectLifecycleOfficeRetry(db, { requestId, tenantId, taskId, actionId,
        actor: { userId, role: 'operator' }, reason: 'Retry after ADR-142', expectedRev: 2, rev: 3,
        key: `${requestId}:3:officeRetry:desk:${actionId}` });
      expect(retried).toMatchObject({ stage: 'designing', attempt: 1, runId: `dr-${taskId}-a1`, taskState: 'received' });
      const canva = { importEditableDesign: vi.fn().mockResolvedValue({ operationId: randomUUID(), status: 'submitted', designId: 'DAFCOVER02' }) } as unknown as CanvaConnectService;
      const retry = new DesignStudioService(db, canva, { apiKey: 'test-key', fetcher: fakeProvider(calls) as any, defaultTier: 'standard' });
      // The worker's Studio key for attempt 1 (canva-draft-workflow.ts runKey with redriveAttempt 1).
      const { run: second, created } = await retry.createOrGetRun(studioScope, taskId, `workflow-studio-${taskId}-redrive-1`, { width: 1080, height: 1350, tier: 'standard' });
      expect(created).toBe(true);
      expect(second.id).not.toBe(run.id);
      let next: any = { status: second.status };
      for (let i = 0; i < 20 && !['transferred', 'failed', 'degraded'].includes(next.status); i++) {
        next = await retry.resume(studioScope, taskId, second.id);
      }
      expect(next.status).toBe('transferred');
      const winner = (await sql<any>`SELECT layouts FROM hawa.design_studio_candidates WHERE run_id = ${second.id}::uuid AND status = 'winner'`.execute(owner)).rows[0];
      const layouts = typeof winner.layouts === 'string' ? JSON.parse(winner.layouts) : winner.layouts;
      // ADR-180: art-directed, as in the first run of this file: a hero, at most a texture, the rest left out.
      expect(layouts.at(-1).artDirection?.recipe).toBeTruthy();
      expect(layouts.at(-1).artDirection?.recipe).not.toBe('hero_storyboard');
      expect(layouts.at(-1).photos.length).toBeLessThanOrEqual(2);
    } finally {
      for (const [k, v] of [['HAWA_MODEL_TIER', env.tier], ['DESIGN_PIPELINE_V3', env.v3]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  }, 180_000);
});
