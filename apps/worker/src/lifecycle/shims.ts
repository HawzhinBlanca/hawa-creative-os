/**
 * Every Restate handler any worker build ever hosted, and the shims that stand in for retired ones
 * (architecture programme Phase 2; PHASE2_DESIGN.md section 4 rule 2, ADR-034).
 *
 * A handler is never simply removed. Something may still target it long after the code that sent to
 * it is gone: a delayed send (a reminder up to 5 days ahead, the expiry 14 days ahead, a projection
 * retried 10 minutes ahead), an ingress idempotency key kept for 7 days, an invocation in flight on
 * the draining colour. Restate routes such an invocation to whatever deployment now serves the
 * service; if that build lacks the handler, the invocation fails there for good.
 *
 * So a retired handler becomes a shim (`shimHandler`): it logs what it was sent and answers neutrally,
 * and stays bound until `retiredAt` + 21 days, past the longest of those windows. HANDLERS_EVER is the
 * checked-in record. The worker refuses to start when it binds less than the record requires
 * (missingHandlers, called from index.ts), and apps/worker/test/lifecycle-shims.test.ts checks the
 * same against the services the build defines.
 *
 * To retire a handler: set its `retiredAt`, replace its body with `shimHandler(...)`, and keep it
 * bound. After `retiredAt + 21 d` it may be unbound; its entry stays.
 */
import { log } from '../logging.js';

/** How long a retired handler's shim stays bound: past every delayed send and idempotency window. */
export const SHIM_KEEP_DAYS = 21;

export interface HandlerRecord {
  service: string;
  handler: string;
  /** When it was first bound (the slice that added it). */
  since: string;
  /** When it became a shim (ISO date); absent while it is live. */
  retiredAt?: string;
}

/** Every handler ever bound. Only ever added to; an entry is never removed. */
export const HANDLERS_EVER: readonly HandlerRecord[] = [
  { service: 'TaskWorkflow', handler: 'run', since: 'before-phase-2' },
  { service: 'TaskService', handler: 'runTask', since: 'before-phase-2' },
  { service: 'ChatInbox', handler: 'handleUpdate', since: '2.1' },
  { service: 'ChatInbox', handler: 'get', since: '2.1' },
  { service: 'Delivery', handler: 'run', since: '2.2' },
  { service: 'TelegramSender', handler: 'send', since: '2.2' },
  { service: 'RequestLifecycle', handler: 'open', since: '2.3' },
  { service: 'RequestLifecycle', handler: 'designFinished', since: '2.3' },
  { service: 'RequestLifecycle', handler: 'answer', since: '2.3' },
  { service: 'RequestLifecycle', handler: 'requesterDecision', since: '2.3' },
  { service: 'RequestLifecycle', handler: 'officeDecision', since: '2.3' },
  { service: 'RequestLifecycle', handler: 'deliveryFinished', since: '2.3' },
  { service: 'RequestLifecycle', handler: 'messageSent', since: '2.3' },
  { service: 'RequestLifecycle', handler: 'remind', since: '2.3' },
  { service: 'RequestLifecycle', handler: 'expire', since: '2.3' },
  { service: 'RequestLifecycle', handler: 'cancel', since: '2.3' },
  { service: 'RequestLifecycle', handler: 'retryProjection', since: '2.3' },
  { service: 'RequestLifecycle', handler: 'get', since: '2.3' },
  { service: 'DesignRun', handler: 'run', since: '2.3' },
];

const DAY_MS = 86_400_000;

/** Whether a handler must still be bound at `now`: live, or retired less than SHIM_KEEP_DAYS ago. */
export function mustBeBound(record: HandlerRecord, now: number): boolean {
  if (!record.retiredAt) return true;
  const retired = Date.parse(record.retiredAt);
  // An unreadable date keeps the shim: removing a handler too early loses invocations, too late costs nothing.
  return !Number.isFinite(retired) || now < retired + SHIM_KEEP_DAYS * DAY_MS;
}

/** A Restate service definition as restate.service/object/workflow return it. */
export interface BoundDefinition {
  name: string;
  service?: Record<string, unknown>;
  object?: Record<string, unknown>;
  workflow?: Record<string, unknown>;
}

export function handlersOf(def: BoundDefinition): string[] {
  return Object.keys(def.service ?? def.object ?? def.workflow ?? {});
}

/** `service/handler` of every handler the record requires at `now` that the bound services lack. */
export function missingHandlers(bound: readonly BoundDefinition[], record: readonly HandlerRecord[] = HANDLERS_EVER, now: number = Date.now()): string[] {
  const have = new Set(bound.flatMap((def) => handlersOf(def).map((h) => `${def.name}/${h}`)));
  return record.filter((r) => mustBeBound(r, now) && !have.has(`${r.service}/${r.handler}`)).map((r) => `${r.service}/${r.handler}`);
}

/**
 * The body of a retired handler: it logs what it was sent and answers `neutral`, so a late delayed
 * send or a retry of an old invocation ends quietly instead of failing on a build without it.
 */
export function shimHandler<T>(service: string, handler: string, neutral: T) {
  return async (_ctx: unknown, payload?: unknown): Promise<T> => {
    log.warn(`[shim] ${service}/${handler} is retired; it was sent ${JSON.stringify(payload ?? null).slice(0, 300)} and did nothing`);
    return neutral;
  };
}
