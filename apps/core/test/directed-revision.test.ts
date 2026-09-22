import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NEUTRAL_STYLE_SPEC, type StudioLayoutV2 } from '@hawa/creative';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { carryOver, changesWithin } from '../src/services/design-studio/stages/edit.stage.js';
import { studioStatusNote } from '../src/services/design-studio/studio-status-note.js';

/**
 * "Move the logo up" in reply to a draft. A revision was a new run from nothing (three new layouts,
 * a critique, a judge), so the client got a different design back, with or without the change.
 * The run now edits the design the client received and changes only what was asked.
 */
const scope = { tenantId: '00000000-0000-4000-a000-000000000001', actorId: '00000000-0000-4000-b000-000000000001' };

const parentLayout: StudioLayoutV2 = {
  version: 2,
  width: 1080,
  height: 1350,
  grid: { margin: 72, columns: 12, gutter: 24, baseline: 8 },
  background: { color: '#0A1628' },
  shapes: [],
  text: [
    { x: 72, y: 180, width: 936, height: 260, copyIndex: 0, role: 'title', fontSize: 96, lineHeight: 1.2, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left', bold: true, accentColor: '#F7B500', accentParagraph: 'first' },
    { x: 72, y: 520, width: 700, height: 60, copyIndex: 1, role: 'date', fontSize: 40, lineHeight: 1.3, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left' },
  ],
  logo: { x: 840, y: 1160, width: 168, height: 118 },
} as any;

const movedLogo = { ...parentLayout, logo: { x: 72, y: 72, width: 168, height: 118 }, text: parentLayout.text.map((t) => ({ ...t, y: t.y + 140, accentColor: undefined, accentParagraph: undefined })) };

const harness = (opts: { parent?: boolean; editReply?: any; targets?: string[] } = {}) => {
  const candidateId = { value: '' };
  const run: any = {
    id: randomUUID(),
    tenant_id: scope.tenantId,
    task_id: randomUUID(),
    client_id: 'c1000000-0000-4000-8000-000000000002',
    actor_id: scope.actorId,
    status: 'conceiving',
    stages: JSON.stringify({ brief: { roles: [{ copyIndex: 0, role: 'title', importance: 5 }, { copyIndex: 1, role: 'date', importance: 3 }], readingOrder: [0, 1], referenceSeen: false, styleSpec: NEUTRAL_STYLE_SPEC } }),
    budget: { maxUsd: 5, maxCalls: 20, spentUsd: 0, calls: 0 },
    request: {
      width: 1080,
      height: 1350,
      pipelineV3: true,
      instructions: 'x',
      copyBlocks: [{ text: 'MEET KAAE AT\nSAGACON 2026', script: 'latin' }, { text: 'September 25, 2026', script: 'latin' }],
      directed: { parentTaskId: randomUUID(), revisionDirective: 'move the logo to the top-left' },
    },
  };
  const writes: any[] = [];
  const inserted: any[] = [];
  const updated: any[] = [];
  const repo = {
    getRunById: async (id: string) =>
      id === 'parent-run'
        ? { id: 'parent-run', stages: JSON.stringify({ brief: { roles: [], readingOrder: [0, 1], imageRoles: [{ index: 0, role: 'content_photo', notes: '' }], styleSpec: { ...NEUTRAL_STYLE_SPEC, titleColor: 'light' } } }) }
        : run,
    updateRunStatus: async (_id: string, _t: string, status: string, extra: any = {}) => {
      writes.push({ status, ...extra });
      run.status = status;
      if (extra.stages) run.stages = JSON.stringify(extra.stages);
      if (extra.winnerCandidateId) run.winner_candidate_id = extra.winnerCandidateId;
      return run;
    },
    insertCandidate: async (c: any) => { inserted.push(c); if (c.ordinal === 0) candidateId.value = c.id; return c; },
    updateCandidate: async (id: string, _t: string, u: any) => { updated.push({ id, ...u }); return u; },
    getCandidatesForRun: async () => [],
    recordCallStart: async () => ({}),
    finalizeCall: async () => ({}),
  };
  const completeJson = vi.fn(async (params: any) =>
    params.schemaName === 'EditTargets'
      ? { data: { targets: opts.targets ?? ['logo'] }, receipt: {} }
      : { data: opts.editReply ?? { layout: movedLogo, changes: [{ element: 'logo', before: 'bottom-right', after: 'logo top-left', why: 'asked' }] }, receipt: {} });
  const service = new DesignStudioService({} as any, undefined, { apiKey: 'test-key' });
  (service as any).repo = repo;
  (service as any).attachedImage = async () => undefined;
  (service as any).parentWinner = async () =>
    opts.parent === false ? undefined : { runId: 'parent-run', candidateId: 'parent-cand', layout: JSON.parse(JSON.stringify(parentLayout)), concept: { id: 'c', archetype: 'split-band' } };
  (service as any).createStageContext = (_s: any, r: any) => ({
    runId: r.id, tenantId: scope.tenantId, taskId: r.task_id, clientId: r.client_id, actorId: scope.actorId,
    width: 1080, height: 1350, tier: 'standard', instructions: 'x', copyBlocks: r.request.copyBlocks,
    referencePack: { palette: ['#0A1628', '#1E3A5F', '#F7B500', '#FFFFFF'] }, promotedRules: 'None',
    latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', logoAspect: 168 / 118, client: { completeJson }, pipelineV3: true,
  });
  return { service, run, writes, inserted, updated, completeJson, candidateId };
};

describe('a revision edits the design the client received', () => {
  it('makes the change to the parent design, keeps the rest, and goes straight to QA as the only candidate', async () => {
    const { service, run, writes, inserted, updated, completeJson, candidateId } = harness();
    const first = await service.resume(scope, run.task_id, run.id);
    expect(first.status).toBe('laying_out');
    expect(inserted).toHaveLength(1);

    const second = await service.resume(scope, run.task_id, run.id);
    expect(second.status).toBe('qa');
    expect(completeJson).toHaveBeenCalledTimes(2);
    const prompt = (completeJson.mock.calls.find((c: any) => c[0].schemaName === 'DirectedEdit') as any)[0].prompt as string;
    expect(prompt).toContain('move the logo to the top-left');
    expect(prompt).toContain('"logo":{"x":840');

    const saved = updated.find((u) => u.id === candidateId.value && u.layouts);
    expect(saved.layouts[0].logo).toMatchObject({ x: 72, y: 72 });
    // The gold first line the design had survives an answer that left it out.
    expect(saved.layouts[0].text[0]).toMatchObject({ accentColor: '#F7B500', accentParagraph: 'first' });
    expect(saved.previewPng?.length).toBeGreaterThan(1000);
    expect(writes.at(-1)).toMatchObject({ status: 'qa', winnerCandidateId: candidateId.value, judgeStatus: 'SKIPPED' });

    const note = studioStatusNote({ run: { stages: JSON.parse(run.stages), winner_candidate_id: candidateId.value }, candidates: [{ id: candidateId.value, layouts: saved.layouts }] });
    expect(note).toContain('your change made to the same design (logo top-left)');
  });

  it('designs the revision afresh when the change cannot be made to the design as it stands', async () => {
    const broken = { ...movedLogo, text: [movedLogo.text[0]] }; // drops a copy block
    const { service, run, inserted } = harness({ editReply: { layout: broken, changes: [] } });
    await service.resume(scope, run.task_id, run.id);
    await service.resume(scope, run.task_id, run.id).catch(() => undefined);
    // Two more candidate slots were opened for the full pipeline.
    expect(inserted.map((c) => c.ordinal).sort()).toEqual([0, 1, 2]);
  });

  it('with no finished parent design, the run conceives three candidates as before', async () => {
    const { service, run, inserted } = harness({ parent: false });
    const res = await service.resume(scope, run.task_id, run.id);
    expect(res.status).toBe('laying_out');
    expect(inserted.length).toBe(3);
  });

  it("settles an edit whose logo lands in the title's clear space instead of redesigning", async () => {
    // Live, 2026-09-23: "move the logo to the top-right" failed validation twice (LOGO clear space)
    // and would have fallen back to a new design.
    const cramped = { ...parentLayout, logo: { x: 900, y: 72, width: 108, height: 76 } };
    const { service, run, updated, candidateId, inserted } = harness({ editReply: { layout: cramped, changes: [] }, targets: ['logo'] });
    await service.resume(scope, run.task_id, run.id);
    const res = await service.resume(scope, run.task_id, run.id);
    expect(res.status).toBe('qa');
    expect(inserted).toHaveLength(1);
    const saved = updated.find((u) => u.id === candidateId.value && u.layouts);
    const logo = saved.layouts[0].logo;
    const title = saved.layouts[0].text[0];
    const clear = Math.ceil(0.5 * logo.height);
    const apart = title.y >= logo.y + logo.height + clear || title.x + title.width <= logo.x - clear;
    expect(apart).toBe(true);
    expect(logo.y).toBeLessThan(200);
  });

  it('blocks the request does not name keep their colours, whatever the edit did to them', async () => {
    // The live edit of 2026-09-23 turned the date gold on "make MEET KAAE AT gold": a house rule.
    const recoloured = { ...movedLogo, text: movedLogo.text.map((t, i) => (i === 1 ? { ...t, color: '#F7B500', accentColor: '#F7B500' } : t)) };
    const { service, run, updated, candidateId } = harness({ editReply: { layout: recoloured, changes: [] }, targets: ['logo', 'text:0'] });
    await service.resume(scope, run.task_id, run.id);
    await service.resume(scope, run.task_id, run.id);
    const saved = updated.find((u) => u.id === candidateId.value && u.layouts);
    expect(saved.layouts[0].text[1].color).toBe('#FFFFFF');
    expect(saved.layouts[0].text[1].accentColor).toBeUndefined();
    expect(saved.layouts[0].logo).toMatchObject({ x: 72, y: 72 });
  });

  it("keeps the parent design's brief instead of briefing the revision afresh", async () => {
    const { service, run, completeJson, writes } = harness();
    run.status = 'briefing';
    const res = await service.resume(scope, run.task_id, run.id);
    expect(res.status).toBe('conceiving');
    expect(completeJson).not.toHaveBeenCalled();
    const brief = writes.at(-1).stages.brief;
    expect(brief).toMatchObject({ briefFromParent: true, imageRoles: [{ index: 0, role: 'content_photo' }] });
    expect(brief.styleSpec.titleColor).toBe('light');
  });

  it("starts from the parent design's pictures, with a new picture after them", async () => {
    const { service, run } = harness();
    const byTask = new Map<string, string[]>([[run.request.directed.parentTaskId, ['a', 'b']], [run.task_id, ['b', 'c']]]);
    (service as any).requestImages = async (_s: any, taskId: string) => byTask.get(taskId) || [];
    expect(await (service as any).imagesForRun(scope, run)).toEqual(['a', 'b', 'c']);
    byTask.set(run.task_id, []);
    expect(await (service as any).imagesForRun(scope, run)).toEqual(['a', 'b']);
  });

  it('reports only the changes the design still shows', () => {
    const changes = [
      { element: 'text[copyIndex=0]', after: 'MEET KAAE AT gold' },
      { element: 'logo', after: 'top-right' },
      { element: 'text[2]', after: 'date gold' },
    ];
    expect(changesWithin(changes, ['text:0', 'logo']).map((c) => c.after)).toEqual(['MEET KAAE AT gold', 'top-right']);
    expect(changesWithin(changes, ['all'])).toHaveLength(3);
  });

  it('carryOver keeps what the edit omitted and what it set', () => {
    const edited = carryOver(parentLayout, JSON.parse(JSON.stringify({ ...movedLogo, text: movedLogo.text.map((t, i) => (i === 1 ? { ...t, color: '#F7B500' } : t)) })));
    expect(edited.text[0]).toMatchObject({ accentColor: '#F7B500', accentParagraph: 'first' });
    expect(edited.text[1].color).toBe('#F7B500');
  });
});
