import { afterAll, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createDb, DesignStudioRepository, sql, withRlsContext } from '@hawa/db';
import { PNG, type RawArtDirectionConcept } from '@hawa/creative';
import { photoFactsFor } from '../src/services/design-studio/art-direction.js';
import { hardQaContextFor, runLayoutsStage, runQAStage } from '../src/services/design-studio/stages/index.js';
import { studioStatusNote } from '../src/services/design-studio/studio-status-note.js';
import type { CreativeBrief, StageContext } from '../src/services/design-studio/types.js';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { createApp } from '../src/app.js';
import { KAAE_TEST_CLIENT_LOGO } from './fixtures/kaae-logo.js';

const db = createDb(process.env.HAWA_ISOLATED_TEST_DB!);
afterAll(() => db.destroy());
const png = (width: number, height: number, red: number) => {
  const p = new PNG({ width, height });
  for (let i = 0; i < p.data.length; i += 4) { p.data[i] = red; p.data[i + 1] = 100; p.data[i + 2] = 150; p.data[i + 3] = 255; }
  return PNG.sync.write(p);
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

it('Core measures retained source pixels in generation and preserves fresh resolution warnings through QA and saved office review', async () => {
  const concepts: RawArtDirectionConcept[] = ['cutout_speaker', 'hero_card', 'editorial_split'].map(recipe => ({
    id: recipe, recipe, conceptNote: 'Original speaker announcement', typicality: .2,
    heroPhotoIndex: 0, texturePhotoIndex: null, cutoutPhotoIndex: recipe === 'cutout_speaker' ? 0 : null,
    supportingPhotoIndices: [], slots: [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'body' }],
    titleAccentWords: null, fadeShare: null, surfaceTone: 'auto', frame: 'none', align: 'start',
  }));
  let calls = 0;
  const client = { createStructuredCompletion: async () => {
    calls++;
    return { data: { concepts }, rawText: '', receipt: { responseId: 'synthetic-cutout-resolution', xRequestId: null,
      model: 'synthetic-model', inputTokens: 100, outputTokens: 50, reasoningTokens: 0,
      cacheCreationTokens: 0, cacheReadTokens: 20, costUsd: .01, latencyMs: 1 } };
  } };
  const tenantId = '00000000-0000-4000-a000-000000000001', actorId = randomUUID(), taskId = randomUUID(), clientId = randomUUID(), runId = randomUUID();
  const photos = [0, 1].map(index => {
    const bytes = png(2400, 2400, 40 + index * 60);
    return { bytes, mimeType: 'image/png' as const, dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
      width: 6000, height: 6000, review: { subjectFit: index === 0 ? 5 : 3, shot: 'portrait' as const, quietArea: 'top' as const } };
  });
  const ctx: StageContext = { runId, tenantId, taskId, clientId, actorId, width: 800, height: 1000, tier: 'standard',
    instructions: 'Choose the best source for this speaker announcement.', copyBlocks: [{ text: 'Original title', script: 'latin' },
      { text: 'Exact date 2026 Office details', script: 'latin' }], referencePack: { palette: ['#0A1628', '#FFFFFF', '#F7B500', '#1A1A1A'] },
    promotedRules: '', latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', logoAspect: 1, logo: KAAE_TEST_CLIENT_LOGO,
    client: client as never, pipelineV3: true, imageryStrategy: 'photographic', photos,
    photoCutouts: [{ png: png(100, 200, 220), width: 1200, height: 2400 }, { png: png(1200, 2400, 160), width: 1200, height: 2400 }] };
  const facts = await photoFactsFor(ctx);
  expect(facts[0]).toMatchObject({ width: 2400, height: 2400, cutoutSize: { width: 1200, height: 2400 }, cutoutPixelSize: { width: 100, height: 200 } });
  expect(hardQaContextFor(ctx).photoSources?.[0]).toEqual({ width: 2400, height: 2400,
    cutout: { width: 100, height: 200, placement: { width: 1200, height: 2400 } } });
  const brief: CreativeBrief = { occasion: 'Speaker announcement', audience: 'Office', formality: 3, toneWords: ['clear', 'precise', 'calm'],
    readingOrder: [0, 1], roles: [{ copyIndex: 0, role: 'title', importance: 5 }, { copyIndex: 1, role: 'body', importance: 3 }],
    must: [], mustNot: [], imageryStrategy: 'photographic', imageryRationale: 'Source speaker portraits', kurdishLeads: false, riskFlags: [] };
  const candidates = await runLayoutsStage(ctx, brief, [], [0, 1, 2].map(ordinal => ({ id: randomUUID(), ordinal })));
  const winner = candidates.find(c => c.currentLayout.artDirection?.recipe === 'cutout_speaker')!;
  expect(winner).toBeDefined();
  expect(winner.currentLayout.photos?.map(p => p.photoIndex)).toEqual([1]);
  expect(winner.currentLayout.artDirection?.heroUpscale).toBe(.25);
  // A later source edit leaves its earlier passing metadata intact. QA must inspect current pixels.
  winner.currentLayout.photos![0].photoIndex = 0;
  const before = structuredClone(winner.currentLayout);
  const qa = await runQAStage(ctx, winner);
  expect(qa.passed).toBe(true);
  expect(qa.findings?.filter(f => f.code === 'HERO_UPSCALED')).toHaveLength(1);
  expect(qa.findings?.find(f => f.code === 'HERO_UPSCALED')?.message).toContain('3.0x');
  expect(winner.currentLayout).toEqual(before);
  expect(calls).toBe(1);

  await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${actorId}::uuid,${actorId + '@example.test'},'Resolution operator')`.execute(db);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${actorId}::uuid,'operator')`.execute(db);
  await withRlsContext(db, { tenantId, userId: actorId }, async tx => {
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${tenantId}::uuid,${'resolution-' + clientId},'Synthetic office')`.execute(tx);
    await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${taskId}::uuid,${tenantId}::uuid,${clientId}::uuid,'Resolution review')`.execute(tx);
  });
  const repo = new DesignStudioRepository(db), request = { clientId, copyBlocks: ctx.copyBlocks, width: 800, height: 1000 };
  await repo.createRun({ id: runId, tenantId, taskId, clientId, actorId, requestKey: runId, requestHash: hash(JSON.stringify(request)), request, tier: 'standard' });
  await repo.updateRunStatus(runId, tenantId, 'briefing', { expectedStatus: 'briefing', stages: { qa } });
  const saved = await repo.getRunById(runId, tenantId);
  expect(saved?.stages).toMatchObject({ qa: { findings: qa.findings } });
  const svc = new DesignStudioService(db, undefined, { apiKey: 'synthetic-key', fetcher: async () => { throw new Error('No provider call authorized'); } });
  const app = createApp({ db, designStudioService: svc, testAuth: { principal: { role: 'operator', userId: actorId } } });
  const response = await app.request(`/v1/tasks/${taskId}/canva/studio/${runId}`, { headers: { Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}` } });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.run.stages.qa.findings).toEqual(qa.findings);
  expect(studioStatusNote({ run: { ...saved, stages: body.run.stages }, candidates: [] })).toContain('3.0x its current source pixels');
  expect(calls).toBe(1);
});
