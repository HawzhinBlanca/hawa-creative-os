import { useMemoryVisualInputs } from '../test-support/studio-visual-input-fixture.js';
import { KAAE_TEST_CLIENT_LOGO } from './fixtures/kaae-logo.js';
import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NEUTRAL_STYLE_SPEC, type StudioLayoutV2 } from '@hawa/creative';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { askOutcomes, keepUntouched, applyCopyEdits } from '../src/services/design-studio/stages/edit.stage.js';
import { requesterDraftNotes } from '../src/services/design-studio/studio-status-note.js';
import { composeCanvaStatusMessage, composeChangeNeedsDesignerAlert } from '../src/services/canva-status-message.js';

/**
 * 2026-09-23: a requester asked for the panelists cut out of their photos, as in her reference. The
 * edit had no means to do it, wrote so in its own notes, made other changes in its place (bigger
 * photos, the date recoloured), and she was told "your change made to the same design (312 × 326.42
 * at (65, 672) …)". Her second change found none of her photos and the edit removed both.
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
    { x: 72, y: 180, width: 936, height: 260, copyIndex: 0, role: 'title', fontSize: 96, lineHeight: 1.2, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left', bold: true },
    { x: 72, y: 520, width: 700, height: 60, copyIndex: 1, role: 'date', fontSize: 40, lineHeight: 1.3, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left' },
  ],
  logo: { x: 840, y: 1160, width: 168, height: 118 },
} as any;

const withPhotos = {
  ...parentLayout,
  photos: [
    { x: 72, y: 760, width: 300, height: 300, photoIndex: 0, role: 'portrait' },
    { x: 400, y: 760, width: 300, height: 300, photoIndex: 1, role: 'portrait' },
  ],
} as any as StudioLayoutV2;

type Ask = { ask: string; elements: string[]; restyle: boolean; possible: boolean; reason: string; copyEdits?: Array<{ copyIndex: number; from: string; to: string }> };

const harness = (opts: { parentLayout?: StudioLayoutV2; asks?: Ask[]; targets?: string[]; editReply?: any; photos?: unknown[] } = {}) => {
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
      directed: { parentTaskId: randomUUID(), revisionDirective: 'the panelists photos need to be a cutout of them, and move the logo to the top-left' },
    },
  };
  const writes: any[] = [];
  const updated: any[] = [];
  const repo = {
    getCallsForRun: async () => [],
    getRunById: async () => run,
    updateRunStatus: async (_id: string, _t: string, status: string, extra: any = {}) => {
      writes.push({ status, ...extra });
      run.status = status;
      if (extra.stages) run.stages = JSON.stringify(extra.stages);
      if (extra.winnerCandidateId) run.winner_candidate_id = extra.winnerCandidateId;
      return run;
    },
    insertCandidate: async (c: any) => { if (c.ordinal === 0) candidateId.value = c.id; return c; },
    updateCandidate: async (id: string, _t: string, u: any) => { updated.push({ id, ...u }); return u; },
    getCandidatesForRun: async () => [],
    recordCallStart: async () => ({}),
    finalizeCall: async () => ({}),
  };
  const completeJson = vi.fn(async (params: any) => {
    if (params.schemaName === 'EditTargets') return { data: { targets: opts.targets ?? ['logo'], asks: opts.asks ?? [] }, receipt: {} };
    return {
      data: JSON.parse(JSON.stringify(opts.editReply ?? { layout: { ...parentLayout, logo: { x: 72, y: 1160, width: 168, height: 118 } }, changes: [{ element: 'logo', before: 'right', after: 'left', why: 'asked' }] })),
      receipt: {},
    };
  });
  const service = new DesignStudioService({} as any, undefined, { apiKey: 'test-key' });
  useMemoryVisualInputs(service);
  // Stage-only harness: task admission/RLS is covered by studio-run-guards and DB integration tests.
  vi.spyOn(service as any, 'assertTaskCanGenerate').mockResolvedValue(undefined);
  (service as any).repo = repo;
  (service as any).attachedImage = async () => undefined;
  (service as any).imagesForRun = async () => [];
  (service as any).activeRunsOfTask = async () => 0;
  (service as any).parentWinner = async () => ({ runId: 'parent-run', candidateId: 'parent-cand', layout: JSON.parse(JSON.stringify(opts.parentLayout ?? parentLayout)), concept: { id: 'c', archetype: 'split-band' } });
  (service as any).createStageContext = (_s: any, r: any) => ({
    runId: r.id, tenantId: scope.tenantId, taskId: r.task_id, clientId: r.client_id, actorId: scope.actorId,
    width: 1080, height: 1350, tier: 'standard', instructions: 'x', copyBlocks: r.request.copyBlocks,
    referencePack: { palette: ['#0A1628', '#1E3A5F', '#F7B500', '#FFFFFF'] }, promotedRules: 'None',
    latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', logoAspect: 168 / 118, client: { completeJson }, logo: KAAE_TEST_CLIENT_LOGO, pipelineV3: true,
    ...(opts.photos ? { photos: opts.photos } : {}),
  });
  return { service, run, writes, updated, completeJson, candidateId };
};

const cutout: Ask = { ask: 'cut the panelists out of their photos', elements: ['photos'], restyle: false, possible: false, reason: 'the people need cutting out of their photo backgrounds' };
const moveLogo: Ask = { ask: 'move the logo to the left', elements: ['logo'], restyle: false, possible: true, reason: '' };

describe('a change the edit cannot make is said, not replaced by other changes', () => {
  it('stops before the paid edit when nothing asked for is possible, and does not design afresh', async () => {
    const { service, run, writes, completeJson } = harness({ asks: [cutout] });
    await service.resume(scope, run.task_id, run.id);
    const res: any = await service.resume(scope, run.task_id, run.id);
    expect(res).toMatchObject({ status: 'failed', code: 'CHANGE_NOT_SUPPORTED' });
    expect(completeJson.mock.calls.map((c: any) => c[0].schemaName)).toEqual(['EditTargets']);
    const stages = JSON.parse(run.stages);
    expect(stages.directed.asks).toEqual([{ ask: 'cut the panelists out of their photos', reason: 'the people need cutting out of their photo backgrounds', status: 'not_possible' }]);
    expect(stages.directedFailed).toBeUndefined();
    expect(writes.at(-1).diagnostic).toMatch(/not designed afresh/);
  });

  it('makes the possible part, tells the edit not to stand in for the rest, and records both', async () => {
    const { service, run, completeJson } = harness({ asks: [cutout, moveLogo] });
    await service.resume(scope, run.task_id, run.id);
    const res: any = await service.resume(scope, run.task_id, run.id);
    expect(res.status).toBe('qa');
    const prompt = (completeJson.mock.calls.find((c: any) => c[0].schemaName === 'DirectedEdit') as any)[0].prompt as string;
    expect(prompt).toContain('Make exactly these changes:\n1. move the logo to the left');
    expect(prompt).toMatch(/Do not attempt them, and do not make other changes in their place[^]*- cut the panelists out of their photos/);
    const stages = JSON.parse(run.stages);
    expect(stages.directed.asks).toEqual([
      { ask: 'cut the panelists out of their photos', status: 'not_possible', reason: 'the people need cutting out of their photo backgrounds' },
      { ask: 'move the logo to the left', status: 'done', by: 'model' },
    ]);
  });

  it('a request to move text does not recolour it, whatever the edit answered', () => {
    const recoloured = structuredClone(parentLayout);
    recoloured.text[1] = { ...recoloured.text[1], y: 600, color: '#F7B500' };
    const kept = keepUntouched(parentLayout, structuredClone(recoloured), ['text:0', 'text:1'], []);
    expect(kept.text[1]).toMatchObject({ y: 600, color: '#FFFFFF' });
    // Asked for a colour, the colour stays.
    expect(keepUntouched(parentLayout, structuredClone(recoloured), ['text:1'], ['text:1']).text[1].color).toBe('#F7B500');
  });

  it('an ask is done only when the design shows it', () => {
    const moved = { ...parentLayout, logo: { ...parentLayout.logo, x: 72 } };
    expect(askOutcomes(parentLayout, moved, [moveLogo, { ...moveLogo, ask: 'make the date bigger', elements: ['text:1'] }])).toEqual([
      { ask: 'move the logo to the left', status: 'done' },
      { ask: 'make the date bigger', status: 'not_done' },
    ]);
  });
});

describe('a change keeps the photos of the design it changes', () => {
  it('refuses, before any model call, an edit the design\'s photos did not reach', async () => {
    const { service, run, completeJson } = harness({ parentLayout: withPhotos });
    await service.resume(scope, run.task_id, run.id);
    const res: any = await service.resume(scope, run.task_id, run.id);
    expect(res).toMatchObject({ status: 'failed', code: 'PHOTOS_MISSING' });
    expect(completeJson).not.toHaveBeenCalled();
    expect(JSON.parse(run.stages).directedFailed).toBeUndefined();
  });

  it('finds the pictures of a change to a change back at the request that brought them', async () => {
    const service = new DesignStudioService({} as any, undefined, { apiKey: 'test-key' });
    useMemoryVisualInputs(service);
    // Stage-only harness: task admission/RLS is covered by studio-run-guards and DB integration tests.
    vi.spyOn(service as any, 'assertTaskCanGenerate').mockResolvedValue(undefined);
    const own: Record<string, string[]> = { root: ['p1', 'p2', 'ref'], rev1: [], rev2: [] };
    const parentOf: Record<string, string | undefined> = { rev2: 'rev1', rev1: 'root', root: undefined };
    (service as any).requestImages = async (_s: unknown, id: string) => own[id] ?? [];
    (service as any).parentTaskOf = async (_s: unknown, id: string) => parentOf[id];
    const images = await (service as any).imagesForRun(scope, { task_id: 'rev3', request: { pipelineV3: true, directed: { parentTaskId: 'rev2' } } });
    expect(images).toEqual(['p1', 'p2', 'ref']);
    // A picture sent with a later change comes after the design's own, in order.
    own.rev2 = ['p3'];
    expect(await (service as any).imagesForRun(scope, { task_id: 'rev3', request: { pipelineV3: true, directed: { parentTaskId: 'rev2' } } })).toEqual(['p1', 'p2', 'ref', 'p3']);
  });
});

describe('the requester reads plain words', () => {
  const candidate = (photos: number) => ({ id: 'w', layouts: [{ photos: Array.from({ length: photos }, (_, i) => ({ photoIndex: i })) }] });

  it('says what was done and what needs a designer, with no coordinates, models or scores', () => {
    const run = {
      winner_candidate_id: 'w',
      stages: {
        brief: { photosSent: 2, imageRoles: [{ role: 'content_photo' }, { role: 'content_photo' }, { role: 'style_reference', notes: 'paired cutout portraits anchored at the bottom left' }] },
        directed: {
          changes: [{ element: 'photos[0]', after: '312 × 326.42 at (65, 672). Cutout processing remains required.' }],
          asks: [
            { ask: 'spread the text to reduce empty space', status: 'done' },
            { ask: 'cut the panelists out of their photos', status: 'not_possible', reason: 'the people need cutting out of their photo backgrounds' },
          ],
        },
      },
    };
    const notes = requesterDraftNotes({ run, candidates: [candidate(2)] });
    expect(notes).toEqual([
      '✅ Done: spread the text to reduce empty space.',
      '❌ Not possible automatically: cut the panelists out of their photos (the people need cutting out of their photo backgrounds). The office has been told, and a designer will do it.',
      'Your 2 photos are on the design.',
      'Image 1 — content photo (placed): No individual analysis recorded.',
      'Image 2 — content photo (placed): No individual analysis recorded.',
      'Image 3 — style reference (not placed as a content photo): paired cutout portraits anchored at the bottom left',
    ]);
    expect(notes.join(' ')).not.toMatch(/\d+ × \d|at \(\d|models|score|Studio v/);
  });

  it('says so when the reference has its people cut out and the draft cannot', () => {
    const run = { winner_candidate_id: 'w', stages: { brief: { photosSent: 2, imageRoles: [{ role: 'style_reference', notes: 'paired cutout portraits anchored at the bottom left' }] } } };
    expect(requesterDraftNotes({ run, candidates: [candidate(2)] })).toContain(
      '⚠️ Your reference shows the people cut out of their photos. This draft shows your photos as you sent them, because cut-outs cannot be made automatically yet; the art director can make them in Canva.'
    );
    const plainRef = { winner_candidate_id: 'w', stages: { brief: { imageRoles: [{ role: 'style_reference', notes: 'heavy left-aligned title on a blue field' }] } } };
    expect(requesterDraftNotes({ run: plainRef, candidates: [candidate(0)] })).toEqual(['Image 1 — style reference (not placed as a content photo): heavy left-aligned title on a blue field', 'Styled after the reference design you sent.']);
  });

  it('warns when photos went missing', () => {
    const run = { winner_candidate_id: 'w', stages: { brief: { photosSent: 2 } } };
    expect(requesterDraftNotes({ run, candidates: [candidate(0)] })).toEqual(['⚠️ Only 0 of your 2 photos are on the design.']);
  });
});

describe('the messages for a change that needs a designer', () => {
  const taskId = '00000000-0000-4000-c000-000000000001';
  it('tells the requester what cannot be done automatically and that their draft stands', () => {
    const msg = composeCanvaStatusMessage({ taskId, status: 'DESIGN_FAILED', code: 'CHANGE_NOT_SUPPORTED', notPossible: [{ ask: 'cut the panelists out of their photos', reason: 'the people need cutting out <b>' }] });
    // ADR-145 (#28): plain words, and any other change is simply written, not replied to a message.
    expect(msg.text).toContain('A designer will make this part of your change to your design by hand');
    expect(msg.text).toContain('• cut the panelists out of their photos (the people need cutting out &lt;b&gt;)');
    expect(msg.text).toContain('Your last draft stays as it is');
    expect(msg.text).not.toMatch(/reply to/i);
    expect(msg.text).not.toContain('CHANGE_NOT_SUPPORTED');
  });
  it('keeps a note\'s own sign and marks the others', () => {
    const msg = composeCanvaStatusMessage({ taskId, status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', canvaUrl: 'https://www.canva.com/design/DA_x/edit', notes: ['✅ Done: move the logo.', 'Styled after the reference design you sent.'] });
    expect(msg.text).toContain('\n✅ Done: move the logo.\n');
    expect(msg.text).toContain('ℹ️ Styled after the reference design you sent.');
  });
  it('alerts the office with the task and what a designer must make', () => {
    const alert = composeChangeNeedsDesignerAlert({ taskId, title: 'KAAE <SAGACON>', asks: [{ ask: 'cut the panelists out of their photos' }], draftSent: true });
    expect(alert.text).toContain(`<code>${taskId}</code>`);
    expect(alert.text).toContain('KAAE &lt;SAGACON&gt;');
    expect(alert.text).toContain('• cut the panelists out of their photos');
    expect(alert.text).toContain('before approving it');
  });
});

describe('with cut-outs made, "cut them out" is a change the edit makes', () => {
  const ONE_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const photo = { dataUrl: `data:image/png;base64,${ONE_PIXEL}`, bytes: Buffer.from(ONE_PIXEL, 'base64'), mimeType: 'image/png' as const, width: 1, height: 1 };
  const cutAsset = { png: Buffer.from(ONE_PIXEL, 'base64'), width: 300, height: 450, shadowPng: Buffer.from(ONE_PIXEL, 'base64'), shadowWidth: 330, shadowHeight: 480, shadowX: -12, shadowY: -12 };
  const cutAsk: Ask = { ask: 'cut the panelists out of their photos', elements: ['photos'], restyle: false, possible: true, reason: '' };

  it('shows the people cut out, standing on the bottom edge, heads matched, and reports it done', async () => {
    const answer = structuredClone(withPhotos);
    for (const p of answer.photos!) p.treatment = 'cutout';
    const { service, run, updated, candidateId, completeJson } = harness({
      parentLayout: withPhotos,
      asks: [cutAsk],
      targets: ['photos'],
      photos: [photo, photo],
      editReply: { layout: answer, changes: [{ element: 'photos', before: 'framed', after: 'cut out', why: 'asked' }] },
    });
    const ctxFactory = (service as any).createStageContext;
    (service as any).createStageContext = (s: any, r: any) => ({
      ...ctxFactory(s, r),
      photoCutouts: [cutAsset, cutAsset],
      cutoutOutcomes: [{ photoIndex: 0, passed: true, faceHeight: 60 }, { photoIndex: 1, passed: true, faceHeight: 60 }],
    });
    await service.resume(scope, run.task_id, run.id);
    const res: any = await service.resume(scope, run.task_id, run.id);
    expect(res.status).toBe('qa');
    const analysis = (completeJson.mock.calls.find((c: any) => c[0].schemaName === 'EditTargets') as any)[0].prompt as string;
    expect(analysis).toContain('show the person in photos 0, 1 cut out');
    const saved = updated.find((u) => u.id === candidateId.value && u.layouts).layouts[0];
    expect(saved.photos.map((p: any) => p.treatment)).toEqual(['cutout', 'cutout']);
    for (const p of saved.photos) expect(p.y + p.height).toBe(1350);
    expect(saved.photos[0].height).toBe(saved.photos[1].height);
    expect(JSON.parse(run.stages).directed.asks).toEqual([{ ask: 'cut the panelists out of their photos', status: 'done', by: 'model' }]);
  });
});

describe('a change of wording uses only the client\'s own words', () => {
  const blocks = [{ text: 'MEET KAAE AT\nSAGACON 2026', script: 'latin' }, { text: 'September 25, 2026', script: 'latin' }, { text: 'کۆبوونەوەی ئەندامان', script: 'arabic' }];
  const ask = (copyEdits: Array<{ copyIndex: number; from: string; to: string }>, text = 'change the date'): any => ({ ask: text, elements: ['text:1'], restyle: false, possible: true, reason: '', copyEdits });

  it('replaces words on the design with words written out in the request', () => {
    const out = applyCopyEdits(blocks, [ask([{ copyIndex: 1, from: 'September 25', to: 'September 26' }])], 'please change the date to September 26');
    expect(out.blocks[1].text).toBe('September 26, 2026');
    expect(out.asks[0].possible).toBe(true);
    expect(out.applied).toHaveLength(1);
    expect(blocks[1].text).toBe('September 25, 2026');
  });

  it('refuses new words the request does not contain, and never guesses', () => {
    const out = applyCopyEdits(blocks, [ask([{ copyIndex: 1, from: 'September 25, 2026', to: 'September 26, 2026' }])], 'make it the 26th');
    expect(out.asks[0]).toMatchObject({ possible: false });
    expect(out.asks[0].reason).toMatch(/written out exactly in your message/);
    expect(out.blocks[1].text).toBe('September 25, 2026');
  });

  it('refuses words that are not on the design, or are on it twice', () => {
    expect(applyCopyEdits(blocks, [ask([{ copyIndex: 1, from: 'October 1', to: 'October 2' }])], 'change October 1 to October 2').asks[0].reason).toMatch(/not on the design/);
    const twice = [{ text: '2026 and 2026', script: 'latin' }];
    expect(applyCopyEdits(twice, [ask([{ copyIndex: 0, from: '2026', to: '2027' }])], 'change 2026 to 2027').asks[0].reason).toMatch(/more than once/);
  });

  it('keeps Sorani letter for letter, from the request', () => {
    const out = applyCopyEdits(blocks, [ask([{ copyIndex: 2, from: 'ئەندامان', to: 'مامۆستایان' }])], 'بیکە بە مامۆستایان');
    expect(out.blocks[2].text).toBe('کۆبوونەوەی مامۆستایان');
    const invented = applyCopyEdits(blocks, [ask([{ copyIndex: 2, from: 'ئەندامان', to: 'مامۆستاکان' }])], 'بیکە بە مامۆستایان');
    expect(invented.asks[0].possible).toBe(false);
  });

  it('a change of wording that fits is made without the edit model, and every later stage carries the new words', async () => {
    const dateAsk: Ask = { ask: 'change the date to September 26, 2026', elements: ['text:1'], restyle: false, possible: true, reason: '', copyEdits: [{ copyIndex: 1, from: 'September 25, 2026', to: 'September 26, 2026' }] };
    const { service, run, completeJson } = harness({ asks: [dateAsk], targets: ['text:1'], editReply: { layout: parentLayout, changes: [] } });
    run.request.directed.revisionDirective = 'change the date to September 26, 2026 please';
    await service.resume(scope, run.task_id, run.id);
    const res: any = await service.resume(scope, run.task_id, run.id);
    expect(res.status).toBe('qa');
    expect(completeJson.mock.calls.map((c: any) => c[0].schemaName)).toEqual(['EditTargets']);
    const stages = JSON.parse(run.stages);
    expect(stages.effectiveCopy[1].text).toBe('September 26, 2026');
    expect(stages.directed.asks).toEqual([{ ask: 'change the date to September 26, 2026', status: 'done', by: 'rule' }]);
  });

  it('longer new words get a taller box from the house rules, still without the edit model', async () => {
    const long = 'September 26, 2026 at the Erbil International Conference Centre, Hall B, from nine in the morning until the evening';
    const dateAsk: Ask = { ask: 'change the date line', elements: ['text:1'], restyle: false, possible: true, reason: '', copyEdits: [{ copyIndex: 1, from: 'September 25, 2026', to: long }] };
    const { service, run, completeJson, updated } = harness({ asks: [dateAsk], targets: ['text:1'], editReply: { layout: parentLayout, changes: [] } });
    run.request.directed.revisionDirective = `change the date to ${long}`;
    await service.resume(scope, run.task_id, run.id);
    await service.resume(scope, run.task_id, run.id);
    expect(completeJson.mock.calls.map((c: any) => c[0].schemaName)).toEqual(['EditTargets']);
    const date = updated.find((u: any) => u.layouts).layouts[0].text.find((t: any) => t.copyIndex === 1);
    expect(date.height).toBeGreaterThan(60);
    expect(date.fontSize).toBe(40);
  });

  it('a rule whose result does not pass the checks goes to the edit model', async () => {
    // Navy text on the navy background is not readable: hard QA refuses the rule's result.
    const navyDate = { ask: 'make the date navy', op: 'text_colour', params: { text: 1, colour: '#0A1628' }, elements: ['text:1'], restyle: true, possible: true, reason: '' } as unknown as Ask;
    const { service, run, completeJson } = harness({ asks: [navyDate], targets: ['text:1'], editReply: { layout: parentLayout, changes: [] } });
    run.request.directed.revisionDirective = 'make the date navy';
    await service.resume(scope, run.task_id, run.id);
    await service.resume(scope, run.task_id, run.id);
    expect(completeJson.mock.calls.map((c: any) => c[0].schemaName)).toContain('DirectedEdit');
  });
});
