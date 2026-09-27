import type { OperationsReliabilityReport } from '@hawa/contracts';
import { parseOperationsReliability } from '../services/operationsEvidence.js';
import { SpendingPolicyPanel } from '../components/SpendingPolicyPanel.js';
import React, { useState, useEffect, useRef } from 'react';
import { eventStream } from '../services/eventStream';
import { apiClient } from '../api/client.js';
import { read, reasonOf } from '../services/statusReport.js';
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

export interface ReconciliationReport {
  auditId: string;
  timestamp: string;
  basis: string;
  simulated: boolean;
  totalTasksAudited: number;
  totalDriveDeliverablesChecked: number;
  totalSheetRowsAudited: number;
  inSyncCount: number;
  driftCount: number;
  status: 'clean' | 'divergent';
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

function parseAudit(value: unknown): ReconciliationReport | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.auditId !== 'string' || !v.auditId || typeof v.timestamp !== 'string' || !Number.isFinite(Date.parse(v.timestamp)) ||
      typeof v.basis !== 'string' || !v.basis || v.simulated !== false || !['clean','divergent'].includes(String(v.status))) return null;
  if (['totalTasksAudited','totalDriveDeliverablesChecked','totalSheetRowsAudited','inSyncCount','driftCount'].some(k =>
      typeof v[k] !== 'number' || !Number.isSafeInteger(v[k]) || (v[k] as number) < 0)) return null;
  if ((v.status === 'clean') !== (v.driftCount === 0) || (v.inSyncCount as number) > (v.totalTasksAudited as number)) return null;
  return v as unknown as ReconciliationReport;
}

export const OpsScreen: React.FC = () => {
  const [integrations, setIntegrations] = useState<IntegrationHealth[]>([]);
  const [funnel, setFunnel] = useState<FunnelHealth | null>(null);
  const [failures, setFailures] = useState<FailureItem[]>([]);
  const [reliability, setReliability] = useState<OperationsReliabilityReport | null>(null);
  const refreshSequence = useRef(0);
  const [reconciliation, setReconciliation] = useState<ReconciliationReport | null>(null);
  const [unreadable, setUnreadable] = useState<Record<string, string>>({});

  const [loading, setLoading] = useState(false);
  const [runningReconciliation, setRunningReconciliation] = useState(false);
  const [lastCheck, setLastCheck] = useState<string | null>(null);
  const [reconcileToast, setReconcileToast] = useState<string | null>(null);
  const [opsToast, setOpsToast] = useState<string | null>(null);
  const showOpsToast = (text: string) => {
    setOpsToast(text);
    setTimeout(() => setOpsToast(null), 6000);
  };
  const [inspectingFailure, setInspectingFailure] = useState<FailureItem | null>(null);

  const fetchOpsData = async () => {
    const sequence = ++refreshSequence.current;
    setLoading(true);
    const [healthRes, funnelRes, failRes, sloRes, reconRes] = await Promise.all([
      read(() => apiClient.operations.integrationsHealth()),
      read(() => apiClient.operations.funnelHealth()),
      read(() => apiClient.operations.failures()),
      read(() => apiClient.operations.slo()),
      read(() => apiClient.operations.reconciliation()),
    ]);
    if (sequence !== refreshSequence.current) return;
    const gaps: Record<string, string> = {};
    const note = (name: string, r: { state: string; reason?: string }) => {
      if (r.state === 'unknown') gaps[name] = r.reason || 'unknown error';
    };
    note('integrations', healthRes);
    note('design funnel', funnelRes);
    note('failures', failRes);
    note('slo', sloRes);
    note('reconciliation', reconRes);

    const nextIntegrations = healthRes.state === 'known' ? integrationItems(healthRes.value) : null;
    const nextFailures = failRes.state === 'known' ? failureItems(failRes.value) : null;
    const nextFunnel = funnelRes.state === 'known' ? parseFunnel(funnelRes.value) : null;
    if (!nextIntegrations && healthRes.state === 'known') gaps.integrations = 'Integration results were not reported';
    if (!nextFailures && failRes.state === 'known') gaps.failures = 'Failure results were not reported';
    if (!nextFunnel && funnelRes.state === 'known') gaps['design funnel'] = 'Progress evidence was not reported';
    setIntegrations(nextIntegrations || []);
    setFailures(nextFailures || []);
    setFunnel(nextFunnel);
    const nextReliability = sloRes.state === 'known' ? parseOperationsReliability(sloRes.value) : null;
    if (!nextReliability && sloRes.state === 'known') gaps.slo = 'Unsupported or incomplete reliability evidence';
    setReliability(nextReliability);
    const nextAudit = reconRes.state === 'known' ? parseAudit(reconRes.value) : null;
    if (!nextAudit && reconRes.state === 'known' && reconRes.value !== null) gaps.reconciliation = 'Unsupported or incomplete audit evidence';
    setReconciliation(nextAudit);
    setUnreadable(gaps);
    setLastCheck(new Date().toLocaleTimeString());
    setLoading(false);
  };

  // Audit only: the Desk never asks Core to auto-repair (see apiClient.operations.auditReconciliation).
  const runReconciliation = async () => {
    const sequence = ++refreshSequence.current;
    setLoading(false);
    setRunningReconciliation(true);
    setReconcileToast(null);
    try {
      const data = await apiClient.operations.auditReconciliation();
      if (sequence !== refreshSequence.current) return;
      const audit = parseAudit(data);
      if (!audit) throw new Error('Unsupported or incomplete audit evidence');
      setReconciliation(audit);
      setUnreadable(old => Object.fromEntries(Object.entries(old).filter(([key]) => key !== 'reconciliation')));
      setReconcileToast(`✓ Stored receipt audit: ${data.inSyncCount} in sync, ${data.driftCount} drift(s) found, none repaired`);
      setTimeout(() => setReconcileToast(null), 6000);
    } catch (err) {
      if (sequence !== refreshSequence.current) return;
      setReconciliation(null);
      setUnreadable(old => ({...old,reconciliation:reasonOf(err)}));
      showOpsToast(`✗ Reconciliation audit did not run: ${reasonOf(err)}`);
    } finally {
      setRunningReconciliation(false);
    }
  };

  useEffect(() => {
    fetchOpsData();

    const unsubReconcile = eventStream.on('reconciliation:completed', () => {
      fetchOpsData();
    });

    return () => {
      refreshSequence.current++;
      unsubReconcile();
    };
  }, []);

  const degradedCount = integrations.filter((i) => i.state !== 'paid_verified').length;
  const criticalCount = failures.filter((f) => f.status === 'OPERATOR_REQUIRED').length;
  const recoverableCount = failures.length;
  const failuresKnown = Boolean(lastCheck) && !unreadable.failures;
  const integrationsKnown = Boolean(lastCheck) && !unreadable.integrations;

  return (
    <section id="ops" className="screen active">
      <SpendingPolicyPanel />
      <CallCostAccountingPanel />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>
          {loading
            ? 'Polling infrastructure telemetry…'
            : !lastCheck
              ? 'Telemetry not read yet'
              : Object.keys(unreadable).length > 0
                ? `Telemetry incomplete · last checked ${lastCheck} · could not read ${Object.entries(unreadable).map(([name, why]) => `${name} (${why})`).join('; ')}`
                : `Telemetry read · last checked ${lastCheck}`}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={fetchOpsData}>Refresh telemetry</button>
        </div>
      </div>

      {/* Primary Ops Metrics */}
      <h1 className="sr-only">Operations & Telemetry Overview</h1>
      <div className="grid4">
        {/* A count Core could not supply is shown as —, never as 0. */}
        <div className="stat"><b>{failuresKnown ? criticalCount : '—'}</b><span>critical incidents</span></div>
        <div className="stat"><b>{failuresKnown ? recoverableCount : '—'}</b><span>recoverable failures</span></div>
        <div className="stat"><b>{integrationsKnown ? degradedCount : '—'}</b><span>adapters not verified</span></div>
        <div className="stat"><b>—</b><span>last backup age (not reported to the Desk)</span></div>
      </div>

      <div className="panel" style={{ padding: 16, marginTop: 16 }}>
        <h2>Design request progress</h2>
        {funnel ? (
          <>
            <p>Last {funnel.windowHours} hours: {funnel.briefsCount ?? '—'} requests · {funnel.draftsCount ?? '—'} Canva drafts · {funnel.stalledTaskCount ?? '—'} overdue automatic requests · {funnel.status.replace('_', ' ')}</p>
            {funnel.oldestStalledTaskId && <p>Oldest overdue task: {funnel.oldestStalledTaskId} ({funnel.oldestStalledTaskHours} hours). {funnel.nextAction}</p>}
            {funnel.stageDurations && Object.entries(funnel.stageDurations).map(([stage, timing]) => (
              <p key={stage}>{stage.replace(/([A-Z])/g, ' $1')}: {timing.samples} completed · p50 {timing.p50Hours === null ? '—' : `${timing.p50Hours}h`} · p95 {timing.p95Hours === null ? '—' : `${timing.p95Hours}h`}</p>
            ))}
          </>
        ) : <p>Design progress unknown. {unreadable['design funnel'] || 'No result has been read yet.'}</p>}
      </div>

      <section className="panel" aria-label="Office reliability" style={{padding:16,marginTop:16}}>
        <h2>Office availability and latency</h2>
        {reliability ? <>
          <p><span className="pill warn">Availability unmeasured</span></p>
          <p>Target: {reliability.availability.targetPercent}% monthly availability for office intake and review (Asia/Baghdad).</p>
          <p>No independent availability observations or measured office latency are recorded. Compliance, error budget and latency are unknown.</p>
          <p>{reliability.nextAction}</p>
          <small>Evidence checked {reliability.checkedAt}. This time records the status read, not a successful operation.</small>
        </> : <p>Reliability evidence unavailable. {unreadable.slo || 'No report has been read yet.'}</p>}
      </section>

      {/* Reconciliation & Storage Drift Audit Panel (FR-049, FR-050) */}
      <div className="panel" style={{ padding: 16, marginTop: 16, borderLeft: '4px solid var(--border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
          <div>
            <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, fontSize: 16 }}>
              <span>🔄 Stored publication receipt audit</span>
              <span className={`pill ${!reconciliation || reconciliation.totalTasksAudited === 0 ? '' : reconciliation.status === 'clean' ? 'ok' : 'bad'}`} style={{ fontSize: 11 }}>
                {!reconciliation
                  ? lastCheck && !unreadable.reconciliation
                    ? 'No audit since Core started'
                    : 'No audit read'
                  : reconciliation.totalTasksAudited === 0
                    ? 'No tasks audited'
                    : reconciliation.status === 'clean'
                    ? 'Stored receipts consistent'
                    : 'Drift found'}
              </span>
            </h2>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              {reconciliation?.basis || 'Compares PostgreSQL tasks with stored publication receipts. External Drive and Sheets state is not checked, and nothing is repaired.'}
            </div>
          </div>
          <button
            className="btn"
            style={{ fontSize: 12, padding: '4px 10px', background: 'rgba(22, 101, 52, 0.08)', color: 'var(--ok-text, #166534)', borderColor: 'var(--ok-text, #166534)', fontWeight: 600 }}
            onClick={runReconciliation}
            disabled={runningReconciliation}
          >
            {runningReconciliation ? 'Running Audit…' : 'Run Reconciliation Audit'}
          </button>
        </div>

        {reconciliation && <p>Audit recorded {reconciliation.timestamp} · {reconciliation.simulated ? 'Simulated evidence' : 'Stored receipt evidence'}</p>}

        {reconcileToast && (
          <div style={{ background: 'rgba(22, 101, 52, 0.08)', border: '1px solid rgba(22, 101, 52, 0.25)', borderRadius: 6, padding: '8px 12px', marginBottom: 12, fontSize: 12, color: 'var(--ok-text, #166534)' }}>
            {reconcileToast}
          </div>
        )}

        <div className="ops-audit-stats">
          <div className="stat" style={{ padding: '8px 10px' }}>
            <b style={{ fontSize: 18 }}>{reconciliation?.totalTasksAudited ?? '—'}</b>
            <span style={{ fontSize: 11 }}>Tasks Audited</span>
          </div>
          <div className="stat" style={{ padding: '8px 10px' }}>
            <b style={{ fontSize: 18 }}>{reconciliation?.totalDriveDeliverablesChecked ?? '—'}</b>
            <span style={{ fontSize: 11 }}>Drive receipts</span>
          </div>
          <div className="stat" style={{ padding: '8px 10px' }}>
            <b style={{ fontSize: 18 }}>{reconciliation?.totalSheetRowsAudited ?? '—'}</b>
            <span style={{ fontSize: 11 }}>Sheet receipts</span>
          </div>
          <div className="stat" style={{ padding: '8px 10px' }}>
            <b style={{ fontSize: 18, color: 'var(--ok-text, #166534)' }}>{reconciliation?.inSyncCount ?? '—'}</b>
            <span style={{ fontSize: 11 }}>In Sync</span>
          </div>
          <div className="stat" style={{ padding: '8px 10px' }}>
            <b style={{ fontSize: 18, color: (reconciliation?.driftCount || 0) > 0 ? 'var(--warn-text, #854d0e)' : 'var(--ok-text, #166534)' }}>
              {reconciliation?.driftCount ?? '—'}
            </b>
            <span style={{ fontSize: 11 }}>Anomalies found</span>
          </div>
        </div>
      </div>

      <div className="ops" style={{ marginTop: 16 }}>
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
                  <td data-label="Evidence">Client: {f.clientId || 'Office'} · Invariant #7 check</td>
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
              {unreadable.failures && (
                <tr>
                  <td colSpan={4}>Could not read task failures, so this list may be incomplete: {unreadable.failures}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

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
                onClick={async () => {
                  try {
                    await apiClient.tasks.redrive(inspectingFailure.id);
                    setOpsToast(`✓ Task ${inspectingFailure.id.substring(0, 8)}… re-queued into operator intake pipeline`);
                  } catch (err: any) {
                    setOpsToast(`✕ Failed to re-queue task: ${err.message || 'Error'}`);
                  }
                  setTimeout(() => setOpsToast(null), 4000);
                  setInspectingFailure(null);
                }}
              >
                Re-Queue Task
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
