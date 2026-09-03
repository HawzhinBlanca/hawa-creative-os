import React from 'react';

export const EvalScreen: React.FC = () => {
  return (
    <section id="eval" className="screen active">
      <div className="eval">
        <div className="panel" style={{ padding: 16 }}>
          <h3>Evaluation datasets</h3>
          <div className="listitem sel">
            <span>Brief Builder</span>
            <span className="pill ok">200 cases</span>
          </div>
          <div className="listitem">
            <span>Creative Direction</span>
            <span className="pill">80 cases</span>
          </div>
          <div className="listitem">
            <span>Visual Defects</span>
            <span className="pill">120 cases</span>
          </div>
          <div className="listitem">
            <span>RTL Golden Suite</span>
            <span className="pill ok">40 cases</span>
          </div>
          <div className="listitem">
            <span>Retrieval & Leakage</span>
            <span className="pill ok">100 cases</span>
          </div>
          <button className="btn" style={{ width: '100%', marginTop: 14 }}>New frozen run</button>
        </div>

        <div className="panel" style={{ padding: 16 }}>
          <h2>Brief Builder tournament</h2>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>Blind holdout · exact versions · no production state mutation</p>

          <div className="score">
            <div className="stat"><b>100%</b><span>protected tokens</span></div>
            <div className="stat"><b>98.6%</b><span>requirement recall</span></div>
            <div className="stat"><b>$0.014</b><span>median case cost</span></div>
          </div>

          <table className="table">
            <thead>
              <tr>
                <th>Candidate</th>
                <th>Hard gates</th>
                <th>Score</th>
                <th>Latency</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><b>Gemini 3.8 Flash (2026-09-03)</b></td>
                <td><span className="pill ok">Pass</span></td>
                <td>94.2</td>
                <td>2.1s</td>
                <td><span className="pill ok">active canary</span></td>
              </tr>
              <tr>
                <td><b>GPT-5.6 Sol</b></td>
                <td><span className="pill ok">Pass</span></td>
                <td>92.8</td>
                <td>1.3s</td>
                <td><span className="pill">candidate</span></td>
              </tr>
              <tr>
                <td><b>Experimental Untested</b></td>
                <td><span className="pill bad">fact failure</span></td>
                <td>—</td>
                <td>3.7s</td>
                <td><span className="pill bad">blocked</span></td>
              </tr>
            </tbody>
          </table>

          <h3 style={{ marginTop: 24 }}>Admission</h3>
          <div className="finding" style={{ background: '#f2f8f4', borderColor: '#4d9d69' }}>
            <b style={{ color: '#1d733c' }}>Gemini 3.8 Flash passed all admission gates</b>
            <p>100% protected token preservation, zero hallucinated facts, and verified Sorani Kurdish missing-information detection.</p>
          </div>
        </div>
      </div>
    </section>
  );
};
