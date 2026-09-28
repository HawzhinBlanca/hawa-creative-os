import { useEffect, useRef, useState } from 'react';
import type { OperationsReliabilityReport } from '@hawa/contracts';
import { apiClient } from '../api/client.js';
import { parseOperationsReliability } from '../services/operationsEvidence.js';

const percent = (v: number | null) => v === null ? 'Unknown' : `${v.toFixed(3)}%`;
export function AvailabilityPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [month, setMonth] = useState('');
  const [report, setReport] = useState<OperationsReliabilityReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const sequence = useRef(0);
  useEffect(() => {
    const refresh = () => {
      const request = ++sequence.current;
      setLoading(true); setReport(null); setError('');
      void apiClient.operations.slo(month || undefined).then(value => {
        if (sequence.current !== request) return;
        const parsed = parseOperationsReliability(value);
        if (!parsed || parsed.schemaVersion === 2 && month && parsed.period.month !== month) {
          setError('Unsupported or incomplete reliability evidence'); return;
        }
        setReport(parsed);
      }).catch(() => { if (sequence.current === request) setError('Stored observations could not be read.'); })
        .finally(() => { if (sequence.current === request) setLoading(false); });
    };
    refresh();
    const timer = setInterval(refresh, 60000);
    return () => { clearInterval(timer); sequence.current++; };
  }, [month, refreshKey]);
  return <section className="panel" aria-label="Office reliability" style={{ padding: 16, marginTop: 16, minWidth: 0, overflowWrap: 'anywhere' }}>
    <h2>Office availability and latency</h2>
    <label>Evidence month (Asia/Baghdad) <input aria-label="Availability month" type="month" value={month} onChange={e => setMonth(e.target.value)} /></label>
    {month && <button className="btn" onClick={() => setMonth('')}>Current month</button>}
    {loading ? <p>Reading availability evidence…</p> : !report ? <p>Reliability evidence unavailable. {error}</p> : <>
      <p>Target: {report.availability.targetPercent}% monthly availability for office intake and review (Asia/Baghdad).</p>
      {report.schemaVersion === 1 ? <>
        <p><span className="pill warn">Availability unmeasured</span></p>
        <p>No independent availability observations or measured office latency are recorded. Compliance, error budget and latency are unknown.</p>
      </> : <>
        <p><span className="pill warn">{report.period.complete ? 'Completed month' : 'Provisional month'} · {report.period.month}</span></p>
        <p>Collector: {report.monitor.status.replaceAll('_', ' ')}. Last observation: {report.monitor.lastObservedAt || 'None'}. Last received: {report.monitor.lastReceivedAt || 'None'}.</p>
        <p>Known observations available: <b>{percent(report.availability.observedPercent)}</b> · Coverage: <b>{percent(report.availability.coveragePercent)}</b>.</p>
        <p>{report.availability.availableSlots} available · {report.availability.unavailableSlots} unavailable · {report.availability.unknownSlots} unknown minute slots ({report.availability.missingSlots} missing observations).</p>
        <p>With unknown time included, availability is between {percent(report.availability.minimumPercent)} and {percent(report.availability.maximumPercent)}.</p>
        <p>Monthly target: {report.availability.sloCompliant === null ? 'Not established — requires a completed month with full coverage.' : report.availability.sloCompliant ? 'Met for sampled readiness.' : 'Not met for sampled readiness.'}</p>
        <p>Successful readiness probe round-trip latency: p50 {report.latency.p50Ms === null ? '—' : `${report.latency.p50Ms} ms`} · p95 {report.latency.p95Ms === null ? '—' : `${report.latency.p95Ms} ms`} · p99 {report.latency.p99Ms === null ? '—' : `${report.latency.p99Ms} ms`} ({report.latency.observationCount} observations).</p>
        <p>These samples check Desk assets, storage and workflow readiness. They do not measure complete user journeys or design quality. Use an independent host to observe office-host outages.</p>
        {report.recentFailures.length > 0 && <details><summary>Recent unavailable or unknown observations</summary>
          <ul>{report.recentFailures.map(f => <li key={f.slotStart}>{f.slotStart} — Desk: {f.probes.desk.error.replaceAll('_', ' ')}; office: {f.probes.office.error.replaceAll('_', ' ')}</li>)}</ul>
        </details>}
        <small>Closed minute slots through {report.period.throughAt}. Target: {report.monitor.targetOrigin}. Monitor: {report.monitor.id}.</small>
      </>}
      <p>{report.nextAction}</p>
      <small>Evidence checked {report.checkedAt}. This time records the status read, not a successful operation.</small>
    </>}
  </section>;
}
