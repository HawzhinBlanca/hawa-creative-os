/**
 * RequestLifecycle's first two revisions (ADR-034, Phase 2.3): open and terminal design outcome.
 * ChatInbox does not route here yet; the cutover remains closed until decisions and delivery exist.
 * Once bound, the service name stays in every worker build for blue/green drain compatibility.
 */
import { createHash } from 'node:crypto';
import * as restate from '@restatedev/restate-sdk';
import type { OutboundMessage } from '@hawa/contracts';
import { withInvocationLogContext } from '../logging.js';
import { coreInternalFromEnv, type CoreInternal } from './delivery.js';
import { TelegramSenderApi } from './telegram-sender.js';
import { DesignRunApi, type DesignRunInput } from './design-run.js';

const DEFAULT_TENANT_ID = '00000000-0000-4000-a000-000000000001';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT_RETRY = { initialRetryInterval: 2000, retryIntervalFactor: 2, maxRetryInterval: 30_000, maxRetryDuration: 30 * 60_000 };
// A DesignRun has already ended when it sends this event. Keep its sole outcome pending through a
// Core outage; a bounded step here could abandon the only report of paid work.
const OUTCOME_RETRY = { initialRetryInterval: 2000, retryIntervalFactor: 2, maxRetryInterval: 30_000 };

export interface OpenManualEvent {
  v: 1;
  eventId: string;
  requestId: string;
  tenantId: string;
  chatId: string;
  draft: {
    platform: 'telegram';
    sourceEventId: string;
    sourceChannelId: string;
    rawText: string;
    title: string;
    designInstructions: string;
    exactCopy: unknown[];
    clientId: string | null;
    autoGenerate: false;
  };
}

export interface ManualLifecycleState {
  v: 1;
  requestId: string;
  tenantId: string;
  chatId: string;
  owner: 'restate';
  stage: 'manual';
  rev: 1;
  taskId: string;
  openEventId: string;
  openSha256: string;
}

export interface OpenManualResult { accepted: true; taskId: string; stage: 'manual'; rev: 1 }

export interface OpenAutomaticEvent extends Omit<OpenManualEvent, 'draft'> {
  draft: Omit<OpenManualEvent['draft'], 'autoGenerate'> & {
    autoGenerate: true;
    variant?: { width: number; height: number };
    designStudio?: boolean;
    studioOptions?: DesignRunInput['studioOptions'];
  };
}

export interface AutomaticLifecycleState extends Omit<ManualLifecycleState, 'stage' | 'rev'> {
  stage: 'designing' | 'in_review' | 'manual';
  rev: 1 | 2 | 3;
  runId: string;
  designInput: DesignRunInput;
  outcome?: { eventId: string; sha256: string; status: string; revisionId?: string;
    message?: { text: string; parseMode: 'HTML' }; officeAlert?: { chatId: string; text: string } };
  officeRevision?: { eventId: string; sha256: string; actionId: string; revisionId: string; approvalId: string };
}

export interface OfficeRevisionEvent {
  v: 1; eventId: string; requestId: string; taskId: string; revisionId: string;
  actionId: string; expectedRev: 2; kind: 'revise';
  actor: { userId: string; role: string }; reason: string;
}

export type OfficeRevisionReply =
  | { accepted: true; requestId: string; taskId: string; revisionId: string; actionId: string;
      approvalId: string; stage: 'manual'; rev: 3 }
  | { accepted: false; code: 'WRONG_STAGE' | 'NOT_CURRENT_DRAFT' };

export interface AutomaticOpenContext {
  key: string;
  get(name: string): Promise<ManualLifecycleState | AutomaticLifecycleState | null>;
  run<T>(name: string, action: () => Promise<T>): Promise<T>;
  set(name: string, value: ManualLifecycleState | AutomaticLifecycleState): void;
  send(message: OutboundMessage): void;
  startDesign(input: DesignRunInput): void;
}

export interface DesignFinishedEvent {
  v: 1; eventId: string; requestId: string; runId: string; round: 0; taskId: string;
  report: { status: string; designId?: string; code?: string; runId?: string;
    parity?: string; parityError?: string; detail?: string; notifyRequester?: boolean };
}

export interface OpenContext {
  key: string;
  get(name: string): Promise<ManualLifecycleState | null>;
  run<T>(name: string, action: () => Promise<T>): Promise<T>;
  set(name: string, value: ManualLifecycleState): void;
  send(message: OutboundMessage): void;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

const hashOf = (event: unknown) => createHash('sha256').update(canonical(event)).digest('hex');
const invalid = (reason: string) => new restate.TerminalError(`LIFECYCLE_OPEN_REFUSED: ${reason}`, { errorCode: 409 });

function sendAcknowledgement(ctx: Pick<OpenContext, 'send'>, state: ManualLifecycleState): void {
  ctx.send({
    v: 1, key: `${state.requestId}:1:ack`, chatId: state.chatId, kind: 'text',
    text: 'Request received. An art director will review it.', class: 'critical',
    tenantId: state.tenantId, taskId: state.taskId,
  });
}

/** A replay after `set` still emits the same fenced message key, so a crash cannot lose the ack. */
export async function openManualRequest(ctx: OpenContext, core: CoreInternal, event: OpenManualEvent): Promise<OpenManualResult> {
  if (event?.v !== 1 || !UUID.test(event.requestId) || ctx.key !== event.requestId ||
      event.eventId !== `open:${event.requestId}` || event.tenantId !== DEFAULT_TENANT_ID ||
      !/^-?\d{1,20}$/.test(event.chatId) || event.draft?.platform !== 'telegram' ||
      event.draft?.sourceEventId !== `lc-${event.requestId}-r0` ||
      event.draft?.sourceChannelId !== event.chatId || event.draft?.autoGenerate !== false) {
    throw invalid('this handler accepts only a versioned manual round-zero request under its own key');
  }
  const fingerprint = hashOf(event);
  const prior = await ctx.get('lc');
  if (prior) {
    if (prior.requestId !== event.requestId || prior.openEventId !== event.eventId || prior.openSha256 !== fingerprint) {
      throw invalid('this request was opened with different content');
    }
    sendAcknowledgement(ctx, prior);
    return { accepted: true, taskId: prior.taskId, stage: 'manual', rev: 1 };
  }
  const projected = await ctx.run('project:1', () => core.post<{ v: 1; taskId: string; stage: string; rev: number; autoGenerate: boolean }>(
    `/internal/lifecycle/${encodeURIComponent(event.requestId)}/project`,
    { v: 1, expectedRev: 0, rev: 1, key: `${event.requestId}:1:open`, ops: [{ kind: 'createRequest', draft: event.draft }] },
  ));
  if (projected?.v !== 1 || !UUID.test(projected.taskId) || projected.stage !== 'manual' || projected.rev !== 1 || projected.autoGenerate !== false) {
    throw new Error('Core did not return a manual request projection; do not acknowledge it');
  }
  const state: ManualLifecycleState = {
    v: 1, requestId: event.requestId, tenantId: event.tenantId, chatId: event.chatId,
    owner: 'restate', stage: 'manual', rev: 1, taskId: projected.taskId,
    openEventId: event.eventId, openSha256: fingerprint,
  };
  ctx.set('lc', state);
  sendAcknowledgement(ctx, state);
  return { accepted: true, taskId: state.taskId, stage: 'manual', rev: 1 };
}

function sendAutomaticAcknowledgement(ctx: AutomaticOpenContext, state: AutomaticLifecycleState): void {
  ctx.send({ v: 1, key: `${state.requestId}:1:ack`, chatId: state.chatId, kind: 'text',
    text: 'Request received. I am preparing a draft for art director review.', class: 'critical',
    tenantId: state.tenantId, taskId: state.taskId });
}

/** The persisted Core projection, not the untrusted open event, supplies the run's execution policy. */
export async function openAutomaticRequest(ctx: AutomaticOpenContext, core: CoreInternal, event: OpenAutomaticEvent) {
  if (event?.v !== 1 || !UUID.test(event.requestId) || ctx.key !== event.requestId ||
      event.eventId !== `open:${event.requestId}` || event.tenantId !== DEFAULT_TENANT_ID ||
      !/^-?\d{1,20}$/.test(event.chatId) || event.draft?.platform !== 'telegram' ||
      event.draft?.sourceEventId !== `lc-${event.requestId}-r0` ||
      event.draft?.sourceChannelId !== event.chatId || event.draft?.autoGenerate !== true ||
      !event.draft.clientId || !UUID.test(event.draft.clientId)) {
    throw invalid('automatic round-zero request has an invalid owner, source or client');
  }
  const fingerprint = hashOf(event);
  const prior = await ctx.get('lc');
  if (prior) {
    if (prior.requestId !== event.requestId || prior.openEventId !== event.eventId ||
        prior.openSha256 !== fingerprint) {
      throw invalid('this request was opened with different content');
    }
    if (!('runId' in prior)) {
      sendAcknowledgement(ctx, prior);
      return { accepted: true as const, taskId: prior.taskId, stage: 'manual' as const, rev: 1 as const };
    }
    sendAutomaticAcknowledgement(ctx, prior);
    if (prior.rev === 1) ctx.startDesign(prior.designInput);
    return { accepted: true as const, taskId: prior.taskId, stage: prior.stage, rev: prior.rev };
  }
  const projected = await ctx.run('project:1', () => core.post<{
    v: 1; taskId: string; stage: string; rev: number; autoGenerate: boolean;
    design?: { clientId: string; rawText: string; sourcePlatform: string;
      variant?: { width: number; height: number }; designStudio: boolean; studioOptions?: DesignRunInput['studioOptions'] };
  }>(`/internal/lifecycle/${encodeURIComponent(event.requestId)}/project`,
    { v: 1, expectedRev: 0, rev: 1, key: `${event.requestId}:1:open`, ops: [{ kind: 'createRequest', draft: event.draft }] }));
  if (projected?.v !== 1 || !UUID.test(projected.taskId) || projected.rev !== 1) {
    throw new Error('Core did not return an automatic design projection; do not start the run');
  }
  if (projected.stage === 'manual' && projected.autoGenerate === false) {
    const manual: ManualLifecycleState = {
      v: 1, requestId: event.requestId, tenantId: event.tenantId, chatId: event.chatId,
      owner: 'restate', stage: 'manual', rev: 1, taskId: projected.taskId,
      openEventId: event.eventId, openSha256: fingerprint,
    };
    ctx.set('lc', manual);
    sendAcknowledgement(ctx, manual);
    return { accepted: true as const, taskId: manual.taskId, stage: 'manual' as const, rev: 1 as const };
  }
  if (projected.stage !== 'designing' || projected.autoGenerate !== true ||
      !projected.design || projected.design.clientId !== event.draft.clientId) {
    throw new Error('Core returned an inconsistent automatic design projection; do not start the run');
  }
  const runId = `dr-${projected.taskId}`;
  const designInput: DesignRunInput = {
    v: 1, lifecycle: { requestId: event.requestId, round: 0, runId },
    taskId: projected.taskId, tenantId: event.tenantId, clientId: projected.design.clientId,
    rawText: projected.design.rawText, sourcePlatform: projected.design.sourcePlatform,
    idempotencyKey: `lifecycle:${event.requestId}:${projected.taskId}`, canvaAutoGenerate: true,
    ...(projected.design.variant ? { canvaVariant: projected.design.variant } : {}),
    designStudio: projected.design.designStudio,
    ...(projected.design.studioOptions ? { studioOptions: projected.design.studioOptions } : {}),
  };
  const state: AutomaticLifecycleState = {
    v: 1, requestId: event.requestId, tenantId: event.tenantId, chatId: event.chatId,
    owner: 'restate', stage: 'designing', rev: 1, taskId: projected.taskId,
    openEventId: event.eventId, openSha256: fingerprint, runId, designInput,
  };
  ctx.set('lc', state);
  sendAutomaticAcknowledgement(ctx, state);
  ctx.startDesign(designInput);
  return { accepted: true as const, taskId: state.taskId, stage: state.stage, rev: state.rev };
}

export async function recordDesignFinished(ctx: AutomaticOpenContext, core: CoreInternal, event: DesignFinishedEvent) {
  if (event?.v !== 1 || !UUID.test(event.requestId) || ctx.key !== event.requestId ||
      !UUID.test(event.taskId) || event.runId !== `dr-${event.taskId}` ||
      event.eventId !== `dr-finished:${event.runId}` || event.round !== 0 ||
      !event.report || typeof event.report.status !== 'string') throw invalid('invalid design finish identity');
  const prior = await ctx.get('lc');
  if (!prior || !('runId' in prior) || prior.requestId !== event.requestId ||
      prior.taskId !== event.taskId || prior.runId !== event.runId) return { ignored: true as const };
  const fingerprint = hashOf(event);
  if (prior.rev >= 2) {
    if (prior.outcome?.eventId !== event.eventId || prior.outcome.sha256 !== fingerprint) {
      throw invalid('the design outcome was already recorded with different content');
    }
    sendDesignOutcome(ctx, prior);
    return { ignored: false as const, stage: prior.stage, rev: prior.rev };
  }
  if (prior.stage !== 'designing') throw invalid('request is not designing');
  const projected = await ctx.run('project:2', () => core.post<{
    v: 1; requestId: string; taskId: string; rev: 2; stage: 'in_review' | 'manual';
    status: string; revisionId?: string; message?: { text: string; parseMode: 'HTML' };
    officeAlert?: { chatId: string; text: string };
  }>(`/internal/lifecycle/${encodeURIComponent(event.requestId)}/design-outcome`, {
    v: 1, expectedRev: 1, rev: 2, key: `${event.requestId}:2:designFinished:${event.runId}`,
    ops: [{ kind: 'recordOutcome', taskId: event.taskId, runId: event.runId, report: event.report }],
  }));
  if (projected?.v !== 1 || projected.requestId !== event.requestId ||
      projected.taskId !== event.taskId || projected.rev !== 2 ||
      !['in_review', 'manual'].includes(projected.stage)) {
    throw new Error('Core did not return a valid design outcome projection');
  }
  const next: AutomaticLifecycleState = { ...prior, stage: projected.stage, rev: 2,
    outcome: { eventId: event.eventId, sha256: fingerprint, status: projected.status,
      ...(projected.revisionId ? { revisionId: projected.revisionId } : {}),
      ...(projected.message ? { message: projected.message } : {}),
      ...(projected.officeAlert ? { officeAlert: projected.officeAlert } : {}),
    },
  };
  ctx.set('lc', next);
  sendDesignOutcome(ctx, next);
  return { ignored: false as const, stage: next.stage, rev: next.rev };
}

const OFFICE_ROLES = new Set(['art_director', 'creative_director', 'account_lead', 'office_admin', 'administrator']);

/** The first request-owned office action: a reviewer's revision request for the current draft. */
export async function recordOfficeRevision(ctx: AutomaticOpenContext, core: CoreInternal, event: OfficeRevisionEvent): Promise<OfficeRevisionReply> {
  if (event?.v !== 1 || !UUID.test(event.requestId) || ctx.key !== event.requestId ||
      !UUID.test(event.taskId) || !UUID.test(event.revisionId) || !UUID.test(event.actionId) ||
      event.eventId !== `desk:${event.actionId}` || event.kind !== 'revise' ||
      event.expectedRev !== 2 || !event.actor || !UUID.test(event.actor.userId) ||
      !OFFICE_ROLES.has(event.actor.role) || typeof event.reason !== 'string' ||
      !event.reason.trim() || event.reason.length > 2000) {
    throw invalid('invalid office revision identity, reviewer or audit reason');
  }
  const fingerprint = hashOf(event);
  const prior = await ctx.get('lc');
  if (!prior || !('runId' in prior)) return { accepted: false, code: 'WRONG_STAGE' };
  if (prior.rev === 3) {
    if (prior.officeRevision?.eventId !== event.eventId || prior.officeRevision.sha256 !== fingerprint) {
      throw invalid('this office decision was already recorded with different content');
    }
    return { accepted: true, requestId: prior.requestId, taskId: prior.taskId,
      revisionId: prior.officeRevision.revisionId, actionId: prior.officeRevision.actionId,
      approvalId: prior.officeRevision.approvalId, stage: 'manual', rev: 3 };
  }
  if (prior.rev !== 2 || prior.stage !== 'in_review') return { accepted: false, code: 'WRONG_STAGE' };
  if (prior.taskId !== event.taskId || prior.outcome?.revisionId !== event.revisionId) {
    return { accepted: false, code: 'NOT_CURRENT_DRAFT' };
  }
  const projected = await ctx.run('project:3', () => core.post<{
    v: 1; requestId: string; taskId: string; revisionId: string; actionId: string;
    approvalId: string; taskState: string; rev: 3; stage: 'manual';
  }>(`/internal/lifecycle/${encodeURIComponent(event.requestId)}/office-decision`, {
    v: 1, expectedRev: 2, rev: 3,
    key: `${event.requestId}:3:officeDecision:${event.eventId}`,
    ops: [{ kind: 'recordOfficeRevision', taskId: event.taskId, revisionId: event.revisionId,
      actionId: event.actionId, actor: event.actor, reason: event.reason.trim() }],
  }));
  if (projected?.v !== 1 || projected.requestId !== event.requestId || projected.taskId !== event.taskId ||
      projected.revisionId !== event.revisionId || projected.actionId !== event.actionId ||
      !UUID.test(projected.approvalId) || projected.taskState !== 'revision_requested' ||
      projected.rev !== 3 || projected.stage !== 'manual') {
    throw new Error('Core did not return a valid office revision projection');
  }
  const next: AutomaticLifecycleState = { ...prior, stage: 'manual', rev: 3,
    officeRevision: { eventId: event.eventId, sha256: fingerprint,
      actionId: event.actionId, revisionId: event.revisionId, approvalId: projected.approvalId } };
  ctx.set('lc', next);
  return { accepted: true, requestId: event.requestId, taskId: event.taskId, revisionId: event.revisionId,
    actionId: event.actionId, approvalId: projected.approvalId, stage: 'manual', rev: 3 };
}

function sendDesignOutcome(ctx: AutomaticOpenContext, state: AutomaticLifecycleState): void {
  const message = state.outcome?.message;
  if (message) ctx.send({ v: 1, key: `${state.requestId}:2:design-outcome`, chatId: state.chatId,
    kind: 'text', text: message.text, parseMode: message.parseMode, class: 'critical',
    tenantId: state.tenantId, taskId: state.taskId });
  const alert = state.outcome?.officeAlert;
  if (alert) ctx.send({ v: 1, key: `${state.requestId}:2:office-alert`, chatId: alert.chatId,
    kind: 'text', text: alert.text, class: 'critical', tenantId: state.tenantId, taskId: state.taskId });
}

export function createRequestLifecycle(core: CoreInternal = coreInternalFromEnv()) {
  return restate.object({
    name: 'RequestLifecycle',
    handlers: {
      open: restate.handlers.object.exclusive(
        { idempotencyRetention: { days: 7 }, journalRetention: { days: 7 } },
        async (ctx: restate.ObjectContext, event: OpenManualEvent | OpenAutomaticEvent) =>
          withInvocationLogContext(ctx, { requestId: event?.requestId, tenantId: event?.tenantId }, () =>
            event?.draft?.autoGenerate === true ? openAutomaticRequest({
              key: ctx.key,
              get: (name) => ctx.get<ManualLifecycleState | AutomaticLifecycleState>(name),
              run: (name, action) => ctx.run(name, action, PROJECT_RETRY),
              set: (name, value) => ctx.set(name, value),
              send: (message) => ctx.objectSendClient(TelegramSenderApi, message.chatId)
                .send(message, restate.rpc.sendOpts({ idempotencyKey: message.key })),
              startDesign: (input) => ctx.workflowSendClient(DesignRunApi, input.lifecycle.runId).run(input),
            }, core, event as OpenAutomaticEvent) : openManualRequest({
              key: ctx.key,
              get: (name) => ctx.get<ManualLifecycleState>(name),
              run: (name, action) => ctx.run(name, action, PROJECT_RETRY),
              set: (name, value) => ctx.set(name, value),
              send: (message) => ctx.objectSendClient(TelegramSenderApi, message.chatId)
                .send(message, restate.rpc.sendOpts({ idempotencyKey: message.key })),
            }, core, event as OpenManualEvent)),
      ),
      designFinished: restate.handlers.object.exclusive(
        { idempotencyRetention: { days: 7 }, journalRetention: { days: 7 } },
        async (ctx: restate.ObjectContext, event: DesignFinishedEvent) =>
          withInvocationLogContext(ctx, { requestId: event?.requestId }, () => recordDesignFinished({
            key: ctx.key,
            get: (name) => ctx.get<ManualLifecycleState | AutomaticLifecycleState>(name),
            run: (name, action) => ctx.run(name, action, OUTCOME_RETRY),
            set: (name, value) => ctx.set(name, value),
            send: (message) => ctx.objectSendClient(TelegramSenderApi, message.chatId)
              .send(message, restate.rpc.sendOpts({ idempotencyKey: message.key })),
            startDesign: () => { throw new Error('designFinished cannot start a new run'); },
          }, core, event)),
      ),
      officeDecision: restate.handlers.object.exclusive(
        { idempotencyRetention: { days: 7 }, journalRetention: { days: 7 } },
        async (ctx: restate.ObjectContext, event: OfficeRevisionEvent) =>
          withInvocationLogContext(ctx, { requestId: event?.requestId }, () => recordOfficeRevision({
            key: ctx.key,
            get: (name) => ctx.get<ManualLifecycleState | AutomaticLifecycleState>(name),
            run: (name, action) => ctx.run(name, action, PROJECT_RETRY),
            set: (name, value) => ctx.set(name, value),
            send: () => { throw new Error('officeDecision cannot send from this transition'); },
            startDesign: () => { throw new Error('officeDecision cannot start a run from this transition'); },
          }, core, event)),
      ),
      get: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext): Promise<ManualLifecycleState | AutomaticLifecycleState | null> =>
        (await ctx.get<ManualLifecycleState | AutomaticLifecycleState>('lc')) ?? null),
    },
    options: {
      ingressPrivate: true,
      inactivityTimeout: { minutes: 1 }, abortTimeout: { minutes: 5 },
      retryPolicy: { initialInterval: 1000, exponentiationFactor: 2, maxInterval: 60_000, maxAttempts: 300, onMaxAttempts: 'pause' },
    },
  });
}

/** Stable client definition shared by DesignRun and the worker endpoint. */
export const RequestLifecycleApi = createRequestLifecycle();
