/**
 * The one vocabulary for a task's status (architecture programme 1.2).
 *
 * Until 2026-09-24 there were five lists: the database enum (22 states), Task.schema.json (21),
 * OpenAPI, the domain's TaskStatus (19) and the Desk (22 plus aliases), and Core set words on its
 * in-memory tasks that none of them had (IN_PROGRESS, CHANGES_REQUESTED, COMPLETED,
 * DESIGN_IN_PROGRESS, CLARIFICATION_REQUIRED). A word one layer did not know silently became
 * 'received', and the Desk showed six states as RECEIVED. Every list is now this file: the database
 * enum and its API names, the mapping between them, the legal moves, the Desk's labels, and which
 * statuses can be approved, are finished, or are being worked on. The JSON schema and OpenAPI enums
 * are generated from it (scripts/generate_task_status_contract.ts), and a contract test fails when
 * any layer disagrees or adds a word.
 *
 * This file imports nothing, so the Desk bundles it straight from source.
 */

/** Every value of the database's `task_state` enum (db/schema.sql), in its declared order. */
export const TASK_DB_STATES = [
  'received', 'promotion_pending', 'routing', 'routing_review', 'brief_draft', 'brief_review',
  'context_ready', 'design_planning', 'asset_production', 'studio_composition', 'qa',
  'auto_repair', 'human_review', 'revision_requested', 'approved', 'publishing', 'complete',
  'paused', 'failed_retryable', 'failed_operator', 'cancelled', 'rejected',
] as const;
export type TaskDbState = (typeof TASK_DB_STATES)[number];

/** Every status the API reports and the Desk shows, in the order a task usually moves through them. */
export const TASK_API_STATUSES = [
  'RECEIVED', 'PROMOTION_PENDING', 'ROUTING', 'ROUTING_REVIEW', 'BRIEFING', 'BRIEF_REVIEW',
  'PLANNING', 'ASSET_GENERATION', 'COMPOSING', 'QA', 'REPAIRING', 'AWAITING_APPROVAL',
  'REVISION_REQUESTED', 'APPROVED', 'PUBLISHING', 'PUBLISH_RECONCILIATION', 'COMPLETE',
  'PAUSED', 'OPERATOR_REQUIRED', 'REJECTED', 'CANCELLED',
] as const;
export type TaskApiStatus = (typeof TASK_API_STATUSES)[number];

/**
 * The API status of each database state. Two pairs share a status: `context_ready` reads as
 * BRIEFING (the brief is still being made) and `failed_retryable` as OPERATOR_REQUIRED (the office
 * sees one "needs a designer" either way).
 */
export const API_STATUS_OF_DB_STATE: Readonly<Record<TaskDbState, TaskApiStatus>> = {
  received: 'RECEIVED',
  promotion_pending: 'PROMOTION_PENDING',
  routing: 'ROUTING',
  routing_review: 'ROUTING_REVIEW',
  brief_draft: 'BRIEFING',
  brief_review: 'BRIEF_REVIEW',
  context_ready: 'BRIEFING',
  design_planning: 'PLANNING',
  asset_production: 'ASSET_GENERATION',
  studio_composition: 'COMPOSING',
  qa: 'QA',
  auto_repair: 'REPAIRING',
  human_review: 'AWAITING_APPROVAL',
  revision_requested: 'REVISION_REQUESTED',
  approved: 'APPROVED',
  publishing: 'PUBLISHING',
  complete: 'COMPLETE',
  paused: 'PAUSED',
  failed_retryable: 'OPERATOR_REQUIRED',
  failed_operator: 'OPERATOR_REQUIRED',
  cancelled: 'CANCELLED',
  rejected: 'REJECTED',
};

/**
 * The database state each API status is stored as. PUBLISH_RECONCILIATION (the files are in Drive,
 * the Sheets row is not confirmed) has no state of its own and is stored as `publishing`, so a task
 * read back from the database reports PUBLISHING until the row is retried.
 */
export const DB_STATE_OF_API_STATUS: Readonly<Record<TaskApiStatus, TaskDbState>> = {
  RECEIVED: 'received',
  PROMOTION_PENDING: 'promotion_pending',
  ROUTING: 'routing',
  ROUTING_REVIEW: 'routing_review',
  BRIEFING: 'brief_draft',
  BRIEF_REVIEW: 'brief_review',
  PLANNING: 'design_planning',
  ASSET_GENERATION: 'asset_production',
  COMPOSING: 'studio_composition',
  QA: 'qa',
  REPAIRING: 'auto_repair',
  AWAITING_APPROVAL: 'human_review',
  REVISION_REQUESTED: 'revision_requested',
  APPROVED: 'approved',
  PUBLISHING: 'publishing',
  PUBLISH_RECONCILIATION: 'publishing',
  COMPLETE: 'complete',
  PAUSED: 'paused',
  OPERATOR_REQUIRED: 'failed_operator',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
};

const DB_STATE_SET: ReadonlySet<string> = new Set(TASK_DB_STATES);
const API_STATUS_SET: ReadonlySet<string> = new Set(TASK_API_STATUSES);

export function isTaskDbState(word: unknown): word is TaskDbState {
  return typeof word === 'string' && DB_STATE_SET.has(word);
}

export function isTaskApiStatus(word: unknown): word is TaskApiStatus {
  return typeof word === 'string' && API_STATUS_SET.has(word);
}

/** A status word no layer defines. It is refused, never read as 'received'. */
export class UnknownTaskStatusError extends Error {
  readonly word: string;
  constructor(word: unknown) {
    super(`Unknown task status ${JSON.stringify(word)}: it is neither a database state (${TASK_DB_STATES.join(', ')}) nor an API status (${TASK_API_STATUSES.join(', ')})`);
    this.name = 'UnknownTaskStatusError';
    this.word = String(word);
  }
}

/**
 * The database state for a status word: an API status (upper case) or a database state (lower case)
 * as it is. Anything else throws; this used to return 'received' for every word it did not know.
 */
export function toDbTaskState(word: string): TaskDbState {
  if (isTaskDbState(word)) return word;
  if (isTaskApiStatus(word)) return DB_STATE_OF_API_STATUS[word];
  throw new UnknownTaskStatusError(word);
}

/** The API status for a status word: a database state (lower case) or an API status as it is. Anything else throws. */
export function toApiTaskStatus(word: string): TaskApiStatus {
  if (isTaskApiStatus(word)) return word;
  if (isTaskDbState(word)) return API_STATUS_OF_DB_STATE[word];
  throw new UnknownTaskStatusError(word);
}

/**
 * The legal moves between API statuses. Taken from the domain state machine as it stood on
 * 2026-09-24 and reconciled with what Core records:
 *  - NEEDS_INFORMATION is gone: it had no database state (it was stored as 'received'), and PAUSED is
 *    the same wait for the requester. Its moves are PAUSED's.
 *  - PROMOTION_PENDING, PAUSED and CANCELLED are database states the domain did not have.
 *  - A design outcome (canva-task-outcome transitionTaskForOutcome) moves a task from any state before
 *    its first outcome, and from OPERATOR_REQUIRED after a re-drive, to AWAITING_APPROVAL (a draft),
 *    OPERATOR_REQUIRED (no draft) or PAUSED (a question to the requester).
 *  - A checked Canva export after a revision request becomes the new revision to review
 *    (REVISION_REQUESTED → AWAITING_APPROVAL, recordCheckedExportQc).
 *  - An answered question closes the paused task (PAUSED → CANCELLED, closeAnsweredQuestion).
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskApiStatus, readonly TaskApiStatus[]>> = {
  RECEIVED: ['ROUTING', 'AWAITING_APPROVAL', 'OPERATOR_REQUIRED', 'PAUSED'],
  PROMOTION_PENDING: ['RECEIVED', 'REJECTED', 'AWAITING_APPROVAL', 'OPERATOR_REQUIRED', 'PAUSED'],
  ROUTING: ['ROUTING_REVIEW', 'PAUSED', 'BRIEFING', 'AWAITING_APPROVAL', 'OPERATOR_REQUIRED'],
  ROUTING_REVIEW: ['ROUTING', 'PAUSED', 'BRIEFING', 'REJECTED', 'AWAITING_APPROVAL', 'OPERATOR_REQUIRED'],
  BRIEFING: ['BRIEF_REVIEW', 'PLANNING', 'PAUSED', 'OPERATOR_REQUIRED', 'AWAITING_APPROVAL'],
  BRIEF_REVIEW: ['PLANNING', 'PAUSED', 'OPERATOR_REQUIRED', 'REJECTED', 'AWAITING_APPROVAL'],
  PLANNING: ['ASSET_GENERATION', 'COMPOSING', 'OPERATOR_REQUIRED', 'AWAITING_APPROVAL', 'PAUSED'],
  ASSET_GENERATION: ['COMPOSING', 'OPERATOR_REQUIRED', 'AWAITING_APPROVAL', 'PAUSED'],
  COMPOSING: ['QA', 'OPERATOR_REQUIRED', 'AWAITING_APPROVAL', 'PAUSED'],
  QA: ['REPAIRING', 'AWAITING_APPROVAL', 'OPERATOR_REQUIRED', 'PAUSED'],
  REPAIRING: ['COMPOSING', 'QA', 'OPERATOR_REQUIRED', 'AWAITING_APPROVAL', 'PAUSED'],
  AWAITING_APPROVAL: ['REVISION_REQUESTED', 'REJECTED', 'APPROVED', 'OPERATOR_REQUIRED'],
  REVISION_REQUESTED: ['PLANNING', 'COMPOSING', 'OPERATOR_REQUIRED', 'AWAITING_APPROVAL'],
  APPROVED: ['PUBLISHING', 'AWAITING_APPROVAL', 'REVISION_REQUESTED'],
  // Back to APPROVED when the delivery failed before any file reached Drive, so it can be retried.
  PUBLISHING: ['COMPLETE', 'PUBLISH_RECONCILIATION', 'OPERATOR_REQUIRED', 'APPROVED'],
  PUBLISH_RECONCILIATION: ['COMPLETE', 'OPERATOR_REQUIRED'],
  COMPLETE: [],
  PAUSED: ['ROUTING', 'BRIEFING', 'REJECTED', 'CANCELLED'],
  OPERATOR_REQUIRED: ['ROUTING', 'BRIEFING', 'PLANNING', 'COMPOSING', 'QA', 'AWAITING_APPROVAL', 'PUBLISHING', 'REJECTED', 'PAUSED'],
  REJECTED: [],
  CANCELLED: [],
};

export function canTransitionTaskStatus(from: TaskApiStatus, to: TaskApiStatus): boolean {
  return (TASK_TRANSITIONS[from] || []).includes(to);
}

/** What the Desk shows for each status (the status pill). The wording is the Desk's of 2026-09-24. */
export const TASK_STATUS_LABELS: Readonly<Record<TaskApiStatus, string>> = {
  RECEIVED: 'RECEIVED',
  PROMOTION_PENDING: 'STARTING',
  ROUTING: 'ROUTING',
  ROUTING_REVIEW: 'CHECK CLIENT',
  BRIEFING: 'BRIEFING',
  BRIEF_REVIEW: 'CHECK BRIEF',
  PLANNING: 'PLANNING',
  ASSET_GENERATION: 'MAKING IMAGES',
  COMPOSING: 'BEING MADE',
  QA: 'CHECKING',
  REPAIRING: 'CORRECTING',
  AWAITING_APPROVAL: 'NEEDS APPROVAL',
  REVISION_REQUESTED: 'CHANGES REQUESTED',
  APPROVED: 'APPROVED',
  PUBLISHING: 'DELIVERING',
  PUBLISH_RECONCILIATION: 'SHEETS ROW PENDING',
  COMPLETE: 'COMPLETE',
  PAUSED: 'WAITING FOR ANSWER',
  OPERATOR_REQUIRED: 'NEEDS A DESIGNER',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
};

/**
 * The statuses a person may approve a design in: a draft with a person (AWAITING_APPROVAL). The Desk
 * used to allow every status it had not listed as refused, including one it did not know.
 * PUBLISHING also moves to APPROVED, but that is Core putting back a delivery that failed before any
 * file reached Drive, not a person's approval.
 */
export const APPROVABLE_TASK_STATUSES: readonly TaskApiStatus[] = ['AWAITING_APPROVAL'];

/** The statuses nothing moves a task out of. */
export const TERMINAL_TASK_STATUSES: readonly TaskApiStatus[] = TASK_API_STATUSES.filter((s) => TASK_TRANSITIONS[s].length === 0);

/** The statuses in which Core or the worker is working on the task and no person has a move to make. */
export const IN_PROGRESS_TASK_STATUSES: readonly TaskApiStatus[] = [
  'PROMOTION_PENDING', 'ROUTING', 'BRIEFING', 'PLANNING', 'ASSET_GENERATION', 'COMPOSING', 'QA', 'REPAIRING', 'PUBLISHING',
];

export function isApprovableTaskStatus(status: unknown): boolean {
  return isTaskApiStatus(status) && APPROVABLE_TASK_STATUSES.includes(status);
}

export function isTerminalTaskStatus(status: unknown): boolean {
  return isTaskApiStatus(status) && TERMINAL_TASK_STATUSES.includes(status);
}

export function isInProgressTaskStatus(status: unknown): boolean {
  return isTaskApiStatus(status) && IN_PROGRESS_TASK_STATUSES.includes(status);
}

/** The Desk's live stream event name for a task's move. */
export const TASK_TRANSITIONED_EVENT = 'task:transitioned';

/**
 * The one payload of `task:transitioned`. It had four shapes (`{status}`, `{fromStatus, toStatus}`,
 * `{action}`, mixes of them) with database words upper-cased in some ('HUMAN_REVIEW').
 */
export interface TaskTransitionedEvent {
  taskId: string;
  /** The status before the move; null for a task that did not exist before it. */
  from: TaskApiStatus | null;
  to: TaskApiStatus;
  /**
   * The tasks.version the move wrote; null when the move was not written to the database. A later
   * write in the same transaction (the new revision of a draft) can raise the stored version again.
   */
  version: number | null;
  /** When the move happened (ISO 8601). */
  at: string;
}

export const TASK_TRANSITIONED_KEYS = ['taskId', 'from', 'to', 'version', 'at'] as const;

/**
 * Builds the event from database states or API statuses. An unknown word, a missing task id or a
 * version that is not a positive integer throws, so no layer can send a word the others do not know.
 */
export function taskTransitioned(input: {
  taskId: string;
  from?: string | null;
  to: string;
  version?: number | string | null;
  at?: string | Date;
}): TaskTransitionedEvent {
  if (typeof input.taskId !== 'string' || !input.taskId) throw new Error('task:transitioned needs a task id');
  const version = input.version === undefined || input.version === null ? null : Number(input.version);
  if (version !== null && !(Number.isInteger(version) && version >= 1)) throw new Error(`task:transitioned version ${JSON.stringify(input.version)} is not a task version`);
  const at = input.at instanceof Date ? input.at.toISOString() : input.at || new Date().toISOString();
  return {
    taskId: input.taskId,
    from: input.from === undefined || input.from === null ? null : toApiTaskStatus(input.from),
    to: toApiTaskStatus(input.to),
    version,
    at,
  };
}

/**
 * Reads a `task:transitioned` payload from the stream: the event, or null when it is not one (a
 * missing field, an extra field or a status word this vocabulary does not have). Never guesses.
 */
export function parseTaskTransitioned(data: unknown): TaskTransitionedEvent | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  // The stream adds the tenant to every event it sends; it is not part of the payload.
  const keys = Object.keys(d).filter((k) => k !== 'tenantId');
  if (keys.length !== TASK_TRANSITIONED_KEYS.length || !TASK_TRANSITIONED_KEYS.every((k) => keys.includes(k))) return null;
  if (typeof d.taskId !== 'string' || !d.taskId || typeof d.at !== 'string') return null;
  if (!isTaskApiStatus(d.to) || !(d.from === null || isTaskApiStatus(d.from))) return null;
  if (!(d.version === null || (typeof d.version === 'number' && Number.isInteger(d.version) && d.version >= 1))) return null;
  return { taskId: d.taskId, from: d.from as TaskApiStatus | null, to: d.to, version: d.version as number | null, at: d.at };
}
