import { useEffect, useRef, useState } from 'react';
import { apiClient, type DocumentInspection } from '../api/client.js';

/** Each client owns its own preview lifetime. Extracted text is untrusted, rendered only as text. */
export function DocumentInspectionPanel({ clientId }: { clientId: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<DocumentInspection | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  const [visible, setVisible] = useState(100);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    generation.current++;
    controller.current?.abort();
    setFile(null); setResult(null); setError(''); setBusy(false);
    if (input.current) input.current.value = '';
    return () => { generation.current++; controller.current?.abort(); };
  }, [clientId]);
  const inspect = async () => {
    if (!file || !clientId) return;
    const current = ++generation.current;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setBusy(true); setResult(null); setError('');
    try {
      const answer = await apiClient.clients.inspectDocument(clientId, file, request.signal);
      if (current !== generation.current) return;
      if (answer.clientId !== clientId || answer.sourceSaved !== false || answer.approved !== false ||
          !answer.document?.chunks?.length) throw new Error('The document preview could not be verified.');
      setResult(answer); setPage(1); setVisible(100);
    } catch (err) {
      if (current === generation.current) setError(err instanceof Error ? err.message : 'PDF inspection failed.');
    } finally { if (current === generation.current) setBusy(false); }
  };
  const chunks = result?.document.chunks.filter(chunk => chunk.pageNumber === page) ?? [];
  return <section aria-label="PDF text inspection" style={{ borderTop: '1px solid var(--line)', marginTop: 16, paddingTop: 12 }}>
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
    <button type="button" className="btn" disabled={!file || !clientId || busy} onClick={() => void inspect()}>
      {busy ? 'Inspecting PDF…' : 'Preview PDF text'}
    </button>
    {busy && <p role="status">Reading the PDF locally…</p>}
    {error && <p role="alert">{error}</p>}
    {result && <div>
      <p role="status">Preview only. The file and extracted text have not been saved or approved.</p>
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
    </div>}
  </section>;
}
