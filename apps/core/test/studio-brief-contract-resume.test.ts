import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext, DesignStudioRepository, StudioVisualInputsError } from '@hawa/db';
import { NEUTRAL_STYLE_SPEC, type StudioLayoutV2 } from '@hawa/creative';
import { renderBriefContractForPrompt } from '@hawa/domain';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { resolveClientDesignReference } from '../src/services/client-design-reference.js';
import type { StageContext } from '../src/services/design-studio/types.js';

/**
 * ADR-125 resume. A directed revision whose edit fails (not a refusal, not a transport error) is
 * designed afresh. Its brief contract is recorded before the layout call, so an interruption after
 * that point resumes a stage that has already written part of its state. The resumed stage must
 * lay out the same copy under the same authority and make the same model-call sequence, so its
 * retained calls replay instead of holding the run for good.
 *
 * Unreachable in production while ADR-113 holds directed revisions; the fixture bypasses only that
 * admission. PostgreSQL, the model-call ledger, retained results and replay are real.
 */
const boundary = vi.hoisted(() => ({ layout: vi.fn() }));
vi.mock('../src/services/design-studio/stages/index.js', async original => ({
  ...await original<typeof import('../src/services/design-studio/stages/index.js')>(), runLayoutsStage: boundary.layout,
}));
const url = process.env.HAWA_ISOLATED_TEST_DB;
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const REQUEST_COPY = [{ text: 'MEET KAAE AT SAGACON 2026', script: 'latin' as const }, { text: 'September 25, 2026', script: 'latin' as const }];
const PARENT_COPY = [REQUEST_COPY[0], { text: 'October 2, 2026', script: 'latin' as const }];
const parentLayout: StudioLayoutV2 = {
  version: 2, width: 1080, height: 1350, grid: { margin: 72, columns: 12, gutter: 24, baseline: 8 }, background: { color: '#0A1628' }, shapes: [],
  text: [
    { x: 72, y: 180, width: 936, height: 260, copyIndex: 0, role: 'title', fontSize: 96, lineHeight: 1.2, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left', bold: true },
    { x: 72, y: 520, width: 700, height: 60, copyIndex: 1, role: 'date', fontSize: 40, lineHeight: 1.3, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left' },
  ],
  logo: { x: 840, y: 1160, width: 168, height: 118 },
} as StudioLayoutV2;
// Drops a copy block: the edit gate refuses it twice, so the revision is designed afresh.
const droppedBlock = { layout: { ...parentLayout, logo: { x: 72, y: 72, width: 168, height: 118 }, text: [parentLayout.text[0]] }, changes: [] };
const response = (data: unknown) => new Response(JSON.stringify({ id: `synthetic-${randomUUID()}`, model: 'gpt-6-astra',
  usage: { prompt_tokens: 1000, completion_tokens: 200 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] }));
const schemaOf = (init?: RequestInit) => (JSON.parse(String(init?.body ?? '{}')) as { response_format?: { json_schema?: { name?: string } } })
  .response_format?.json_schema?.name ?? 'unknown';

describe.skipIf(!url)('an interrupted afresh-designed revision resumes with the same copy and call sequence', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair'), runs = new DesignStudioRepository(db);
  const scope = { tenantId: '00000000-0000-4000-a000-000000000001', actorId: '', role: 'operator' as const };
  const clientId = 'c1000000-0000-4000-8000-000000000002';
  let taskId: string, runId: string, parentRunId: string, parentTaskId: string;
  const seen: Array<{ copy: string[]; reply: unknown; authority?: string }> = [];

  beforeEach(async () => {
    vi.stubEnv('DESIGN_PIPELINE_V3', 'on');
    vi.stubEnv('HAWA_MODEL_TIER', 'production');
    scope.actorId = randomUUID(); taskId = randomUUID(); runId = randomUUID(); parentRunId = randomUUID(); parentTaskId = randomUUID();
    seen.length = 0; boundary.layout.mockReset();
    // The layout boundary makes one real ledger call (so it is retained), then is interrupted.
    boundary.layout.mockImplementation(async (ctx: StageContext) => {
      const reply = await ctx.client.completeJson<{ ok: boolean }>({ system: 'Synthetic layout boundary', schemaName: 'SyntheticLayouts', schema: { type: 'object' },
        prompt: `${ctx.briefContract ? renderBriefContractForPrompt(ctx.briefContract) : ''}\n${ctx.copyBlocks.map((b) => b.text).join('\n')}` });
      seen.push({ copy: ctx.copyBlocks.map((b) => b.text), reply: reply.data,
        authority: ctx.briefContract?.items.find((i) => i.id === 'content/text-copy-1')?.authority });
      throw new StudioVisualInputsError('Synthetic interruption after the layout call');
    });
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${scope.actorId}::uuid,${scope.actorId + '@example.test'},'Resume operator')`.execute(db);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${scope.tenantId}::uuid,${scope.actorId}::uuid,'operator')`.execute(db);
    await withRlsContext(db, { tenantId: scope.tenantId, userId: scope.actorId }, async tx => {
      await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${scope.tenantId}::uuid,'visual-kaae','Synthetic KAAE') ON CONFLICT(id) DO NOTHING`.execute(tx);
      await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${taskId}::uuid,${scope.tenantId}::uuid,${clientId}::uuid,'Revision task')`.execute(tx);
      await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${parentTaskId}::uuid,${scope.tenantId}::uuid,${clientId}::uuid,'Parent task')`.execute(tx);
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  afterAll(() => db.destroy());

  async function createRevision(parentChangedCopy: boolean) {
    const { reference, logo } = await resolveClientDesignReference(db, scope, clientId);
    const base = { clientId, width: 1080, height: 1350, instructions: 'Move the logo', referenceHash: hash(JSON.stringify(reference)), logoSha256: hash(logo), pipelineV3: true };
    // The design being revised; an earlier round of it changed the date.
    await runs.createRun({ id: parentRunId, taskId: parentTaskId, tenantId: scope.tenantId, clientId, actorId: scope.actorId, requestKey: parentRunId,
      requestHash: hash(parentRunId), request: { ...base, copyBlocks: REQUEST_COPY }, tier: 'standard' });
    await runs.updateRunStatus(parentRunId, scope.tenantId, 'transferred', { stages: parentChangedCopy ? { effectiveCopy: PARENT_COPY } : {} });
    const request = { ...base, copyBlocks: REQUEST_COPY, directed: { parentTaskId, revisionDirective: 'move the logo to the top-left' } };
    await runs.createRun({ id: runId, taskId, tenantId: scope.tenantId, clientId, actorId: scope.actorId, requestKey: runId,
      requestHash: hash(JSON.stringify(request)), request, tier: 'standard', budget: { maxUsd: 5, maxCalls: 20, spentUsd: 0, calls: 0 } });
    const candidateId = randomUUID();
    await runs.insertCandidate({ id: candidateId, runId, tenantId: scope.tenantId, ordinal: 0, concept: { id: 'c', archetype: 'split-band' }, status: 'draft' });
    await runs.updateRunStatus(runId, scope.tenantId, 'laying_out', { stages: {
      brief: { roles: [{ copyIndex: 0, role: 'title', importance: 5 }, { copyIndex: 1, role: 'date', importance: 3 }], readingOrder: [0, 1], referenceSeen: false, styleSpec: NEUTRAL_STYLE_SPEC },
      concepts: [], cutoutsWanted: false,
      directed: { parentRunId, parentCandidateId: randomUUID(), candidateId, directive: 'move the logo to the top-left' },
    } });
  }

  function service(fetcher: typeof fetch) {
    const svc = new DesignStudioService(db, undefined, { fetcher, apiKey: 'synthetic-key' });
    // ADR-113 holds every resume of a run with a directed parent before any stage today
    // (NATIVE_REVISION_HANDOFF_REQUIRED). This stage-level check bypasses that admission, as the
    // directed-edit fixtures do, to exercise the code path the hold keeps closed.
    vi.spyOn(svc as unknown as { assertTaskCanGenerate: () => Promise<void> }, 'assertTaskCanGenerate').mockResolvedValue(undefined);
    Object.assign(svc, { imagesForRun: vi.fn(async () => []), attachedImage: vi.fn(async () => undefined), earlierAsks: vi.fn(async () => []),
      parentWinner: vi.fn(async () => ({ runId: parentRunId, candidateId: 'parent-candidate', layout: structuredClone(parentLayout), concept: { id: 'c', archetype: 'split-band' } })) });
    return svc;
  }
  const storedStages = async () => {
    const run = await runs.getRunById(runId, scope.tenantId);
    return (typeof run?.stages === 'string' ? JSON.parse(run.stages) : run?.stages) as Record<string, any>;
  };

  it.each([true, false])('replays the failed edit and the layout call without a new charge (parent changed the copy: %s)', async (parentChangedCopy) => {
    await createRevision(parentChangedCopy);
    const expectedCopy = (parentChangedCopy ? PARENT_COPY : REQUEST_COPY).map((b) => b.text);
    const paid = vi.fn<typeof fetch>(async (_url, init) => {
      const schema = schemaOf(init);
      if (schema === 'EditTargets') return response({ targets: ['logo'] });
      if (schema === 'DirectedEdit') return response(droppedBlock);
      if (schema === 'SyntheticLayouts') return response({ ok: true, layouts: 3 });
      throw new Error(`Unexpected synthetic call ${schema}`);
    });
    await expect(service(paid).resume(scope, taskId, runId)).rejects.toMatchObject({ code: 'STUDIO_VISUAL_INPUTS_UNSAFE' });
    const firstSchemas = paid.mock.calls.map(([, init]) => schemaOf(init));
    expect(firstSchemas).toEqual(['EditTargets', 'DirectedEdit', 'DirectedEdit', 'SyntheticLayouts']);
    expect.soft(seen[0]).toMatchObject({ copy: expectedCopy, authority: parentChangedCopy ? 'run_effective_copy' : 'source_copy' });

    // What the stage recorded before its layout call: the contract, the copy it lays out, and
    // nothing that would make a resumed stage skip the edit its retained calls begin with.
    const mid = await storedStages();
    expect.soft(mid.directedFailed).toBeUndefined();
    expect.soft(mid.briefContract?.items.find((i: { id: string }) => i.id === 'content/text-copy-1'))
      .toMatchObject({ authority: parentChangedCopy ? 'run_effective_copy' : 'source_copy', value: { sha256: hash(expectedCopy[1]) } });
    if (parentChangedCopy) expect.soft(mid.effectiveCopy).toEqual(PARENT_COPY); else expect.soft(mid.effectiveCopy).toBeUndefined();
    const calls = await runs.getCallsForRun(runId, scope.tenantId);
    expect.soft(calls).toHaveLength(4);
    expect.soft(calls.every((c) => c.stage === 'laying_out' && c.status === 'ok' && c.has_retained_result)).toBe(true);

    // A second process with no transport resumes: every call replays, the copy and contract hold.
    const noTransport = vi.fn<typeof fetch>(async () => { throw new Error('No second transport is authorized'); });
    const outcome = await service(noTransport).resume(scope, taskId, runId).then((r) => ({ result: r }), (e: { code?: string; message?: string }) => ({ code: e.code, message: e.message }));
    // Recorded so a red run shows how the resume ended (before the fix: BRIEF_CONTRACT_CHANGED or MODEL_STAGE_REPLAY_UNSAFE).
    console.info(`[resume parentChangedCopy=${parentChangedCopy}] ${JSON.stringify({ ...('result' in outcome ? { status: outcome.result.status, diagnostic: outcome.result.diagnostic } : { code: outcome.code }), layoutCalls: seen.length, transport: noTransport.mock.calls.length })}`);
    expect(outcome).toMatchObject({ code: 'STUDIO_VISUAL_INPUTS_UNSAFE' });
    expect(noTransport).not.toHaveBeenCalled();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(seen[0]);
    expect((await storedStages()).briefContract).toEqual(mid.briefContract);
    expect(await runs.getCallsForRun(runId, scope.tenantId)).toHaveLength(4);
    // The afresh slots are reserved once, however often the stage resumes.
    expect((await runs.getCandidatesForRun(runId, scope.tenantId)).map((c) => c.ordinal).sort()).toEqual([0, 1, 2]);
    expect((await runs.getRunById(runId, scope.tenantId))?.status).toBe('laying_out');
  });
});
