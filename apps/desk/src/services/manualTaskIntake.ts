import { getAuthHeaders } from './auth.js';
import { draftStore, type ActiveDraft } from './draftStore.js';

const DOCUMENT_PENDING_KEY = 'hawa_desk_pending_document_intake_v1';
const PENDING_KEY = 'hawa_desk_pending_manual_intake_v1';

interface PendingIntake { key: string; body: string; draft: Omit<ActiveDraft, 'savedAt'> }

function readPending(key: string): PendingIntake | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const value = JSON.parse(raw) as PendingIntake | null;
    if (!value || typeof value.key !== 'string' || !value.key || typeof value.body !== 'string' ||
        !value.draft || typeof value.draft.title !== 'string' || typeof value.draft.copy !== 'string') throw new Error();
    return value;
  } catch {
    throw new Error('The saved retry record cannot be read. Saving is blocked to avoid a duplicate request. Keep this browser data and ask an operator to reconcile the earlier save.');
  }
}

export function getPendingManualDraft(key = PENDING_KEY): Omit<ActiveDraft, 'savedAt'> | null {
  return readPending(key)?.draft ?? null;
}

/** Freeze the whole request before the side effect. Uncertain replies retry the same key/body. */
export const getPendingDocumentDraft = () => getPendingManualDraft(DOCUMENT_PENDING_KEY);
export const submitDocumentTask = (draft: Omit<ActiveDraft, 'savedAt'>) => submitManualTask(draft, DOCUMENT_PENDING_KEY);

function sameRequestApartFromWorkflow(frozen: string, current: string): boolean {
  try {
    const [a, b] = [JSON.parse(frozen), JSON.parse(current)] as Array<Record<string, unknown>>;
    delete a.workflow; delete b.workflow;
    return JSON.stringify(a) === JSON.stringify(b);
  } catch { return false; }
}

export async function submitManualTask(draft: Omit<ActiveDraft, 'savedAt'>, pendingKey = PENDING_KEY) {
  if (!navigator.onLine) throw new Error('You are offline. Your draft is retained. Reconnect and press Save request.');
  const body = JSON.stringify({
    clientId: draft.clientId, title: draft.title, priority: 'routine',
    description: [draft.copy, draft.copyCkb].filter(Boolean).join('\n\n'),
    copyEn: draft.copy, copyCkb: draft.copyCkb || '',
    designInstructions: draft.designInstructions || '', referenceAssets: draft.referenceAssets || '',
    // ADR-287 and its addendum: "New task" and a reviewed PDF request both open a request on the request
    // lifecycle (drafts, review, approval, delivery). A PDF request carries the reviewed receipt it names.
    workflow: 'office_request',
    ...(draft.sourceDocument ? { sourceDocument: draft.sourceDocument } : {}),
    source: { platform: 'hawa_desk', externalId: 'operator-desk' },
  });
  const saved = readPending(pendingKey);
  const pending = saved ?? { key: `task-desk-${crypto.randomUUID()}`, body, draft };
  // A request frozen by an earlier Desk release differs only in its workflow; it is retried exactly as it
  // was sent, so the same key gets the same answer.
  if (pending.body !== body && !sameRequestApartFromWorkflow(pending.body, body)) throw new Error('The previous request has an unconfirmed result. Close and reopen this form to restore it, then retry before submitting a different request.');
  localStorage.setItem(pendingKey, JSON.stringify(pending));
  let response: Response;
  try {
    response = await fetch('/v1/tasks', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'Idempotency-Key': pending.key, ...getAuthHeaders(),
    }, body: pending.body, credentials: 'same-origin', signal: AbortSignal.timeout(30000) });
  } catch {
    throw new Error('The server result is unconfirmed. Your full draft is retained. Retry unchanged to avoid a duplicate task.');
  }
  if (!response.ok) {
    // A first, definitive refusal made no task. An earlier uncertain request keeps its frozen
    // identity even if a later auth/scope check refuses it; its original commit is still unknown.
    // A PDF request's 409 on a fresh key is its reviewed evidence changing, which made nothing either.
    if (!saved && [400, 401, 403, 404, 422, ...(draft.sourceDocument ? [409] : [])].includes(response.status)) {
      localStorage.removeItem(pendingKey);
      if ([403, 409, 422].includes(response.status)) {
        const problem = await response.json().catch(() => null);
        if (typeof problem?.detail === 'string') throw new Error(problem.detail.slice(0, 500));
      }
      throw new Error(`Request was refused (HTTP ${response.status}). Your draft is retained. Correct the client or access problem, then save again.`);
    }
    throw new Error(`Request was not confirmed (HTTP ${response.status}). Your full draft is retained. Retry unchanged after the problem is resolved.`);
  }
  const task = await response.json();
  if (typeof task.id !== 'string' || !task.id) throw new Error('The server did not return a task ID. Retry unchanged; your draft is retained.');
  try {
    // Retain the idempotency record until cleanup succeeds. Otherwise a saved
    // draft left behind by denied storage can be submitted with a fresh key.
    if (pendingKey === PENDING_KEY) draftStore.clearActiveDraft();
    localStorage.removeItem(pendingKey);
  } catch {
    throw new Error('Request saved, but this browser could not clear its local draft. Retry unchanged to recover the same task; do not create a replacement request.');
  }
  return task;
}
