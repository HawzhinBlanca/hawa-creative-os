import { useEffect, useRef, useState } from 'react';
import { apiClient, type RetainedSourceFile, type RetainedVoiceReview } from '../api/client.js';

const stages: Record<RetainedSourceFile['stage'], string> = {
  retained: 'Original saved; extraction pending', ready: 'Ready for copy review',
  copy_confirmed: 'Requester copy reviewed', extraction_stopped: 'Extraction stopped; original available',
};
export function SourceFilesPanel({ clientId, onOpen }: { clientId: string; onOpen: (documentId: string) => void }) {
  const [items, setItems] = useState<RetainedSourceFile[]>([]), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false);
  const [voice, setVoice] = useState<RetainedVoiceReview | null>(null);
  const generation = useRef(0), controller = useRef<AbortController | null>(null);
  useEffect(() => {
    generation.current++; controller.current?.abort(); setItems([]); setError(''); setBusy(false); setLoaded(false); setVoice(null);
    return () => { generation.current++; controller.current?.abort(); };
  }, [clientId]);
  const run = async (source?: RetainedSourceFile, review = false) => {
    const current = ++generation.current, request = new AbortController();
    controller.current?.abort(); controller.current = request; setBusy(true); setError('');
    try {
      if (source) {
        if (source.clientId !== clientId) throw new Error('Source client changed. Reload retained files.');
        if (review) {
          setVoice(null);
          const result = await apiClient.clients.sourceVoiceReview(clientId, source.updateId, request.signal);
          if (current !== generation.current) return;
          if (result.clientId !== clientId || result.updateId !== source.updateId || result.sourceSha256 !== source.sourceSha256)
            throw new Error('Voice source identity could not be verified.');
          setVoice(result); return;
        }
        const blob = await apiClient.clients.sourceFileContent(clientId, source.updateId, request.signal);
        if (current !== generation.current) return;
        const url = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = url; link.download = `source-${source.sourceSha256.slice(0, 12)}.${source.kind === 'voice' ? 'ogg' : 'pdf'}`;
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
  return <section aria-label="Retained Telegram sources">
    <h4>Telegram originals</h4>
    <p>Inspect saved originals here, including files whose text could not be extracted. Copy review does not approve a design.</p>
    <button className="btn" type="button" disabled={busy || !clientId} onClick={() => void run()}>Browse Telegram sources</button>
    {busy && <p role="status">Loading retained source…</p>}
    {error && <p role="alert">{error}</p>}
    {loaded && !items.length && <p>No retained Telegram sources for this client.</p>}
    {items.length > 0 && <ul>{items.map(item => <li key={item.updateId}>
      <span>{new Date(item.createdAt).toLocaleString()} · {stages[item.stage]}</span>
      {item.message && <p>{item.message}</p>}
      <button className="btn" type="button" disabled={busy} onClick={() => void run(item)}>Download retained {item.kind === 'voice' ? 'audio' : 'PDF'}</button>
      {item.kind === 'voice' && <button className="btn" type="button" disabled={busy} onClick={() => void run(item, true)}>Inspect transcription</button>}
      {item.documentId && <button className="btn" type="button" disabled={busy} onClick={() => onOpen(item.documentId!)}>Review extracted text</button>}
    </li>)}</ul>}
    {voice && <section aria-label="Unreviewed voice transcription">
      <h4>Voice source {voice.sourceSha256.slice(0, 12)}</h4>
      <p>{voice.message}</p>
      <p>Reserved estimate: {voice.estimatedUsd === null ? 'no paid call' : `$${voice.estimatedUsd.toFixed(3)}`}. Actual billed cost: unknown.</p>
      {voice.audio && <p>Audio duration: {voice.audio.durationSeconds.toFixed(2)} seconds.</p>}
      {voice.transcript !== null && <pre dir="auto" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{voice.transcript}</pre>}
      <p>Listen to the retained original. Reply to your original Telegram source with /use_source on its own line, followed by the exact corrected copy. This does not approve a design.</p>
    </section>}
  </section>;
}
