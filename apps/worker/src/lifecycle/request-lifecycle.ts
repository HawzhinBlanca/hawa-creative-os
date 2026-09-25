/**
 * First RequestLifecycle handler (ADR-034, Phase 2.3). It can open a manual Telegram request with
 * one Core projection and a fenced acknowledgement. ChatInbox does not route here yet. Automatic
 * design, questions, office decisions and delivery remain closed until their handlers are ready.
 * Once bound, the service name stays in every worker build for blue/green drain compatibility.
 */
import { createHash } from 'node:crypto';
import * as restate from '@restatedev/restate-sdk';
import type { OutboundMessage } from '@hawa/contracts';
import { withInvocationLogContext } from '../logging.js';
import { coreInternalFromEnv, type CoreInternal } from './delivery.js';
import { TelegramSenderApi } from './telegram-sender.js';

const DEFAULT_TENANT_ID = '00000000-0000-4000-a000-000000000001';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT_RETRY = { initialRetryInterval: 2000, retryIntervalFactor: 2, maxRetryInterval: 30_000, maxRetryDuration: 30 * 60_000 };

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

const hashOf = (event: OpenManualEvent) => createHash('sha256').update(canonical(event)).digest('hex');
const invalid = (reason: string) => new restate.TerminalError(`LIFECYCLE_OPEN_REFUSED: ${reason}`, { errorCode: 409 });

function sendAcknowledgement(ctx: OpenContext, state: ManualLifecycleState): void {
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

export function createRequestLifecycle(core: CoreInternal = coreInternalFromEnv()) {
  return restate.object({
    name: 'RequestLifecycle',
    handlers: {
      open: restate.handlers.object.exclusive(
        { idempotencyRetention: { days: 7 }, journalRetention: { days: 7 } },
        async (ctx: restate.ObjectContext, event: OpenManualEvent): Promise<OpenManualResult> =>
          withInvocationLogContext(ctx, { requestId: event?.requestId, tenantId: event?.tenantId }, () =>
            openManualRequest({
              key: ctx.key,
              get: (name) => ctx.get<ManualLifecycleState>(name),
              run: (name, action) => ctx.run(name, action, PROJECT_RETRY),
              set: (name, value) => ctx.set(name, value),
              send: (message) => ctx.objectSendClient(TelegramSenderApi, message.chatId)
                .send(message, restate.rpc.sendOpts({ idempotencyKey: message.key })),
            }, core, event)),
      ),
      get: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext): Promise<ManualLifecycleState | null> =>
        (await ctx.get<ManualLifecycleState>('lc')) ?? null),
    },
    options: {
      ingressPrivate: true,
      inactivityTimeout: { minutes: 1 }, abortTimeout: { minutes: 5 },
      retryPolicy: { initialInterval: 1000, exponentiationFactor: 2, maxInterval: 60_000, maxAttempts: 300, onMaxAttempts: 'pause' },
    },
  });
}
