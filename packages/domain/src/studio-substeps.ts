import { createHash } from 'node:crypto';

/**
 * ADR-122: a stable semantic identity for one unit of Studio work, separate from the
 * execution attempts that produced it. Examples: `layout/concept-1`, `art/hero-1`,
 * `native/capture/revision-4`. A key names what the work is, never when it ran.
 */
const SUBSTEP_KEY = /^[a-z][a-z0-9_-]{0,39}(?:\/[a-z0-9][a-z0-9._-]{0,63}){1,4}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const IDENTITY_VALUE = /^[\x21-\x7e]{1,200}$/;

export function isStudioSubstepKey(value: unknown): value is string {
  return typeof value === 'string' && SUBSTEP_KEY.test(value);
}

export function studioSubstepKey(family: string, ...path: Array<string | number>): string {
  const key = [family, ...path.map(String)].join('/');
  if (!isStudioSubstepKey(key)) throw new TypeError(`Invalid Studio substep key: ${key}`);
  return key;
}

/**
 * What a retained result was derived from. Every entry must be equal for reuse.
 * - inputs: exact input digests (the provider request, a copy block, an upstream result).
 * - identities: schema/prompt/model/provider, renderer/font and capability/design policy.
 * - assets: identities whose *current authorization* is rechecked on every reuse,
 *   even when their bytes are unchanged.
 */
export interface StudioSubstepBinding {
  version: 1;
  substep: string;
  inputs: Record<string, string>;
  identities: Record<string, string>;
  assets: Array<{ id: string; sha256: string }>;
}

const sortedRecord = (record: Record<string, string>, check: (value: string) => boolean, label: string) =>
  Object.fromEntries(Object.keys(record).sort().map((name) => {
    const value = record[name];
    if (!name || name.length > 160 || typeof value !== 'string' || !check(value)) throw new TypeError(`Invalid Studio binding ${label}: ${name}`);
    return [name, value];
  }));

/** Canonical text of a binding; the stored digest is taken over exactly this text. */
export function studioBindingText(binding: StudioSubstepBinding): string {
  if (binding?.version !== 1 || !isStudioSubstepKey(binding.substep)) throw new TypeError('Invalid Studio substep binding.');
  const assets = [...(binding.assets ?? [])].map((asset) => {
    if (!asset || typeof asset.id !== 'string' || !asset.id || asset.id.length > 160 || !DIGEST.test(asset.sha256)) {
      throw new TypeError('Invalid Studio binding asset.');
    }
    return { id: asset.id, sha256: asset.sha256 };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(assets.map((asset) => asset.id)).size !== assets.length) throw new TypeError('Duplicate Studio binding asset.');
  const text = JSON.stringify({
    version: 1,
    substep: binding.substep,
    inputs: sortedRecord(binding.inputs ?? {}, (v) => DIGEST.test(v), 'input'),
    identities: sortedRecord(binding.identities ?? {}, (v) => IDENTITY_VALUE.test(v), 'identity'),
    assets,
  });
  if (text.length > 16384) throw new TypeError('Studio substep binding is too large.');
  return text;
}

export function studioBindingSha256(binding: StudioSubstepBinding): string {
  return createHash('sha256').update(studioBindingText(binding)).digest('hex');
}

/** Names of the entries that differ: `input:<name>`, `identity:<name>`, `asset:<id>`. */
export function studioBindingDifferences(before: StudioSubstepBinding, after: StudioSubstepBinding): string[] {
  const out = new Set<string>();
  const compare = (prefix: string, a: Record<string, string>, b: Record<string, string>) => {
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[name] !== b[name]) out.add(`${prefix}:${name}`);
  };
  compare('input', before.inputs ?? {}, after.inputs ?? {});
  compare('identity', before.identities ?? {}, after.identities ?? {});
  const assets = (binding: StudioSubstepBinding) => Object.fromEntries((binding.assets ?? []).map((a) => [a.id, a.sha256]));
  compare('asset', assets(before), assets(after));
  if (before.substep !== after.substep) out.add('substep');
  return [...out].sort();
}

// ---------------------------------------------------------------------------------------------
// Attempt replay: a retained result is consumed by its substep and attempt, not by run order.
// ---------------------------------------------------------------------------------------------

/** One recorded call, as the ledger stores it. `substep` is null on rows admitted before ADR-122. */
export interface RecordedStudioAttempt {
  callId: string;
  substep: string | null;
  attempt: number | null;
  ordinal: number | null;
  stage: string;
  provider: string;
  model: string;
  status: 'ok' | 'error' | 'uncertain';
  retained: boolean;
  costBasis: string | null;
  usd: number;
  errorCode: string | null;
  requestSha256: string | null;
  bindingSha256: string | null;
}

export interface StudioReplayRequest {
  substep: string;
  stage: string;
  provider: string;
  model: string;
  kind: 'structured' | 'image';
  requestSha256: string;
  bindingSha256: string;
}

export type StudioReplayHoldReason =
  | 'UNKNOWN_OUTCOME' | 'PAID_WITHOUT_RESULT' | 'INPUT_CHANGED' | 'ATTEMPT_NOT_REPRODUCIBLE' | 'ORDER_CHANGED';

export type StudioReplayDecision =
  | { action: 'reuse'; callId: string; attempt: number }
  | { action: 'replay_refusal'; attempt: number }
  | { action: 'execute'; attempt: number }
  | { action: 'hold'; reason: StudioReplayHoldReason; detail: string };

/** The only failure whose outcome the ledger can reproduce exactly: the image provider declined. */
const REPRODUCIBLE_IMAGE_REFUSAL = 'IMAGE_REQUEST_REJECTED';

const unaccepted = (call: RecordedStudioAttempt) => call.status === 'error' && call.usd === 0;
const paidWithoutResult = (call: RecordedStudioAttempt) =>
  (call.status === 'ok' && !call.retained) || (call.status === 'error' && call.usd > 0);

/** A retained result the resume did not read, reported so bypassed paid work stays visible. */
export interface UnconsumedStudioAttempt {
  callId: string;
  substep: string | null;
  attempt: number | null;
}

/**
 * Decides, per call, whether to return a retained result, reproduce a recorded refusal, admit a
 * new attempt, or hold. Replay is active only when the pool holds at least one retained result
 * (ADR-111). A pool containing any pre-ADR-122 row keeps ADR-111's ordered-prefix rule for all
 * of it; post-065 rows in such a pool must still match their substep and binding. Each recorded
 * attempt is consumed at most once.
 */
export class StudioSubstepReplay {
  readonly replaying: boolean;
  private readonly legacy: boolean;
  private readonly ordered: RecordedStudioAttempt[];
  private readonly queues = new Map<string, RecordedStudioAttempt[]>();
  private readonly positions = new Map<string, number>();
  private readonly assigned = new Map<string, number>();
  private readonly historyMax = new Map<string, number>();
  /** Admission order within the pool: call ordinal, then started_at (the order `recorded` arrives in). */
  private readonly admission = new Map<string, number>();
  private readonly consumed = new Set<string>();
  private legacyPosition = 0;

  /**
   * `recorded` is the replay pool (the interrupted stage's calls). `history` is every call of the
   * run, used only so a new attempt never reuses an attempt number recorded at another stage.
   */
  constructor(recorded: readonly RecordedStudioAttempt[], history: readonly RecordedStudioAttempt[] = recorded) {
    for (const call of history) {
      if (call.substep !== null) this.historyMax.set(call.substep, Math.max(this.historyMax.get(call.substep) ?? 0, call.attempt ?? 0));
    }
    this.ordered = [...recorded].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
    this.ordered.forEach((call, index) => this.admission.set(call.callId, index));
    this.replaying = this.ordered.some((call) => call.status === 'ok' && call.retained);
    this.legacy = this.ordered.some((call) => call.substep === null);
    for (const call of this.ordered) {
      if (call.substep === null) continue;
      const queue = this.queues.get(call.substep) ?? [];
      queue.push(call);
      this.queues.set(call.substep, queue);
    }
    // Attempts, not admission ordinals, are the order of work inside a substep.
    for (const queue of this.queues.values()) {
      queue.sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0) || (a.ordinal ?? 0) - (b.ordinal ?? 0));
    }
  }

  private recordedMax(substep: string): number {
    return Math.max(this.historyMax.get(substep) ?? 0, ...(this.queues.get(substep) ?? []).map((call) => call.attempt ?? 0));
  }

  private assign(substep: string, attempt: number): number {
    this.assigned.set(substep, Math.max(this.assigned.get(substep) ?? 0, attempt));
    return attempt;
  }

  private execute(substep: string): StudioReplayDecision {
    return { action: 'execute', attempt: this.assign(substep, Math.max(this.recordedMax(substep), this.assigned.get(substep) ?? 0) + 1) };
  }

  next(request: StudioReplayRequest): StudioReplayDecision {
    if (!isStudioSubstepKey(request.substep)) throw new TypeError(`Invalid Studio substep key: ${request.substep}`);
    if (!this.replaying) return this.execute(request.substep);
    const unknown = this.ordered.find((call) => call.status === 'uncertain');
    if (unknown) return { action: 'hold', reason: 'UNKNOWN_OUTCOME', detail: `Call ${unknown.callId} has an unknown outcome.` };
    return this.legacy ? this.nextLegacy(request) : this.nextBySubstep(request);
  }

  /** Retained results in the pool that no decision has returned yet, in admission order. */
  unconsumed(): UnconsumedStudioAttempt[] {
    return this.ordered.filter((call) => call.status === 'ok' && call.retained && !this.consumed.has(call.callId))
      .map((call) => ({ callId: call.callId, substep: call.substep, attempt: call.attempt }));
  }

  private nextLegacy(request: StudioReplayRequest): StudioReplayDecision {
    const previous = this.ordered[this.legacyPosition];
    if (!previous) return this.execute(request.substep);
    // A pool that crossed the migration 065 deploy: its post-065 rows still carry a binding, so
    // their authority and renderer basis are rechecked; pre-065 rows can only match the request.
    const bindingChanged = previous.substep !== null &&
      (previous.substep !== request.substep || previous.bindingSha256 !== request.bindingSha256);
    if (previous.stage !== request.stage || previous.provider !== request.provider || previous.model !== request.model ||
        previous.status !== 'ok' || !previous.retained || previous.requestSha256 !== request.requestSha256 || bindingChanged) {
      return { action: 'hold', reason: 'ORDER_CHANGED', detail: 'The interrupted stage no longer matches its recorded model-call order.' };
    }
    this.legacyPosition++;
    this.consumed.add(previous.callId);
    return { action: 'reuse', callId: previous.callId,
      attempt: this.assign(request.substep, (this.assigned.get(request.substep) ?? 0) + 1) };
  }

  private nextBySubstep(request: StudioReplayRequest): StudioReplayDecision {
    const queue = this.queues.get(request.substep) ?? [];
    const position = this.positions.get(request.substep) ?? 0;
    const recorded = queue[position];
    if (!recorded) return this.execute(request.substep);
    const attempt = this.assign(request.substep, recorded.attempt ?? position + 1);
    const matches = recorded.stage === request.stage && recorded.provider === request.provider && recorded.model === request.model &&
      recorded.requestSha256 === request.requestSha256 && recorded.bindingSha256 === request.bindingSha256;
    if (paidWithoutResult(recorded)) {
      return { action: 'hold', reason: 'PAID_WITHOUT_RESULT', detail: `Attempt ${attempt} of ${request.substep} was paid without a retained result.` };
    }
    if (recorded.status === 'ok') {
      if (!matches) return { action: 'hold', reason: 'INPUT_CHANGED', detail: `Attempt ${attempt} of ${request.substep} was retained for different inputs.` };
      this.positions.set(request.substep, position + 1);
      this.consumed.add(recorded.callId);
      return { action: 'reuse', callId: recorded.callId, attempt };
    }
    // An attempt that failed without charge. Reproduce it exactly where the recorded outcome is
    // known to be the same one the caller would see. Otherwise re-attempt it only when nothing was
    // saved after it anywhere in the stage: work admitted later, in any substep, may have been
    // designed from the control flow that followed the failure (a board from the brief a failed
    // re-read left in place), and no declared dependency proves otherwise.
    if (unaccepted(recorded) && matches && request.kind === 'image' && recorded.costBasis === 'not_accepted' &&
        recorded.errorCode === REPRODUCIBLE_IMAGE_REFUSAL) {
      this.positions.set(request.substep, position + 1);
      return { action: 'replay_refusal', attempt };
    }
    const failedAt = this.admission.get(recorded.callId) ?? -1;
    const savedLater = this.ordered.slice(failedAt + 1).find((call) => call.status === 'ok') ??
      queue.slice(position + 1).find((call) => call.status === 'ok');
    if (savedLater) {
      return { action: 'hold', reason: 'ATTEMPT_NOT_REPRODUCIBLE',
        detail: `Attempt ${attempt} of ${request.substep} failed before later saved work (${savedLater.substep ?? savedLater.stage}); its outcome cannot be reproduced.` };
    }
    this.positions.set(request.substep, queue.length);
    return this.execute(request.substep);
  }
}

// ---------------------------------------------------------------------------------------------
// Explicit dependency invalidation.
// ---------------------------------------------------------------------------------------------

/**
 * A node's `inputs` name the binding entries it owns (`input:copy/event.date`, `identity:font`);
 * `dependsOn` names upstream substeps; `assets` names assets whose authorization it relies on.
 */
export interface StudioSubstepNode {
  key: string;
  inputs: readonly string[];
  dependsOn: readonly string[];
  assets?: readonly string[];
}

export interface StudioSubstepGraph {
  /** Topological order: every node follows all of its dependencies. */
  order: readonly string[];
  nodes: ReadonlyMap<string, StudioSubstepNode>;
}

export function studioSubstepGraph(nodes: readonly StudioSubstepNode[]): StudioSubstepGraph {
  const map = new Map<string, StudioSubstepNode>();
  for (const node of nodes) {
    if (!isStudioSubstepKey(node.key)) throw new TypeError(`Invalid Studio substep key: ${node.key}`);
    if (map.has(node.key)) throw new TypeError(`Duplicate Studio substep: ${node.key}`);
    map.set(node.key, node);
  }
  for (const node of nodes) {
    for (const upstream of node.dependsOn) if (!map.has(upstream)) throw new TypeError(`Studio substep ${node.key} depends on unknown ${upstream}`);
  }
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (key: string) => {
    if (state.get(key) === 'done') return;
    if (state.get(key) === 'visiting') throw new TypeError(`Studio substep dependency cycle at ${key}`);
    state.set(key, 'visiting');
    for (const upstream of map.get(key)!.dependsOn) visit(upstream);
    state.set(key, 'done');
    order.push(key);
  };
  for (const node of nodes) visit(node.key);
  return { order, nodes: map };
}

/** An authorized, idempotently keyed change, e.g. the office's date correction. */
export interface StudioDeclaredChange {
  key: string;
  /** Binding entry names this change is allowed to alter, e.g. `input:copy/event.date`. */
  changes: readonly string[];
}

export type StudioAssetAuthorization = 'authorized' | 'revoked' | 'unknown';

export type StudioReuseAction =
  | { action: 'reuse' }
  | { action: 'recompute'; causes: string[] }
  | { action: 'hold'; reason: 'UNDECLARED_CHANGE'; differences: string[] }
  | { action: 'hold'; reason: 'ASSET_NOT_AUTHORIZED'; assets: string[] }
  | { action: 'hold'; reason: 'UPSTREAM_HELD'; upstream: string[] };

export interface StudioReusePlanInput {
  graph: StudioSubstepGraph;
  /** The binding each substep's retained result was produced from; absent when nothing is retained. */
  retained: ReadonlyMap<string, StudioSubstepBinding>;
  /** The binding the substep would have now. */
  current: ReadonlyMap<string, StudioSubstepBinding>;
  authorizations: ReadonlyMap<string, StudioAssetAuthorization>;
  declaredChanges: readonly StudioDeclaredChange[];
}

/**
 * Plans which retained results remain usable. A result is reused only when its binding is
 * unchanged, every upstream result is reused and every relied-on asset is currently authorized.
 * A difference is recomputed only when a declared change names it or an upstream result is
 * recomputed; undeclared drift holds, and holds propagate downstream. Applying the same keyed
 * change twice is the same as applying it once.
 */
export function planStudioReuse(input: StudioReusePlanInput): { actions: Map<string, StudioReuseAction>; appliedChanges: string[] } {
  const declared = new Map<string, string>();
  const permitted = new Set<string>();
  for (const change of input.declaredChanges) {
    if (!change.key || change.key.length > 200) throw new TypeError('A declared Studio change needs an idempotency key.');
    const signature = JSON.stringify([...change.changes].sort());
    const previous = declared.get(change.key);
    if (previous !== undefined) {
      if (previous !== signature) throw new TypeError(`Declared Studio change ${change.key} was replayed with different changes.`);
      continue;
    }
    declared.set(change.key, signature);
    for (const name of change.changes) permitted.add(name);
  }
  const actions = new Map<string, StudioReuseAction>();
  for (const key of input.graph.order) {
    const node = input.graph.nodes.get(key)!;
    const held = node.dependsOn.filter((upstream) => actions.get(upstream)?.action === 'hold');
    if (held.length) { actions.set(key, { action: 'hold', reason: 'UPSTREAM_HELD', upstream: held }); continue; }
    const current = input.current.get(key);
    const assets = [...new Set([...(node.assets ?? []), ...(current?.assets ?? []).map((asset) => asset.id)])].sort();
    const unauthorized = assets.filter((id) => input.authorizations.get(id) !== 'authorized');
    if (unauthorized.length) { actions.set(key, { action: 'hold', reason: 'ASSET_NOT_AUTHORIZED', assets: unauthorized }); continue; }
    const recomputedUpstream = node.dependsOn.filter((upstream) => actions.get(upstream)?.action === 'recompute').map((upstream) => `upstream:${upstream}`);
    const retained = input.retained.get(key);
    if (!retained || !current) { actions.set(key, { action: 'recompute', causes: ['no-retained-result', ...recomputedUpstream] }); continue; }
    const differences = studioBindingDifferences(retained, current)
      // An upstream digest changes because that upstream is being recomputed, not by drift.
      .filter((name) => !recomputedUpstream.some((cause) => name === `input:upstream/${cause.slice('upstream:'.length)}`));
    const undeclared = differences.filter((name) => !permitted.has(name));
    if (undeclared.length) { actions.set(key, { action: 'hold', reason: 'UNDECLARED_CHANGE', differences: undeclared }); continue; }
    if (differences.length || recomputedUpstream.length) { actions.set(key, { action: 'recompute', causes: [...differences, ...recomputedUpstream] }); continue; }
    actions.set(key, { action: 'reuse' });
  }
  return { actions, appliedChanges: [...declared.keys()] };
}
