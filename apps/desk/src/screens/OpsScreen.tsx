import React from 'react';

export const OpsScreen: React.FC = () => {
  return (
    <section id="ops" className="screen active">
      <div className="grid4">
        <div className="stat"><b>0</b><span>critical incidents</span></div>
        <div className="stat"><b>2</b><span>recoverable failures</span></div>
        <div className="stat"><b>1</b><span>adapter degraded</span></div>
        <div className="stat"><b>14m</b><span>last backup age</span></div>
      </div>

      <div className="ops" style={{ marginTop: 16 }}>
        <div className="panel" style={{ padding: 16 }}>
          <h2>Actionable operations</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Component</th>
                <th>State</th>
                <th>Evidence</th>
                <th>Safe action</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>WAHA</td>
                <td><span className="pill warn">reauth</span></td>
                <td>cursor current to 09:42</td>
                <td><button className="btn" style={{ fontSize: 11 }}>Keep disabled</button></td>
              </tr>
              <tr>
                <td>Drive publication</td>
                <td><span className="pill warn">retryable</span></td>
                <td>file exists; response lost</td>
                <td><button className="btn" style={{ fontSize: 11 }}>Reconcile</button></td>
              </tr>
              <tr>
                <td>Task 0261</td>
                <td><span className="pill bad">operator</span></td>
                <td>studio revision conflict</td>
                <td><button className="btn" style={{ fontSize: 11 }}>Compare sources</button></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="panel" style={{ padding: 16 }}>
          <h2>Component health</h2>
          <div className="rule">
            <span className="dot"></span><b>PostgreSQL 17</b>
            <p>PITR WAL archiving current · RLS tenant & client context active</p>
          </div>
          <div className="rule">
            <span className="dot"></span><b>Restate 1.7.x</b>
            <p>18 active durable invocations · 4 waiting on human approval</p>
          </div>
          <div className="rule">
            <span className="dot"></span><b>HyCanvas Studio</b>
            <p>Pinned v0.3.9 · round-trip checksum pass · Chromium render active</p>
          </div>
          <div className="rule">
            <span className="dot"></span><b>Asset Lab Worker</b>
            <p>Queue 2 · approved workflow nodes only · network outbound disabled</p>
          </div>
        </div>
      </div>
    </section>
  );
};
