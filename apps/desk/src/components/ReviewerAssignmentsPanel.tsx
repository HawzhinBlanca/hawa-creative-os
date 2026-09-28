import React, { useEffect, useRef, useState } from 'react';
import { ApiError, apiClient, type ReviewAssignment, type ReviewAssignmentChange,
  type ReviewDirectory } from '../api/client.js';

type PendingAction = { assignmentId: string; actionId: string; fingerprint: string };
type HistoryEvent = { id: string; action: string; assignment_version: number | string;
  reason: string; occurred_at: string };

/** A small named-administrator surface; Core remains the authority for every change. */
export const ReviewerAssignmentsPanel: React.FC = () => {
  const [directory, setDirectory] = useState<ReviewDirectory | null>(null);
  const [assignments, setAssignments] = useState<ReviewAssignment[]>([]);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState('');
  const [projectId, setProjectId] = useState('');
  const [grantReason, setGrantReason] = useState('');
  const [revokeReasons, setRevokeReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEvent[]>([]);
  const pending = useRef(new Map<string, PendingAction>());

  const refresh = async () => {
    const [nextDirectory, nextAssignments] = await Promise.all([
      apiClient.reviewAssignments.directory(), apiClient.reviewAssignments.list(),
    ]);
    setDirectory(nextDirectory);
    setAssignments(nextAssignments);
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all([apiClient.reviewAssignments.directory(), apiClient.reviewAssignments.list()])
      .then(([nextDirectory, nextAssignments]) => {
        if (!cancelled) { setDirectory(nextDirectory); setAssignments(nextAssignments); }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 403) setHidden(true);
        else setMessage(`Reviewer access is unavailable: ${error instanceof Error ? error.message : 'try again later'}`);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (hidden) return null;
  const chosen = directory?.reviewers.find((row) => `${row.clientId}:${row.userId}` === selection);
  const projects = (directory?.projects || []).filter((project) => project.clientId === chosen?.clientId);
  const reviewerName = (row: ReviewAssignment) =>
    directory?.reviewers.find((candidate) => candidate.userId === row.userId && candidate.clientId === row.clientId)?.displayName
      || 'Reviewer whose membership changed';
  const clientName = (row: ReviewAssignment) =>
    directory?.reviewers.find((candidate) => candidate.clientId === row.clientId)?.clientName || 'Client';
  const scopeName = (row: ReviewAssignment) => row.projectId
    ? directory?.projects.find((project) => project.id === row.projectId)?.name || 'Project'
    : 'All projects';

  const reserve = (key: string, assignmentId: string, body: ReviewAssignmentChange) => {
    const fingerprint = JSON.stringify(body);
    const old = pending.current.get(key);
    if (old?.fingerprint === fingerprint) return old;
    const action = { assignmentId, actionId: crypto.randomUUID(), fingerprint };
    pending.current.set(key, action);
    return action;
  };

  const grant = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!chosen || !grantReason.trim() || busy) return;
    const existing = assignments.find((row) => row.userId === chosen.userId &&
      row.clientId === chosen.clientId && row.projectId === (projectId || null));
    if (existing?.active) { setMessage('This reviewer already has that access.'); return; }
    const body: ReviewAssignmentChange = { userId: chosen.userId, clientId: chosen.clientId,
      projectId: projectId || null, active: true, expectedVersion: existing?.version ?? 0,
      reason: grantReason.trim() };
    const key = `grant:${chosen.userId}:${chosen.clientId}:${projectId}`;
    const prior = pending.current.get(key);
    const assignmentId = existing?.id || (prior?.fingerprint === JSON.stringify(body)
      ? prior.assignmentId : crypto.randomUUID());
    const action = reserve(key, assignmentId, body);
    setBusy(true); setMessage('');
    try {
      const saved = await apiClient.reviewAssignments.save(action.assignmentId, action.actionId, body);
      await refresh();
      pending.current.delete(key);
      setGrantReason('');
      setMessage(`${chosen.displayName} now has ${projectId ? 'project' : 'client-wide'} review access (version ${saved.version}).`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        pending.current.delete(key);
        await refresh().catch(() => undefined);
        setMessage('Review access changed while you were editing. Check the refreshed assignments before trying again.');
      } else {
        setMessage(`Access change was not confirmed: ${error instanceof Error ? error.message : 'try again'}. Retry with the same details.`);
      }
    } finally { setBusy(false); }
  };

  const revoke = async (row: ReviewAssignment) => {
    const reason = revokeReasons[row.id]?.trim();
    if (!reason || busy) return;
    const body: ReviewAssignmentChange = { userId: row.userId, clientId: row.clientId,
      projectId: row.projectId, active: false, expectedVersion: row.version, reason };
    const key = `revoke:${row.id}`;
    const action = reserve(key, row.id, body);
    setBusy(true); setMessage('');
    try {
      await apiClient.reviewAssignments.save(row.id, action.actionId, body);
      await refresh();
      pending.current.delete(key);
      setRevokeReasons((current) => ({ ...current, [row.id]: '' }));
      setMessage(`Review access for ${reviewerName(row)} was revoked.`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        pending.current.delete(key);
        await refresh().catch(() => undefined);
        setMessage('Review access changed while you were editing. Check the refreshed assignment before trying again.');
      } else {
        setMessage(`Revocation was not confirmed: ${error instanceof Error ? error.message : 'try again'}. Retry with the same details.`);
      }
    } finally { setBusy(false); }
  };

  const showHistory = async (assignmentId: string) => {
    if (historyId === assignmentId) { setHistoryId(null); return; }
    try {
      setHistory(await apiClient.reviewAssignments.events(assignmentId));
      setHistoryId(assignmentId);
    } catch (error) {
      setMessage(`Could not read assignment history: ${error instanceof Error ? error.message : 'try again'}`);
    }
  };

  return <div className="panel" style={{ padding: 16, marginTop: 16 }}>
    <h2>Design review access</h2>
    <p style={{ color: 'var(--muted)' }}>Assign a named reviewer to one project or the whole client. Changes are recorded with your account and reason.</p>
    {loading && <p>Loading reviewer access…</p>}
    {message && <p role="status">{message}</p>}
    {directory && <>
      {(directory.reviewers.length === 1000 || directory.projects.length === 1000 || assignments.length === 500) &&
        <p role="status">This list reached its display limit. Ask an administrator to check older assignments before changing access.</p>}
      {directory.reviewers.length === 0 && <p>No eligible reviewers are provisioned yet. Ask a trusted administrator to add their Google account and client access.</p>}
      <form onSubmit={grant} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'end', gap: 8 }}>
        <label>Reviewer and client<br />
          <select className="input" aria-label="Reviewer and client" value={selection}
            onChange={(event) => { setSelection(event.target.value); setProjectId(''); }}>
            <option value="">Choose reviewer</option>
            {directory.reviewers.map((row) => <option key={`${row.clientId}:${row.userId}`} value={`${row.clientId}:${row.userId}`}>
              {row.displayName} · {row.clientName}
            </option>)}
          </select>
        </label>
        <label>Scope<br />
          <select className="input" aria-label="Review scope" value={projectId}
            onChange={(event) => setProjectId(event.target.value)} disabled={!chosen}>
            <option value="">All projects for this client</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <label>Reason<br />
          <input className="input" aria-label="Reason for granting review access" value={grantReason}
            onChange={(event) => setGrantReason(event.target.value)} maxLength={500} required />
        </label>
        <button className="btn primary" type="submit" disabled={!chosen || !grantReason.trim() || busy}>Grant access</button>
      </form>
      <h3>Current assignments</h3>
      {assignments.length === 0 ? <p>No review assignments yet.</p> : <div style={{ overflowX: 'auto' }}><table className="table">
        <thead><tr><th>Reviewer</th><th>Client</th><th>Scope</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>{assignments.map((row) => <React.Fragment key={row.id}>
          <tr>
            <td>{reviewerName(row)}</td><td>{clientName(row)}</td><td>{scopeName(row)}</td>
            <td>{row.active ? 'Active' : 'Revoked'} · v{row.version}</td>
            <td>
              {row.active && <><input className="input" aria-label={`Reason to revoke ${reviewerName(row)}`}
                value={revokeReasons[row.id] || ''} maxLength={500}
                onChange={(event) => setRevokeReasons((current) => ({ ...current, [row.id]: event.target.value }))}
                placeholder="Reason for revocation" />
                <button className="btn" type="button" disabled={busy || !revokeReasons[row.id]?.trim()}
                  onClick={() => revoke(row)}>Revoke</button></>}
              <button className="btn" type="button" onClick={() => showHistory(row.id)}>History</button>
            </td>
          </tr>
          {historyId === row.id && <tr><td colSpan={5}>
            {history.length === 0 ? 'No recorded changes.' : <ul>{history.map((event) => <li key={event.id}>
              {event.action} · version {event.assignment_version} · {event.reason} · {new Date(event.occurred_at).toLocaleString()}
            </li>)}</ul>}
          </td></tr>}
        </React.Fragment>)}</tbody>
      </table></div>}
    </>}
  </div>;
};
