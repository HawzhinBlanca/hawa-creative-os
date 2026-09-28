import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  StudioSubstepReplay,
  isStudioSubstepKey,
  planStudioReuse,
  studioBindingDifferences,
  studioBindingSha256,
  studioBindingText,
  studioSubstepGraph,
  studioSubstepKey,
  type RecordedStudioAttempt,
  type StudioSubstepBinding,
  type StudioSubstepNode,
} from '../src/studio-substeps.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

describe('semantic substep identity', () => {
  it('accepts stable semantic keys and refuses attempt numbers or free text', () => {
    for (const key of ['layout/concept-1', 'art/hero-1', 'native/capture/revision-4', 'sequence/laying_out', 'measure/event.date']) {
      expect(isStudioSubstepKey(key)).toBe(true);
    }
    for (const key of ['layout', 'Layout/concept-1', 'layout//x', 'layout/concept 1', '/art/hero', `a/${'x'.repeat(80)}`, 'a/b/c/d/e/f']) {
      expect(isStudioSubstepKey(key)).toBe(false);
    }
    expect(studioSubstepKey('native', 'capture', 'revision-4')).toBe('native/capture/revision-4');
    expect(() => studioSubstepKey('layout')).toThrow(TypeError);
  });

  it('binds canonically and names every difference', () => {
    const a: StudioSubstepBinding = { version: 1, substep: 'art/hero-1',
      inputs: { request: sha('r'), palette: sha('p') }, identities: { provider: 'openai', model: 'image' }, assets: [] };
    const reordered: StudioSubstepBinding = { version: 1, substep: 'art/hero-1',
      identities: { model: 'image', provider: 'openai' }, inputs: { palette: sha('p'), request: sha('r') }, assets: [] };
    expect(studioBindingText(a)).toBe(studioBindingText(reordered));
    expect(studioBindingSha256(a)).toBe(studioBindingSha256(reordered));
    const changed = { ...a, inputs: { ...a.inputs, request: sha('r2') }, identities: { ...a.identities, font: sha('f') },
      assets: [{ id: 'photo-1', sha256: sha('photo') }] };
    expect(studioBindingDifferences(a, changed)).toEqual(['asset:photo-1', 'identity:font', 'input:request']);
    expect(() => studioBindingText({ ...a, inputs: { request: 'not-a-digest' } })).toThrow(TypeError);
  });
});

const call = (partial: Partial<RecordedStudioAttempt> & Pick<RecordedStudioAttempt, 'callId'>): RecordedStudioAttempt => ({
  substep: 'concepts/board', attempt: 1, ordinal: 1, stage: 'conceiving', provider: 'openai', model: 'm',
  status: 'ok', retained: true, costBasis: 'estimate', usd: 0.01, errorCode: null,
  requestSha256: sha('board'), bindingSha256: sha('binding-board'), ...partial,
});
const ask = (substep: string, request = 'board', binding = `binding-${request}`, kind: 'structured' | 'image' = 'structured') => ({
  substep, stage: 'conceiving', provider: 'openai', model: 'm', kind, requestSha256: sha(request), bindingSha256: sha(binding),
});

describe('attempt replay by semantic substep', () => {
  it('resumes a persisted branch: an unconsumed rebrief does not block the retained board', () => {
    const replay = new StudioSubstepReplay([
      call({ callId: 'rebrief', substep: 'brief/images-rebrief', ordinal: 1, requestSha256: sha('rebrief'), bindingSha256: sha('binding-rebrief') }),
      call({ callId: 'board', ordinal: 2 }),
    ]);
    expect(replay.next(ask('concepts/board'))).toEqual({ action: 'reuse', callId: 'board', attempt: 1 });
    expect(replay.next(ask('concepts/board'))).toEqual({ action: 'execute', attempt: 2 });
  });

  it('holds a changed binding, an unknown outcome and a paid attempt without a result', () => {
    expect(new StudioSubstepReplay([call({ callId: 'a' })]).next(ask('concepts/board', 'board', 'other-policy')))
      .toMatchObject({ action: 'hold', reason: 'INPUT_CHANGED' });
    expect(new StudioSubstepReplay([call({ callId: 'a' }), call({ callId: 'u', substep: 'layout/concept-1', status: 'uncertain', retained: false })])
      .next(ask('concepts/board'))).toMatchObject({ action: 'hold', reason: 'UNKNOWN_OUTCOME' });
    expect(new StudioSubstepReplay([call({ callId: 'a', retained: false }), call({ callId: 'b', substep: 'x/y', ordinal: 2 })])
      .next(ask('concepts/board'))).toMatchObject({ action: 'hold', reason: 'PAID_WITHOUT_RESULT' });
    expect(new StudioSubstepReplay([call({ callId: 'e', status: 'error', retained: false, usd: 0.2 }), call({ callId: 'b', substep: 'x/y', ordinal: 2 })])
      .next(ask('concepts/board'))).toMatchObject({ action: 'hold', reason: 'PAID_WITHOUT_RESULT' });
  });

  it('replays a definite image refusal, then the retained image and verdict', () => {
    const replay = new StudioSubstepReplay([
      call({ callId: 'refused', substep: 'art/candidate-1', stage: 'art', status: 'error', retained: false, usd: 0, costBasis: 'not_accepted',
        errorCode: 'IMAGE_REQUEST_REJECTED', requestSha256: sha('image'), bindingSha256: sha('binding-image') }),
      call({ callId: 'image', substep: 'art/candidate-1', stage: 'art', attempt: 2, ordinal: 2, requestSha256: sha('image'), bindingSha256: sha('binding-image') }),
      call({ callId: 'verdict', substep: 'art/candidate-1', attempt: 3, ordinal: 3, requestSha256: sha('verdict'), bindingSha256: sha('binding-verdict') }),
    ]);
    const image = { ...ask('art/candidate-1', 'image', 'binding-image', 'image'), stage: 'art' };
    expect(replay.next(image)).toEqual({ action: 'replay_refusal', attempt: 1 });
    expect(replay.next(image)).toEqual({ action: 'reuse', callId: 'image', attempt: 2 });
    expect(replay.next(ask('art/candidate-1', 'verdict'))).toEqual({ action: 'reuse', callId: 'verdict', attempt: 3 });
    expect(replay.next(image)).toEqual({ action: 'execute', attempt: 4 });
  });

  it('re-attempts only a trailing unaccepted failure; one before retained work is not reproducible', () => {
    const refused = call({ callId: 'refused', status: 'error', retained: false, usd: 0, costBasis: 'not_accepted', errorCode: 'CALL_FAILED' });
    expect(new StudioSubstepReplay([call({ callId: 'other', substep: 'brief/request', requestSha256: sha('brief'), bindingSha256: sha('binding-brief') }), { ...refused, ordinal: 2 }])
      .next(ask('concepts/board'))).toEqual({ action: 'execute', attempt: 2 });
    expect(new StudioSubstepReplay([refused, call({ callId: 'later', attempt: 2, ordinal: 2 })]).next(ask('concepts/board')))
      .toMatchObject({ action: 'hold', reason: 'ATTEMPT_NOT_REPRODUCIBLE' });
  });

  it('holds a failed attempt followed by saved work in another substep of the stage, without admitting a new attempt', () => {
    // brief/late-reference failed (400, no charge); concepts/board was then designed from the blind
    // brief and saved. Re-running the re-read would pay for a brief that orphans the saved board.
    const failed = call({ callId: 'late', substep: 'brief/late-reference', ordinal: 1, status: 'error', retained: false, usd: 0,
      costBasis: 'not_accepted', errorCode: 'CALL_FAILED', requestSha256: sha('late'), bindingSha256: sha('binding-late') });
    const replay = new StudioSubstepReplay([failed, call({ callId: 'board', ordinal: 2 })]);
    expect(replay.next(ask('brief/late-reference', 'late'))).toMatchObject({ action: 'hold', reason: 'ATTEMPT_NOT_REPRODUCIBLE' });
    // The same failure after the saved board is trailing: nothing saved followed it.
    const trailing = new StudioSubstepReplay([call({ callId: 'board', ordinal: 1 }), { ...failed, ordinal: 2 }]);
    expect(trailing.next(ask('concepts/board'))).toEqual({ action: 'reuse', callId: 'board', attempt: 1 });
    expect(trailing.next(ask('brief/late-reference', 'late'))).toEqual({ action: 'execute', attempt: 2 });
    // Parity rows carry no ordinal; their admission (started_at) order decides.
    const unordered = new StudioSubstepReplay([{ ...failed, ordinal: null }, call({ callId: 'board', ordinal: null })]);
    expect(unordered.next(ask('brief/late-reference', 'late'))).toMatchObject({ action: 'hold', reason: 'ATTEMPT_NOT_REPRODUCIBLE' });
  });

  it('reports saved results the resume never read', () => {
    const replay = new StudioSubstepReplay([
      call({ callId: 'rebrief', substep: 'brief/images-rebrief', ordinal: 1, requestSha256: sha('rebrief'), bindingSha256: sha('binding-rebrief') }),
      call({ callId: 'board', ordinal: 2 }),
      call({ callId: 'refused', substep: 'layout/concept-1', ordinal: 3, status: 'error', retained: false, usd: 0, costBasis: 'not_accepted' }),
    ]);
    expect(replay.unconsumed().map(c => c.callId)).toEqual(['rebrief', 'board']);
    replay.next(ask('concepts/board'));
    expect(replay.unconsumed()).toEqual([{ callId: 'rebrief', substep: 'brief/images-rebrief', attempt: 1 }]);
    const legacy = new StudioSubstepReplay([call({ callId: 'first', substep: null, attempt: null, bindingSha256: null })]);
    expect(legacy.unconsumed()).toEqual([{ callId: 'first', substep: null, attempt: null }]);
    legacy.next(ask('concepts/board'));
    expect(legacy.unconsumed()).toEqual([]);
  });

  it('keeps legacy rows without a substep on the original ordered prefix', () => {
    const legacy = new StudioSubstepReplay([
      call({ callId: 'first', substep: null, attempt: null, bindingSha256: null, requestSha256: sha('rebrief') }),
      call({ callId: 'second', substep: null, attempt: null, bindingSha256: null, ordinal: 2 }),
    ]);
    expect(legacy.next(ask('concepts/board'))).toMatchObject({ action: 'hold', reason: 'ORDER_CHANGED' });
    const inOrder = new StudioSubstepReplay([call({ callId: 'first', substep: null, attempt: null, bindingSha256: null })]);
    expect(inOrder.next(ask('concepts/board'))).toEqual({ action: 'reuse', callId: 'first', attempt: 1 });
    expect(inOrder.next(ask('concepts/board'))).toEqual({ action: 'execute', attempt: 2 });
  });

  it('checks the binding of a post-065 row even in a pool that crossed the deploy', () => {
    const mixed = () => new StudioSubstepReplay([
      call({ callId: 'before-deploy', substep: null, attempt: null, bindingSha256: null, requestSha256: sha('brief') }),
      call({ callId: 'after-deploy', ordinal: 2 }),
    ]);
    const first = mixed();
    expect(first.next(ask('brief/request', 'brief'))).toEqual({ action: 'reuse', callId: 'before-deploy', attempt: 1 });
    expect(first.next(ask('concepts/board'))).toEqual({ action: 'reuse', callId: 'after-deploy', attempt: 1 });
    // Same request bytes, withdrawn authority: the new-format row's binding differs.
    const withdrawn = mixed();
    withdrawn.next(ask('brief/request', 'brief'));
    expect(withdrawn.next(ask('concepts/board', 'board', 'binding-withdrawn'))).toMatchObject({ action: 'hold', reason: 'ORDER_CHANGED' });
    const otherSubstep = mixed();
    otherSubstep.next(ask('brief/request', 'brief'));
    expect(otherSubstep.next(ask('layout/concept-1'))).toMatchObject({ action: 'hold', reason: 'ORDER_CHANGED' });
  });

  it('numbers attempts but reuses nothing when no result was retained', () => {
    const replay = new StudioSubstepReplay([call({ callId: 'refused', status: 'error', retained: false, usd: 0, costBasis: 'not_accepted' })]);
    expect(replay.replaying).toBe(false);
    expect(replay.next(ask('concepts/board'))).toEqual({ action: 'execute', attempt: 2 });
    expect(replay.next(ask('concepts/board'))).toEqual({ action: 'execute', attempt: 3 });
  });
});

describe('attempt numbering across the run', () => {
  it('consumes a substep in attempt order even when admission ordinals interleave differently', () => {
    const replay = new StudioSubstepReplay([
      call({ callId: 'second', attempt: 2, ordinal: 3, requestSha256: sha('b'), bindingSha256: sha('binding-b') }),
      call({ callId: 'first', attempt: 1, ordinal: 4, requestSha256: sha('a'), bindingSha256: sha('binding-a') }),
    ]);
    expect(replay.next(ask('concepts/board', 'a'))).toEqual({ action: 'reuse', callId: 'first', attempt: 1 });
    expect(replay.next(ask('concepts/board', 'b'))).toEqual({ action: 'reuse', callId: 'second', attempt: 2 });
  });

  it('never reissues an attempt number recorded at another stage', () => {
    const elsewhere = call({ callId: 'earlier', substep: 'art/candidate-1', attempt: 3, stage: 'art', retained: false, status: 'error', usd: 0, costBasis: 'not_accepted' });
    const replay = new StudioSubstepReplay([], [elsewhere]);
    expect(replay.next({ ...ask('art/candidate-1', 'image', 'binding-image', 'image'), stage: 'art' })).toEqual({ action: 'execute', attempt: 4 });
  });
});

// A recurring poster: two copy groups, one generated artwork, one client photo, native capture and approval.
const nodes: StudioSubstepNode[] = [
  { key: 'art/hero-1', inputs: ['input:art-prompt/hero-1', 'identity:image-model'], dependsOn: [] },
  { key: 'measure/event.title', inputs: ['input:copy/event.title', 'identity:font', 'identity:renderer'], dependsOn: [] },
  { key: 'measure/event.date', inputs: ['input:copy/event.date', 'identity:font', 'identity:renderer'], dependsOn: [] },
  { key: 'geometry/title-group', inputs: ['input:layout/title-group'], dependsOn: ['measure/event.title'] },
  { key: 'geometry/when-group', inputs: ['input:layout/when-group'], dependsOn: ['measure/event.date'] },
  { key: 'geometry/photo-frame', inputs: ['input:layout/photo-frame'], dependsOn: [], assets: ['photo-1'] },
  { key: 'render/composite', inputs: [], dependsOn: ['art/hero-1', 'geometry/title-group', 'geometry/when-group', 'geometry/photo-frame'] },
  { key: 'native/capture/revision-4', inputs: ['identity:capability'], dependsOn: ['render/composite'] },
  { key: 'approval/revision-4', inputs: [], dependsOn: ['native/capture/revision-4'] },
];
const graph = studioSubstepGraph(nodes);
function bindings(copy: Record<string, string>, photo = 'photo-bytes'): Map<string, StudioSubstepBinding> {
  const out = new Map<string, StudioSubstepBinding>();
  for (const node of nodes) {
    const inputs: Record<string, string> = {};
    const identities: Record<string, string> = {};
    for (const name of node.inputs) {
      const [kind, key] = name.split(/:(.+)/);
      const value = key.startsWith('copy/') ? copy[key] : `${key}-v1`;
      if (kind === 'input') inputs[key] = sha(value); else identities[key] = value;
    }
    for (const upstream of node.dependsOn) inputs[`upstream/${upstream}`] = sha(`${upstream}-result`);
    out.set(node.key, { version: 1, substep: node.key, inputs, identities,
      assets: (node.assets ?? []).map(id => ({ id, sha256: sha(photo) })) });
  }
  return out;
}
const base = { 'copy/event.title': 'Annual Forum', 'copy/event.date': '11 October' };
const authorized = new Map([['photo-1', 'authorized' as const]]);
const actions = (plan: ReturnType<typeof planStudioReuse>) => Object.fromEntries([...plan.actions].map(([key, a]) => [key, a.action]));

describe('explicit dependency invalidation', () => {
  it('rejects unknown dependencies and cycles', () => {
    expect(() => studioSubstepGraph([{ key: 'a/b', inputs: [], dependsOn: ['c/d'] }])).toThrow(/unknown/i);
    expect(() => studioSubstepGraph([{ key: 'a/b', inputs: [], dependsOn: ['c/d'] }, { key: 'c/d', inputs: [], dependsOn: ['a/b'] }])).toThrow(/cycle/i);
  });

  it('a date correction recomputes its measurement, group, capture and approval; the artwork and its asset hashes stay reused', () => {
    const retained = bindings(base);
    const current = bindings({ ...base, 'copy/event.date': '12 October' });
    const plan = planStudioReuse({ graph, retained, current, authorizations: authorized,
      declaredChanges: [{ key: 'office-correction-7', changes: ['input:copy/event.date'] }] });
    expect(actions(plan)).toEqual({
      'art/hero-1': 'reuse', 'measure/event.title': 'reuse', 'measure/event.date': 'recompute',
      'geometry/title-group': 'reuse', 'geometry/when-group': 'recompute', 'geometry/photo-frame': 'reuse',
      'render/composite': 'recompute', 'native/capture/revision-4': 'recompute', 'approval/revision-4': 'recompute' });
    // Metamorphic: the unrelated bindings are identical before and after the date change.
    for (const key of ['art/hero-1', 'geometry/photo-frame', 'measure/event.title']) {
      expect(studioBindingSha256(current.get(key)!)).toBe(studioBindingSha256(retained.get(key)!));
    }
    expect(current.get('geometry/photo-frame')!.assets).toEqual(retained.get('geometry/photo-frame')!.assets);
  });

  it('no single copy change ever reaches the artwork or the unrelated group', () => {
    for (const block of Object.keys(base)) {
      const plan = planStudioReuse({ graph, retained: bindings(base), current: bindings({ ...base, [block]: `${base[block as keyof typeof base]} (corrected)` }),
        authorizations: authorized, declaredChanges: [{ key: `fix-${block}`, changes: [`input:${block}`] }] });
      expect(plan.actions.get('art/hero-1')?.action).toBe('reuse');
      expect(plan.actions.get('geometry/photo-frame')?.action).toBe('reuse');
      expect(plan.actions.get('approval/revision-4')?.action).toBe('recompute');
    }
  });

  it('holds an undeclared change instead of treating drift as permission', () => {
    const plan = planStudioReuse({ graph, retained: bindings(base), current: bindings({ ...base, 'copy/event.date': '12 October' }),
      authorizations: authorized, declaredChanges: [] });
    expect(plan.actions.get('measure/event.date')).toMatchObject({ action: 'hold', reason: 'UNDECLARED_CHANGE', differences: ['input:copy/event.date'] });
    expect(plan.actions.get('geometry/when-group')).toMatchObject({ action: 'hold', reason: 'UPSTREAM_HELD' });
    expect(plan.actions.get('art/hero-1')?.action).toBe('reuse');
  });

  it('re-authorizes a revoked asset even though its bytes are unchanged', () => {
    const retained = bindings(base);
    const current = bindings(base);
    expect(studioBindingSha256(current.get('geometry/photo-frame')!)).toBe(studioBindingSha256(retained.get('geometry/photo-frame')!));
    for (const state of ['revoked', 'unknown'] as const) {
      const plan = planStudioReuse({ graph, retained, current, authorizations: new Map([['photo-1', state]]), declaredChanges: [] });
      expect(plan.actions.get('geometry/photo-frame')).toMatchObject({ action: 'hold', reason: 'ASSET_NOT_AUTHORIZED', assets: ['photo-1'] });
      expect(plan.actions.get('render/composite')).toMatchObject({ action: 'hold', reason: 'UPSTREAM_HELD' });
      expect(plan.actions.get('approval/revision-4')?.action).toBe('hold');
      expect(plan.actions.get('art/hero-1')?.action).toBe('reuse');
    }
  });

  it('a keyed change applies once: duplicates and a replay after recomputation change nothing more', () => {
    const change = { key: 'office-correction-7', changes: ['input:copy/event.date'] };
    const current = bindings({ ...base, 'copy/event.date': '12 October' });
    const once = planStudioReuse({ graph, retained: bindings(base), current, authorizations: authorized, declaredChanges: [change] });
    const twice = planStudioReuse({ graph, retained: bindings(base), current, authorizations: authorized, declaredChanges: [change, change] });
    expect(twice.appliedChanges).toEqual(['office-correction-7']);
    expect(actions(twice)).toEqual(actions(once));
    // After the recomputed results are retained, replaying the same keyed change recomputes nothing.
    const replayed = planStudioReuse({ graph, retained: current, current, authorizations: authorized, declaredChanges: [change] });
    expect(new Set(Object.values(actions(replayed)))).toEqual(new Set(['reuse']));
    expect(() => planStudioReuse({ graph, retained: bindings(base), current, authorizations: authorized,
      declaredChanges: [change, { key: 'office-correction-7', changes: ['input:copy/event.title'] }] })).toThrow(/different changes/i);
  });

  it('a changed renderer or font identity is not a date change', () => {
    const retained = bindings(base);
    const current = new Map(retained);
    const title = retained.get('measure/event.title')!;
    current.set('measure/event.title', { ...title, identities: { ...title.identities, font: 'font-v2' } });
    const plan = planStudioReuse({ graph, retained, current, authorizations: authorized,
      declaredChanges: [{ key: 'office-correction-7', changes: ['input:copy/event.date'] }] });
    expect(plan.actions.get('measure/event.title')).toMatchObject({ action: 'hold', reason: 'UNDECLARED_CHANGE', differences: ['identity:font'] });
    expect(plan.actions.get('art/hero-1')?.action).toBe('reuse');
  });
});
