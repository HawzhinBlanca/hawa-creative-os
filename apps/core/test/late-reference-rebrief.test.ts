import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NEUTRAL_STYLE_SPEC } from '@hawa/creative';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';

/**
 * The owner sends the request text and the reference photo as two Telegram messages. The brief runs
 * before a photo sent as its own message arrives, so the photo reaches a brief written without it:
 * referenceSeen false and a neutral styleSpec, which left the design following the reference
 * through prose notes alone ("doesn't look like the reference"). The run now re-reads the brief
 * with the image, once, while the layouts can still change.
 */
const scope = { tenantId: '00000000-0000-4000-a000-000000000001', actorId: '00000000-0000-4000-b000-000000000001' };
const photo = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==';

/** What the brief reads off the reference: the values preparation enforces on every candidate. */
const REFERENCE_SPEC = {
  ...NEUTRAL_STYLE_SPEC,
  titleScale: 'dominant',
  titleWeight: 'heavy',
  typeface: 'sans',
  alignment: 'center',
  accentLastTitleLine: true,
  cta: 'gold_button',
  logoCorner: 'bottom-right',
};

const briefReply = (extra: Record<string, unknown>) => ({
  data: {
    occasion: 'Standards launch',
    audience: 'Officials',
    formality: 5,
    toneWords: ['Formal', 'National', 'Clear'],
    readingOrder: [0],
    roles: [{ copyIndex: 0, role: 'title', importance: 5 }],
    must: [],
    mustNot: [],
    imageryStrategy: 'none',
    imageryRationale: '',
    kurdishLeads: false,
    riskFlags: [],
    requestedBackground: '',
    referenceRole: 'none',
    referenceNotes: '',
    styleSpec: { ...NEUTRAL_STYLE_SPEC },
    ...extra,
  },
  receipt: { id: `resp_${randomUUID().slice(0, 8)}`, inputTokens: 10, outputTokens: 10, model: 'test-model' },
});

/** The brief the run stored before the photo arrived. */
const blindBrief = { ...briefReply({}).data, referenceSeen: false };

const harness = (over: { status?: string; stages?: Record<string, unknown>; attachedImage?: string } = {}) => {
  const run: any = {
    id: randomUUID(),
    tenant_id: scope.tenantId,
    task_id: randomUUID(),
    client_id: 'c1000000-0000-4000-8000-000000000002',
    actor_id: scope.actorId,
    request_key: `k-${randomUUID().slice(0, 8)}`,
    status: over.status || 'conceiving',
    stages: JSON.stringify(over.stages ?? { brief: blindBrief }),
    budget: { maxUsd: 5, maxCalls: 20, spentUsd: 0, calls: 0 },
    request: { width: 1080, height: 1350, pipelineV3: true, instructions: 'Announce the standards launch', copyBlocks: [{ text: 'Standards Framework 2.0', script: 'latin' }] },
  };

  const writes: Array<{ status: string; stages?: any; diagnostic?: string | null }> = [];
  const repo = {
    getCallsForRun: async () => [],
    getRunById: async () => run,
    updateRunStatus: async (_id: string, _tenant: string, status: string, extra: any = {}) => {
      writes.push({ status, stages: extra.stages, diagnostic: extra.diagnostic });
      run.status = status;
      if (extra.stages) run.stages = JSON.stringify(extra.stages);
      return run;
    },
    insertCandidate: async () => ({}),
    updateCandidate: async () => ({}),
    getCandidatesForRun: async () => [],
  };

  const completeJson = vi.fn(async () =>
    briefReply({
      referenceRole: 'style_reference',
      referenceNotes: 'gold rule under the title, logo bottom right',
      styleSpec: REFERENCE_SPEC,
    })
  );

  const contexts: any[] = [];
  const service = new DesignStudioService({} as any, undefined, { apiKey: 'test-key' });
  (service as any).repo = repo;
  (service as any).attachedImage = async () => ('attachedImage' in over ? over.attachedImage : photo);
  // The real context carries the stored brief's styleSpec (design-studio-service createStageContext),
  // which is the neutral one until the brief is re-read.
  (service as any).createStageContext = (_s: any, r: any) => {
    const stored = typeof r.stages === 'string' ? JSON.parse(r.stages) : r.stages;
    const ctx = {
      runId: r.id,
      tenantId: scope.tenantId,
      taskId: r.task_id,
      clientId: r.client_id,
      actorId: scope.actorId,
      width: 1080,
      height: 1350,
      tier: 'standard',
      instructions: r.request.instructions,
      copyBlocks: r.request.copyBlocks,
      referencePack: { palette: ['#0A1628', '#1E3A5F', '#F7B500', '#FFFFFF'] },
      promotedRules: 'None',
      latinFont: 'Verdana',
      arabicFont: 'Noto Sans Arabic',
      client: { completeJson },
      pipelineV3: true,
      style: stored.brief?.styleSpec,
    };
    contexts.push(ctx);
    return ctx;
  };

  return { service, run, repo, writes, completeJson, contexts };
};

const lastStoredBrief = (writes: Array<{ stages?: any }>) =>
  [...writes].reverse().find((w) => w.stages?.brief)?.stages.brief;

describe('a reference photo that joins the request after the brief', () => {
  it('re-reads the brief once, with the image, and the style values reach the stage context', async () => {
    const { service, run, writes, completeJson, contexts } = harness();

    const result = await service.resume(scope, run.task_id, run.id);

    expect(completeJson).toHaveBeenCalledTimes(1);
    const params = (completeJson.mock.calls[0] as any)[0];
    expect(params.images).toEqual([{ mediaType: 'image/jpeg', data: photo.split('base64,')[1] }]);
    expect(params.prompt).toContain('separate message moments after the request');

    // The enforced values, on the brief the run stores and on the context this same resume uses.
    const stored = lastStoredBrief(writes);
    expect(stored).toMatchObject({ referenceRole: 'style_reference', referenceSeen: true, referenceRebrief: 'applied' });
    expect(stored.styleSpec).toEqual(REFERENCE_SPEC);
    expect(contexts[0].style).toEqual(REFERENCE_SPEC);
    expect(contexts[0].reference).toEqual({ dataUrl: photo, notes: 'gold rule under the title, logo bottom right' });

    // The marker is stored under the run's own status, before the stage that follows it advances.
    expect(writes[0].status).toBe('conceiving');
    expect(result.status).toBe('laying_out');
  });

  it('does not call the model again when the same stage is resumed after the re-read', async () => {
    const { service, run, writes, completeJson, contexts } = harness();
    await service.resume(scope, run.task_id, run.id);
    expect(completeJson).toHaveBeenCalledTimes(1);

    // A resume that replays the stage it re-read in, as a worker retry does.
    run.status = 'conceiving';
    await service.resume(scope, run.task_id, run.id);

    expect(completeJson).toHaveBeenCalledTimes(1);
    expect(lastStoredBrief(writes).styleSpec).toEqual(REFERENCE_SPEC);
    expect(contexts[1].style).toEqual(REFERENCE_SPEC);
  });

  it('leaves a run whose layouts exist alone, and says so in the diagnostic', async () => {
    const { service, run, writes, completeJson } = harness({
      status: 'rendering',
      stages: { brief: blindBrief, concepts: [], layouts: { count: 3 } },
    });

    await service.resume(scope, run.task_id, run.id);

    expect(completeJson).not.toHaveBeenCalled();
    const noted = writes.find((w) => w.status === 'rendering');
    expect(noted?.diagnostic).toContain('after its layouts were generated');
    expect(noted?.stages.brief).toMatchObject({ referenceRebrief: 'too_late', referenceSeen: false });
    expect(noted?.stages.brief.styleSpec).toEqual(NEUTRAL_STYLE_SPEC);
  });

  it('keeps the neutral spec and claims no reference when no image was ever attached', async () => {
    const { service, run, writes, completeJson, contexts } = harness({ attachedImage: undefined });

    await service.resume(scope, run.task_id, run.id);

    expect(completeJson).not.toHaveBeenCalled();
    expect(contexts[0].reference).toBeUndefined();
    expect(contexts[0].style).toEqual(NEUTRAL_STYLE_SPEC);
    expect(lastStoredBrief(writes)).toMatchObject({ referenceRole: 'none', referenceSeen: false });
    expect(lastStoredBrief(writes).referenceRebrief).toBeUndefined();
  });
});

describe('a picture that joins after the brief classified the others', () => {
  it('re-reads the brief once with every picture, before any layout', async () => {
    const two = [photo, photo.replace('2Q==', '2Q=')];
    const { service, run, writes, completeJson } = harness({
      stages: { brief: { ...blindBrief, referenceSeen: true, imageRoles: [{ index: 0, role: 'content_photo', notes: '' }, { index: 1, role: 'content_photo', notes: '' }] } },
    });
    const three = [...two, photo];
    (service as any).requestImages = async () => three;
    completeJson.mockImplementation(async () =>
      briefReply({
        imageRoles: [
          { index: 0, role: 'content_photo', notes: '' },
          { index: 1, role: 'content_photo', notes: '' },
          { index: 2, role: 'style_reference', notes: 'follow this' },
        ],
      }) as any
    );
    await service.resume(scope, run.task_id, run.id);
    expect(completeJson).toHaveBeenCalledTimes(1);
    expect(((completeJson.mock.calls[0] as any)[0].images || []).length).toBe(3);
    const stored = lastStoredBrief(writes);
    expect(stored).toMatchObject({ imagesRebrief: true, photosSent: 2 });
    expect(stored.imageRoles).toHaveLength(3);

    // Resumed again, it does not re-read a second time.
    run.status = 'conceiving';
    await service.resume(scope, run.task_id, run.id);
    expect(completeJson).toHaveBeenCalledTimes(1);
  });
});
