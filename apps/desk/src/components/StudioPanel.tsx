import React, { useEffect, useRef, useState } from 'react';
import { apiClient } from '../api/client.js';

interface CandidateData {
  id: string;
  ordinal: number;
  concept: {
    id: string;
    name: string;
    archetype: string;
    artStrategy: string;
    motif?: string;
    typographicScale?: { ratio: number; titleSize: number; bodySize: number };
    colourRoles?: Record<string, string>;
    layoutIdea?: string;
    whyDifferent?: string;
  };
  status: string;
  rank?: number;
  score?: number;
  metrics?: {
    alignmentScore?: number;
    whitespaceRatio?: number;
    apcaTitle?: number;
    apcaBody?: number;
  };
  critiques?: Array<{
    scores?: Record<string, number>;
    evidence?: Record<string, string>;
    overall?: number;
  }>;
  artSha256?: string;
  previewSha256?: string;
  previewUrl: string;
  artUrl?: string;
  compositeUrl?: string;
}

interface RunData {
  id: string;
  taskId: string;
  tier: string;
  status: string;
  planId?: string;
  winnerCandidateId?: string;
  judgeStatus?: string;
  budget?: {
    maxUsd: number;
    maxCalls: number;
    spentUsd: number;
    calls: number;
  };
  stages?: Record<string, any>;
  diagnostic?: string;
}

export const StudioPanel: React.FC<{ taskId: string; initialRunId?: string }> = ({
  taskId,
  initialRunId,
}) => {
  const [runId, setRunId] = useState<string | null>(initialRunId || null);
  const [run, setRun] = useState<RunData | null>(null);
  const [candidates, setCandidates] = useState<CandidateData[]>([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  // Form states
  const [width, setWidth] = useState('1080');
  const [height, setHeight] = useState('1350');
  const [tier, setTier] = useState<'standard' | 'premium'>('standard');
  const [imagery, setImagery] = useState<'auto' | 'none' | 'generated'>('auto');
  const [holdForSelection, setHoldForSelection] = useState(false);

  // Feedback states
  const [feedbackVerdict, setFeedbackVerdict] = useState<'approve' | 'reject' | 'revise'>('approve');
  const [feedbackRating, setFeedbackRating] = useState<number>(9);
  const [feedbackNotes, setFeedbackNotes] = useState('');
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);

  const activeTask = useRef(taskId);
  activeTask.current = taskId;
  const idempotencyKey = useRef<string>(crypto.randomUUID());

  const refresh = async () => {
    if (!runId) return;
    try {
      const data = await apiClient.studio.getRun(taskId, runId);
      if (activeTask.current !== taskId) return;
      setRun(data.run);
      setCandidates(data.candidates || []);
      if (!selectedCandidateId && data.run.winnerCandidateId) {
        setSelectedCandidateId(data.run.winnerCandidateId);
      } else if (!selectedCandidateId && data.candidates?.length > 0) {
        setSelectedCandidateId(data.candidates[0].id);
      }
    } catch (err: any) {
      if (activeTask.current === taskId) {
        setMessage(err.message || 'Failed to load studio run');
      }
    }
  };

  useEffect(() => {
    setRun(null);
    setCandidates([]);
    setMessage('');
    setFeedbackSubmitted(false);
    idempotencyKey.current = crypto.randomUUID();
    if (runId) {
      void refresh();
    }
  }, [taskId, runId]);

  // Polling while run is actively progressing
  useEffect(() => {
    if (!run || ['transferred', 'degraded', 'failed', 'abandoned', 'awaiting_selection'].includes(run.status)) {
      return;
    }
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 4000);
    return () => clearInterval(timer);
  }, [taskId, runId, run?.status]);

  const handleStart = async () => {
    setBusy(true);
    setMessage('Initiating Design Studio v2 pipeline (Claude Fable 5.1 + Nano Banana Pro)...');
    try {
      const key = idempotencyKey.current;
      const res = await apiClient.studio.start(
        taskId,
        {
          width: Number(width),
          height: Number(height),
          tier,
          imagery,
          holdForSelection,
        },
        key
      );
      setRunId(res.runId);
      setMessage(`Studio run started: ${res.runId} (${res.status})`);
      const data = await apiClient.studio.getRun(taskId, res.runId);
      setRun(data.run);
      setCandidates(data.candidates || []);
    } catch (err: any) {
      setMessage(err.message || 'Failed to start studio run');
    } finally {
      setBusy(false);
    }
  };

  const handleResume = async () => {
    if (!runId) return;
    setBusy(true);
    setMessage('Advancing stage...');
    try {
      const res = await apiClient.studio.resume(taskId, runId);
      setMessage(`Advanced to stage: ${res.stage || res.status} (spent: $${(res.spentUsd || 0).toFixed(4)})`);
      await refresh();
    } catch (err: any) {
      setMessage(err.message || 'Resume failed');
    } finally {
      setBusy(false);
    }
  };

  const handleSelectCandidate = async (candidateId: string) => {
    if (!runId) return;
    setBusy(true);
    setMessage('Selecting candidate for Canva transfer...');
    try {
      await apiClient.studio.select(taskId, runId, candidateId);
      setMessage('Candidate selected. Transfer initiated.');
      await refresh();
    } catch (err: any) {
      setMessage(err.message || 'Selection failed');
    } finally {
      setBusy(false);
    }
  };

  const handleAbandon = async () => {
    if (!runId) return;
    if (!window.confirm('Are you sure you want to abandon this Design Studio run?')) return;
    setBusy(true);
    try {
      await apiClient.studio.abandon(taskId, runId, 'Operator manual abandon');
      setMessage('Studio run abandoned.');
      await refresh();
    } catch (err: any) {
      setMessage(err.message || 'Abandon failed');
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitFeedback = async () => {
    if (!runId) return;
    setBusy(true);
    try {
      await apiClient.studio.feedback(taskId, {
        runId,
        candidateId: selectedCandidateId || undefined,
        verdict: feedbackVerdict,
        rating: feedbackRating,
        notes: feedbackNotes.trim() || undefined,
      });
      setFeedbackSubmitted(true);
      setMessage('Design feedback recorded in durable memory.');
    } catch (err: any) {
      setMessage(err.message || 'Feedback recording failed');
    } finally {
      setBusy(false);
    }
  };

  const activeCandidate = candidates.find((c) => c.id === selectedCandidateId) || candidates[0];

  return (
    <section
      aria-label="Design Studio v2"
      className="rule studio-panel-container"
      style={{
        marginTop: 16,
        padding: 16,
        borderRadius: 8,
        background: 'var(--surface, #111B27)',
        border: '1px solid var(--border, #243447)',
        color: 'var(--text-main, #FDF8F3)',
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600, color: '#F7B500' }}>
            Design Studio v2
          </h3>
          <span style={{ fontSize: '0.8rem', color: '#8899A6' }}>
            See → Judge → Revise Pipeline (Fable 5.1 &amp; Nano Banana Pro)
          </span>
        </div>
        {run && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span
              style={{
                padding: '3px 8px',
                borderRadius: 4,
                fontSize: '0.75rem',
                fontWeight: 600,
                textTransform: 'uppercase',
                background:
                  run.status === 'transferred'
                    ? '#137333'
                    : run.status === 'degraded'
                    ? '#B06000'
                    : run.status === 'failed'
                    ? '#C5221F'
                    : '#1A73E8',
                color: '#FFFFFF',
              }}
            >
              {run.status.replace('_', ' ')}
            </span>
            {run.judgeStatus && (
              <span
                style={{
                  padding: '3px 8px',
                  borderRadius: 4,
                  fontSize: '0.75rem',
                  background: run.judgeStatus === 'RELIABLE' ? '#1E3A5F' : '#5C1D24',
                  color: run.judgeStatus === 'RELIABLE' ? '#D4E2F0' : '#FFD2D2',
                }}
              >
                Judge: {run.judgeStatus}
              </span>
            )}
          </div>
        )}
      </header>

      {/* 1. START PANEL (if no active run) */}
      {!run && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ margin: 0, fontSize: '0.9rem', color: '#D4E2F0' }}>
            Generate 3–5 distinct visual concepts evaluated in tournament rounds with deterministic QA before Canva transfer.
          </p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', marginBottom: 4 }}>Proportions</label>
              <select
                value={`${width}x${height}`}
                onChange={(e) => {
                  const [w, h] = e.target.value.split('x');
                  setWidth(w);
                  setHeight(h);
                }}
                style={{ padding: '6px 10px', borderRadius: 4, background: '#1E293B', color: '#FFF', border: '1px solid #334155' }}
              >
                <option value="1080x1350">1080 × 1350 (Portrait Post)</option>
                <option value="1080x1080">1080 × 1080 (Square Post)</option>
                <option value="1080x1920">1080 × 1920 (Story / Reel)</option>
                <option value="1240x1754">1240 × 1754 (A4 Print / Invite)</option>
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', marginBottom: 4 }}>Tier</label>
              <select
                value={tier}
                onChange={(e) => setTier(e.target.value as any)}
                style={{ padding: '6px 10px', borderRadius: 4, background: '#1E293B', color: '#FFF', border: '1px solid #334155' }}
              >
                <option value="standard">Standard (3 Concepts · 1 Rev)</option>
                <option value="premium">Premium (5 Concepts · 2 Rev)</option>
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', marginBottom: 4 }}>Imagery</label>
              <select
                value={imagery}
                onChange={(e) => setImagery(e.target.value as any)}
                style={{ padding: '6px 10px', borderRadius: 4, background: '#1E293B', color: '#FFF', border: '1px solid #334155' }}
              >
                <option value="auto">Auto (Brief Directed)</option>
                <option value="none">None (Typography Only)</option>
                <option value="generated">Generated (Nano Banana Pro)</option>
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                id="hold-selection"
                checked={holdForSelection}
                onChange={(e) => setHoldForSelection(e.target.checked)}
              />
              <label htmlFor="hold-selection" style={{ fontSize: '0.85rem', cursor: 'pointer' }}>
                Hold for Operator Selection
              </label>
            </div>

            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={handleStart}
              style={{
                padding: '7px 16px',
                borderRadius: 4,
                background: '#F7B500',
                color: '#0A1628',
                fontWeight: 600,
                border: 'none',
                cursor: 'pointer',
              }}
            >
              Start Studio Generation
            </button>
          </div>
        </div>
      )}

      {/* 2. ACTIVE RUN CONTROLS & STATUS */}
      {run && (
        <div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '8px 12px',
              borderRadius: 6,
              background: '#192734',
              marginBottom: 12,
              fontSize: '0.85rem',
            }}
          >
            <div>
              <strong>Run ID:</strong> <code>{run.id.slice(0, 8)}...</code>
              <span style={{ marginLeft: 12 }}>
                <strong>Budget:</strong> ${run.budget?.spentUsd?.toFixed(3) || '0.000'} / ${run.budget?.maxUsd?.toFixed(2) || '6.00'}
              </span>
              <span style={{ marginLeft: 12 }}>
                <strong>Calls:</strong> {run.budget?.calls || 0} / {run.budget?.maxCalls || 40}
              </span>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              {!['transferred', 'degraded', 'failed', 'abandoned'].includes(run.status) && (
                <button
                  className="btn"
                  disabled={busy}
                  onClick={handleResume}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 4,
                    background: '#2B4C7E',
                    color: '#FFF',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  Advance Stage
                </button>
              )}
              {!['transferred', 'degraded', 'failed', 'abandoned'].includes(run.status) && (
                <button
                  className="btn"
                  disabled={busy}
                  onClick={handleAbandon}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 4,
                    background: '#442226',
                    color: '#FFA8A8',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  Abandon
                </button>
              )}
            </div>
          </div>

          {run.diagnostic && (
            <div
              style={{
                padding: 8,
                borderRadius: 4,
                marginBottom: 12,
                background: '#331B1E',
                color: '#FFB8B8',
                fontSize: '0.85rem',
              }}
            >
              <strong>Diagnostic:</strong> {run.diagnostic}
            </div>
          )}

          {/* 3. CANDIDATE COMPARISON MATRIX */}
          {candidates.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <h4 style={{ margin: '0 0 8px 0', fontSize: '1rem', color: '#D4E2F0' }}>
                Generated Candidates ({candidates.length})
              </h4>

              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${candidates.length}, 1fr)`, gap: 12 }}>
                {candidates.map((cand) => {
                  const isWinner = cand.id === run.winnerCandidateId;
                  const isSelected = cand.id === selectedCandidateId;

                  return (
                    <div
                      key={cand.id}
                      onClick={() => setSelectedCandidateId(cand.id)}
                      style={{
                        padding: 8,
                        borderRadius: 6,
                        border: isSelected
                          ? '2px solid #F7B500'
                          : isWinner
                          ? '2px solid #137333'
                          : '1px solid #334155',
                        background: isSelected ? '#1A293B' : '#0F172A',
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <strong style={{ fontSize: '0.85rem', color: '#FFF' }}>
                          {cand.concept?.name || `Option ${cand.ordinal + 1}`}
                        </strong>
                        {isWinner && (
                          <span style={{ fontSize: '0.7rem', padding: '1px 5px', borderRadius: 3, background: '#137333', color: '#FFF' }}>
                            WINNER
                          </span>
                        )}
                      </div>

                      <span style={{ fontSize: '0.75rem', color: '#94A3B8' }}>
                        Archetype: {cand.concept?.archetype}
                      </span>

                      {cand.score && (
                        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#F7B500' }}>
                          Judge Score: {cand.score.toFixed(1)} / 10
                        </span>
                      )}

                      {/* Thumbnail */}
                      <div
                        style={{
                          width: '100%',
                          height: 180,
                          borderRadius: 4,
                          background: '#050B14',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          overflow: 'hidden',
                        }}
                      >
                        <img
                          src={cand.previewUrl}
                          alt={cand.concept?.name}
                          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                          onError={(e) => {
                            (e.target as HTMLElement).style.display = 'none';
                          }}
                        />
                      </div>

                      {run.status === 'awaiting_selection' && (
                        <button
                          className="btn"
                          disabled={busy}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleSelectCandidate(cand.id);
                          }}
                          style={{
                            marginTop: 4,
                            padding: '4px 8px',
                            borderRadius: 4,
                            background: '#1A73E8',
                            color: '#FFF',
                            border: 'none',
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          Use This Design
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 4. ACTIVE CANDIDATE DETAILS & FEEDBACK */}
          {activeCandidate && (
            <div
              style={{
                marginTop: 16,
                padding: 12,
                borderRadius: 6,
                background: '#0B131F',
                border: '1px solid #1E2E42',
              }}
            >
              <h4 style={{ margin: '0 0 8px 0', fontSize: '0.95rem', color: '#F7B500' }}>
                Candidate Detail: {activeCandidate.concept?.name}
              </h4>
              <p style={{ margin: '0 0 6px 0', fontSize: '0.85rem', color: '#D4E2F0' }}>
                <em>{activeCandidate.concept?.layoutIdea}</em>
              </p>

              {activeCandidate.metrics && (
                <div style={{ display: 'flex', gap: 16, fontSize: '0.8rem', color: '#94A3B8', marginBottom: 8 }}>
                  <span>Alignment: {(activeCandidate.metrics.alignmentScore || 0).toFixed(2)}</span>
                  <span>Whitespace: {((activeCandidate.metrics.whitespaceRatio || 0) * 100).toFixed(0)}%</span>
                  <span>Title APCA: {(activeCandidate.metrics.apcaTitle || 0).toFixed(1)} Lc</span>
                  <span>Body APCA: {(activeCandidate.metrics.apcaBody || 0).toFixed(1)} Lc</span>
                </div>
              )}

              {/* Feedback Loop */}
              <div
                style={{
                  marginTop: 12,
                  padding: 10,
                  borderRadius: 6,
                  background: '#142030',
                  borderTop: '1px solid #23354D',
                }}
              >
                <h5 style={{ margin: '0 0 8px 0', fontSize: '0.85rem', color: '#FFF' }}>
                  Art Director Feedback (Learning Loop)
                </h5>

                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label style={{ fontSize: '0.8rem' }}>Verdict:</label>
                  {(['approve', 'revise', 'reject'] as const).map((v) => (
                    <label key={v} style={{ fontSize: '0.8rem', cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name="verdict"
                        checked={feedbackVerdict === v}
                        onChange={() => setFeedbackVerdict(v)}
                      />{' '}
                      {v.toUpperCase()}
                    </label>
                  ))}

                  <label style={{ fontSize: '0.8rem', marginLeft: 8 }}>Score (1–10):</label>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={feedbackRating}
                    onChange={(e) => setFeedbackRating(Number(e.target.value))}
                    style={{ width: 45, padding: '2px 4px', background: '#1E293B', color: '#FFF', border: '1px solid #334155' }}
                  />

                  <input
                    type="text"
                    placeholder="Rationale or guidance notes (e.g. hierarchy, contrast)..."
                    value={feedbackNotes}
                    onChange={(e) => setFeedbackNotes(e.target.value)}
                    style={{
                      flex: 1,
                      minWidth: 200,
                      padding: '4px 8px',
                      borderRadius: 4,
                      background: '#1E293B',
                      color: '#FFF',
                      border: '1px solid #334155',
                      fontSize: '0.8rem',
                    }}
                  />

                  <button
                    className="btn"
                    disabled={busy || feedbackSubmitted}
                    onClick={handleSubmitFeedback}
                    style={{
                      padding: '4px 12px',
                      borderRadius: 4,
                      background: feedbackSubmitted ? '#137333' : '#F7B500',
                      color: '#0A1628',
                      fontWeight: 600,
                      border: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    {feedbackSubmitted ? 'Recorded ✓' : 'Submit Feedback'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {message && (
        <div
          role="status"
          style={{
            marginTop: 10,
            padding: '6px 10px',
            borderRadius: 4,
            background: '#1E2D40',
            color: '#D4E2F0',
            fontSize: '0.8rem',
          }}
        >
          {message}
        </div>
      )}
    </section>
  );
};
