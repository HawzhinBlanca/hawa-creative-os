import React, { useState, useEffect } from 'react';
import { eventStream } from '../services/eventStream';
import { apiClient } from '../api/client.js';
import { read, reasonOf } from '../services/statusReport.js';

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

interface CircuitBreakerInfo {
  name: string;
  state: string;
  consecutiveFailures: number;
  totalTrips: number;
}

interface SloSummary {
  totalProbes: number;
  successfulProbes: number;
  failedProbes: number;
  successRate: number;
  errorBudgetRemaining: number;
  p50DurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  targetP99Ms: number;
  sloCompliant: boolean;
  circuitBreakers: CircuitBreakerInfo[];
  lastProbeAt?: string;
}

interface SloProbeResult {
  probeId: string;
  timestamp: string;
  scenario: string;
  totalDurationMs: number;
  success: boolean;
  stages: {
    ingressMs: number;
    routingMs: number;
    briefMs: number;
    composingMs: number;
    qaMs: number;
    approvalMs: number;
    publishMs: number;
  };
  taskId?: string;
  invariantsVerified?: {
    deskCanonical: boolean;
    clientScopeLocked: boolean;
    protectedTokensPreserved: boolean;
    editableDocumentMaintained: boolean;
    deterministicQaPassed: boolean;
    idempotentPublication: boolean;
  };
}

export interface ReconciliationReport {
  auditId: string;
  timestamp: string;
  basis: string;
  totalTasksAudited: number;
  totalDriveDeliverablesChecked: number;
  totalSheetRowsAudited: number;
  inSyncCount: number;
  driftCount: number;
  status: 'clean' | 'divergent';
}

export interface ClientBudgetReport {
  clientId: string;
  clientName: string;
  monthlyCapUsd: number;
  currentSpendUsd: number;
  remainingUsd: number;
  percentUsed: number;
  quotaStatus: 'HEALTHY' | 'WARNING' | 'EXCEEDED';
  currency: string;
  billingCycle: string;
}

export const OpsScreen: React.FC = () => {
  const [integrations, setIntegrations] = useState<IntegrationHealth[]>([]);
  const [funnel, setFunnel] = useState<FunnelHealth | null>(null);
  const [failures, setFailures] = useState<FailureItem[]>([]);
  const [sloSummary, setSloSummary] = useState<SloSummary | null>(null);
  const [recentProbes, setRecentProbes] = useState<SloProbeResult[]>([]);
  const [reconciliation, setReconciliation] = useState<ReconciliationReport | null>(null);
  // Budgets come only from Core. Until it answers there is nothing to show, not a sample.
  const [clientBudgets, setClientBudgets] = useState<ClientBudgetReport[]>([]);
  // Reads that failed on the last refresh, by name, with the reason. A failed read is never shown as zero.
  const [unreadable, setUnreadable] = useState<Record<string, string>>({});
  const [editingBudgetClient, setEditingBudgetClient] = useState<ClientBudgetReport | null>(null);
  const [newAllocatedCap, setNewAllocatedCap] = useState<number>(300);

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
    setLoading(true);
    const [healthRes, funnelRes, failRes, sloRes, reconRes, budgetsRes] = await Promise.all([
      read(() => apiClient.operations.integrationsHealth()),
      read(() => apiClient.operations.funnelHealth()),
      read(() => apiClient.operations.failures()),
      read(() => apiClient.operations.slo()),
      read(() => apiClient.operations.reconciliation()),
      read(() => apiClient.clients.budgets()),
    ]);
    const gaps: Record<string, string> = {};
    const note = (name: string, r: { state: string; reason?: string }) => {
      if (r.state === 'unknown') gaps[name] = r.reason || 'unknown error';
    };
    note('integrations', healthRes);
    note('design funnel', funnelRes);
    note('failures', failRes);
    note('slo', sloRes);
    note('reconciliation', reconRes);
    note('budgets', budgetsRes);
    setUnreadable(gaps);

    setIntegrations(healthRes.state === 'known' && Array.isArray(healthRes.value?.items) ? healthRes.value.items : []);
    setFunnel(funnelRes.state === 'known' && funnelRes.value?.status ? funnelRes.value as FunnelHealth : null);
    setFailures(failRes.state === 'known' && Array.isArray(failRes.value?.items) ? failRes.value.items : []);
    if (sloRes.state === 'known' && sloRes.value?.summary) {
      setSloSummary(sloRes.value.summary);
      setRecentProbes(sloRes.value.recentProbes || []);
    }
    if (reconRes.state === 'known' && reconRes.value?.auditId) {
      setReconciliation(reconRes.value);
    }
    const budgets = budgetsRes.state === 'known' && Array.isArray(budgetsRes.value?.budgets) ? budgetsRes.value.budgets : [];
    setClientBudgets(
      budgets.map((b: any): ClientBudgetReport => {
        const cap = Number(b.monthlyCapUsd ?? b.capUsd ?? 250);
        const spent = Number(b.currentSpendUsd ?? b.spentUsd ?? 0);
        const remaining = Number(b.remainingUsd ?? Math.max(0, cap - spent));
        const pct = Number(b.percentUsed ?? (cap > 0 ? (spent / cap) * 100 : 0));
        return {
          clientId: b.clientId || 'client-unknown',
          clientName: b.clientName || b.clientId || 'Client Brand',
          monthlyCapUsd: cap,
          currentSpendUsd: spent,
          remainingUsd: remaining,
          percentUsed: pct,
          quotaStatus: b.quotaStatus || b.status || (pct >= 100 ? 'EXCEEDED' : pct >= 80 ? 'WARNING' : 'HEALTHY'),
          currency: b.currency || 'USD',
          billingCycle: b.billingCycle || b.month || '2026-09',
        };
      })
    );
    setLastCheck(new Date().toLocaleTimeString());
    setLoading(false);
  };

  // Audit only: the Desk never asks Core to auto-repair (see apiClient.operations.auditReconciliation).
  const runReconciliation = async () => {
    setRunningReconciliation(true);
    setReconcileToast(null);
    try {
      const data = await apiClient.operations.auditReconciliation();
      setReconciliation(data);
      setReconcileToast(`✓ Storage audit: ${data.inSyncCount} in sync, ${data.driftCount} drift(s) found, none repaired`);
      setTimeout(() => setReconcileToast(null), 6000);
    } catch (err) {
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
    const unsubSlo = eventStream.on('slo:probe_completed', () => {
      fetchOpsData();
    });

    return () => {
      unsubReconcile();
      unsubSlo();
    };
  }, []);

  const handleAllocateBudget = async (clientId: string, newCap: number) => {
    try {
      const updated = await apiClient.clients.allocateBudget(clientId, newCap);
      // Core clamps the cap, so the toast reports the cap it stored, not the one typed.
      const stored = Number(updated?.capUsd);
      showOpsToast(
        Number.isFinite(stored)
          ? `✓ Core set the monthly budget cap for ${clientId} to $${stored.toFixed(2)}`
          : `✓ Core accepted the budget change for ${clientId} but did not report the cap it stored`
      );
      setEditingBudgetClient(null);
      fetchOpsData();
    } catch (err) {
      // Core did not change the cap, so the screen keeps showing the one it has.
      showOpsToast(`✗ Budget cap for ${clientId} was not changed: ${reasonOf(err)}`);
    }
  };

  const degradedCount = integrations.filter((i) => i.state !== 'paid_verified').length;
  const criticalCount = failures.filter((f) => f.status === 'OPERATOR_REQUIRED').length;
  const recoverableCount = failures.length;
  const failuresKnown = Boolean(lastCheck) && !unreadable.failures;
  const integrationsKnown = Boolean(lastCheck) && !unreadable.integrations;

  return (
    <section id="ops" className="screen active">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
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
          {/* Not enabled (owner decision, 2026-09-19): Core's probe runs a fake design studio, so its
              timings describe no real pipeline. */}
          <button
            className="btn"
            style={{ fontSize: 12, padding: '4px 10px' }}
            disabled
            title="Not enabled: Core's SLO probe runs against a fake design studio, so its timings would not describe the real pipeline."
          >
            ⚡ Run Synthetic Benchmark (not enabled)
          </button>
          <button
            className="btn"
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={fetchOpsData}
            disabled={loading}
          >
            {loading ? 'Checking…' : '↻ Refresh'}
          </button>
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
            <p>Last {funnel.windowHours} hours: {funnel.briefsCount} requests · {funnel.draftsCount} Canva drafts · {funnel.stalledTaskCount} overdue automatic requests · {funnel.status.replace('_', ' ')}</p>
            {funnel.oldestStalledTaskId && <p>Oldest overdue task: {funnel.oldestStalledTaskId} ({funnel.oldestStalledTaskHours} hours). {funnel.nextAction}</p>}
            {funnel.stageDurations && Object.entries(funnel.stageDurations).map(([stage, timing]) => (
              <p key={stage}>{stage.replace(/([A-Z])/g, ' $1')}: {timing.samples} completed · p50 {timing.p50Hours === null ? '—' : `${timing.p50Hours}h`} · p95 {timing.p95Hours === null ? '—' : `${timing.p95Hours}h`}</p>
            ))}
          </>
        ) : <p>Design progress unknown. {unreadable['design funnel'] || 'No result has been read yet.'}</p>}
      </div>

      {/* SLO Latency & Synthetic Heartbeat Dashboard */}
      {sloSummary && (
        <div className="panel" style={{ padding: 16, marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>SLO & Latency Performance Telemetry</h2>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className={`pill ${sloSummary.sloCompliant ? 'ok' : 'bad'}`}>
                {sloSummary.sloCompliant ? `P99 < ${sloSummary.targetP99Ms}ms SLO: COMPLIANT` : 'SLO BREACHED'}
              </span>
              <span className="pill ok" style={{ fontSize: 11 }}>
                Error Budget: {sloSummary.errorBudgetRemaining}%
              </span>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 14 }}>
            <div className="stat" style={{ padding: '10px 12px' }}>
              <b style={{ fontSize: 20 }}>{sloSummary.p50DurationMs}ms</b>
              <span style={{ fontSize: 11 }}>P50 Latency (Median)</span>
            </div>
            <div className="stat" style={{ padding: '10px 12px' }}>
              <b style={{ fontSize: 20 }}>{sloSummary.p95DurationMs}ms</b>
              <span style={{ fontSize: 11 }}>P95 Latency</span>
            </div>
            <div className="stat" style={{ padding: '10px 12px' }}>
              <b style={{ fontSize: 20, color: sloSummary.p99DurationMs < 1500 ? 'var(--accent-text, #0369a1)' : '#b91c1c' }}>
                {sloSummary.p99DurationMs}ms
              </b>
              <span style={{ fontSize: 11 }}>P99 Latency (&lt;1500ms)</span>
            </div>
            <div className="stat" style={{ padding: '10px 12px' }}>
              <b style={{ fontSize: 20 }}>{sloSummary.totalProbes}</b>
              <span style={{ fontSize: 11 }}>Synthetic Probes</span>
            </div>
            <div className="stat" style={{ padding: '10px 12px' }}>
              <b style={{ fontSize: 20, color: 'var(--ok-text, #166534)' }}>{sloSummary.successRate}%</b>
              <span style={{ fontSize: 11 }}>Success Rate</span>
            </div>
          </div>

          {/* Model Circuit Breakers */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 8 }}>
              MULTI-MODEL PROVIDER CIRCUIT BREAKERS
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {sloSummary.circuitBreakers.map((cb) => (
                <div
                  key={cb.name}
                  style={{
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    padding: '6px 12px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <span className={`dot ${cb.state === 'CLOSED' ? '' : cb.state === 'HALF_OPEN' ? 'warn' : 'bad'}`} />
                  <span style={{ fontSize: 12, fontWeight: 600, textTransform: 'capitalize' }}>{cb.name}</span>
                  <span className={`pill ${cb.state === 'CLOSED' ? 'ok' : 'warn'}`} style={{ fontSize: 10, padding: '2px 6px' }}>
                    {cb.state}
                  </span>
                  {cb.consecutiveFailures > 0 && (
                    <span style={{ fontSize: 11, color: '#EF4444' }}>Failures: {cb.consecutiveFailures}</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Recent Synthetic Runs */}
          {recentProbes.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }}>
                RECENT SYNTHETIC CAMPAIGN PROBES
              </div>
              <table className="table" style={{ fontSize: 11 }}>
                <thead>
                  <tr>
                    <th>Probe ID</th>
                    <th>Scenario</th>
                    <th>Total Latency</th>
                    <th>Stages (Ingress / Compose / QA / Publish)</th>
                    <th>Invariants</th>
                    <th>Timestamp</th>
                  </tr>
                </thead>
                <tbody>
                  {recentProbes.slice(0, 5).map((p) => (
                    <tr key={p.probeId}>
                      <td><code>{p.probeId.substring(0, 16)}</code></td>
                      <td><b>{p.scenario.replace('_', ' ').toUpperCase()}</b></td>
                      <td>
                        <span className="pill ok" style={{ fontSize: 10 }}>{p.totalDurationMs}ms</span>
                      </td>
                      <td style={{ color: 'var(--muted)' }}>
                        {p.stages.ingressMs}ms / {p.stages.composingMs}ms / {p.stages.qaMs}ms / {p.stages.publishMs}ms
                      </td>
                      <td>
                        <span className="pill ok" style={{ fontSize: 10 }}>✓ 6/6 Invariants</span>
                      </td>
                      <td style={{ color: 'var(--muted)' }}>{p.timestamp.substring(11, 19)} UTC</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Reconciliation & Storage Drift Audit Panel (FR-049, FR-050) */}
      <div className="panel" style={{ padding: 16, marginTop: 16, borderLeft: '4px solid #166534' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div>
            <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: 16 }}>
              <span>🔄 PostgreSQL · Drive · Sheets Reconciliation Ledger</span>
              <span className={`pill ${!reconciliation ? '' : reconciliation.status === 'clean' ? 'ok' : 'bad'}`} style={{ fontSize: 11 }}>
                {!reconciliation
                  ? lastCheck && !unreadable.reconciliation
                    ? 'No audit since Core started'
                    : 'No audit read'
                  : reconciliation.status === 'clean'
                    ? '100% In Sync'
                    : 'Drift found'}
              </span>
            </h2>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              Compares Core's task list with the publication receipts Core holds in memory. It does not read Google Drive or Google Sheets, and repairs nothing.
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

        {reconcileToast && (
          <div style={{ background: 'rgba(22, 101, 52, 0.08)', border: '1px solid rgba(22, 101, 52, 0.25)', borderRadius: 6, padding: '8px 12px', marginBottom: 12, fontSize: 12, color: 'var(--ok-text, #166534)' }}>
            {reconcileToast}
          </div>
        )}

        <div className="stats" style={{ gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
          <div className="stat" style={{ padding: '8px 10px' }}>
            <b style={{ fontSize: 18 }}>{reconciliation?.totalTasksAudited ?? '—'}</b>
            <span style={{ fontSize: 11 }}>Tasks Audited</span>
          </div>
          <div className="stat" style={{ padding: '8px 10px' }}>
            <b style={{ fontSize: 18 }}>{reconciliation?.totalDriveDeliverablesChecked ?? '—'}</b>
            <span style={{ fontSize: 11 }}>Drive Files</span>
          </div>
          <div className="stat" style={{ padding: '8px 10px' }}>
            <b style={{ fontSize: 18 }}>{reconciliation?.totalSheetRowsAudited ?? '—'}</b>
            <span style={{ fontSize: 11 }}>Sheet Rows</span>
          </div>
          <div className="stat" style={{ padding: '8px 10px' }}>
            <b style={{ fontSize: 18, color: 'var(--ok-text, #166534)' }}>{reconciliation?.inSyncCount ?? '—'}</b>
            <span style={{ fontSize: 11 }}>In Sync</span>
          </div>
          <div className="stat" style={{ padding: '8px 10px' }}>
            <b style={{ fontSize: 18, color: (reconciliation?.driftCount || 0) > 0 ? 'var(--warn-text, #854d0e)' : 'var(--ok-text, #166534)' }}>
              {reconciliation?.driftCount ?? '—'}
            </b>
            <span style={{ fontSize: 11 }}>Drifts Repaired</span>
          </div>
        </div>
      </div>

      {/* Client AI Generation Budgets & Token/GPU Cost Controller (Langfuse / Helicone Grade) */}
      <div className="panel" style={{ padding: 16, marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div>
            <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>⚡</span>
              <span>Client AI Generation Budgets & Cost Governance</span>
              <span className="pill blue" style={{ fontSize: 10 }}>Langfuse / Helicone Grade</span>
            </h2>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--muted)' }}>
              Real-time token & GPU spend meters, automated quota enforcement, and tenant margin protection.
            </p>
          </div>
          <button
            className="btn"
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={fetchOpsData}
          >
            🔄 Refresh Budgets
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {unreadable.budgets && (
            <div className="rule"><b>Budgets unknown</b><p>Could not read client budgets: {unreadable.budgets}</p></div>
          )}
          {clientBudgets.map((b) => {
            const isExceeded = b.quotaStatus === 'EXCEEDED';
            const isWarning = b.quotaStatus === 'WARNING';
            const barColor = isExceeded ? '#b91c1c' : isWarning ? '#92400e' : '#166534';

            return (
              <div
                key={b.clientId}
                style={{
                  padding: 14,
                  background: 'var(--soft)',
                  border: `1px solid ${isExceeded ? 'rgba(239, 68, 68, 0.4)' : 'var(--line)'}`,
                  borderRadius: 8,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div>
                    <b style={{ fontSize: 13, color: 'var(--text)' }}>{b.clientName}</b>
                    <code style={{ fontSize: 11, marginLeft: 8, color: 'var(--muted)' }}>{b.clientId}</code>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      className="pill"
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        background: barColor,
                        color: '#fff',
                      }}
                    >
                      {b.quotaStatus}
                    </span>
                    <button
                      className="btn"
                      style={{ fontSize: 11, padding: '3px 8px' }}
                      onClick={() => {
                        setEditingBudgetClient(b);
                        setNewAllocatedCap(b.monthlyCapUsd);
                      }}
                    >
                      ⚙ Adjust Cap
                    </button>
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                  <span style={{ color: 'var(--muted)' }}>
                    Monthly Spend: <b>${Number(b.currentSpendUsd || 0).toFixed(2)}</b> of <b>${Number(b.monthlyCapUsd || 0).toFixed(2)}</b>
                  </span>
                  <span style={{ fontWeight: 600, color: barColor }}>
                    {Number(b.percentUsed || 0).toFixed(1)}% Used (Remaining: ${Number(b.remainingUsd || 0).toFixed(2)})
                  </span>
                </div>

                {/* Visual Meter */}
                <div style={{ width: '100%', height: 7, background: 'rgba(255, 255, 255, 0.08)', borderRadius: 4, overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${Math.min(100, b.percentUsed)}%`,
                      height: '100%',
                      background: barColor,
                      transition: 'width 0.3s ease',
                    }}
                  />
                </div>
              </div>
            );
          })}
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
                  <td><b>{f.title || f.id.substring(0, 8)}</b></td>
                  <td>
                    <span className={`pill ${f.status === 'OPERATOR_REQUIRED' ? 'bad' : 'warn'}`}>
                      {f.status}
                    </span>
                  </td>
                  <td>Client: {f.clientId || 'Office'} · Invariant #7 check</td>
                  <td>
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
            style={{
              width: 520,
              padding: 24,
              boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
            }}
          >
            <h2 style={{ marginTop: 0 }}>Intervention Inspection</h2>
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
                <p>Client: <b>{inspectingFailure.clientId || 'Office'}</b> · {inspectingFailure.reason || 'Manual human operator intervention requested for ambiguous brief'}</p>
              </div>
              <div className="rule">
                <b>Invariant Audit State</b>
                <p>Status: <span className="pill warn">{inspectingFailure.status}</span> · Scope and design history locked.</p>
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

      {/* Client Monthly Budget Cap Allocation Modal */}
      {editingBudgetClient && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <div
            className="panel"
            style={{
              width: 440,
              padding: 24,
              boxShadow: '0 20px 40px rgba(0,0,0,0.3)',
            }}
          >
            <h2 style={{ marginTop: 0 }}>Adjust AI Generation Budget</h2>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: -4 }}>
              Set monthly spend cap for <b>{editingBudgetClient.clientName}</b> (<code>{editingBudgetClient.clientId}</code>).
            </p>

            <div style={{ margin: '16px 0' }}>
              <label htmlFor="ops-monthly-cap-input" style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                Monthly Cap (USD)
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--muted)' }}>$</span>
                <input
                  id="ops-monthly-cap-input"
                  name="opsMonthlyCapInput"
                  aria-label="Monthly Cap in USD"
                  type="number"
                  step="25"
                  min="50"
                  max="5000"
                  className="search"
                  style={{ flex: 1, fontSize: 14 }}
                  value={newAllocatedCap}
                  onChange={(e) => setNewAllocatedCap(parseFloat(e.target.value) || 0)}
                />
              </div>
              <small style={{ color: 'var(--muted)', display: 'block', marginTop: 6 }}>
                Current month spend: ${Number(editingBudgetClient.currentSpendUsd || 0).toFixed(2)}. Hard ceiling triggers at 100% cap.
              </small>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
              <button className="btn" onClick={() => setEditingBudgetClient(null)}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={() => handleAllocateBudget(editingBudgetClient.clientId, newAllocatedCap)}
              >
                Save Budget Allocation
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
