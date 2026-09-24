/**
 * The Work queue lists tasks from `GET /tasks`, which carries no captured preview: only
 * `GET /tasks/:id` returns the stored export as `latestRevision.previewUrl`. The Desk used to call the
 * detail route only after an action (capture, decision, delivery), so a design that existed showed
 * "No captured design yet" until the operator pressed a button. The selected task's detail is a query
 * of its own (`['task', id, 'detail']`, ADR-037): read when the task is selected, again on every live
 * event that names it, and, while the event stream is down, when the list shows the task changed.
 */

export interface TaskDetailApi {
  get<T = any>(taskId: string): Promise<T>;
}

/**
 * The selected task's authoritative detail. A failed read throws, so the query layer sees it (a 401
 * ends the session; any other failure leaves the list entry on screen); an answer about another task
 * is refused rather than shown.
 */
export async function readTaskDetail<T extends { id: string }>(api: TaskDetailApi, taskId: string): Promise<T> {
  const detail = await api.get<T>(taskId);
  if (!detail || typeof detail !== 'object' || detail.id !== taskId) {
    throw new Error(`Core answered for another task than ${taskId}`);
  }
  return detail;
}

/** The fields of a queue entry this file compares; both routes return them. */
export interface QueueEntry {
  id: string;
  status?: string;
  version?: number;
  updatedAt?: string;
  latestRevisionId?: string;
  latestRevision?: { id: string };
  latestApproval?: { decisionId: string };
  qaReport?: { passed: boolean };
  deliveryReceipt?: unknown;
}

/** Whether the list shows a task changed since it was last read (or it appeared or disappeared). */
export function queueEntryChanged(before: QueueEntry | undefined, after: QueueEntry | undefined): boolean {
  if (!before || !after) return before !== after;
  return (
    before.status !== after.status ||
    before.version !== after.version ||
    before.updatedAt !== after.updatedAt ||
    before.latestRevisionId !== after.latestRevisionId ||
    before.latestApproval?.decisionId !== after.latestApproval?.decisionId ||
    before.qaReport?.passed !== after.qaReport?.passed
  );
}
