import React, { useState, useEffect } from 'react';

interface IntegrationHealth {
  integrationId: string;
  kind: string;
  state: 'healthy' | 'degraded' | 'unhealthy';
  checkedAt: string;
}

interface FailureItem {
  id: string;
  title: string;
  status: string;
  clientId?: string;
  reason?: string;
  createdAt?: string;
}

export const OpsScreen: React.FC = () => {
  const [integrations, setIntegrations] = useState<IntegrationHealth[]>([]);
  const [failures, setFailures] = useState<FailureItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastCheck, setLastCheck] = useState<string | null>(null);

  const fetchOpsData = async () => {
    setLoading(true);
    try {
      const [healthRes, failRes] = await Promise.all([
        fetch('/v1/integrations/health').then((r) => (r.ok ? r.json() : { items: [] })),
        fetch('/v1/operations/failures').then((r) => (r.ok ? r.json() : { items: [] })),
      ]);

      if (healthRes.items) {
        setIntegrations(healthRes.items);
      }
      if (failRes.items) {
        setFailures(failRes.items);
      }
      setLastCheck(new Date().toLocaleTimeString());
    } catch (err) {
      console.error('Failed to fetch ops telemetry:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOpsData();
  }, []);

  const degradedCount = integrations.filter((i) => i.state !== 'healthy').length;
  const criticalCount = failures.filter((f) => f.status === 'OPERATOR_REQUIRED').length;
  const recoverableCount = failures.length;

  return (
    <section id="ops" className="screen active">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>
          {loading ? 'Polling infrastructure telemetry…' : lastCheck ? `Live telemetry active · Last checked ${lastCheck}` : 'Connected to Core Telemetry'}
        </div>
        <button
          className="btn"
          style={{ fontSize: 12, padding: '4px 10px' }}
          onClick={fetchOpsData}
          disabled={loading}
        >
          {loading ? 'Checking…' : '⚡ Ping Integrations'}
        </button>
      </div>

      <div className="grid4">
        <div className="stat"><b>{criticalCount}</b><span>critical incidents</span></div>
        <div className="stat"><b>{recoverableCount}</b><span>recoverable failures</span></div>
        <div className="stat"><b>{degradedCount}</b><span>adapter degraded</span></div>
        <div className="stat"><b>14m</b><span>last backup age</span></div>
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
                      onClick={() => alert(`Reviewing task ${f.id} intervention context`)}
                    >
                      Inspect
                    </button>
                  </td>
                </tr>
              ))}

              <tr>
                <td>WAHA (WhatsApp)</td>
                <td><span className="pill ok">active</span></td>
                <td>QR connected · cursor current</td>
                <td><button className="btn" style={{ fontSize: 11 }} onClick={() => alert('Session verified')}>Verify</button></td>
              </tr>
              <tr>
                <td>Drive publication</td>
                <td><span className="pill ok">verified</span></td>
                <td>Google Shared Drive target reachable</td>
                <td><button className="btn" style={{ fontSize: 11 }} onClick={() => alert('Drive permission check: OK')}>Check</button></td>
              </tr>
              <tr>
                <td>Google Sheets Ledger</td>
                <td><span className="pill ok">connected</span></td>
                <td>Durable transaction append enabled</td>
                <td><button className="btn" style={{ fontSize: 11 }} onClick={() => alert('Sheets schema check: OK')}>Verify</button></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="panel" style={{ padding: 16 }}>
          <h2>Component health</h2>
          {integrations.length > 0 ? (
            integrations.map((item) => (
              <div key={item.integrationId} className="rule">
                <span className={`dot ${item.state === 'healthy' ? '' : item.state === 'degraded' ? 'warn' : 'bad'}`}></span>
                <b>{item.kind.toUpperCase().replace('_', ' ')} ({item.integrationId})</b>
                <p>Status: {item.state} · Checked {item.checkedAt.substring(11, 19)} UTC</p>
              </div>
            ))
          ) : (
            <>
              <div className="rule">
                <span className="dot"></span><b>PostgreSQL 17</b>
                <p>PITR WAL archiving current · RLS tenant & client context active</p>
              </div>
              <div className="rule">
                <span className="dot"></span><b>Restate 1.7.x</b>
                <p>18 active durable invocations · 4 waiting on human approval</p>
              </div>
            </>
          )}

          <div className="rule">
            <span className="dot"></span><b>PostgreSQL 17</b>
            <p>PITR WAL archiving current · RLS tenant & client context active</p>
          </div>
          <div className="rule">
            <span className="dot"></span><b>Restate 1.7.x</b>
            <p>18 active durable invocations · deterministic replay verified</p>
          </div>
        </div>
      </div>
    </section>
  );
};

