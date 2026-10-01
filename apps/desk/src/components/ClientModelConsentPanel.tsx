import React, { useEffect, useRef, useState } from 'react';
import { ApiError, apiClient, type ClientModelConsent, type ClientModelConsentChange } from '../api/client.js';
import { reasonOf } from '../services/statusReport.js';

/** Review is read-only. Consent changes require an explicit administrator submission to Core. */
export function ClientModelConsentPanel({ clientId, onRecorded }: {
  clientId: string; onRecorded: () => Promise<void>;
}) {
  const [status, setStatus] = useState<ClientModelConsent | null>(null);
  const [administrator, setAdministrator] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'approved_providers' | 'local_only'>('local_only');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const pending = useRef<ClientModelConsentChange | null>(null);
  const mounted = useRef(true);
  const refresh = async () => {
    setLoading(true);
    try {
      const [session, consent] = await Promise.all([apiClient.auth.getSession(), apiClient.clients.modelConsent(clientId)]);
      if (!mounted.current) return;
      if (consent.clientId !== clientId) throw new Error('Core returned consent for a different client');
      setAdministrator(session.authenticated && session.user?.role === 'administrator');
      setStatus(consent);
    } catch (error) {
      if (mounted.current) { setStatus(null); setAdministrator(false); setMessage(`Consent could not be read: ${reasonOf(error)}`); }
    } finally { if (mounted.current) setLoading(false); }
  };
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
  }, [clientId]);
  const record = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!administrator || busy || loading || !status?.version || (!pending.current && reason.trim().length < 3)) return;
    const body = pending.current ?? { expectedVersion: status.version, mode,
      providers: mode === 'approved_providers' ? ['openai'] as ['openai'] : [], reason: reason.trim() } satisfies ClientModelConsentChange;
    pending.current = body;
    setBusy(true); setMessage('');
    let confirmed = false;
    try {
      const saved = await apiClient.clients.recordModelConsent(clientId, body);
      if (!mounted.current) return;
      if (saved.clientId !== clientId) throw new Error('Core returned a different client');
      confirmed = true;
      pending.current = null;
      setReason('');
      setMessage(`Consent recorded at brand version ${saved.version}. Model reading is ${saved.modelReading.openai ? 'on' : 'off'}.`);
      await onRecorded();
      await refresh();
    } catch (error) {
      if (!mounted.current) return;
      if (confirmed) {
        setMessage(`Consent was recorded, but the brand view could not be refreshed: ${reasonOf(error)}`);
        setStatus(null);
      } else if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        pending.current = null;
        setMessage(`Core did not confirm consent: ${reasonOf(error)}. Review the current consent before another change.`);
        setStatus(null);
      } else setMessage(`The consent request is unconfirmed: ${reasonOf(error)}. Retry the unchanged request to recover its result.`);
    } finally { if (mounted.current) setBusy(false); }
  };
  return <section className="finding" aria-label="Client model consent" style={{ marginBottom: 16 }}>
    <h3>Model reading consent</h3>
    {loading ? <p role="status">Reading this client's current consent…</p> : status ? <>
      <p>Brand version {status.version ?? 'unknown'} · OpenAI reading {status.modelReading.openai ? 'on' : 'off'}</p>
      <p>Recorded providers: {status.privacy?.allowedProviders?.join(', ') || 'none'}</p>
      {administrator ? <form onSubmit={record}>
        <p>This decision replaces the current provider permissions.</p>
        <fieldset disabled={busy || Boolean(pending.current)}>
          <label>Permission <select aria-label="Model reading permission" value={mode}
            onChange={event => setMode(event.target.value as typeof mode)}>
            <option value="local_only">Keep model reading off</option>
            <option value="approved_providers">Allow OpenAI to read this client's content</option>
          </select></label>
          <label>Reason <textarea aria-label="Consent reason" value={reason} minLength={3} maxLength={500}
            onChange={event => setReason(event.target.value)} /></label>
        </fieldset>
        <button className="btn" disabled={busy || (!pending.current && (reason.trim().length < 3 || !status.version))}>
          {pending.current ? 'Retry unchanged consent request' : 'Record consent decision'}
        </button>
      </form> : <p>An office administrator must record any consent change.</p>}
    </> : <button className="btn" disabled={busy} onClick={() => void refresh()}>Review current consent</button>}
    {message && <p role="status">{message}</p>}
  </section>;
}
