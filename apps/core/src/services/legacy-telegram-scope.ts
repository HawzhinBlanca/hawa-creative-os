/**
 * The old Telegram intake finishes the requests it started and starts no new ones (ADR-135).
 *
 * Every Telegram chat is owned by RequestLifecycle. Core's legacy intake (`/webhooks/telegram`,
 * services/telegram-intake/) is still reached for work that belongs to a request it created before
 * the switch: a reply to one of its drafts, a press of one of its buttons, a change to the chat's
 * open legacy request, and the answers to questions and greetings the lifecycle path delegates to
 * it. In that scope it must not create a task that is not part of an open legacy request.
 *
 * The scope is "finish-only" when Core runs in production, whoever calls the route, and when the
 * internal intake hands an update on with FINISH_ONLY_HEADER. A caller outside production without
 * the header (the unit tests that build legacy tasks as fixtures) keeps the old behaviour; stage 2
 * of the retirement deletes the new-request stage with those fixtures
 * (plans/lean-design-implementation-2026-09-28/LEGACY_PATH_RETIREMENT.md).
 *
 * Two guards apply the rule. The route refuses its "new request" stage before it sends anything.
 * persistChatIntake, which every legacy task creation goes through, refuses a Telegram task outside
 * the lifecycle unless it continues an open legacy request of the same chat (a backstop for the
 * readers that create revisions, answers, reformats and reference tasks).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Sent by Core's internal intake with the value `finish-only`. It can only make intake stricter. */
export const FINISH_ONLY_HEADER = 'x-hawa-intake-scope';

export type LegacyRefusalReason =
  /** The update would have started a new request. */
  | 'NEW_REQUEST'
  /** The update would have extended a legacy request that is finished (complete, rejected or cancelled). */
  | 'REQUEST_CLOSED'
  /** The update would have extended a request RequestLifecycle owns. */
  | 'LIFECYCLE_OWNED';

/** The answer code the legacy route gives, and the internal intake passes on. */
export const LEGACY_REQUEST_REFUSED = 'LEGACY_REQUEST_REFUSED';

export class LegacyTelegramRequestRefused extends Error {
  constructor(readonly reason: LegacyRefusalReason) {
    super(`Legacy Telegram intake starts no new work (${reason}); new requests go through RequestLifecycle (ADR-135)`);
    this.name = 'LegacyTelegramRequestRefused';
  }
}

const scope = new AsyncLocalStorage<{ finishOnly: boolean }>();

/** Run one legacy intake call in its scope. */
export function runLegacyTelegramIntake<T>(finishOnly: boolean, fn: () => Promise<T>): Promise<T> {
  return scope.run({ finishOnly }, fn);
}

/** Whether the legacy intake call this code runs in may only finish open legacy requests. */
export function legacyTelegramFinishOnly(): boolean {
  return scope.getStore()?.finishOnly === true;
}
