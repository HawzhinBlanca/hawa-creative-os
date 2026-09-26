import { useState } from 'react';
import { apiClient, type DocumentReceipt, type SavedDocumentInspection } from '../api/client.js';
import { getPendingDocumentDraft, submitDocumentTask } from '../services/manualTaskIntake.js';

export function OriginalDocument({ receipt }: { receipt: Pick<DocumentReceipt, 'clientId' | 'id' | 'sourceSha256'> }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setError(''); setBusy(true);
    try {
      const blob = await apiClient.clients.documentContent(receipt.clientId, receipt.id);
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `source-${receipt.sourceSha256.slice(0, 12)}.pdf`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e instanceof Error ? e.message : 'Original PDF unavailable.'); }
    finally { setBusy(false); }
  };
  return <div><button type="button" className="btn" disabled={busy} onClick={() => void download()}>Download original PDF</button>
    {error && <p role="alert">{error}</p>}</div>;
}

/** Extracted text stays evidence. The operator deliberately chooses the exact copy to submit. */
export function DocumentRequestForm({ source }: { source: SavedDocumentInspection }) {
  const pending = getPendingDocumentDraft();
  const own = pending?.clientId === source.clientId && pending.sourceDocument?.id === source.receipt.id ? pending : null;
  const [title, setTitle] = useState(own?.title ?? '');
  const [copy, setCopy] = useState(own?.copy ?? '');
  const [copyCkb, setCopyCkb] = useState(own?.copyCkb ?? '');
  const [instructions, setInstructions] = useState(own?.designInstructions ?? '');
  const [confirmed, setConfirmed] = useState(Boolean(own));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [taskId, setTaskId] = useState('');
  const locked = busy || Boolean(own) || Boolean(taskId);
  const save = async () => {
    if (busy || !confirmed || taskId) return;
    setBusy(true); setError('');
    try {
      const task = await submitDocumentTask({ clientId: source.clientId, title, copy, copyCkb,
        designInstructions: instructions, sourceDocument: { id: source.receipt.id,
          sourceSha256: source.receipt.sourceSha256, extractionSha256: source.receipt.extractionSha256, confirmed: true } });
      setTaskId(task.id);
    } catch (e) { setError(e instanceof Error ? e.message : 'Request save was not confirmed.'); }
    finally { setBusy(false); }
  };
  return <section aria-label="Reviewed PDF request">
    <h4>Create a request from this PDF</h4>
    <p>Enter only the copy this design should contain. Review every page of the original for omitted text, images and tables. Saving a request does not approve a design or brand knowledge.</p>
    <OriginalDocument receipt={source.receipt} />
    {pending && !own && <p role="alert">Another PDF request has an unconfirmed result. Reopen its saved document and retry it before submitting a different request.</p>}
    {own && !taskId && <p role="status">This request has an unconfirmed result. Its original copy and request key are retained; retry unchanged.</p>}
    <label>Request title<input aria-label="PDF request title" value={title} maxLength={200} disabled={locked} onChange={e => { setTitle(e.target.value); setConfirmed(false); }} /></label>
    <label>Exact copy (English)<textarea aria-label="PDF exact copy English" dir="auto" value={copy} maxLength={20000} disabled={locked} onChange={e => { setCopy(e.target.value); setConfirmed(false); }} /></label>
    <label>Exact copy (Sorani)<textarea aria-label="PDF exact copy Sorani" dir="rtl" value={copyCkb} maxLength={20000} disabled={locked} onChange={e => { setCopyCkb(e.target.value); setConfirmed(false); }} /></label>
    <label>Design instructions<textarea aria-label="PDF design instructions" value={instructions} maxLength={4000} disabled={locked} onChange={e => { setInstructions(e.target.value); setConfirmed(false); }} /></label>
    <label><input type="checkbox" checked={confirmed} disabled={locked} onChange={e => setConfirmed(e.target.checked)} /> I checked the original PDF and confirm the exact copy above for this request.</label>
    <button className="btn" type="button" disabled={busy || Boolean(taskId) || !confirmed || !title.trim() || !(copy.trim() || copyCkb.trim()) || Boolean(pending && !own)} onClick={() => void save()}>
      {busy ? 'Saving request…' : own ? 'Retry saved PDF request' : 'Save reviewed request'}
    </button>
    {error && <p role="alert">{error}</p>}
    {taskId && <p role="status">Request saved. Open Work to continue: {taskId}</p>}
  </section>;
}
