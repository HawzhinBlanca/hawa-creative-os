import { useEffect, useRef, useState } from 'react';
import { apiClient, ApiError, type DocumentReceipt, type DocumentKnowledgeState, type DocumentKnowledgeChange } from '../api/client.js';

type Pending = { actionId: string; body: string };
const storageKey = (receipt: DocumentReceipt) => `hawa_document_knowledge_v1:${receipt.clientId}:${receipt.id}`;
function clearPending(receipt: DocumentReceipt, actionId: string) {
  if (pendingFor(receipt)?.actionId === actionId) localStorage.removeItem(storageKey(receipt));
}
function pendingFor(receipt: DocumentReceipt): Pending | null {
  try {
    const raw = localStorage.getItem(storageKey(receipt));
    if (!raw) return null;
    const pending = JSON.parse(raw) as Pending;
    const body = JSON.parse(pending.body) as DocumentKnowledgeChange;
    if (typeof pending.actionId !== 'string' || body.sourceSha256 !== receipt.sourceSha256 ||
      body.extractionSha256 !== receipt.extractionSha256) return null;
    return pending;
  } catch { return null; }
}

export function DocumentKnowledgePanel({ receipt, onChanged }: { receipt: DocumentReceipt; onChanged: () => void }) {
  const [status, setStatus] = useState<DocumentKnowledgeState | null>(null);
  const [pending, setPending] = useState<Pending | null>(() => pendingFor(receipt));
  const [reason, setReason] = useState(''), [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    generation.current++; setStatus(null); setPending(pendingFor(receipt)); setReason(''); setReviewed(false); setBusy(false); setError('');
    return () => { generation.current++; };
  }, [receipt.id, receipt.clientId]);
  const refresh = async () => {
    const current = generation.current; setBusy(true); setError('');
    try {
      const answer = await apiClient.clients.documentKnowledge(receipt.clientId, receipt.id);
      if (current !== generation.current) return;
      setStatus(answer);
      // A receipt from the ledger reconciles an uncertain action even after later revocation.
      if (pending && answer.events.some(e => e.actionId === pending.actionId)) {
        clearPending(receipt, pending.actionId); setPending(null); onChanged();
      }
    } catch (e) { if (current === generation.current) setError(e instanceof Error ? e.message : 'Reference approval unavailable.'); }
    finally { if (current === generation.current) setBusy(false); }
  };
  const change = async (approved: boolean) => {
    if (busy || (!pending && (!status?.canManage || !reason.trim() || (approved && !reviewed)))) return;
    const current = generation.current, wasPending = Boolean(pending);
    let actionId: string | undefined;
    setBusy(true); setError('');
    try {
      const action = pending ?? { actionId: crypto.randomUUID(), body: JSON.stringify({ approved,
        expectedVersion: status!.state.version, reviewed, reason,
        sourceSha256: receipt.sourceSha256, extractionSha256: receipt.extractionSha256 } satisfies DocumentKnowledgeChange) };
      const other = pendingFor(receipt);
      if (other && other.actionId !== action.actionId) {
        setPending(other); throw new Error('Another saved reference action needs reconciliation. Retry it unchanged.');
      }
      actionId = action.actionId;
      // Persist before the network call; a storage failure must not send an unrecoverable action.
      localStorage.setItem(storageKey(receipt), JSON.stringify(action)); setPending(action);
      const answer = await apiClient.clients.changeDocumentKnowledge(receipt.clientId, receipt.id, action.actionId, action.body);
      clearPending(receipt, action.actionId);
      if (current !== generation.current) return;
      setPending(null); setStatus(answer); setReason(''); setReviewed(false); onChanged();
    } catch (e) {
      if (current !== generation.current) return;
      if (!wasPending && e instanceof ApiError && [403, 404, 409, 422].includes(e.status)) {
        if (actionId) clearPending(receipt, actionId);
        setPending(null); setStatus(null); setReviewed(false);
      }
      setError(e instanceof Error ? e.message : 'The result is unconfirmed. Retry the saved action.');
    } finally { if (current === generation.current) setBusy(false); }
  };
  const locked = busy || Boolean(pending);
  return <section aria-label="Reference material approval">
    <h4>Reference material</h4>
    <p>A named client knowledge manager can make this PDF searchable. Check every page and the extraction limits first. Design copy and brand rules still require their own review.</p>
    <button className="btn" type="button" disabled={busy} onClick={() => void refresh()}>Check reference approval</button>
    {status && <p role="status">{status.state.approved ? 'Approved for reference search' : 'Not available in reference search'} · version {status.state.version}</p>}
    {status && !status.canManage && <p>Sign in with a named client knowledge manager or administrator account to change this approval.</p>}
    {status?.canManage && <>
      <label>Reason<input aria-label="Reference approval reason" value={reason} maxLength={1000} disabled={locked} onChange={e => { setReason(e.target.value); setReviewed(false); }} /></label>
      <label><input aria-label="Reference original reviewed" type="checkbox" checked={reviewed} disabled={locked} onChange={e => setReviewed(e.target.checked)} /> I reviewed the original PDF and the extraction limits for reference use.</label>
      {!pending && <button className="btn" type="button" disabled={busy || !reason.trim() || (!status.state.approved && !reviewed)} onClick={() => void change(!status.state.approved)}>
        {status.state.approved ? 'Revoke reference approval' : 'Approve reference search'}
      </button>}
    </>}
    {pending && <><p role="status">An action has an unconfirmed result. Retry it unchanged or check its recorded approval.</p>
      <button className="btn" type="button" disabled={busy} onClick={() => void change(false)}>Retry saved reference action</button></>}
    {error && <p role="alert">{error}</p>}
    {status && status.events.length > 0 && <details><summary>Approval history (latest 20)</summary><ol>{status.events.map(e => <li key={e.actionId}>
      Version {e.version}: {e.approved ? 'approved' : 'revoked'} · {new Date(e.createdAt).toLocaleString()} · {e.actorDisplayName}<p>{e.reason}</p>
    </li>)}</ol></details>}
  </section>;
}
