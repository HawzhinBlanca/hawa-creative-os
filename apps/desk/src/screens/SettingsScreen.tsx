import React from 'react';

export const SettingsScreen: React.FC = () => {
  return (
    <section id="settings" className="screen active">
      <div className="ops">
        <div className="panel" style={{ padding: 16 }}>
          <h2>Adapters and capabilities</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Adapter</th>
                <th>Authority</th>
                <th>State</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><b>Hawa Desk</b></td>
                <td>canonical</td>
                <td><span className="pill ok">healthy</span></td>
                <td>—</td>
              </tr>
              <tr>
                <td><b>Telegram</b></td>
                <td>capture only</td>
                <td><span className="pill ok">healthy</span></td>
                <td><button className="btn" style={{ fontSize: 11 }}>Test webhook</button></td>
              </tr>
              <tr>
                <td><b>WAHA WhatsApp</b></td>
                <td>capture only</td>
                <td><span className="pill warn">quarantined</span></td>
                <td><button className="btn" style={{ fontSize: 11 }}>View admission</button></td>
              </tr>
              <tr>
                <td><b>HyCanvas</b></td>
                <td>creative source</td>
                <td><span className="pill ok">v0.3.9 admitted</span></td>
                <td><button className="btn" style={{ fontSize: 11 }}>Proof report</button></td>
              </tr>
            </tbody>
          </table>

          <h3 style={{ marginTop: 24 }}>Network policy</h3>
          <div className="rule">
            <b>Private office / VPN only</b>
            <p>No public administration endpoints. Outbound provider egress is capability-scoped, token-budgeted, and audited in OpenTelemetry.</p>
          </div>
        </div>

        <div className="panel" style={{ padding: 16 }}>
          <h2>Model registry</h2>
          <div className="rule">
            <b>fast_router & brief_builder</b>
            <p>Gemini 3.8 Flash · exact snapshot 2026-09-03 · 100% token preservation</p>
          </div>
          <div className="rule">
            <b>creative_director</b>
            <p>GPT-5.6 Sol · creator/judge separation active · discrete editable nodes</p>
          </div>
          <div className="rule">
            <b>visual_judge (advisory)</b>
            <p>Claude Opus 5 · independent model family · cannot waive hard QA</p>
          </div>

          <h3 style={{ marginTop: 24 }}>Upstream locks</h3>
          <div className="finding">
            <b>No automatic upgrades</b>
            <p>Studio, workflow engine, Comfy nodes, models, and containers require offline evidence before admission.</p>
          </div>
        </div>
      </div>
    </section>
  );
};
