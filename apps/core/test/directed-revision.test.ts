import { KAAE_TEST_CLIENT_LOGO } from './fixtures/kaae-logo.js';
import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NEUTRAL_STYLE_SPEC, evaluateHardQa, OpenAiModelTimeoutError, OpenAiModelHttpError, type StudioLayoutV2 } from '@hawa/creative';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { carryOver, changesWithin, changesShown, dropUnreadableAccents, isModelTransportError } from '../src/services/design-studio/stages/edit.stage.js';
import { hardQaContextFor } from '../src/services/design-studio/stages/v3.stage.js';
import { studioStatusNote } from '../src/services/design-studio/studio-status-note.js';
import { StudioBudgetExhaustedError } from '../src/services/design-studio/types.js';

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

const harness = (
  opts: {
    parent?: boolean;
    /** The parent task still has a studio run in progress. */
    parentRunning?: boolean;
    parentLayout?: StudioLayoutV2;
    editReply?: any;
    /** One reply per DirectedEdit call, the last repeated. */
    editReplies?: any[];
    /** An error a call throws instead of answering, by schema name. */
    callError?: (schemaName: string) => Error | undefined;
    targets?: string[];
  } = {}
) => {
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
  const replies = [...(opts.editReplies ?? [])];
  const completeJson = vi.fn(async (params: any) => {
    const failure = opts.callError?.(params.schemaName);
    if (failure) throw failure;
    if (params.schemaName === 'EditTargets') return { data: { targets: opts.targets ?? ['logo'] }, receipt: {} };
    const reply = replies.length > 1 ? replies.shift() : replies[0];
    // A fresh copy each call: the stage edits the answer it is given in place.
    return { data: JSON.parse(JSON.stringify(reply ?? opts.editReply ?? { layout: movedLogo, changes: [{ element: 'logo', before: 'bottom-right', after: 'logo top-left', why: 'asked' }] })), receipt: {} };
  });
  const service = new DesignStudioService({} as any, undefined, { apiKey: 'test-key' });
  (service as any).repo = repo;
  (service as any).attachedImage = async () => undefined;
  (service as any).activeRunsOfTask = async () => (opts.parentRunning ? 1 : 0);
  (service as any).parentWinner = async () =>
    opts.parent === false ? undefined : { runId: 'parent-run', candidateId: 'parent-cand', layout: JSON.parse(JSON.stringify(opts.parentLayout ?? parentLayout)), concept: { id: 'c', archetype: 'split-band' } };
  (service as any).createStageContext = (_s: any, r: any) => ({
    runId: r.id, tenantId: scope.tenantId, taskId: r.task_id, clientId: r.client_id, actorId: scope.actorId,
    width: 1080, height: 1350, tier: 'standard', instructions: 'x', copyBlocks: r.request.copyBlocks,
    referencePack: { palette: ['#0A1628', '#1E3A5F', '#F7B500', '#FFFFFF'] }, promotedRules: 'None',
    latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', logoAspect: 168 / 118, client: { completeJson }, logo: KAAE_TEST_CLIENT_LOGO, pipelineV3: true,
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

/** A gold divider between the title and the date, as the brand's designs carry them. */
const withDivider: StudioLayoutV2 = {
  ...parentLayout,
  shapes: [{ kind: 'line', role: 'rule', x: 72, y: 478, width: 240, height: 4, color: '#F7B500' }],
} as StudioLayoutV2;
const shifted = (layout: StudioLayoutV2, dy: number, opts: { shapes?: boolean } = {}) => ({
  ...layout,
  logo: { x: 72, y: 72, width: 168, height: 118 },
  text: layout.text.map((t) => ({ ...t, y: t.y + dy })),
  shapes: opts.shapes ? layout.shapes.map((s) => ({ ...s, y: s.y + dy })) : layout.shapes,
});
/** Navy type on white, where the brand's gold is not readable as text. */
const onWhite: StudioLayoutV2 = {
  ...parentLayout,
  background: { color: '#FFFFFF' },
  text: parentLayout.text.map((t) => ({ ...t, color: '#0A1628', accentColor: undefined, accentParagraph: undefined })),
} as StudioLayoutV2;
const qaContext = hardQaContextFor({
  width: 1080, height: 1350, latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', logoAspect: 168 / 118,
  referencePack: { palette: ['#0A1628', '#1E3A5F', '#F7B500', '#FFFFFF'] },
  copyBlocks: [{ text: 'MEET KAAE AT\nSAGACON 2026', script: 'latin' }, { text: 'September 25, 2026', script: 'latin' }],
} as any);
const editPrompts = (completeJson: ReturnType<typeof vi.fn>) =>
  completeJson.mock.calls.filter((c: any) => c[0].schemaName === 'DirectedEdit').map((c: any) => c[0].prompt as string);

describe('a revision reaches QA only as a design QA passes (2026-09-23)', () => {
  it('an edit that puts the text on a divider is refused with the reason, and the corrected edit goes on', async () => {
    // "Move the logo to the top-left": the text moved down, the divider stayed, and the normaliser
    // quietly deleted the divider the text now covered.
    const { service, run, updated, candidateId, inserted, completeJson } = harness({
      parentLayout: withDivider,
      editReplies: [
        { layout: shifted(withDivider, 140), changes: [{ element: 'logo', before: 'bottom-right', after: 'logo top-left', why: 'asked' }] },
        { layout: shifted(withDivider, 140, { shapes: true }), changes: [{ element: 'logo', before: 'bottom-right', after: 'logo top-left', why: 'asked' }] },
      ],
    });
    await service.resume(scope, run.task_id, run.id);
    const res = await service.resume(scope, run.task_id, run.id);
    expect(res.status).toBe('qa');
    expect(inserted).toHaveLength(1);
    const prompts = editPrompts(completeJson);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/refused: OVERLAP: Shape role 'rule' intersects text box/);
    const saved = updated.find((u) => u.id === candidateId.value && u.layouts);
    // The divider is still there, moved with the text, and the design passes the gate QA applies.
    expect(saved.layouts[0].shapes).toEqual([expect.objectContaining({ role: 'rule', y: 618 })]);
    expect(evaluateHardQa(saved.layouts[0], qaContext, saved.metrics)).toMatchObject({ passed: true });
  });

  it('an edit that passes validation and fails hard QA is settled before it is returned', async () => {
    // The date's box cut to 40px: its line needs 52px, which only hard QA measures (COPY_OVERFLOW).
    const cut = { ...movedLogo, text: movedLogo.text.map((t, i) => (i === 1 ? { ...t, height: 40 } : t)) };
    expect(evaluateHardQa(carryOver(parentLayout, JSON.parse(JSON.stringify(cut))), qaContext).defectCodes).toContain('COPY_OVERFLOW');
    const { service, run, updated, candidateId, completeJson } = harness({ editReply: { layout: cut, changes: [] } });
    await service.resume(scope, run.task_id, run.id);
    const res = await service.resume(scope, run.task_id, run.id);
    expect(res.status).toBe('qa');
    expect(editPrompts(completeJson)).toHaveLength(1);
    const saved = updated.find((u) => u.id === candidateId.value && u.layouts);
    expect(saved.layouts[0].text[1].height).toBeGreaterThanOrEqual(52);
    expect(evaluateHardQa(saved.layouts[0], qaContext, saved.metrics)).toMatchObject({ passed: true });
  });

  it('an edit hard QA refuses even settled is asked for again with the defect, then designed afresh', async () => {
    // The date set above the title: the client's copy order, which settling does not change.
    const reordered = { ...parentLayout, text: [{ ...parentLayout.text[0], y: 400 }, { ...parentLayout.text[1], y: 200 }] };
    const { service, run, inserted, completeJson } = harness({ editReply: { layout: reordered, changes: [] } });
    await service.resume(scope, run.task_id, run.id);
    await service.resume(scope, run.task_id, run.id);
    const prompts = editPrompts(completeJson);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/refused: hard QA refused it: COPY_ORDER/);
    expect(inserted.map((c) => c.ordinal).sort()).toEqual([0, 1, 2]);
  });
});

describe("the sender's note says what the design shows", () => {
  it('a requested gold that would not be readable is reported as not made, not as made', async () => {
    const gold = {
      ...onWhite,
      text: onWhite.text.map((t, i) => (i === 1 ? { ...t, accentColor: '#F7B500', accentText: 'September 25, 2026' } : t)),
    };
    const { service, run, updated, candidateId } = harness({
      parentLayout: onWhite,
      targets: ['text:1'],
      editReply: { layout: gold, changes: [{ element: 'text[1]', before: 'navy', after: 'the date in gold', why: 'asked' }] },
    });
    run.request.directed.revisionDirective = 'make the date gold';
    await service.resume(scope, run.task_id, run.id);
    const res = await service.resume(scope, run.task_id, run.id);
    expect(res.status).toBe('qa');
    const saved = updated.find((u) => u.id === candidateId.value && u.layouts);
    expect(saved.layouts[0].text[1].accentColor).toBeUndefined();
    const directed = JSON.parse(run.stages).directed;
    expect(directed).toMatchObject({ changes: [], unchanged: true, unmade: ['the colour on "September 25, 2026" (it would not be readable on its background)'] });

    const note = studioStatusNote({ run: { stages: JSON.parse(run.stages), winner_candidate_id: candidateId.value }, candidates: [{ id: candidateId.value, layouts: saved.layouts }] });
    expect(note).toContain('⚠️ could not be made: the colour on "September 25, 2026" (it would not be readable on its background)');
    expect(note).not.toContain('your change made');
  });

  it('keeps the made changes in the note and names the one that was not made', () => {
    const final = { ...onWhite, logo: { x: 72, y: 72, width: 168, height: 118 } };
    const shown = changesShown(
      onWhite,
      final,
      ['logo', 'text:1'],
      [
        { element: 'logo', after: 'logo top-left' },
        { element: 'date', after: 'date in gold' },
      ],
      ['MEET KAAE AT\nSAGACON 2026', 'September 25, 2026'],
      [1]
    );
    expect(shown.changes.map((c) => c.after)).toEqual(['logo top-left']);
    expect(shown.unmade).toEqual(['the colour on "September 25, 2026" (it would not be readable on its background)']);
    expect(shown.unchanged).toBe(false);
    const note = studioStatusNote({ run: { stages: { directed: { changes: shown.changes, unmade: shown.unmade, unchanged: shown.unchanged } } }, candidates: [] });
    expect(note).toContain('your change made to the same design (logo top-left) · ⚠️ could not be made: the colour on "September 25, 2026"');
  });

  it('a requested element the design does not change is named, and the model\'s claim about it dropped', () => {
    const shown = changesShown(parentLayout, JSON.parse(JSON.stringify(parentLayout)), ['text:0'], [{ element: 'title', after: 'title larger' }], ['MEET KAAE AT\nSAGACON 2026']);
    expect(shown).toEqual({ changes: [], unmade: ['the change to "MEET KAAE AT SAGACON 2026"'], unchanged: true });
  });
});

describe('an approved accent on a block the request does not name stays', () => {
  it('keeps the parent gold line the check would call unreadable when the request is about the logo', async () => {
    const approved = { ...onWhite, text: onWhite.text.map((t, i) => (i === 0 ? { ...t, accentColor: '#F7B500', accentParagraph: 'first' } : t)) } as StudioLayoutV2;
    const moved = { ...approved, logo: { x: 72, y: 1160, width: 168, height: 118 } };
    const { service, run, updated, candidateId } = harness({ parentLayout: approved, targets: ['logo'], editReply: { layout: moved, changes: [{ element: 'logo', before: 'right', after: 'logo bottom-left', why: 'asked' }] } });
    await service.resume(scope, run.task_id, run.id);
    expect((await service.resume(scope, run.task_id, run.id)).status).toBe('qa');
    const saved = updated.find((u) => u.id === candidateId.value && u.layouts);
    expect(saved.layouts[0].text[0]).toMatchObject({ accentColor: '#F7B500', accentParagraph: 'first' });
    expect(saved.layouts[0].logo).toMatchObject({ x: 72, y: 1160 });
  });

  it('checks the blocks the request names, and every block when it is about the whole design or the background', () => {
    const gold = () => JSON.parse(JSON.stringify({ ...onWhite, text: onWhite.text.map((t) => ({ ...t, accentColor: '#F7B500', accentParagraph: 'first' })) }));
    expect(dropUnreadableAccents(gold(), ['text:1']).text.map((t) => t.accentColor)).toEqual(['#F7B500', undefined]);
    expect(dropUnreadableAccents(gold(), ['logo']).text.map((t) => t.accentColor)).toEqual(['#F7B500', '#F7B500']);
    expect(dropUnreadableAccents(gold(), ['all']).text.map((t) => t.accentColor)).toEqual([undefined, undefined]);
    expect(dropUnreadableAccents(gold(), ['background']).text.map((t) => t.accentColor)).toEqual([undefined, undefined]);
  });
});

describe('what an edit leaves out of its answer stays in the design', () => {
  const art = { source: 'procedural', motif: 'thin-rules', box: { x: 0, y: 0, width: 1080, height: 1350 }, opacity: 0.15, calmRegion: { x: 72, y: 72, width: 936, height: 1206 } } as const;
  const withArt = { ...withDivider, art } as StudioLayoutV2;
  const omitted = () => {
    const answer = JSON.parse(JSON.stringify(shifted(withArt, 0)));
    delete answer.art;
    delete answer.shapes;
    return answer;
  };

  it('keeps the art layer and the shapes an answer left out, unless the request is about the background', () => {
    const kept = carryOver(withArt, omitted(), ['logo']);
    expect(kept.art).toEqual(art);
    expect(kept.shapes).toEqual(withDivider.shapes);
    expect(carryOver(withArt, omitted(), ['background']).art).toBeUndefined();
    expect(carryOver(withArt, omitted(), ['all']).art).toBeUndefined();
    // An empty list is the edit's answer: the shapes were taken out.
    expect(carryOver(withArt, { ...omitted(), shapes: [] }, ['logo']).shapes).toEqual([]);
  });

  it('the edited design keeps the art and the divider the answer left out', async () => {
    const { service, run, updated, candidateId } = harness({ parentLayout: withArt, editReply: { layout: omitted(), changes: [] } });
    await service.resume(scope, run.task_id, run.id);
    expect((await service.resume(scope, run.task_id, run.id)).status).toBe('qa');
    const saved = updated.find((u) => u.id === candidateId.value && u.layouts);
    expect(saved.layouts[0].art).toEqual(art);
    expect(saved.layouts[0].shapes).toEqual([expect.objectContaining({ role: 'rule', y: 478 })]);
  });
});

describe('a failed model call during an edit is not paid for three times over', () => {
  const failedEdit = async (error: Error) => {
    const h = harness({ callError: (schema) => (schema === 'DirectedEdit' ? error : undefined) });
    await h.service.resume(scope, h.run.task_id, h.run.id);
    const res = await h.service.resume(scope, h.run.task_id, h.run.id);
    return { ...h, res };
  };

  it('a timeout fails the run with the reason instead of designing afresh', async () => {
    const { res, inserted, writes, completeJson, run } = await failedEdit(new OpenAiModelTimeoutError(180000));
    expect(res).toMatchObject({ status: 'failed', code: 'MODEL_UNAVAILABLE' });
    expect(inserted.map((c) => c.ordinal)).toEqual([0]);
    // Asked once: a timed-out call is not asked again.
    expect(editPrompts(completeJson)).toHaveLength(1);
    expect(writes.at(-1)).toMatchObject({ status: 'failed' });
    expect(writes.at(-1).diagnostic).toMatch(/model call failed \(OpenAiModelTimeoutError: .*\). It was not designed afresh/);
    expect(JSON.parse(run.stages).directedFailed).toBeUndefined();
  });

  it('an exhausted quota, and an error known only by its name, fail the same way', async () => {
    const quota = await failedEdit(new OpenAiModelHttpError(429, JSON.stringify({ error: { code: 'insufficient_quota' } })));
    expect(quota.res.status).toBe('failed');
    expect(quota.inserted).toHaveLength(1);
    const truncated = await failedEdit(Object.assign(new Error('reply cut off at the output limit'), { name: 'OpenAiModelTruncatedError' }));
    expect(truncated.res.status).toBe('failed');
    expect(truncated.inserted).toHaveLength(1);
  });

  it('tells transport failures from refusals', () => {
    expect(isModelTransportError(new OpenAiModelTimeoutError(1000))).toBe(true);
    expect(isModelTransportError(new OpenAiModelHttpError(500, 'upstream'))).toBe(true);
    expect(isModelTransportError(Object.assign(new Error('not JSON'), { name: 'OpenAiModelParseError' }))).toBe(true);
    expect(isModelTransportError(new TypeError('fetch failed'))).toBe(true);
    expect(isModelTransportError(new Error('OVERLAP: text over the logo'))).toBe(false);
    expect(isModelTransportError(new StudioBudgetExhaustedError())).toBe(false);
  });
});

describe('a revision of a design still being made waits for it', () => {
  it('refuses with 409 PARENT_STILL_RUNNING and leaves the run where it is, with no candidates', async () => {
    const { service, run, inserted, writes } = harness({ parent: false, parentRunning: true });
    await expect(service.resume(scope, run.task_id, run.id)).rejects.toMatchObject({ status: 409, code: 'PARENT_STILL_RUNNING' });
    expect(inserted).toHaveLength(0);
    expect(run.status).toBe('conceiving');
    expect(writes.some((w) => w.status === 'failed')).toBe(false);
  });

  it('does not brief the revision on its own while the parent is still running', async () => {
    const { service, run, completeJson } = harness({ parent: false, parentRunning: true });
    run.status = 'briefing';
    await expect(service.resume(scope, run.task_id, run.id)).rejects.toMatchObject({ code: 'PARENT_STILL_RUNNING' });
    expect(completeJson).not.toHaveBeenCalled();
    expect(run.status).toBe('briefing');
  });
});

describe('a run is never left at its stage by an exception', () => {
  const png = (n: number) => `data:image/png;base64,${Buffer.from(`picture ${n}`).toString('base64')}`;

  it('a failed image re-brief before the stage marks the run failed with the reason', async () => {
    const { service, run, writes } = harness({ callError: (schema) => (schema !== 'EditTargets' && schema !== 'DirectedEdit' ? new Error('brief model unavailable') : undefined) });
    const stages = JSON.parse(run.stages);
    stages.brief.imageRoles = [{ index: 0, role: 'content_photo', notes: '' }];
    run.stages = JSON.stringify(stages);
    // A second picture joined the request after its brief: the brief is written again first.
    (service as any).imagesForRun = async () => [png(1), png(2)];
    const res = await service.resume(scope, run.task_id, run.id);
    expect(res.status).toBe('failed');
    expect(writes.at(-1)).toMatchObject({ status: 'failed' });
    expect(writes.at(-1).diagnostic).toMatch(/Studio v3 failed at stage conceiving: brief model unavailable/);
  });

  it('a run that reaches its spending cap ends failed, with the cap in its diagnostic', async () => {
    const { service, run, writes, inserted } = harness({ callError: () => new StudioBudgetExhaustedError() });
    await service.resume(scope, run.task_id, run.id);
    const res = await service.resume(scope, run.task_id, run.id);
    expect(res).toMatchObject({ status: 'failed', diagnostic: 'BUDGET_EXHAUSTED' });
    expect(inserted).toHaveLength(1);
    expect(writes.at(-1).status).toBe('failed');
    expect(writes.at(-1).diagnostic).toMatch(/^BUDGET_EXHAUSTED at stage laying_out \(\$0\.00 of \$5, 0 of 20 calls\)/);
  });
});
