import { AvailabilityPanel } from '../components/AvailabilityPanel.js';
import { ReceiptAuditPanel } from '../components/ReceiptAuditPanel.js';
import { PublicationInspectionPanel } from '../components/PublicationInspectionPanel.js';
import { SpendingPolicyPanel } from '../components/SpendingPolicyPanel.js';
import React, { useState, useEffect, useRef } from 'react';
import { apiClient } from '../api/client.js';
import { read } from '../services/statusReport.js';
import { formatElapsedHours, stageLabel } from '../services/operationsPresentation.js';
import { CallCostAccountingPanel } from '../components/CallCostAccountingPanel.js';

interface IntegrationHealth {
  integrationId: string;
  kind: string;
  state: 'configured' | 'unconfigured' | 'unknown' | 'degraded' | 'kill_switch_active' | 'quarantined' | 'stale' | 'paid_verified' | 'billing_exhausted' | 'unauthorized' | 'rate_limited' | 'unreachable' | 'http_error';
  configured: boolean | null;
  reachability: 'unknown' | 'reachable' | 'unreachable';
  paidVerification: 'not_run' | 'paid_verified' | 'failed' | 'stale' | 'unknown';
  lastVerifiedAt: string | null;
  lastObservedAt?: string | null;
  checkedAt: string;
  nextAction: string;
}

interface FunnelHealth {
  status: 'healthy' | 'idle' | 'in_progress' | 'stalled' | 'unknown';
  windowHours: number;
  briefsCount: number | null;
  draftsCount: number | null;
  stalledTaskCount: number | null;
  oldestStalledTaskId?: string | null;
  oldestStalledTaskHours?: number | null;
  nextAction?: string | null;
  stageDurations?: Record<string, { samples: number; p50Hours: number | null; p95Hours: number | null }> | null;
}

interface FailureItem {
  id: string;
  title: string;
  status: string;
  clientId?: string;
  reason?: string;
  createdAt?: string;
}

const record = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const nonnegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const count = (v: unknown) => nonnegative(v) && Number.isSafeInteger(v);
function integrationItems(value: unknown): IntegrationHealth[] | null {
  if (!record(value) || !Array.isArray(value.items) || !value.items.every(v => record(v) &&
      ['integrationId','kind','state','checkedAt','nextAction'].every(k => typeof v[k] === 'string' && v[k]) &&
      (v.configured === null || typeof v.configured === 'boolean') &&
      ['unknown','reachable','unreachable'].includes(String(v.reachability)) &&
      ['not_run','paid_verified','failed','stale','unknown'].includes(String(v.paidVerification)))) return null;
  return value.items as IntegrationHealth[];
}
function failureItems(value: unknown): FailureItem[] | null {
  if (!record(value) || !Array.isArray(value.items) || !value.items.every(v => record(v) &&
      typeof v.id === 'string' && v.id && typeof v.status === 'string' && v.status &&
      ['title','clientId','reason','createdAt'].every(k => v[k] === undefined || typeof v[k] === 'string'))) return null;
  return value.items as FailureItem[];
}
function parseFunnel(value: unknown): FunnelHealth | null {
  if (!record(value) || !['healthy','idle','in_progress','stalled','unknown'].includes(String(value.status)) ||
      !nonnegative(value.windowHours) || !['briefsCount','draftsCount','stalledTaskCount'].every(k => value[k] === null || count(value[k]))) return null;
  if (value.stageDurations !== undefined && value.stageDurations !== null && (!record(value.stageDurations) ||
      !Object.values(value.stageDurations).every(v => record(v) && count(v.samples) &&
        (v.p50Hours === null || nonnegative(v.p50Hours)) && (v.p95Hours === null || nonnegative(v.p95Hours))))) return null;
  if (!['oldestStalledTaskId','nextAction'].every(k => value[k] === undefined || value[k] === null || typeof value[k] === 'string') ||
      !(value.oldestStalledTaskHours === undefined || value.oldestStalledTaskHours === null || nonnegative(value.oldestStalledTaskHours))) return null;
  return value as unknown as FunnelHealth;
}

export const OpsScreen: React.FC = () => {
  const [integrations, setIntegrations] = useState<IntegrationHealth[]>([]);
  const [funnel, setFunnel] = useState<FunnelHealth | null>(null);
  const [failures, setFailures] = useState<FailureItem[]>([]);
  const refreshSequence = useRef(0);
  const [auditRefresh, setAuditRefresh] = useState(0);
  const [unreadable, setUnreadable] = useState<Record<string, string>>({});

  const [loading, setLoading] = useState(false);
  const [lastCheck, setLastCheck] = useState<string | null>(null);
  const [opsToast, setOpsToast] = useState<string | null>(null);
  const [inspectingFailure, setInspectingFailure] = useState<FailureItem | null>(null);
  // One re-drive per press: each one pays for a design again, and the button stayed live while it ran.
  const [requeueing, setRequeueing] = useState(false);
  const requeueStarted = useRef(false);
  const requeueInspected = async () => {
    if (!inspectingFailure || requeueStarted.current) return;
    requeueStarted.current = true;
    setRequeueing(true);
    try {
      await apiClient.tasks.redrive(inspectingFailure.id);
      setOpsToast(`✓ Task ${inspectingFailure.id.substring(0, 8)}… re-queued into operator intake pipeline`);
    } catch (err: any) {
      setOpsToast(`✕ Failed to re-queue task: ${err.message || 'Error'}`);
    } finally {
      requeueStarted.current = false;
      setRequeueing(false);
    }
    setTimeout(() => setOpsToast(null), 4000);
    setInspectingFailure(null);
  };

  const fetchOpsData = async () => {
    const sequence = ++refreshSequence.current;
    setLoading(true);
    setFunnel(null); setFailures([]); setIntegrations([]); setLastCheck(null);
    const [healthRes, funnelRes, failRes] = await Promise.all([
      read(() => apiClient.operations.integrationsHealth()),
      read(() => apiClient.operations.funnelHealth()),
      read(() => apiClient.operations.failures()),
    ]);
    if (sequence !== refreshSequence.current) return;
    const gaps: Record<string, string> = {};
    const note = (name: string, r: { state: string; reason?: string }) => {
      if (r.state === 'unknown') gaps[name] = r.reason || 'unknown error';
    };
    note('integrations', healthRes);
    note('design funnel', funnelRes);
    note('failures', failRes);

    const nextIntegrations = healthRes.state === 'known' ? integrationItems(healthRes.value) : null;
    const nextFailures = failRes.state === 'known' ? failureItems(failRes.value) : null;
    const nextFunnel = funnelRes.state === 'known' ? parseFunnel(funnelRes.value) : null;
    if (!nextIntegrations && healthRes.state === 'known') gaps.integrations = 'Integration results were not reported';
    if (!nextFailures && failRes.state === 'known') gaps.failures = 'Failure results were not reported';
    if (!nextFunnel && funnelRes.state === 'known') gaps['design funnel'] = 'Progress evidence was not reported';
    setIntegrations(nextIntegrations || []);
    setFailures(nextFailures || []);
    setFunnel(nextFunnel);
    setUnreadable(gaps);
    setLastCheck(new Date().toISOString());
    setLoading(false);
  };

  useEffect(() => {
    void fetchOpsData();
    const refreshVisible = () => { if (!document.hidden) void fetchOpsData(); };
    const timer = window.setInterval(refreshVisible, 60_000);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => { refreshSequence.current++; window.clearInterval(timer); document.removeEventListener('visibilitychange', refreshVisible); };
  }, []);

  const degradedCount = integrations.filter((i) => i.state !== 'paid_verified').length;
  const criticalCount = failures.filter((f) => f.status === 'OPERATOR_REQUIRED').length;
  const recoverableCount = failures.length;
  const failuresKnown = Boolean(lastCheck) && !unreadable.failures;
  const integrationsKnown = Boolean(lastCheck) && !unreadable.integrations;

  return (
    <section id="ops" className="screen active">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
        <div role="status" style={{ fontSize: 13, color: 'var(--muted)' }}>
          {loading
            ? 'Polling infrastructure telemetry…'
            : !lastCheck
              ? 'Telemetry not read yet'
              : Object.keys(unreadable).length > 0
                ? `Telemetry incomplete · last checked ${lastCheck} · could not read ${Object.entries(unreadable).map(([name, why]) => `${name} (${why})`).join('; ')}`
                : `Snapshot read ${lastCheck}. Current connection health is shown separately. Refreshes every minute while visible.`}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" disabled={loading} onClick={() => { setAuditRefresh(value => value + 1); void fetchOpsData(); }}>Refresh telemetry</button>
        </div>
      </div>

      <div className="ops-actions" style={{ marginTop: 16 }}>
        <div className="panel" style={{ padding: 16 }}>
          <h2>Actionable operations</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Component / Task</th>
                <th>State</th>
                <th>Evidence</th>
                <th>Safe action</th>
              </tr>
            </thead>
            <tbody>
              {failures.map((f) => (
                <tr key={f.id}>
                  <td data-label="Component / Task"><b>{f.title || f.id.substring(0, 8)}</b></td>
                  <td data-label="State">
                    <span className={`pill ${f.status === 'OPERATOR_REQUIRED' ? 'bad' : 'warn'}`}>
                      {f.status}
                    </span>
                  </td>
                  <td data-label="Evidence">{f.reason || 'Open this task to inspect the recorded failure.'}</td>
                  <td data-label="Safe action">
                    <button
                      className="btn"
                      style={{ fontSize: 11 }}
                      onClick={() => setInspectingFailure(f)}
                    >
                      Inspect
                    </button>
                  </td>
                </tr>
              ))}
              {failuresKnown && failures.length === 0 && <tr><td colSpan={4}>No task failures reported in this snapshot.</td></tr>}
              {unreadable.failures && (
                <tr>
                  <td colSpan={4}>Could not read task failures, so this list may be incomplete: {unreadable.failures}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

      </div>

      {/* Primary Ops Metrics */}
      <h2 className="sr-only">Operations overview</h2>
      <div className="grid4">
        {/* A count Core could not supply is shown as —, never as 0. */}
        <div className="stat"><b>{failuresKnown ? criticalCount : '—'}</b><span>critical incidents</span></div>
        <div className="stat"><b>{failuresKnown ? recoverableCount : '—'}</b><span>recoverable failures</span></div>
        <div className="stat"><b>{integrationsKnown ? degradedCount : '—'}</b><span>adapters not verified</span></div>
        <div className="stat"><b>—</b><span>last backup age (not reported to the Desk)</span></div>
      </div>

      <div className="panel" style={{ padding: 16, marginTop: 16 }}>
        <h2>Design request progress</h2>
        {lastCheck && <p className="observation-note">Snapshot read <time dateTime={lastCheck}>{lastCheck}</time>. These counts describe workflow progress, not live service availability.</p>}
        {funnel ? (
          <>
            <p>Last {funnel.windowHours} hours: {funnel.briefsCount ?? '—'} requests · {funnel.draftsCount ?? '—'} Canva drafts · {funnel.stalledTaskCount ?? '—'} overdue automatic requests · workflow timeliness: {funnel.status === 'healthy' ? 'no overdue automatic requests at this read' : funnel.status.replaceAll('_', ' ')}</p>
            {funnel.oldestStalledTaskId && <p>Oldest overdue task: {funnel.oldestStalledTaskId} ({funnel.oldestStalledTaskHours} hours). {funnel.nextAction}</p>}
            {funnel.stageDurations && Object.entries(funnel.stageDurations).map(([stage, timing]) => (
              <p key={stage}>{stageLabel(stage)}: {timing.samples} completed · p50 {formatElapsedHours(timing.p50Hours)} · p95 {formatElapsedHours(timing.p95Hours)}</p>
            ))}
          </>
        ) : <p>Design progress unknown. {unreadable['design funnel'] || 'No result has been read yet.'}</p>}
      </div>

      <AvailabilityPanel refreshKey={auditRefresh} />

      <ReceiptAuditPanel refreshKey={auditRefresh} />
      <PublicationInspectionPanel refreshKey={auditRefresh} />

      <div className="ops" style={{ marginTop: 16 }}>
        <div className="panel" style={{ padding: 16 }}>
          <h2>Component health</h2>
          {integrations.length > 0 ? (
            integrations.map((item) => (
              <div key={item.integrationId} className="rule">
                <span className={`dot ${item.state === 'paid_verified' ? '' : 'warn'}`}></span>
                <b>{item.kind.toUpperCase().replace('_', ' ')} ({item.integrationId})</b>
                <p>Setup: {item.configured === null ? 'unknown' : item.configured ? 'configured' : 'missing'} · Reachability: {item.reachability} · Paid verification: {item.paidVerification.replace('_', ' ')} · Local state: {item.state}</p>
                <p>Next: {item.nextAction} · Configuration observed {item.checkedAt.substring(11, 19)} UTC{item.lastObservedAt ? ` · Last probe ${item.lastObservedAt}` : item.lastVerifiedAt ? ` · Last verified ${item.lastVerifiedAt}` : ''}</p>
              </div>
            ))
          ) : (
            <div className="rule">
              <b>{unreadable.integrations ? 'Component health unknown' : integrationsKnown ? 'No components reported' : 'Not read yet'}</b>
              {unreadable.integrations && <p>Could not read component health: {unreadable.integrations}</p>}
            </div>
          )}
        </div>
      </div>

      <SpendingPolicyPanel />
      <CallCostAccountingPanel />

      {/* Intervention Inspection Modal */}
      {inspectingFailure && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <div
            className="panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ops-inspection-title"
            style={{
              width: 'min(520px, calc(100vw - 24px))',
              maxHeight: 'calc(100dvh - 24px)',
              overflowY: 'auto',
              padding: 24,
              boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
            }}
          >
            <h2 id="ops-inspection-title" style={{ marginTop: 0 }}>Intervention Inspection</h2>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: -4 }}>
              Deterministic operational failure inspection (Invariant #7).
            </p>

            <div style={{ margin: '16px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="rule">
                <b>Task ID & Title</b>
                <p><code>{inspectingFailure.id}</code> — {inspectingFailure.title}</p>
              </div>
              <div className="rule">
                <b>Client Context & Reason</b>
                <p>Client: <b>{inspectingFailure.clientId || 'Office'}</b> · {inspectingFailure.reason || 'No failure reason recorded'}</p>
              </div>
              <div className="rule">
                <b>Invariant Audit State</b>
                <p>Status: <span className="pill warn">{inspectingFailure.status}</span></p>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
              <button className="btn" onClick={() => setInspectingFailure(null)}>
                Close
              </button>
              <button
                className="btn primary"
                onClick={() => void requeueInspected()}
                disabled={requeueing}
              >
                {requeueing ? 'Re-queueing…' : 'Re-Queue Task'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating Ops Toast */}
      {opsToast && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            right: 24,
            background: '#0f172a',
            color: '#ffffff',
            padding: '12px 20px',
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 500,
            boxShadow: '0 10px 25px rgba(0,0,0,0.3)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span>{opsToast}</span>
        </div>
      )}
    </section>
  );
};
