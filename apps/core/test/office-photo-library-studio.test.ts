/**
 * ADR-280 through the real Studio service: a text-only KAAE request (no picture sent), resumed stage
 * by stage against fake providers (no paid call) until it transfers a draft.
 *
 * - Flag on, with a library holding a matching, cleared photo: the run designs with it through a
 *   photo recipe, records the photo's provenance and reasons, and hard QA passes.
 * - Flag off, with the same library on disk: the run makes exactly the model calls, writes exactly
 *   the stage keys and ships exactly the photo-less design of a run with no library at all.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql } from '@hawa/db';
import { HAWZHIN_AUTH_ORIGIN } from '../src/customer/supabase-member.js';
import { ingestOfficePhotoFolder, parseOfficePhotoTagSheet } from '@hawa/creative';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import type { CanvaConnectService } from '../src/services/canva-connect-service.js';
import { syntheticPhoto } from '../../../packages/creative/test/fixtures/synthetic-photos.js';

const tenantId = '00000000-0000-4000-a000-000000000001';
const userId = '00000000-0000-4000-b000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const studioScope = { tenantId, actorId: userId };
const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const dirs: string[] = [];
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await db.destroy(); await owner.destroy(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const visit = syntheticPhoto(1200, 1500, 51);
let libraryRoot = '';
beforeAll(async () => {
  libraryRoot = mkdtempSync(path.join(tmpdir(), 'olp-studio-'));
  const source = mkdtempSync(path.join(tmpdir(), 'olp-studio-src-'));
  dirs.push(libraryRoot, source);
  writeFileSync(path.join(source, 'visit.png'), visit);
  writeFileSync(path.join(source, 'signing.png'), syntheticPhoto(1500, 1000, 52, [120, 90, 70]));
  await ingestOfficePhotoFolder({ sourceDir: source, libraryRoot, clientId, tagRows: parseOfficePhotoTagSheet([
    'source,description,subjects,events,keywords,shot,people,consent,usable',
    'visit.png,KAAE evaluators with pupils in a school classroom,school; k12,field visit,pilot; students,classroom_or_interior,yes,granted,yes',
    'signing.png,Partnership signing at the ministry,ministry,signing,agreement,event_or_stage,yes,granted,yes',
  ].join('\n'), 'csv') });
});

/** A synthetic website customer account of the KAAE client (no real person). */
async function customerAccount() {
  const accountId = randomUUID(), customerUser = randomUUID(), subject = randomUUID();
  await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${customerUser}::uuid,${customerUser + '@example.test'},'Synthetic customer')`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${customerUser}::uuid,'requester')`.execute(owner);
  await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role) VALUES(${tenantId}::uuid,${clientId}::uuid,${customerUser}::uuid,'requester')`.execute(owner);
  await sql`INSERT INTO hawa.customer_accounts(id,tenant_id,issuer,subject,user_id,provisioned_by,reason,concurrent_job_limit)
    VALUES(${accountId}::uuid,${tenantId}::uuid,${HAWZHIN_AUTH_ORIGIN},${subject}::uuid,${customerUser}::uuid,${userId}::uuid,'Synthetic office-library check',2)`.execute(owner);
  await sql`INSERT INTO hawa.customer_client_grants(tenant_id,account_id,client_id,provisioned_by,reason)
    VALUES(${tenantId}::uuid,${accountId}::uuid,${clientId}::uuid,${userId}::uuid,'Synthetic office-library check')`.execute(owner);
  return { accountId, userId: customerUser, subject };
}

const COPY = 'KAAE K-12 Pilot Study\n\nField Visit Report\n\nInsights from KAAE school field visits and next steps';

/** Fake provider answers; the image count each call carried is recorded with its schema. */
function fakeProvider(calls: Array<{ schema: string; images: number }>) {
  const reply = (body: any, data: unknown) => ({
    ok: true, status: 200, headers: { get: () => `req_${randomUUID().slice(0, 8)}` },
    json: async () => ({ id: `chatcmpl-${randomUUID().slice(0, 12)}`, model: body.model, choices: [{ message: { content: JSON.stringify(data) } }],
      usage: { prompt_tokens: 3000, completion_tokens: 500, total_tokens: 3500 } }),
  });
  return vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const schema: string = body.response_format?.json_schema?.name ?? 'none';
    const text = JSON.stringify(body.messages);
    const images = body.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((p: any) => p.type === 'image_url').length;
    calls.push({ schema, images });
    const copyCount = (text.match(/\[Index \d+ - /g) || []).length || (text.match(/- Block \d+ \[role/g) || []).length || 3;
    if (schema === 'CreativeBrief') {
      return reply(body, {
        occasion: 'KAAE K-12 pilot study school field visit report', audience: 'Education officials and partners', formality: 5,
        toneWords: ['Formal', 'Institutional', 'Educational'], readingOrder: Array.from({ length: copyCount }, (_, i) => i),
        roles: Array.from({ length: copyCount }, (_, i) => ({ copyIndex: i, role: i === 0 ? 'title' : i === 1 ? 'subtitle' : 'body', importance: 5 - Math.min(i, 3) })),
        must: ['Keep the text exactly as written'], mustNot: [], imageryStrategy: 'none', imageryRationale: 'Typographic', kurdishLeads: false, riskFlags: [],
        referenceRole: 'none', referenceNotes: '', imageRoles: [], subjectTags: ['field_visit', 'k12', 'report_release'],
      });
    }
    if (schema === 'art_direction_concepts') {
      const c = (id: string, recipe: string) => ({ id, conceptNote: id, recipe, typicality: 0.5, heroPhotoIndex: 0, texturePhotoIndex: null, cutoutPhotoIndex: null,
        slots: [], titleAccentWords: null, fadeShare: null, surfaceTone: 'navy', frame: 'inset', align: 'start' });
      return reply(body, { concepts: [c('fade', 'hero_fade_report'), c('scrim', 'scrim_caption'), c('card', 'hero_card')] });
    }
    if (schema === 'DesignCritiqueReport') return reply(body, { overallAssessment: 'Balanced and legible.', comments: [] });
    if (schema === 'PairwiseDimensionVerdict') {
      const dims = ['hierarchy', 'composition', 'typographic_craft', 'brand_fit', 'legibility'];
      return reply(body, { dimensions: Object.fromEntries(dims.map((d) => [d, { winner: 'A', rationale: 'position' }])), majorityWinner: 'A', summary: 'A' });
    }
    return reply(body, {});
  });
}

async function runTextOnlyRequest(env: Record<string, string | undefined>, options: { website?: boolean } = {}) {
  vi.stubEnv('DESIGN_PIPELINE_V3', 'on');
  vi.stubEnv('HAWA_STUDIO_VISUAL_REVIEW_ROUNDS', '0');
  vi.stubEnv('HAWA_MODEL_JUDGE', 'gpt-4.1-mini');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
  // The legacy shape of a website (customer) request with no photo: no customerWebPhotos manifest, so no
  // webPhotoPolicy reaches its run. Core now sends an empty manifest (customer-web-lifecycle.ts); this
  // keeps the task-origin guard (isWebsiteTask) proven as defence in depth for tasks made before that.
  const customer = options.website ? await customerAccount() : undefined;
  const taskId = (await persistChatIntake(db, {
    platform: customer ? 'hawzhin_web' : 'telegram', sourceEventId: randomUUID(),
    sourceChannelId: customer ? `web:${customer.accountId}` : `olp-${randomUUID().slice(0, 8)}`, clientId,
    title: 'KAAE: field visit report', rawText: `Make a post for the report.\n---\n${COPY}`,
    designInstructions: 'Make a post for the report.', exactCopy: [], designStudio: true,
  }, customer ? { customer: { accountId: customer.accountId, userId: customer.userId, dnaVersion: 1,
    body: { clientId, title: 'KAAE: field visit report', exactCopy: [{ text: COPY, language: 'en' }], designInstructions: 'Make a post for the report.', variant: 'portrait' } as never } } : {})).task.id as string;
  // The retained website brief the customer generation lock checks (customer-requests.test.ts covers the lifecycle).
  if (customer) {
    const requestId = randomUUID();
    await sql`INSERT INTO hawa.customer_web_requests(request_id,tenant_id,account_id,client_id,subject,action_key,body_hash,body,dna_version)
      VALUES(${requestId}::uuid,${tenantId}::uuid,${customer.accountId}::uuid,${clientId}::uuid,${customer.subject}::uuid,${randomUUID()},${'0'.repeat(64)},'{}'::jsonb,1)`.execute(owner);
    await sql`INSERT INTO hawa.requests(request_id,tenant_id,root_task_id,current_task_id,parent_request_id,owner,stage,rev,chat_id)
      VALUES(${requestId}::uuid,${tenantId}::uuid,${taskId}::uuid,${taskId}::uuid,NULL,'restate','designing',1,${`web:${customer.accountId}`})`.execute(owner);
    await sql`UPDATE hawa.tasks SET request_id = ${requestId}::uuid WHERE id = ${taskId}::uuid`.execute(owner);
  }
  const calls: Array<{ schema: string; images: number }> = [];
  const canva = { importEditableDesign: vi.fn().mockResolvedValue({ operationId: randomUUID(), status: 'submitted', designId: `DAF${randomUUID().slice(0, 6)}` }) } as unknown as CanvaConnectService;
  const service = new DesignStudioService(db, canva, { apiKey: 'test-key', fetcher: fakeProvider(calls) as any, defaultTier: 'standard' });
  const { run } = await service.createOrGetRun(studioScope, taskId, `key-${randomUUID().slice(0, 16)}`, { width: 1080, height: 1350, tier: 'standard' });
  let result: any = { status: run.status };
  for (let i = 0; i < 20 && !['transferred', 'failed', 'degraded'].includes(result.status); i++) result = await service.resume(studioScope, taskId, run.id);
  const final = (await sql<any>`SELECT status, diagnostic, stages FROM hawa.design_studio_runs WHERE id=${run.id}::uuid`.execute(owner)).rows[0];
  const winner = (await sql<any>`SELECT layouts, preview_png FROM hawa.design_studio_candidates WHERE run_id = ${run.id}::uuid AND status = 'winner'`.execute(owner)).rows[0];
  const layouts = winner ? (typeof winner.layouts === 'string' ? JSON.parse(winner.layouts) : winner.layouts) : [];
  const stages = typeof final.stages === 'string' ? JSON.parse(final.stages) : final.stages;
  return { final, stages, shipped: layouts.at(-1), calls, canva, preview: winner?.preview_png as Buffer | null | undefined };
}

describe('a text-only KAAE request and the office photo library (ADR-280)', () => {
  it('flag on: designed with the library photo through a photo recipe, its provenance recorded, hard QA passed, the copy unchanged', async () => {
    const { final, stages, shipped, calls, preview } = await runTextOnlyRequest({ HAWA_OFFICE_PHOTO_LIBRARY: 'on', HAWA_OFFICE_PHOTO_LIBRARY_DIR: libraryRoot });
    expect({ status: final.status, diagnostic: final.diagnostic }, final.diagnostic).toEqual({ status: 'transferred', diagnostic: final.diagnostic });
    expect(stages.officePhotoLibrary).toMatchObject({ provenance: 'office_library', status: 'attached', clientId, stage: 'conceiving',
      photoSelection: { mode: 'choose', minimum: 1 } });
    expect(stages.officePhotoLibrary.photos.map((p: any) => p.sha256)).toEqual([sha(visit)]);
    expect(stages.officePhotoLibrary.photos[0].reasons.join(' ')).toMatch(/field visit/);
    // The requester sent none: the brief still says so, and the note does not call the photo theirs.
    expect(stages.brief.photosSent).toBe(0);
    // The brief contract pins the library photo as one of the run's assets.
    expect(JSON.stringify(stages.briefContract)).toContain(sha(visit));
    expect(calls.map((c) => c.schema)).toContain('art_direction_concepts');
    expect(shipped.artDirection?.recipe).toMatch(/^(hero_fade_report|scrim_caption|hero_card)$/);
    expect(shipped.photos.map((p: any) => p.photoIndex)).toEqual([0]);
    expect(stages.qa).toMatchObject({ passed: true, defectCodes: [] });
    // Every copy block set, as given: the photo adds no words.
    expect(shipped.text.map((t: any) => t.copyIndex).sort()).toEqual([0, 1, 2]);
    if (process.env.HAWA_PROOF_DIR && preview) {
      mkdirSync(process.env.HAWA_PROOF_DIR, { recursive: true });
      writeFileSync(path.join(process.env.HAWA_PROOF_DIR, 'office_library_studio_run.png'), preview);
      writeFileSync(path.join(process.env.HAWA_PROOF_DIR, 'office_library_studio_run.json'), `${JSON.stringify({ officePhotoLibrary: stages.officePhotoLibrary, recipe: shipped.artDirection?.recipe, qa: { passed: stages.qa.passed, defectCodes: stages.qa.defectCodes }, calls }, null, 2)}\n`);
    }
  }, 180_000);

  it('flag on: a website request that sent no photo is never given the office archive (hunt-3)', async () => {
    const { final, stages, shipped } = await runTextOnlyRequest({ HAWA_OFFICE_PHOTO_LIBRARY: 'on', HAWA_OFFICE_PHOTO_LIBRARY_DIR: libraryRoot }, { website: true });
    // The run reached the layout stage, where the hook acts (the fake provider writes no customer
    // typographic layout, so it stops there); the archive was never attached or recorded.
    expect(stages.brief).toBeDefined();
    expect(final.status === 'transferred' || /stage laying_out/.test(String(final.diagnostic))).toBe(true);
    expect(stages.officePhotoLibrary).toBeUndefined();
    expect(shipped?.photos ?? []).toEqual([]);
  }, 180_000);

  it('flag off with the library on disk: the same calls, stage keys and photo-less design as a run with no library at all', async () => {
    const without = await runTextOnlyRequest({ HAWA_OFFICE_PHOTO_LIBRARY: undefined, HAWA_OFFICE_PHOTO_LIBRARY_DIR: mkdtempSync(path.join(tmpdir(), 'olp-none-')) });
    const off = await runTextOnlyRequest({ HAWA_OFFICE_PHOTO_LIBRARY: 'off', HAWA_OFFICE_PHOTO_LIBRARY_DIR: libraryRoot });
    expect(off.final.status).toBe(without.final.status);
    expect(off.stages.officePhotoLibrary).toBeUndefined();
    expect(Object.keys(off.stages).sort()).toEqual(Object.keys(without.stages).sort());
    expect(off.calls).toEqual(without.calls);
    expect(off.shipped?.photos ?? []).toEqual([]);
    const strip = (l: any) => JSON.stringify(l, (k, v) => (['id', 'candidateId', 'runId', 'createdAt', 'sha256', 'previewSha256'].includes(k) ? undefined : v));
    expect(strip(off.shipped)).toBe(strip(without.shipped));
  }, 240_000);
});
