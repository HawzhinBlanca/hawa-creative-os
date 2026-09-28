import { useEffect, useRef, useState } from 'react';
import { apiClient, type KnowledgeSearch } from '../api/client.js';

export function KnowledgeSearchPanel({ clientId, revision, onOpen }: {
  clientId: string; revision: number; onOpen: (id: string, page: number | null) => void;
}) {
  const [query, setQuery] = useState(''), [result, setResult] = useState<KnowledgeSearch | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const generation = useRef(0), controller = useRef<AbortController | null>(null);
  useEffect(() => {
    generation.current++; controller.current?.abort(); setResult(null); setError(''); setBusy(false);
    return () => { generation.current++; controller.current?.abort(); };
  }, [clientId, revision]);
  useEffect(() => { setQuery(''); }, [clientId]);
  const search = async () => {
    const current = ++generation.current; controller.current?.abort(); controller.current = new AbortController();
    setBusy(true); setError(''); setResult(null);
    try {
      const answer = await apiClient.clients.searchKnowledge(clientId, query.trim(), controller.current.signal);
      if (current !== generation.current) return;
      if (answer.clientId !== clientId) throw new Error('The reference search scope could not be verified.');
      setResult(answer);
    } catch (e) { if (current === generation.current) setError(e instanceof Error ? e.message : 'Reference search unavailable.'); }
    finally { if (current === generation.current) setBusy(false); }
  };
  return <section aria-label="Search approved reference material">
    <h3>Find approved reference material</h3>
    <p>Search the approved PDFs for this client. Review the original before copying a claim. Results reflect approval when the search ran.</p>
    <form onSubmit={e => { e.preventDefault(); if (query.trim() && !busy) void search(); }}>
      <label>Search reference text<input aria-label="Search reference text" value={query} maxLength={500} onChange={e => {
        generation.current++; controller.current?.abort(); setBusy(false); setResult(null); setError(''); setQuery(e.target.value);
      }} /></label>
      <button className="btn" type="submit" disabled={!clientId || !query.trim() || busy}>{busy ? 'Searching…' : 'Search references'}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {result && <div><p role="status">{result.items.length ? `${result.items.length} matching passages (up to 10).` : 'No approved matching passages.'}</p>
      {result.items.map(item => <article key={`${item.citation.documentId}:${item.citation.chunkId}`}>
        <p dir="auto" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.text}</p>
        {item.truncated && <p>Excerpt shortened. Open the saved PDF for the complete passage.</p>}
        <p>Page {item.citation.pageNumber ?? 'unavailable'} · approval version {item.citation.approvalVersion}</p>
        <button className="btn" type="button" onClick={() => onOpen(item.citation.documentId, item.citation.pageNumber)}>Review saved PDF</button>
        <details><summary>Citation</summary><p style={{ overflowWrap: 'anywhere' }}>Source {item.citation.sourceSha256}<br />Chunk {item.citation.chunkId}<br />{item.citation.extractorVersion}</p></details>
      </article>)}
    </div>}
  </section>;
}
