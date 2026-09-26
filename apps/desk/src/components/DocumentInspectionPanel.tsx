import { useEffect, useRef, useState } from 'react';
import { apiClient, type DocumentInspection, type SavedDocumentInspection, type DocumentReceipt } from '../api/client.js';

import { DocumentRequestForm } from './DocumentRequestForm.js';
import { getPendingDocumentDraft } from '../services/manualTaskIntake.js';
import { DocumentKnowledgePanel } from './DocumentKnowledgePanel.js';
import { KnowledgeSearchPanel } from './KnowledgeSearchPanel.js';

/** Each client owns its own preview lifetime. Extracted text is untrusted, rendered only as text. */
export function DocumentInspectionPanel({ clientId }: { clientId: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<DocumentInspection | SavedDocumentInspection | null>(null);
  const [saved, setSaved] = useState<DocumentReceipt[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  const [visible, setVisible] = useState(100);
  const [knowledgeRevision, setKnowledgeRevision] = useState(0);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    generation.current++;
    controller.current?.abort();
    setFile(null); setResult(null); setError(''); setBusy(false); setSaved([]);
    if (input.current) input.current.value = '';
    const pending = getPendingDocumentDraft();
    if (pending?.clientId === clientId && pending.sourceDocument) void openSaved(pending.sourceDocument.id);
    return () => { generation.current++; controller.current?.abort(); };
  }, [clientId]);
  const inspect = async (retain = false) => {
    if (!file || !clientId) return;
    const current = ++generation.current;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setBusy(true); setResult(null); setError('');
    try {
      const answer = retain ? await apiClient.clients.saveDocument(clientId, file, request.signal)
        : await apiClient.clients.inspectDocument(clientId, file, request.signal);
      if (current !== generation.current) return;
      if (answer.clientId !== clientId || answer.sourceSaved !== retain || answer.approved !== false ||
          !answer.document?.chunks?.length || (answer.sourceSaved &&
            (answer.receipt?.clientId !== clientId || answer.receipt.sourceSha256 !== answer.document.sourceSha256))) throw new Error('The document preview could not be verified.');
      setResult(answer); setPage(1); setVisible(100);
    } catch (err) {
      if (current === generation.current) setError(err instanceof Error ? err.message : 'PDF inspection failed.');
    } finally { if (current === generation.current) setBusy(false); }
  };
  const openSaved = async (id: string, sourcePage: number | null = 1) => {
    const current = ++generation.current;
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    setBusy(true); setResult(null); setError('');
    try {
      const answer = await apiClient.clients.document(clientId, id, request.signal);
      if (current !== generation.current) return;
      if (answer.clientId !== clientId || answer.sourceSaved !== true || answer.approved !== false || answer.receipt.id !== id || answer.receipt.clientId !== clientId || answer.receipt.sourceSha256 !== answer.document.sourceSha256)
        throw new Error('The saved PDF scope could not be verified.');
      setResult(answer); setPage(sourcePage && sourcePage <= (answer.document.extraction.pageCount ?? 0) ? sourcePage : 1); setVisible(100);
    } catch (err) { if (current === generation.current) setError(err instanceof Error ? err.message : 'Saved PDF unavailable.'); }
    finally { if (current === generation.current) setBusy(false); }
  };
  const browse = async () => {
    const current = generation.current;
    try {
      const answer = await apiClient.clients.documents(clientId);
      if (current === generation.current) { setSaved(answer.items); if (!answer.items.length) setError('No saved PDFs for this client.'); }
    } catch (err) { if (current === generation.current) setError(err instanceof Error ? err.message : 'Saved PDFs unavailable.'); }
  };
  const chunks = result?.document.chunks.filter(chunk => chunk.pageNumber === page) ?? [];
  return <section aria-label="PDF text inspection" style={{ borderTop: '1px solid var(--line)', marginTop: 16, paddingTop: 12 }}>
    <KnowledgeSearchPanel clientId={clientId} revision={knowledgeRevision} onOpen={(id, sourcePage) => void openSaved(id, sourcePage)} />
    <h3>Inspect a PDF</h3>
    <p>Preview the document’s text before using it in a brief or brand rule. Check it against the original PDF.</p>
    <label>PDF file (up to 20 MiB, 40 pages)
      <input ref={input} type="file" accept="application/pdf,.pdf" disabled={!clientId || busy} onChange={event => {
        generation.current++; setResult(null); setError('');
        const next = event.target.files?.[0] ?? null;
        if (next && (!next.size || next.size > 20 * 1024 * 1024)) {
          setFile(null); setError('Choose a non-empty PDF no larger than 20 MiB.');
        } else setFile(next);
      }} />
    </label>
    <button type="button" className="btn" disabled={!file || !clientId || busy} onClick={() => void inspect(false)}>
      {busy ? 'Inspecting PDF…' : 'Preview PDF text'}
    </button>
    <button type="button" className="btn" disabled={!file || !clientId || busy} onClick={() => void inspect(true)}>Save PDF for a request</button>
    <button type="button" className="btn" disabled={!clientId || busy} onClick={() => void browse()}>Browse saved PDFs</button>
    <p>Save retains the original and its extraction for this client. It does not create a request until you confirm the copy.</p>
    {saved.length > 0 && <label>Recent saved PDFs (latest 20)<select aria-label="Saved PDF" value={result?.sourceSaved ? result.receipt.id : ''} disabled={busy} onChange={e => { if (e.target.value) void openSaved(e.target.value); }}>
      <option value="">Choose a saved PDF</option>{saved.map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString()} · {item.sourceSha256.slice(0, 12)}</option>)}
    </select></label>}
    {busy && <p role="status">Reading the PDF locally…</p>}
    {error && <p role="alert">{error}</p>}
    {result && <div>
      <p role="status">{result.sourceSaved ? 'Original PDF and extraction saved. Review the copy below to create a request. Reference search approval is managed separately below.' : 'Preview only. The file and extracted text have not been saved or approved.'}</p>
      <ul>{result.document.extraction.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul>
      <label>Page <select aria-label="PDF page" value={page} onChange={event => { setPage(Number(event.target.value)); setVisible(100); }}>
        {Array.from({ length: result.document.extraction.pageCount ?? 0 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
      </select></label>
      <div style={{ maxHeight: 350, overflow: 'auto' }}>{chunks.slice(0, visible).map(chunk =>
        <p key={chunk.chunkId} dir="auto" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{chunk.text}</p>)}</div>
      {chunks.length > visible && <button className="btn" onClick={() => setVisible(n => n + 100)}>Show more text</button>}
      <details><summary>Source evidence</summary>
        <p style={{ overflowWrap: 'anywhere' }}>SHA-256: {result.document.sourceSha256}</p>
        <p>Extractor: {result.document.extraction.version}</p>
      </details>
      {result.sourceSaved && <><DocumentKnowledgePanel key={`knowledge:${result.receipt.id}`} receipt={result.receipt} onChanged={() => setKnowledgeRevision(v => v + 1)} />
        <DocumentRequestForm key={result.receipt.id} source={result} /></>}
    </div>}
  </section>;
}
