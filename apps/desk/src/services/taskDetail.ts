/**
 * The Work queue lists tasks from `GET /tasks`, which carries no captured preview: only
 * `GET /tasks/:id` returns the stored export as `latestRevision.previewUrl`. The Desk used to call the
 * detail route only after an action (capture, decision, delivery), so a design that existed showed
 * "No captured design yet" until the operator pressed a button. The selected task's detail is now
 * read whenever a task is selected, after every reload of the queue, after a timed refresh that
 * shows it changed, and on every live event that names it.
 */

export interface TaskDetailApi {
  get<T = any>(taskId: string): Promise<T>;
}

/** The selected task's authoritative detail, or null when it cannot be read (the list entry stays). */
export async function loadTaskDetail<T extends { id: string }>(api: TaskDetailApi, taskId: string): Promise<T | null> {
  if (!taskId) return null;
  try {
    const detail = await api.get<T>(taskId);
    return detail && typeof detail === 'object' && detail.id === taskId ? detail : null;
  } catch {
    return null;
  }
}

/** The queue with the detail laid over its own entry; every other entry is left as it was. */
export function mergeTaskDetail<T extends { id: string }>(tasks: T[], detail: T | null): T[] {
  if (!detail) return tasks;
  return tasks.map((t) => (t.id === detail.id ? { ...t, ...detail } : t));
}

/** The fields of a queue entry this file compares and keeps; both routes return them. */
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

/**
 * The queue after a timed refresh (2026-09-24). The list replaces every entry, except that an entry
 * whose revision did not change keeps what only the detail read carries (the preview, its size and
 * the delivery receipt): replaced outright, the selected design's preview vanished every 30 seconds
 * until its detail was downloaded again.
 */
export function keepLoadedDetail<T extends QueueEntry>(prev: T[], items: T[]): T[] {
  const before = new Map(prev.map((t) => [t.id, t]));
  return items.map((item) => {
    const old = before.get(item.id);
    if (!old || !old.latestRevision || !item.latestRevision || old.latestRevision.id !== item.latestRevision.id) return item;
    return {
      ...item,
      latestRevision: { ...item.latestRevision, ...old.latestRevision },
      ...(item.deliveryReceipt === undefined && old.deliveryReceipt !== undefined ? { deliveryReceipt: old.deliveryReceipt } : {}),
    };
  });
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
