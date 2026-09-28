import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql, withRlsContext, DesignStudioRepository, StudioVisualInputsError } from '@hawa/db';
import { renderMotifPng, negativeSpacePolicyIdentity } from '@hawa/creative';
import { BRIEF_CONTRACT_VERSION, buildBriefContract, renderBriefContractForPrompt } from '@hawa/domain';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { PhotoCutouts } from '../src/services/design-studio/photo-cutouts.js';
import { resolveClientDesignReference } from '../src/services/client-design-reference.js';
import { layoutBriefV3 } from '../src/services/design-studio/stages/layouts.stage.js';
import type { CreativeBrief, StageContext } from '../src/services/design-studio/types.js';

/**
 * ADR-125. The executable brief contract is built from the run's own authorities before the paid
 * layout call, recorded on the run with the policy versions it was built under, and a conflict no
 * layout can satisfy stops the run with an explanation instead of reaching the provider.
 */
const boundary = vi.hoisted(() => ({ layout: vi.fn() }));
vi.mock('../src/services/design-studio/stages/index.js', async original => ({
  ...await original<typeof import('../src/services/design-studio/stages/index.js')>(), runLayoutsStage: boundary.layout,
}));
const url = process.env.HAWA_ISOLATED_TEST_DB;
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
const UNBROKEN = 'W'.repeat(150);

describe.skipIf(!url)('Studio records one executable brief contract before layout', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair'), runs = new DesignStudioRepository(db);
  const scope = { tenantId: '00000000-0000-4000-a000-000000000001', actorId: '', role: 'operator' as const };
  const clientId = 'c1000000-0000-4000-8000-000000000002';
  let taskId: string, runId: string, photo: Buffer;

  async function createRun(copyBlocks: Array<{ text: string; script: 'latin' | 'arabic' }>) {
    const { reference, logo } = await resolveClientDesignReference(db, scope, clientId);
    const request = { clientId, width: 1080, height: 1350, instructions: 'Use the supplied wording exactly', copyBlocks,
      referenceHash: hash(JSON.stringify(reference)), logoSha256: hash(logo), pipelineV3: true };
    await runs.createRun({ id: runId, taskId, tenantId: scope.tenantId, clientId, actorId: scope.actorId, requestKey: runId,
      requestHash: hash(JSON.stringify(request)), request, tier: 'standard' });
    await runs.updateRunStatus(runId, scope.tenantId, 'laying_out', { stages: { cutoutsWanted: false, concepts: [], brief: {
      occasion: 'Workshop', audience: 'Staff', formality: 3, toneWords: ['calm', 'clear', 'formal'], readingOrder: [...copyBlocks.keys()].reverse(),
      roles: copyBlocks.map((_, copyIndex) => ({ copyIndex, role: copyIndex === 0 ? 'title' : 'body', importance: copyIndex === 0 ? 5 : 3 })),
      must: ['Keep the title first'], mustNot: [], imageryStrategy: 'none', imageryRationale: 'Typography only', kurdishLeads: false,
      riskFlags: [], requestedBackground: '', referenceSeen: true, imageRoles: [{ index: 0, role: 'content_photo', notes: 'Speaker' }] } } });
  }

  beforeEach(async () => {
    vi.stubEnv('DESIGN_PIPELINE_V3', 'on');
    scope.actorId = randomUUID(); taskId = randomUUID(); runId = randomUUID(); boundary.layout.mockReset();
    photo = renderMotifPng('gradient-wash', { width: 16, height: 16, palette: ['#1E3A5F'], seed: parseInt(taskId.slice(0, 8), 16) });
    boundary.layout.mockImplementation(async () => { throw new StudioVisualInputsError('Synthetic pause at the layout provider boundary'); });
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${scope.actorId}::uuid,${scope.actorId + '@example.test'},'Contract operator')`.execute(db);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${scope.tenantId}::uuid,${scope.actorId}::uuid,'operator')`.execute(db);
    await withRlsContext(db, { tenantId: scope.tenantId, userId: scope.actorId }, async tx => {
      await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${scope.tenantId}::uuid,'visual-kaae','Synthetic KAAE') ON CONFLICT(id) DO NOTHING`.execute(tx);
      await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${taskId}::uuid,${scope.tenantId}::uuid,${clientId}::uuid,'Contract task')`.execute(tx);
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  afterAll(() => db.destroy());

  function service(connection = db) {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('No paid transport'); });
    const svc = new DesignStudioService(connection, undefined, { fetcher, apiKey: 'synthetic-key' });
    const local = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true, orientation: 1, height: 16, focus: { x: .4, y: .2 }, faces: [{ height: 6 }] })));
    Object.assign(svc, { imagesForRun: vi.fn(async () => [dataUrl(photo)]), attachedImage: vi.fn(async () => undefined),
      cutouts: new PhotoCutouts({ url: 'http://synthetic-cutout', fetcher: local }) });
    return { svc, fetcher };
  }
  const storedStages = async () => {
    const run = await runs.getRunById(runId, scope.tenantId);
    return { run, stages: (typeof run?.stages === 'string' ? JSON.parse(run.stages) : run?.stages) as Record<string, any> };
  };

  it('retains the contract and its policy versions before the layout boundary, through a runtime-role connection', async () => {
    await createRun([{ text: 'Exact workshop title', script: 'latin' }, { text: 'ڕێکەوتی ١٢ی تشرین', script: 'arabic' }]);
    const runtimeUrl = new URL(url!); runtimeUrl.searchParams.set('options', '-c role=hawa_app');
    const peer = createDb(runtimeUrl.toString());
    try {
      const f = service(peer);
      await expect(f.svc.resume(scope, taskId, runId)).rejects.toMatchObject({ code: 'STUDIO_VISUAL_INPUTS_UNSAFE' });
      expect(boundary.layout).toHaveBeenCalledTimes(1); expect(f.fetcher).not.toHaveBeenCalled();
      const ctx = boundary.layout.mock.calls[0][0] as StageContext & { briefContract?: ReturnType<typeof buildBriefContract> };
      const { stages } = await storedStages();
      expect(stages.briefContract).toEqual(ctx.briefContract);
      expect(stages.briefContract).toMatchObject({ version: BRIEF_CONTRACT_VERSION, policies: [negativeSpacePolicyIdentity()] });
      expect(stages.briefContract.items.find((i: { id: string }) => i.id === 'content/text-copy-1')).toMatchObject({ authority: 'source_copy', value: { sha256: hash('ڕێکەوتی ١٢ی تشرین') } });
      expect(stages.briefContract.items.find((i: { id: string }) => i.id === 'content/photo-0')).toMatchObject({ value: { sha256: hash(photo) } });
      expect(stages.briefContract.conflicts.map((c: { code: string }) => c.code)).toEqual(['READING_ORDER_PROPOSAL_NOT_ADOPTED', 'IMAGERY_NONE_WITH_CLIENT_PHOTOS']);
      expect(layoutBriefV3(stages.brief as CreativeBrief, ctx)).toContain(renderBriefContractForPrompt(stages.briefContract));
    } finally { await peer.destroy(); }
  });

  it('stops with an explanation and authorized choices before any layout call when no layout can set the copy', async () => {
    await createRun([{ text: 'Exact workshop title', script: 'latin' }, { text: UNBROKEN, script: 'latin' }]);
    const f = service();
    const result = await f.svc.resume(scope, taskId, runId);
    expect(result).toMatchObject({ status: 'failed', stage: 'brief_contract', code: 'BRIEF_CONTRACT_CONFLICT' });
    expect(result.diagnostic).toMatch(/^BRIEF_CONTRACT_CONFLICT: text-copy-1/);
    expect(result.diagnostic).toContain('CLIENT_APPROVES_REVISED_COPY or CHOOSE_WIDER_APPROVED_FORMAT');
    expect(boundary.layout).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
    const { run, stages } = await storedStages();
    expect(run?.status).toBe('failed'); expect(run?.diagnostic).toBe(result.diagnostic);
    expect(stages.briefContract.conflicts.filter((c: { blocking: boolean }) => c.blocking)).toEqual([expect.objectContaining({
      code: 'COPY_UNBREAKABLE_AT_MINIMUM_SIZE', subject: ['text-copy-1'], authorizedChoices: ['CLIENT_APPROVES_REVISED_COPY', 'CHOOSE_WIDER_APPROVED_FORMAT'] })]);
    // The approved copy was not shortened or rewritten on the way to the stop.
    expect(JSON.stringify(run?.request)).toContain(UNBROKEN);
  });

  it('reuses an intact recorded contract and holds a changed one before the provider', async () => {
    await createRun([{ text: 'Exact workshop title', script: 'latin' }]);
    await expect(service().svc.resume(scope, taskId, runId)).rejects.toMatchObject({ code: 'STUDIO_VISUAL_INPUTS_UNSAFE' });
    const first = (await storedStages()).stages.briefContract;
    await expect(service().svc.resume(scope, taskId, runId)).rejects.toMatchObject({ code: 'STUDIO_VISUAL_INPUTS_UNSAFE' });
    expect(boundary.layout).toHaveBeenCalledTimes(2);
    expect((await storedStages()).stages.briefContract).toEqual(first);

    const { stages } = await storedStages();
    stages.briefContract = { ...first, policies: [{ ...first.policies[0], version: '2026-01-01.0' }] };
    await runs.updateRunStatus(runId, scope.tenantId, 'laying_out', { stages });
    const f = service();
    await expect(f.svc.resume(scope, taskId, runId)).rejects.toMatchObject({ code: 'BRIEF_CONTRACT_CHANGED' });
    expect(boundary.layout).toHaveBeenCalledTimes(2); expect(f.fetcher).not.toHaveBeenCalled();
    expect((await storedStages()).run?.status).toBe('laying_out');
  });
});
