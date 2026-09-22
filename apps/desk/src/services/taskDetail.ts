/**
 * The Work queue lists tasks from `GET /tasks`, which carries no captured preview: only
 * `GET /tasks/:id` returns the stored export as `latestRevision.previewUrl`. The Desk used to call the
 * detail route only after an action (capture, decision, delivery), so a design that existed showed
 * "No captured design yet" until the operator pressed a button. The selected task's detail is now
 * read whenever a task is selected, and after every reload of the queue.
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
