import { getAuthHeaders } from './auth.js';
import type { ActiveDraft } from './draftStore.js';

const DOCUMENT_PENDING_KEY = 'hawa_desk_pending_document_intake_v1';
const PENDING_KEY = 'hawa_desk_pending_manual_intake_v1';

export function getPendingManualDraft(key = PENDING_KEY): Omit<ActiveDraft, 'savedAt'> | null {
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw).draft || null : null;
}

/** Freeze the whole request before the side effect. Uncertain replies retry the same key/body. */
export const getPendingDocumentDraft = () => getPendingManualDraft(DOCUMENT_PENDING_KEY);
export const submitDocumentTask = (draft: Omit<ActiveDraft, 'savedAt'>) => submitManualTask(draft, DOCUMENT_PENDING_KEY);

export async function submitManualTask(draft: Omit<ActiveDraft, 'savedAt'>, pendingKey = PENDING_KEY) {
  if (!navigator.onLine) throw new Error('You are offline. Your draft is retained. Reconnect and press Save request.');
  const body = JSON.stringify({
    clientId: draft.clientId, title: draft.title, priority: 'routine',
    description: [draft.copy, draft.copyCkb].filter(Boolean).join('\n\n'),
    copyEn: draft.copy, copyCkb: draft.copyCkb || '',
    designInstructions: draft.designInstructions || '', referenceAssets: draft.referenceAssets || '',
    workflow: 'canva_manual',
    ...(draft.sourceDocument ? { sourceDocument: draft.sourceDocument } : {}),
    source: { platform: 'hawa_desk', externalId: 'operator-desk' },
  });
  const raw = localStorage.getItem(pendingKey);
  const pending = raw ? JSON.parse(raw) as { key: string; body: string; draft?: Omit<ActiveDraft, 'savedAt'> } : { key: `task-desk-${crypto.randomUUID()}`, body, draft };
  if (pending.body !== body) throw new Error('The previous request has an unconfirmed result. Close and reopen this form to restore it, then retry before submitting a different request.');
  localStorage.setItem(pendingKey, JSON.stringify(pending));
  let response: Response;
  try {
    response = await fetch('/v1/tasks', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'Idempotency-Key': pending.key, ...getAuthHeaders(),
    }, body: pending.body, signal: AbortSignal.timeout(30000) });
  } catch {
    throw new Error('The server result is unconfirmed. Your full draft is retained. Retry unchanged to avoid a duplicate task.');
  }
  if (!response.ok) {
    // A first, definitive refusal made no task. An earlier uncertain request keeps its frozen
    // identity even if a later auth/scope check refuses it; its original commit is still unknown.
    if (!raw && [400, 401, 403, 404, 422].includes(response.status)) {
      localStorage.removeItem(pendingKey);
      if (draft.sourceDocument && response.status === 403) {
        const problem = await response.json().catch(() => null);
        if (typeof problem?.detail === 'string') throw new Error(problem.detail.slice(0, 500));
      }
      throw new Error(`Request was refused (HTTP ${response.status}). Your draft is retained. Correct the client or access problem, then save again.`);
    }
    throw new Error(`Request was not confirmed (HTTP ${response.status}). Your full draft is retained. Retry unchanged after the problem is resolved.`);
  }
  const task = await response.json();
  if (typeof task.id !== 'string' || !task.id) throw new Error('The server did not return a task ID. Retry unchanged; your draft is retained.');
  localStorage.removeItem(pendingKey);
  return task;
}
