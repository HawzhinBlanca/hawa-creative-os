import type { EvaluationDatasetSource } from '@hawa/contracts';
import { EVALUATION_SUITES, object, count, percent, recordedTime, caseOutcome, statsFromReport } from '../services/evaluation-evidence.js';
export { statsFromReport } from '../services/evaluation-evidence.js';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { apiClient } from '../api/client.js';
import { reasonOf } from '../services/statusReport.js';
import { pendingEvaluation, retainEvaluation, clearEvaluation, type EvaluationAction } from '../services/evaluation-action.js';
import { EvaluationSettlementPanel } from '../components/EvaluationSettlementPanel.js';
import { DailySpendingSummary } from '../components/DailySpendingSummary.js';
import { EvaluationCallCost } from '../components/EvaluationCallCost.js';

interface DatasetInfo {
  id: string;
  name: string;
  cases: string;
  status: 'available' | 'unavailable' | 'normal';
  description: string;
}

// Names only, so the screen can be navigated before Core answers. Case counts are unknown until
// Core reports them; a count shown here would be invented.
const FALLBACK_DATASETS: DatasetInfo[] = [
  { id: 'brief', name: 'Brief Builder', cases: 'count unknown', status: 'normal', description: 'Fixture diagnostics · not model admission evidence' },
  { id: 'rtl', name: 'RTL Golden Suite', cases: 'count unknown', status: 'normal', description: 'UAX #9 bidi paragraph embedding, isolate formatting, and Sorani numerals' },
  { id: 'retrieval', name: 'Retrieval & Leakage', cases: 'count unknown', status: 'normal', description: 'Cross-client leakage tests, negative context filtering, and scope locks' },
];

export const EvalScreen: React.FC = () => {
  const [datasets, setDatasets] = useState<DatasetInfo[]>(FALLBACK_DATASETS);
  const [selectedDataset, setSelectedDataset] = useState<string>('brief');
  const [cases, setCases] = useState<any[]>([]);
  const [caseSource, setCaseSource] = useState<EvaluationDatasetSource | null>(null);
  const [selectedReport, setSelectedReport] = useState<unknown>(null);
  const [loadingCases, setLoadingCases] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [langFilter, setLangFilter] = useState<'all' | 'ckb' | 'ar' | 'en'>('all');
  const [inspectCase, setInspectCase] = useState<any | null>(null);
  const [activeTab, setActiveTab] = useState<'cases' | 'candidates' | 'suites'>('cases');

  const [runningTournament, setRunningTournament] = useState(false);
  const [pendingAction, setPendingAction] = useState<EvaluationAction | null>(pendingEvaluation);
  const [lastRunTime, setLastRunTime] = useState<string | null>(null);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [pastRuns, setPastRuns] = useState<any[]>([]);
  const [callEvidence, setCallEvidence] = useState<React.ComponentProps<typeof EvaluationSettlementPanel>['detail'] | null>(null);
  const selectionVersion = useRef(0);
  const receiptSelection=useRef<string|null>(null),receiptRequest=useRef(0);
  // No run loaded means no numbers: the cards show — until Core returns a report.
  const runStats = statsFromReport(selectedReport);
  const selectRun = (run: {runId: string; createdAt?: string; timestamp?: string; report?: unknown}) => {
    selectionVersion.current++;
    setLastRunId(run.runId); setLastRunTime(recordedTime(run.createdAt || run.timestamp));
    setSelectedReport(run.report ?? null);
    receiptSelection.current = null; receiptRequest.current++; setCallEvidence(null);
  };
  const [evalNotice, setEvalNotice] = useState<string | null>(null);
  const addEvalNotice = (text: string) => setEvalNotice((prev) => (prev ? `${prev} ${text}` : text));
  const [casesNotice, setCasesNotice] = useState<string | null>(null);

  // Fetch Dataset List & Historical Runs
  useEffect(() => {
    apiClient.evaluations.datasets()
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          setDatasets(
            data.map((d: any) => ({
              id: d.id,
              name: d.name,
              cases: typeof (d.casesCount ?? d.count) === 'number' ? `${d.casesCount ?? d.count} cases` : 'count unknown',
              status: d.status === 'available' ? 'available' : d.status === 'unavailable' ? 'unavailable' : 'normal',
              description: d.description || '',
            }))
          );
        }
      })
      .catch((err) => addEvalNotice(`Could not read the dataset list: ${reasonOf(err)}. Case counts are unknown.`));

    const initialSelection = selectionVersion.current;
    apiClient.evaluations.runs()
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          setPastRuns(previous => [...data, ...previous.filter(run => !data.some(saved => saved.runId === run.runId))]);
          const latest = data[data.length - 1];
          if (latest?.runId && selectionVersion.current === initialSelection) {
            selectRun(latest);
            if (!latest.settlement && latest.report?.executionStatus === 'stopped') addEvalNotice(`Evaluation stopped. ${latest.report.modelCallHold?.safeAction || 'Review the provider outcome before starting another run.'}`);
          }
        }
      })
      .catch((err) => addEvalNotice(`Could not read past evaluation runs: ${reasonOf(err)}. No results are shown.`));
  }, []);

  // Fetch Cases for currently selected dataset
  useEffect(() => {
    let current = true;
    setLoadingCases(true); setCases([]); setCaseSource(null); setInspectCase(null);
    setCasesNotice(null);
    apiClient.evaluations.cases(selectedDataset)
      .then((data) => {
        if (!current) return;
        if (!Array.isArray(data.cases)) throw new Error('Case definitions were not returned');
        setCases(data.cases);
        setCaseSource(data.datasetId === selectedDataset && typeof data.source?.file === 'string' && typeof data.source?.sha256 === 'string' ? data.source : null);
      })
      .catch((err) => {
        if (!current) return;
        setCases([]); setCaseSource(null);
        setCasesNotice(`Could not read the cases for ${selectedDataset}: ${reasonOf(err)}`);
      })
      .finally(() => { if (current) setLoadingCases(false); });
    return () => { current = false; };
  }, [selectedDataset]);

  const currentDataset = datasets.find((d) => d.id === selectedDataset) || datasets[0];

  // Filtered & Searched Cases
  const filteredCases = useMemo(() => {
    return cases.filter((c) => {
      const lang = c.language || 'unknown';
      if (langFilter !== 'all' && lang !== langFilter) return false;

      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      const idMatch = String(c.id || '').toLowerCase().includes(q);
      const textMatch = String(c.message || c.text || c.query || c.input_text || '').toLowerCase().includes(q);
      const clientMatch = String(c.client_id || c.expected?.client || '').toLowerCase().includes(q);
      return idMatch || textMatch || clientMatch;
    });
  }, [cases, searchQuery, langFilter]);

  const handleRunTournament = async (selected?: EvaluationAction) => {
    setRunningTournament(true);
    try {
      const action = selected || pendingAction || {actionId: crypto.randomUUID(), name: 'Full fixture evaluation'};
      retainEvaluation(action);
      setPendingAction(action);
      const data = await apiClient.evaluations.run(action.name, action.actionId);
      if (data.completedAt || data.settlement) { clearEvaluation(action.actionId); setPendingAction(null); }
      selectRun(data);
      setPastRuns((prev) => [...prev.filter(run => run.runId !== data.runId), data]);
      if (!data.settlement && data.report?.executionStatus === 'stopped') addEvalNotice(`Evaluation stopped. ${data.report.modelCallHold?.safeAction || 'Review the provider outcome before starting another run.'}`);
    } catch (err) {
      addEvalNotice(`Evaluation outcome unavailable: ${reasonOf(err)}. Retry this same action to read or resume its saved run.`);
    } finally {
      setRunningTournament(false);
    }
  };

  const loadReceipts=async(runId:string)=>{
    const request=++receiptRequest.current;receiptSelection.current=runId;setCallEvidence(null);
    try{const detail=await apiClient.evaluations.get(runId);if(request===receiptRequest.current)setCallEvidence(detail);}
    catch(error){if(request===receiptRequest.current)addEvalNotice(`Could not load call receipts: ${reasonOf(error)}`);}
  };

  return (
    <section id="eval" className="screen active" style={{ overflowY: 'auto' }}>
      <div className="eval" style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 16 }}>
        <h1 className="sr-only">Evaluation & Benchmark Suites</h1>
        {/* Left Sidebar: Dataset Navigation & Run Controls */}
        <div className="panel" style={{ padding: 16, height: 'fit-content' }}>
          <h2 style={{ margin: '0 0 12px', fontSize: 16 }}>Evaluation datasets</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {datasets.map((ds) => (
              <div
                key={ds.id}
                className={`listitem ${selectedDataset === ds.id ? 'sel' : ''}`}
                style={{
                  cursor: 'pointer',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 10px',
                  borderRadius: 6,
                }}
                onClick={() => setSelectedDataset(ds.id)}
              >
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontWeight: selectedDataset === ds.id ? 700 : 500, fontSize: 13 }}>{ds.name}</span>
                  <small style={{ color: 'var(--muted)', fontSize: 10 }}>{ds.status === 'unavailable' ? 'Corpus unavailable' : 'Case definitions'}</small>
                </div>
                <span className="pill" style={{ fontSize: 10, color: 'var(--ink)' }}>
                  {ds.cases}
                </span>
              </div>
            ))}
          </div>

          <button
            className="btn primary"
            style={{ width: '100%', marginTop: 16, padding: '10px 12px', fontWeight: 700, fontSize: 13 }}
            disabled={runningTournament}
            onClick={() => void handleRunTournament()}
          >
            {runningTournament ? 'Running evaluation...' : pendingAction ? 'Retry saved evaluation' : 'Run fixture evaluation'}
          </button>

          <p style={{fontSize:12,color:'var(--muted)'}}>Runs routing, retrieval, copy, visual and attack-pattern fixtures. Browsing a dataset does not change this scope. RTL rendering is not included.</p>

          {lastRunId && (
            <div style={{ color: 'var(--muted)', marginTop: 12, textAlign: 'center', fontSize: 11, background: 'rgba(255,255,255,0.03)', padding: 8, borderRadius: 6, border: '1px solid var(--line)' }}>
              <div>Recorded start: <b>{lastRunTime || 'Not reported'}</b></div>
              {lastRunId && <div style={{ fontFamily: 'monospace', fontSize: 10, marginTop: 3 }}>ID: {lastRunId.substring(0, 8)}…</div>}
            </div>
          )}

          {pastRuns.length > 0 && (
            <div style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, color: 'var(--muted)', display: 'flex', justifyContent: 'space-between' }}>
                <span>Run History</span>
                <span className="pill" style={{ fontSize: 9, color: 'var(--ink)' }}>{pastRuns.length} runs</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 150, overflowY: 'auto' }}>
                {pastRuns.slice(-4).reverse().map((run) => (
                  <div
                    key={run.runId}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: 11,
                      padding: '6px 8px',
                      background: 'var(--bg)',
                      borderRadius: 4,
                      border: '1px solid var(--line)',
                    }}
                  >
                    <button className="btn btn-sm" aria-pressed={lastRunId === run.runId} onClick={() => selectRun(run)}>{run.runId.substring(0, 8)}</button>
                    <span className={`pill ${run.settlement || run.status === 'running' || run.report?.executionStatus === 'stopped' || statsFromReport(run.report).overall === '—' ? '' : 'ok'}`} style={{ fontSize: 10, color: 'var(--ink)' }}>
                      {run.settlement ? 'Closed · evidence retained' : run.status === 'running' ? 'Incomplete' : run.report?.executionStatus === 'stopped' ? 'Stopped · review required' : statsFromReport(run.report).overall === '—' ? 'Not reported' : `${statsFromReport(run.report).overall} pass`}
                    </span>
                    <button className="btn btn-sm" onClick={() => void loadReceipts(run.runId)}>Calls</button>
                    {run.resumable && <button className="btn btn-sm" disabled={runningTournament} onClick={() => void handleRunTournament({actionId:run.actionId,name:run.name})}>Resume</button>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {callEvidence && <section className="panel" style={{padding:16,gridColumn:'1 / -1'}} aria-label="Evaluation call receipts">
          <h3>Saved calls · {callEvidence.runId.substring(0,8)}</h3>
          <p>Costs are recorded estimates. An unknown amount remains unknown; these receipts do not establish the provider’s final bill.</p>
          <div style={{maxHeight:260,overflow:'auto'}}><table style={{width:'100%',textAlign:'left'}}>
            <thead><tr><th>Call</th><th>Model</th><th>Outcome</th><th>Estimated cost</th></tr></thead>
            <tbody>{callEvidence.calls.map(call => <tr key={call.ordinal}>
              <td>{call.ordinal}</td><td>{call.provider || 'Unknown provider'} / {call.model || 'Unknown model'}</td>
              <td>{call.status === 'pending' ? 'Unconfirmed · review required' : call.status}{call.error && <div>{call.error.code} {call.error.detail?.providerRequestId || ''}</div>}</td>
              <td><EvaluationCallCost {...call} /></td>
            </tr>)}</tbody>
          </table></div>
          <DailySpendingSummary daily={callEvidence.daily} />
          <EvaluationSettlementPanel key={`${callEvidence.runId}:${callEvidence.snapshotHash}`} detail={callEvidence} onSettled={async()=>{
            const [detail,runs]=await Promise.all([apiClient.evaluations.get(callEvidence.runId),apiClient.evaluations.runs()]);
            if(receiptSelection.current===callEvidence.runId)setCallEvidence(detail);setPastRuns(runs);
            if(detail.settlement){clearEvaluation(detail.actionId);setPendingAction(pendingEvaluation());}
          }}/>
          <div style={{display:'flex',gap:8,marginTop:12}}>
            <button className="btn btn-sm" onClick={() => void loadReceipts(callEvidence.runId)}>Reload receipts</button>
            <button className="btn btn-sm" onClick={() => {receiptSelection.current=null;receiptRequest.current++;setCallEvidence(null);}}>Close receipts</button>
          </div>
        </section>}

        {/* Keep the evaluation beside its sidebar when the full-width receipt row is open. */}
        <div className="panel" style={{ padding: 20, gridColumn: 2, gridRow: 1, minWidth: 0 }}>
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h2 style={{ margin: 0, fontSize: 18 }}>{currentDataset?.name}</h2>
                <span className="pill" style={{ fontSize: 10, color: 'var(--ink)' }}>Fixture diagnostics</span>
              </div>
              <p style={{ color: 'var(--muted)', fontSize: 12, margin: '4px 0 0' }}>{currentDataset?.description}</p>
            </div>

            {/* View Switcher Tabs */}
            <div style={{ display: 'flex', gap: 4, background: 'rgba(0,0,0,0.2)', padding: 3, borderRadius: 6, border: '1px solid var(--line)' }}>
              <button
                className={`btn ${activeTab === 'cases' ? 'primary' : ''}`}
                style={{ fontSize: 11, padding: '4px 10px' }}
                onClick={() => setActiveTab('cases')}
              >
                Cases ({loadingCases || casesNotice ? '—' : cases.length})
              </button>
              <button
                className={`btn ${activeTab === 'suites' ? 'primary' : ''}`}
                style={{ fontSize: 11, padding: '4px 10px' }}
                onClick={() => setActiveTab('suites')}
              >
                Suite Breakdown
              </button>
              <button
                className={`btn ${activeTab === 'candidates' ? 'primary' : ''}`}
                style={{ fontSize: 11, padding: '4px 10px' }}
                onClick={() => setActiveTab('candidates')}
              >
                Candidates
              </button>
            </div>
          </div>

          {runningTournament && (
            <div className="finding" style={{ background: '#eff6ff', borderColor: '#3b82f6', marginBottom: 16 }}>
              <b style={{ color: '#1d4ed8' }}>Running fixture evaluation…</b>
              <p style={{ margin: '4px 0', fontSize: 12, color: '#2563eb' }}>
                Executing fixture checks and bounded model calls: Routing & Brief → Retrieval Isolation → Copy Guard → Visual Rubric → Adversarial Safety. Results appear when Core returns the report.
              </p>
            </div>
          )}

          <p style={{fontSize:12}}>Selected saved run: <b>{lastRunId || 'None'}</b>. Scores cover its full fixture tournament.</p>
          {/* KPI Score Cards */}
          {evalNotice && (
            <div className="finding" style={{ background: '#fef2f2', borderColor: '#dc2626', marginBottom: 16 }}>
              <b style={{ color: '#991b1b' }}>Evaluation data unavailable</b>
              <p style={{ margin: '4px 0', fontSize: 12, color: '#b91c1c' }}>{evalNotice}</p>
            </div>
          )}

          <div className="score" style={{ marginBottom: 16 }}>
            <div className="stat"><b>{runStats?.copyGuard ?? '—'}</b><span>copy guard pass rate</span></div>
            <div className="stat"><b>{runStats?.recall ?? '—'}</b><span>retrieval pass rate</span></div>
            <div className="stat"><b>{runStats?.overall ?? '—'}</b><span>overall pass rate</span></div>
            <div className="stat"><b>{runStats?.totalTests != null ? `${runStats.testsPassed} / ${runStats.totalTests}` : '—'}</b><span>cases passed</span></div>
          </div>

          {/* TAB 1: Real Interactive Cases Browser */}
          {activeTab === 'cases' && (
            <div>
              {/* Search and Language Filters */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
                <input
                  id="eval-case-search-input"
                  name="evalCaseSearch"
                  aria-label="Search cases by ID, prompt text, or client"
                  type="text"
                  placeholder="Search cases by ID, prompt text, or client..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{
                    flex: 1,
                    background: 'var(--bg)',
                    border: '1px solid var(--line)',
                    color: 'var(--ink)',
                    padding: '6px 12px',
                    borderRadius: 6,
                    fontSize: 12,
                    outline: 'none',
                  }}
                />
                <div style={{ display: 'flex', gap: 4 }}>
                  {(['all', 'ckb', 'ar', 'en'] as const).map((l) => (
                    <button
                      key={l}
                      className={`btn ${langFilter === l ? 'primary' : ''}`}
                      style={{ fontSize: 10, padding: '4px 8px', textTransform: 'uppercase', fontWeight: 600 }}
                      onClick={() => setLangFilter(l)}
                    >
                      {l === 'all' ? 'All' : l}
                    </button>
                  ))}
                </div>
              </div>

              {loadingCases ? (
                <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                  Loading {selectedDataset} cases...
                </div>
              ) : casesNotice ? (
                <div style={{ padding: 30, textAlign: 'center', color: '#b91c1c', fontSize: 13, border: '1px dashed var(--line)', borderRadius: 8 }}>
                  {casesNotice}
                </div>
              ) : filteredCases.length === 0 ? (
                <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)', fontSize: 13, border: '1px dashed var(--line)', borderRadius: 8 }}>
                  No cases match query "{searchQuery}"
                </div>
              ) : (
                <div style={{ maxHeight: 420, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 6 }}>
                  <table className="table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--line)', textAlign: 'left' }}>
                        <th style={{ padding: '8px 10px', width: 90 }}>Case ID</th>
                        <th style={{ padding: '8px 10px', width: 60 }}>Lang</th>
                        <th style={{ padding: '8px 10px' }}>Input Text / Query</th>
                        <th style={{ padding: '8px 10px', width: 140 }}>Target / Invariants</th>
                        <th style={{ padding: '8px 10px', width: 120 }}>Status</th>
                        <th style={{ padding: '8px 10px', width: 70 }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCases.map((c, idx) => {
                        const outcome = caseOutcome(selectedReport, caseSource, c.id);
                        const lang = c.language || 'unknown';
                        const text = c.message || c.text || c.query || c.input_text || '—';
                        const target = c.client_id || c.expected?.client || (c.expected_base_direction ? `Direction: ${c.expected_base_direction}` : '—');
                        return (
                          <tr key={c.id || idx} style={{ borderBottom: '1px solid var(--line)' }}>
                            <td style={{ padding: '8px 10px', fontFamily: 'monospace', fontWeight: 700, color: 'var(--accent-text, #0369a1)' }}>
                              {c.id || `CASE-${idx + 1}`}
                            </td>
                            <td style={{ padding: '8px 10px' }}>
                              <span className="pill" style={{ fontSize: 10, color: 'var(--ink)', textTransform: 'uppercase' }}>
                                {lang}
                              </span>
                            </td>
                            <td
                              style={{
                                padding: '8px 10px',
                                fontFamily: lang === 'ckb' || lang === 'ar' ? 'Vazirmatn, sans-serif' : 'inherit',
                                direction: lang === 'ckb' || lang === 'ar' ? 'rtl' : 'ltr',
                                maxWidth: 280,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                              title={text}
                            >
                              {text}
                            </td>
                            <td style={{ padding: '8px 10px', color: 'var(--muted)', fontSize: 11 }}>
                              {target}
                            </td>
                            <td style={{ padding: '8px 10px' }}>
                              <span className={`pill ${outcome === 'Passed' ? 'ok' : outcome === 'Failed' ? 'bad' : ''}`} style={{ fontSize: 10, padding: '2px 6px', color: outcome === 'Passed' || outcome === 'Failed' ? undefined : 'var(--ink)' }}>
                                {outcome}
                              </span>
                            </td>
                            <td style={{ padding: '8px 10px' }}>
                              <button
                                className="btn"
                                style={{ fontSize: 10, padding: '2px 8px' }}
                                onClick={() => setInspectCase(c)}
                                title="Inspect Case Assertions & Ground Truth"
                              >
                                🔍 Inspect
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {activeTab === 'suites' && (
            <div aria-label="Recorded suite results" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
              {EVALUATION_SUITES.map(([key, label]) => {
                const suite = object(object(selectedReport)[key]), execution = object(suite.execution);
                const number = (value: unknown) => count(value) ? String(value) : 'Not reported';
                return <section key={key} style={{border:'1px solid var(--line)',borderRadius:8,padding:14}}>
                  <h3 style={{marginTop:0,fontSize:14}}>{label}</h3>
                  <p>Pass rate: {percent(suite.passRate)}</p>
                  <p>Passed: {number(suite.passedCases)} · Failed: {number(suite.failedCases)} · Total: {number(suite.totalCases)}</p>
                  <p>Not executed: {number(execution.unexecutedCases)} · Unreported: {number(suite.unreportedCases)}</p>
                  <p>Critical violations: {number(suite.criticalViolations)}</p>
                  {typeof suite.dataset === 'string' && <small>{suite.dataset}</small>}
                </section>;
              })}
              <p style={{gridColumn:'1 / -1'}}>Fixture checks do not establish native RTL rendering, Canva editability, held-out retrieval quality or model admission. Missing measurements stay unreported.</p>
            </div>
          )}

          {activeTab === 'candidates' && (
            <section aria-label="Recorded model evidence">
              <p>Candidate ranking, human scores and canary status: Not reported.</p>
              <p>Recorded calls identify the providers observed in a run; they do not establish admission.</p>
              {lastRunId && <button className="btn" onClick={() => void loadReceipts(lastRunId)}>Load calls for selected run</button>}
              {callEvidence?.runId === lastRunId && <table className="table" style={{width:'100%',marginTop:12}}>
                <thead><tr><th>Call</th><th>Observed provider / model</th><th>Outcome</th><th>Evidence source</th><th>Recorded latency</th></tr></thead>
                <tbody>{callEvidence.calls.map(call => <tr key={call.ordinal}>
                  <td>{call.ordinal}</td><td>{call.provider || 'Not reported'} / {call.model || 'Not reported'}</td>
                  <td>{call.status}</td><td>{call.provenance || 'Not reported'}</td><td>{typeof call.latencyMs === 'number' && Number.isFinite(call.latencyMs) && call.latencyMs >= 0 ? `${call.latencyMs} ms` : 'Not reported'}</td>
                </tr>)}</tbody>
              </table>}
            </section>
          )}

          {/* Core reports no admission-gate results, so no model is shown as admitted here. */}
          <h3 style={{ marginTop: 20, fontSize: 13 }}>Admission Status</h3>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>
            Not reported. Core does not return admission-gate results, so this screen shows no model as admitted.
          </p>
        </div>
      </div>

      {/* Case Inspection Modal */}
      {inspectCase && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.7)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: 20,
          }}
          onClick={() => setInspectCase(null)}
        >
          <div
            style={{
              background: '#0F172A',
              border: '1px solid #334155',
              borderRadius: 12,
              width: '100%',
              maxWidth: 680,
              maxHeight: '85vh',
              overflowY: 'auto',
              padding: 20,
              boxShadow: '0 20px 50px rgba(0,0,0,0.8)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="pill ok" style={{ fontSize: 11 }}>{inspectCase.id}</span>
                <b style={{ fontSize: 14, color: '#fff' }}>Evaluation Case Inspector</b>
              </div>
              <button
                className="btn"
                style={{ fontSize: 12, padding: '2px 8px' }}
                onClick={() => setInspectCase(null)}
              >
                ✕ Close
              </button>
            </div>

            {/* Input message card */}
            <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--line)', borderRadius: 8, padding: 12, marginBottom: 14 }}>
              <small style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 }}>
                Input Prompt / Raw Message
              </small>
              <div
                style={{
                  fontSize: 14,
                  marginTop: 6,
                  lineHeight: 1.5,
                  fontFamily: inspectCase.language === 'ckb' || inspectCase.language === 'ar' ? 'Vazirmatn, sans-serif' : 'inherit',
                  direction: inspectCase.language === 'ckb' || inspectCase.language === 'ar' ? 'rtl' : 'ltr',
                }}
              >
                {inspectCase.message || inspectCase.text || inspectCase.query || inspectCase.input_text || '—'}
              </div>
            </div>

            {/* Expected Invariants */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
              <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--line)', borderRadius: 8, padding: 10 }}>
                <b style={{ fontSize: 11, color: 'var(--accent-text, #0369a1)', display: 'block', marginBottom: 4 }}>Target Client / Scope</b>
                <span style={{ fontSize: 13, fontFamily: 'monospace' }}>
                  {inspectCase.client_id || inspectCase.expected?.client || '—'}
                </span>
              </div>
              <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--line)', borderRadius: 8, padding: 10 }}>
                <b style={{ fontSize: 11, color: 'var(--ok-text, #166534)', display: 'block', marginBottom: 4 }}>Required Checks</b>
                <span style={{ fontSize: 12 }}>
                  {Array.isArray(inspectCase.checks) ? inspectCase.checks.join(', ') : 'Not declared in this case'}
                </span>
              </div>
            </div>

            {/* Protected tokens breakdown */}
            {inspectCase.expected?.protected_tokens && inspectCase.expected.protected_tokens.length > 0 && (
              <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--line)', borderRadius: 8, padding: 10, marginBottom: 14 }}>
                <b style={{ fontSize: 11, color: '#F59E0B', display: 'block', marginBottom: 6 }}>
                  Protected Tokens (Must Preserve Exactly)
                </b>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {inspectCase.expected.protected_tokens.map((pt: any, i: number) => (
                    <span
                      key={i}
                      style={{
                        background: 'rgba(245, 158, 11, 0.15)',
                        border: '1px solid rgba(245, 158, 11, 0.4)',
                        color: '#FDE68A',
                        padding: '2px 8px',
                        borderRadius: 4,
                        fontSize: 11,
                        fontFamily: 'monospace',
                      }}
                    >
                      [{pt.kind}] "{pt.value}"
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Forbidden IDs (anti-leakage) */}
            {inspectCase.forbidden_ids && inspectCase.forbidden_ids.length > 0 && (
              <div style={{ background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 8, padding: 10, marginBottom: 14 }}>
                <b style={{ fontSize: 11, color: '#F87171', display: 'block', marginBottom: 4 }}>
                  Forbidden Context (Anti-Leakage Isolation)
                </b>
                <div style={{ display: 'flex', gap: 6 }}>
                  {inspectCase.forbidden_ids.map((fid: string, i: number) => (
                    <span key={i} className="pill bad" style={{ fontSize: 10 }}>{fid}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Raw JSON */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <small style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', fontWeight: 700 }}>
                  Raw JSON Definition
                </small>
                <button
                  className="btn"
                  style={{ fontSize: 10, padding: '2px 6px' }}
                  onClick={() => navigator.clipboard?.writeText(JSON.stringify(inspectCase, null, 2))}
                >
                  Copy JSON
                </button>
              </div>
              <pre
                style={{
                  background: '#020617',
                  border: '1px solid var(--line)',
                  borderRadius: 6,
                  padding: 10,
                  fontSize: 11,
                  fontFamily: 'monospace',
                  overflowX: 'auto',
                  maxHeight: 180,
                  margin: 0,
                  color: '#94A3B8',
                }}
              >
                {JSON.stringify(inspectCase, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
