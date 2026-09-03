import React, { useState } from 'react';

interface DatasetInfo {
  id: string;
  name: string;
  cases: string;
  status: 'ok' | 'normal';
  description: string;
}

const DATASETS: DatasetInfo[] = [
  { id: 'brief', name: 'Brief Builder', cases: '200 cases', status: 'ok', description: 'Blind holdout · exact versions · no production state mutation' },
  { id: 'direction', name: 'Creative Direction', cases: '80 cases', status: 'normal', description: 'Multi-variant layout planning, hierarchy preservation, and spacing' },
  { id: 'defects', name: 'Visual Defects', cases: '120 cases', status: 'normal', description: 'Artifact detection, safe-zone violations, and model hallucinations' },
  { id: 'rtl', name: 'RTL Golden Suite', cases: '40 cases', status: 'ok', description: 'UAX #9 bidi paragraph embedding, isolate formatting, and Sorani numerals' },
  { id: 'retrieval', name: 'Retrieval & Leakage', cases: '100 cases', status: 'ok', description: 'Cross-client leakage tests, negative context filtering, and scope locks' },
];

export const EvalScreen: React.FC = () => {
  const [selectedDataset, setSelectedDataset] = useState<string>('brief');
  const [runningTournament, setRunningTournament] = useState(false);
  const [lastRunTime, setLastRunTime] = useState<string | null>('2026-09-03 23:45 UTC');
  const [runStats, setRunStats] = useState({
    protectedTokens: '100%',
    recall: '98.6%',
    cost: '$0.014',
    overallPassRate: 100,
    testsPassed: 94,
    totalTests: 94,
  });

  const handleRunTournament = () => {
    setRunningTournament(true);
    setTimeout(() => {
      setRunningTournament(false);
      const now = new Date();
      setLastRunTime(now.toISOString().replace('T', ' ').substring(0, 19) + ' UTC');
      setRunStats({
        protectedTokens: '100%',
        recall: '99.1%',
        cost: '$0.013',
        overallPassRate: 100,
        testsPassed: 94,
        totalTests: 94,
      });
    }, 750);
  };

  const currentDataset = DATASETS.find((d) => d.id === selectedDataset) || DATASETS[0];

  return (
    <section id="eval" className="screen active">
      <div className="eval">
        <div className="panel" style={{ padding: 16 }}>
          <h3>Evaluation datasets</h3>
          {DATASETS.map((ds) => (
            <div
              key={ds.id}
              className={`listitem ${selectedDataset === ds.id ? 'sel' : ''}`}
              style={{ cursor: 'pointer' }}
              onClick={() => setSelectedDataset(ds.id)}
            >
              <span>{ds.name}</span>
              <span className={`pill ${ds.status === 'ok' ? 'ok' : ''}`}>{ds.cases}</span>
            </div>
          ))}

          <button
            className="btn primary"
            style={{ width: '100%', marginTop: 14 }}
            disabled={runningTournament}
            onClick={handleRunTournament}
          >
            {runningTournament ? 'Running Tournament...' : '⚡ New frozen run'}
          </button>

          {lastRunTime && (
            <small style={{ color: 'var(--muted)', display: 'block', marginTop: 10, textAlign: 'center' }}>
              Last executed: {lastRunTime}
            </small>
          )}
        </div>

        <div className="panel" style={{ padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2>{currentDataset.name} tournament</h2>
            <span className="pill ok">Holdout v2026.09</span>
          </div>
          <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: -2 }}>
            {currentDataset.description}
          </p>

          {runningTournament && (
            <div className="finding" style={{ background: '#eff6ff', borderColor: '#3b82f6', marginBottom: 16 }}>
              <b style={{ color: '#1d4ed8' }}>Running Multi-Pass Tournament Suite…</b>
              <p style={{ margin: '4px 0', fontSize: 12, color: '#2563eb' }}>
                Executing deterministic checks: Routing & Brief (60/60) → Retrieval Isolation (20/20) → Copy Guard (4/4) → Visual Rubric (10/10)…
              </p>
            </div>
          )}

          <div className="score">
            <div className="stat"><b>{runStats.protectedTokens}</b><span>protected tokens</span></div>
            <div className="stat"><b>{runStats.recall}</b><span>requirement recall</span></div>
            <div className="stat"><b>{runStats.cost}</b><span>median case cost</span></div>
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
                <td><span className="pill ok">Pass (100%)</span></td>
                <td>94.8</td>
                <td>2.1s</td>
                <td><span className="pill ok">active canary</span></td>
              </tr>
              <tr>
                <td><b>GPT-5.6 Sol</b></td>
                <td><span className="pill ok">Pass (100%)</span></td>
                <td>93.2</td>
                <td>1.3s</td>
                <td><span className="pill">candidate</span></td>
              </tr>
              <tr>
                <td><b>Claude Opus 5 (Visual Judge)</b></td>
                <td><span className="pill ok">Pass (10/10)</span></td>
                <td>91.5</td>
                <td>3.1s</td>
                <td><span className="pill">advisory only</span></td>
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

          <h3 style={{ marginTop: 24 }}>Admission Status</h3>
          <div className="finding" style={{ background: '#f2f8f4', borderColor: '#4d9d69' }}>
            <b style={{ color: '#1d733c' }}>Gemini 3.8 Flash & GPT-5.6 Sol passed all admission gates</b>
            <p>100% protected token preservation, zero hallucinated facts, zero hard QA rule overrides, and verified Sorani Kurdish missing-information detection.</p>
          </div>
        </div>
      </div>
    </section>
  );
};

