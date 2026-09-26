import { useEffect, useRef, useState } from 'react';
import { apiClient, type RetainedSourceFile } from '../api/client.js';

const stages: Record<RetainedSourceFile['stage'], string> = {
  retained: 'Original saved; extraction pending', ready: 'Ready for copy review',
  copy_confirmed: 'Requester copy reviewed', extraction_stopped: 'Extraction stopped; original available',
};
export function SourceFilesPanel({ clientId, onOpen }: { clientId: string; onOpen: (documentId: string) => void }) {
  const [items, setItems] = useState<RetainedSourceFile[]>([]), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false);
  const generation = useRef(0), controller = useRef<AbortController | null>(null);
  useEffect(() => {
    generation.current++; controller.current?.abort(); setItems([]); setError(''); setBusy(false); setLoaded(false);
    return () => { generation.current++; controller.current?.abort(); };
  }, [clientId]);
  const run = async (source?: RetainedSourceFile) => {
    const current = ++generation.current, request = new AbortController();
    controller.current?.abort(); controller.current = request; setBusy(true); setError('');
    try {
      if (source) {
        if (source.clientId !== clientId) throw new Error('Source client changed. Reload retained files.');
        const blob = await apiClient.clients.sourceFileContent(clientId, source.updateId, request.signal);
        if (current !== generation.current) return;
        const url = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = url; link.download = `source-${source.sourceSha256.slice(0, 12)}.pdf`;
        link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        const answer = await apiClient.clients.sourceFiles(clientId, request.signal);
        if (current !== generation.current) return;
        if (answer.clientId !== clientId || answer.items.some(item => item.clientId !== clientId))
          throw new Error('Source client could not be verified.');
        setItems(answer.items); setLoaded(true);
      }
    } catch (e) { if (current === generation.current) setError(e instanceof Error ? e.message : 'Retained sources unavailable.'); }
    finally { if (current === generation.current) setBusy(false); }
  };
  return <section aria-label="Retained Telegram PDFs">
    <h4>Telegram PDF originals</h4>
    <p>Inspect saved originals here, including files whose text could not be extracted. Copy review does not approve a design.</p>
    <button className="btn" type="button" disabled={busy || !clientId} onClick={() => void run()}>Browse Telegram PDFs</button>
    {busy && <p role="status">Loading retained source…</p>}
    {error && <p role="alert">{error}</p>}
    {loaded && !items.length && <p>No retained Telegram PDFs for this client.</p>}
    {items.length > 0 && <ul>{items.map(item => <li key={item.updateId}>
      <span>{new Date(item.createdAt).toLocaleString()} · {stages[item.stage]}</span>
      {item.message && <p>{item.message}</p>}
      <button className="btn" type="button" disabled={busy} onClick={() => void run(item)}>Download retained PDF</button>
      {item.documentId && <button className="btn" type="button" disabled={busy} onClick={() => onOpen(item.documentId!)}>Review extracted text</button>}
    </li>)}</ul>}
  </section>;
}
