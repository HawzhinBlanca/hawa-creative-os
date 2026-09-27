import { useRef, useState } from 'react';
import { isTerminalTaskStatus, taskGenerationBlocker } from '@hawa/contracts/task-status';
import { apiClient } from '../api/client.js';

export function TaskControls({ taskId, status, version, role, refresh }: {
  taskId: string; status: string; version?: number; role?: string; refresh: () => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const pending = useRef<{ signature: string; key: string } | null>(null);
  const allowed = ['operator', 'administrator', 'art_director', 'creative_director', 'designer'].includes(role || '');
  const unavailable = busy || !allowed || !reason.trim() || !Number.isSafeInteger(version) || Number(version) < 1;
  const apply = async (action: 'pause' | 'resume' | 'cancel') => {
    if (unavailable) return;
    const body = { reason: reason.trim(), expectedVersion: Number(version) };
    const signature = JSON.stringify({ action, ...body });
    if (pending.current?.signature !== signature) pending.current = { signature, key: crypto.randomUUID() };
    setBusy(true); setMessage('Saving task control…');
    try {
      const receipt = await apiClient.tasks.control(taskId, action, body, pending.current.key);
      setMessage(`Control recorded: ${receipt.status.replaceAll('_', ' ').toLowerCase()}.`);
      setReason(''); pending.current = null;
      await refresh().catch(() => {});
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The control could not be confirmed. Retry with the same reason.');
    } finally { setBusy(false); }
  };
  return <details className="task-controls">
    <summary>Pause, resume or cancel this task</summary>
    {isTerminalTaskStatus(status) ? <p>This task is closed. Its recorded results remain available.</p> : <>
      <p>Pausing stops new design work. Cancelling closes this request. Work already admitted may still finish; its results are retained.</p>
      {!allowed && <p>An office operator or designer is required.</p>}
      <label htmlFor={`control-reason-${taskId}`}>Reason</label>
      <textarea id={`control-reason-${taskId}`} value={reason} maxLength={2000} disabled={busy || !allowed}
        onChange={event => setReason(event.target.value)} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {status === 'PAUSED'
          ? <button className="btn" disabled={unavailable} onClick={() => void apply('resume')}>Resume operator pause</button>
          : <button className="btn" disabled={unavailable || Boolean(taskGenerationBlocker(status))} onClick={() => void apply('pause')}>Pause task</button>}
        <button className="btn" disabled={unavailable} onClick={() => void apply('cancel')}>Cancel task</button>
      </div>
    </>}
    {message && <p role="status">{message}</p>}
  </details>;
}
