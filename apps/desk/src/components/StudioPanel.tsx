import React, { useEffect, useRef, useState } from 'react';
import { apiClient } from '../api/client.js';

interface CritiqueDetail {
  overall?: number;
  weightedScore?: number;
  scores?: {
    hierarchy?: number;
    typography?: number;
    composition?: number;
    whitespace?: number;
    brandFidelity?: number;
    legibility?: number;
    craft?: number;
    [key: string]: number | undefined;
  };
  evidence?: {
    hierarchy?: string;
    typography?: string;
    composition?: string;
    whitespace?: string;
    brandFidelity?: string;
    legibility?: string;
    craft?: string;
    [key: string]: string | undefined;
  };
  hardFails?: string[];
  revisions?: Array<{
    element: string;
    change: string;
    target: string;
  }>;
  observations?: Array<{
    text: string;
    region?: { x: number; y: number; w: number; h: number };
  }>;
}

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
    [key: string]: any;
  };
  critiques?: CritiqueDetail[];
  artSha256?: string;
  previewSha256?: string;
  previewUrl: string;
  artUrl?: string | null;
  compositeUrl?: string | null;
}

interface RunData {
  id: string;
  taskId: string;
  clientId?: string;
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
  createdAt?: string;
  updatedAt?: string;
}

const PIPELINE_STAGES = [
  { id: 'brief', label: 'Brief' },
  { id: 'concepts', label: 'Concepts' },
  { id: 'art', label: 'Art' },
  { id: 'layouts', label: 'Layouts' },
  { id: 'render', label: 'Render' },
  { id: 'critique', label: 'Critique' },
  { id: 'revise', label: 'Revise' },
  { id: 'tournament', label: 'Judge' },
  { id: 'qa', label: 'QA' },
  { id: 'transfer', label: 'Canva' },
];

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

  // View modes
  const [activeTab, setActiveTab] = useState<'preview' | 'art' | 'critique' | 'metrics'>('preview');
  const [zoomModalUrl, setZoomModalUrl] = useState<string | null>(null);

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

  const getMediaUrl = (url?: string | null): string => {
    if (!url) return '';
    return url;
  };

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
    setMessage('Starting a studio run (gpt-6-astra; imagery gpt-image-2.5-sunburst)...');
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
      setMessage(`Studio run started: ${res.runId} (${res.status}). Press Advance Stage to run each stage; a run left unadvanced for 30 minutes releases its studio slot.`);
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
    setMessage('Advancing pipeline stage...');
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
  const latestCritique = activeCandidate?.critiques && activeCandidate.critiques.length > 0
    ? activeCandidate.critiques[activeCandidate.critiques.length - 1]
    : null;

  return (
    <section
      aria-label="Design Studio v2"
      className="rule studio-panel-container"
      style={{
        marginTop: 16,
        padding: 16,
        borderRadius: 8,
        background: 'var(--panel, #181B22)',
        border: '1px solid var(--line, #29303D)',
        color: 'var(--ink, #F1F3F7)',
      }}
    >
      {/* HEADER & STATUS */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600, color: 'var(--warn-text, #FBBF24)' }}>
            Design Studio v2
          </h3>
          <span style={{ fontSize: '0.8rem', color: 'var(--muted, #94A3B8)' }}>
            See → Judge → Revise Multi-Concept Pipeline (gpt-6-astra &amp; gpt-image-2.5-sunburst)
          </span>
        </div>
        {run && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span
              style={{
                padding: '4px 10px',
                borderRadius: 4,
                fontSize: '0.75rem',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                background:
                  run.status === 'transferred'
                    ? 'var(--ok, #0D2818)'
                    : run.status === 'degraded'
                    ? 'var(--warn, #2C2006)'
                    : run.status === 'failed'
                    ? 'var(--bad, #331313)'
                    : 'var(--blue, #14253D)',
                color:
                  run.status === 'transferred'
                    ? 'var(--ok-text, #4ADE80)'
                    : run.status === 'degraded'
                    ? 'var(--warn-text, #FBBF24)'
                    : run.status === 'failed'
                    ? 'var(--bad-text, #F87171)'
                    : 'var(--blue-text, #60A5FA)',
                border: `1px solid ${
                  run.status === 'transferred'
                    ? '#22C55E44'
                    : run.status === 'degraded'
                    ? '#FBBF2444'
                    : run.status === 'failed'
                    ? '#EF444444'
                    : '#3B82F644'
                }`,
              }}
            >
              {run.status.replace('_', ' ')}
            </span>
            {run.judgeStatus && (
              <span
                style={{
                  padding: '4px 8px',
                  borderRadius: 4,
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  background: run.judgeStatus === 'RELIABLE' ? 'var(--blue, #14253D)' : 'var(--bad, #331313)',
                  color: run.judgeStatus === 'RELIABLE' ? 'var(--blue-text, #60A5FA)' : 'var(--bad-text, #F87171)',
                  border: '1px solid currentColor',
                }}
              >
                Judge: {run.judgeStatus}
              </span>
            )}
          </div>
        )}
      </header>

      {/* PIPELINE STAGE STEPPER */}
      {run && (
        <nav
          aria-label="Pipeline Stages"
          style={{
            display: 'flex',
            gap: 4,
            marginBottom: 14,
            padding: '6px 8px',
            background: 'var(--soft, #1F242E)',
            borderRadius: 6,
            overflowX: 'auto',
          }}
        >
          {PIPELINE_STAGES.map((st, idx) => {
            const stageInfo = run.stages?.[st.id];
            const isDone = !!stageInfo?.completedAt;
            const isCurrent = run.status === st.id || (!isDone && (idx === 0 || !!run.stages?.[PIPELINE_STAGES[idx - 1]?.id]?.completedAt));

            return (
              <div
                key={st.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '3px 8px',
                  borderRadius: 4,
                  fontSize: '0.72rem',
                  fontWeight: isCurrent ? 700 : 500,
                  background: isDone
                    ? '#0F331E'
                    : isCurrent
                    ? '#28354A'
                    : 'transparent',
                  color: isDone
                    ? 'var(--ok-text, #4ADE80)'
                    : isCurrent
                    ? 'var(--warn-text, #FBBF24)'
                    : 'var(--muted, #94A3B8)',
                  whiteSpace: 'nowrap',
                }}
              >
                <span>{isDone ? '✓' : isCurrent ? '●' : '○'}</span>
                <span>{st.label}</span>
              </div>
            );
          })}
        </nav>
      )}

      {/* START PANEL (when no active run) */}
      {!run && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--ink, #F1F3F7)' }}>
            Generate 3–5 distinct visual concepts evaluated in tournament rounds with deterministic QA before Canva transfer.
          </p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', marginBottom: 4, color: 'var(--muted, #94A3B8)' }}>
                Proportions
              </label>
              <select
                value={`${width}x${height}`}
                onChange={(e) => {
                  const [w, h] = e.target.value.split('x');
                  setWidth(w);
                  setHeight(h);
                }}
                style={{
                  padding: '6px 10px',
                  borderRadius: 4,
                  background: 'var(--soft, #1F242E)',
                  color: '#FFF',
                  border: '1px solid var(--line, #29303D)',
                }}
              >
                <option value="1080x1350">1080 × 1350 (Portrait Post)</option>
                <option value="1080x1080">1080 × 1080 (Square Post)</option>
                <option value="1080x1920">1080 × 1920 (Story / Reel)</option>
                <option value="1240x1754">1240 × 1754 (A4 Print / Invite)</option>
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', marginBottom: 4, color: 'var(--muted, #94A3B8)' }}>
                Tier
              </label>
              <select
                value={tier}
                onChange={(e) => setTier(e.target.value as any)}
                style={{
                  padding: '6px 10px',
                  borderRadius: 4,
                  background: 'var(--soft, #1F242E)',
                  color: '#FFF',
                  border: '1px solid var(--line, #29303D)',
                }}
              >
                <option value="standard">Standard (3 Concepts · 1 Rev)</option>
                <option value="premium">Premium (5 Concepts · 2 Rev)</option>
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', marginBottom: 4, color: 'var(--muted, #94A3B8)' }}>
                Imagery
              </label>
              <select
                value={imagery}
                onChange={(e) => setImagery(e.target.value as any)}
                style={{
                  padding: '6px 10px',
                  borderRadius: 4,
                  background: 'var(--soft, #1F242E)',
                  color: '#FFF',
                  border: '1px solid var(--line, #29303D)',
                }}
              >
                <option value="auto">Auto (Brief Directed)</option>
                <option value="none">None (Typography Only)</option>
                <option value="generated">Generated (gpt-image-2.5-sunburst)</option>
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
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
                padding: '7px 18px',
                borderRadius: 4,
                background: 'var(--warn-text, #FBBF24)',
                color: '#0A1628',
                fontWeight: 700,
                border: 'none',
                cursor: 'pointer',
              }}
            >
              Start Studio Generation
            </button>
          </div>
        </div>
      )}

      {/* ACTIVE RUN CONTROLS & STATUS */}
      {run && (
        <div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '8px 12px',
              borderRadius: 6,
              background: 'var(--soft, #1F242E)',
              marginBottom: 12,
              fontSize: '0.85rem',
            }}
          >
            <div>
              <strong>Run ID:</strong> <code>{run.id.slice(0, 8)}...</code>
              <span style={{ marginLeft: 14 }}>
                <strong>Budget:</strong> ${run.budget?.spentUsd?.toFixed(3) || '0.000'} / ${run.budget?.maxUsd?.toFixed(2) || '6.00'}
              </span>
              <span style={{ marginLeft: 14 }}>
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
                    padding: '4px 12px',
                    borderRadius: 4,
                    background: 'var(--blue, #14253D)',
                    color: 'var(--blue-text, #60A5FA)',
                    border: '1px solid currentColor',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Advance Stage
                </button>
              )}
              {['failed', 'abandoned'].includes(run.status) && (
                <button
                  className="btn"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await apiClient.tasks.redrive(taskId);
                      setMessage('Task generation re-driven successfully');
                      await refresh();
                    } catch (err: any) {
                      setMessage(err.message || 'Re-drive failed');
                    } finally {
                      setBusy(false);
                    }
                  }}
                  style={{
                    padding: '4px 12px',
                    borderRadius: 4,
                    background: '#0F766E',
                    color: '#2DD4BF',
                    border: '1px solid currentColor',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  🔄 Re-drive Generation
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
                    background: 'var(--bad, #331313)',
                    color: 'var(--bad-text, #F87171)',
                    border: '1px solid currentColor',
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
                padding: 10,
                borderRadius: 6,
                marginBottom: 12,
                background: 'var(--bad, #331313)',
                color: 'var(--bad-text, #F87171)',
                border: '1px solid #EF444433',
                fontSize: '0.85rem',
              }}
            >
              <strong>Diagnostic:</strong> {run.diagnostic}
            </div>
          )}

          {/* TRANSFERRED BANNER */}
          {run.status === 'transferred' && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '10px 14px',
                borderRadius: 6,
                marginBottom: 14,
                background: 'var(--ok, #0D2818)',
                border: '1px solid #22C55E44',
                color: 'var(--ok-text, #4ADE80)',
              }}
            >
              <div>
                <strong>✓ Transferred to Canva</strong>
                <p style={{ margin: '2px 0 0 0', fontSize: '0.8rem', color: '#BBF7D0' }}>
                  OpenXML/PPTX package transferred into native Canva document.
                </p>
              </div>
              {run.planId && (
                <a
                  href={`/tasks/${taskId}/canva/editor`}
                  className="btn"
                  style={{
                    padding: '6px 14px',
                    borderRadius: 4,
                    background: '#22C55E',
                    color: '#0A1628',
                    textDecoration: 'none',
                    fontWeight: 700,
                    fontSize: '0.85rem',
                  }}
                >
                  Open Canva Editor ↗
                </a>
              )}
            </div>
          )}

          {/* CANDIDATE COMPARISON MATRIX */}
          {candidates.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <h4 style={{ margin: 0, fontSize: '1rem', color: 'var(--ink, #F1F3F7)' }}>
                  Generated Candidates ({candidates.length})
                </h4>
                <span style={{ fontSize: '0.75rem', color: 'var(--muted, #94A3B8)' }}>
                  Click candidate to inspect critique, metrics, or select for Canva transfer
                </span>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${Math.min(candidates.length, 5)}, 1fr)`,
                  gap: 12,
                }}
              >
                {candidates.map((cand) => {
                  const isWinner = cand.id === run.winnerCandidateId;
                  const isSelected = cand.id === selectedCandidateId;
                  const mediaPreviewUrl = getMediaUrl(cand.previewUrl);

                  return (
                    <div
                      key={cand.id}
                      onClick={() => setSelectedCandidateId(cand.id)}
                      style={{
                        padding: 10,
                        borderRadius: 6,
                        border: isSelected
                          ? '2px solid var(--warn-text, #FBBF24)'
                          : isWinner
                          ? '2px solid var(--ok-text, #4ADE80)'
                          : '1px solid var(--line, #29303D)',
                        background: isSelected ? 'var(--soft, #1F242E)' : 'var(--dark, #12141A)',
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                        transition: 'border-color 0.15s ease',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <strong style={{ fontSize: '0.85rem', color: '#FFF' }}>
                          {cand.concept?.name || `Option ${cand.ordinal + 1}`}
                        </strong>
                        {isWinner && (
                          <span
                            style={{
                              fontSize: '0.65rem',
                              fontWeight: 700,
                              padding: '2px 6px',
                              borderRadius: 3,
                              background: 'var(--ok, #0D2818)',
                              color: 'var(--ok-text, #4ADE80)',
                              border: '1px solid currentColor',
                            }}
                          >
                            WINNER
                          </span>
                        )}
                      </div>

                      <span style={{ fontSize: '0.75rem', color: 'var(--muted, #94A3B8)' }}>
                        {cand.concept?.archetype || 'Custom Concept'}
                      </span>

                      {cand.score !== null && cand.score !== undefined && (
                        <span
                          style={{
                            fontSize: '0.75rem',
                            fontWeight: 700,
                            color: cand.score >= 8.5 ? 'var(--ok-text, #4ADE80)' : 'var(--warn-text, #FBBF24)',
                          }}
                        >
                          Score: {cand.score.toFixed(1)} / 10
                        </span>
                      )}

                      {/* Thumbnail with Zoom Click */}
                      <div
                        style={{
                          width: '100%',
                          height: 190,
                          borderRadius: 4,
                          background: '#070C14',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          overflow: 'hidden',
                          position: 'relative',
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedCandidateId(cand.id);
                          setZoomModalUrl(mediaPreviewUrl);
                        }}
                        title="Click to zoom candidate image"
                      >
                        {mediaPreviewUrl ? (
                          <img
                            src={mediaPreviewUrl}
                            alt={cand.concept?.name}
                            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                            onError={(e) => {
                              (e.target as HTMLElement).style.display = 'none';
                            }}
                          />
                        ) : (
                          <span style={{ fontSize: '0.75rem', color: 'var(--muted, #94A3B8)' }}>No preview</span>
                        )}
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
                            padding: '5px 8px',
                            borderRadius: 4,
                            background: 'var(--blue-text, #60A5FA)',
                            color: '#0A1628',
                            border: 'none',
                            fontWeight: 700,
                            fontSize: '0.75rem',
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

          {/* ACTIVE CANDIDATE INSPECTOR */}
          {activeCandidate && (
            <div
              style={{
                marginTop: 16,
                padding: 14,
                borderRadius: 6,
                background: 'var(--dark, #12141A)',
                border: '1px solid var(--line, #29303D)',
              }}
            >
              {/* INSPECTION VIEW TABS */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div>
                  <h4 style={{ margin: 0, fontSize: '1rem', color: 'var(--warn-text, #FBBF24)' }}>
                    Candidate {activeCandidate.ordinal + 1}: {activeCandidate.concept?.name}
                  </h4>
                  <p style={{ margin: '2px 0 0 0', fontSize: '0.8rem', color: 'var(--muted, #94A3B8)' }}>
                    <em>{activeCandidate.concept?.layoutIdea}</em>
                  </p>
                </div>

                <div style={{ display: 'flex', gap: 6 }}>
                  {(['preview', 'art', 'critique', 'metrics'] as const).map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      style={{
                        padding: '4px 10px',
                        borderRadius: 4,
                        fontSize: '0.75rem',
                        fontWeight: activeTab === tab ? 700 : 500,
                        background: activeTab === tab ? 'var(--soft, #1F242E)' : 'transparent',
                        color: activeTab === tab ? 'var(--ink, #F1F3F7)' : 'var(--muted, #94A3B8)',
                        border: '1px solid var(--line, #29303D)',
                        cursor: 'pointer',
                      }}
                    >
                      {tab === 'preview'
                        ? 'Composite'
                        : tab === 'art'
                        ? 'Artwork'
                        : tab === 'critique'
                        ? 'Vision Critic'
                        : 'QA Metrics'}
                    </button>
                  ))}
                </div>
              </div>

              {/* TAB 1: COMPOSITE PREVIEW */}
              {activeTab === 'preview' && (
                <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                  <div
                    style={{
                      width: 280,
                      height: 350,
                      borderRadius: 6,
                      background: '#060B12',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                      cursor: 'zoom-in',
                    }}
                    onClick={() => setZoomModalUrl(getMediaUrl(activeCandidate.previewUrl))}
                  >
                    <img
                      src={getMediaUrl(activeCandidate.previewUrl)}
                      alt={activeCandidate.concept?.name}
                      style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                      onError={(e) => {
                        (e.target as HTMLElement).style.display = 'none';
                      }}
                    />
                  </div>

                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontSize: '0.85rem' }}>
                      <strong>Archetype:</strong> {activeCandidate.concept?.archetype}
                    </div>
                    <div style={{ fontSize: '0.85rem' }}>
                      <strong>Art Strategy:</strong> {activeCandidate.concept?.artStrategy}
                    </div>
                    {activeCandidate.concept?.whyDifferent && (
                      <div style={{ fontSize: '0.85rem', color: 'var(--muted, #94A3B8)' }}>
                        <strong>Concept Rationale:</strong> {activeCandidate.concept.whyDifferent}
                      </div>
                    )}
                    {activeCandidate.concept?.colourRoles && (
                      <div style={{ fontSize: '0.85rem' }}>
                        <strong>Palette Roles:</strong>
                        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                          {Object.entries(activeCandidate.concept.colourRoles).map(([role, hex]) => (
                            <span
                              key={role}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4,
                                padding: '2px 6px',
                                borderRadius: 3,
                                background: 'var(--soft, #1F242E)',
                                fontSize: '0.75rem',
                              }}
                            >
                              <span
                                style={{
                                  width: 10,
                                  height: 10,
                                  borderRadius: '50%',
                                  background: hex,
                                  display: 'inline-block',
                                  border: '1px solid #FFF2',
                                }}
                              />
                              {role}: {hex}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 2: ART BACKGROUND LAYER */}
              {activeTab === 'art' && (
                <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                  <div
                    style={{
                      width: 280,
                      height: 350,
                      borderRadius: 6,
                      background: '#060B12',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                      cursor: 'zoom-in',
                    }}
                    onClick={() => activeCandidate.artUrl && setZoomModalUrl(getMediaUrl(activeCandidate.artUrl))}
                  >
                    {activeCandidate.artUrl ? (
                      <img
                        src={getMediaUrl(activeCandidate.artUrl)}
                        alt="Generated Artwork"
                        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                        onError={(e) => {
                          (e.target as HTMLElement).style.display = 'none';
                        }}
                      />
                    ) : (
                      <span style={{ fontSize: '0.8rem', color: 'var(--muted, #94A3B8)' }}>
                        No separate art layer (Typography / Procedural layout)
                      </span>
                    )}
                  </div>

                  <div style={{ flex: 1, fontSize: '0.85rem' }}>
                    <strong>Art Layer SHA-256:</strong>
                    <code style={{ display: 'block', fontSize: '0.75rem', marginTop: 4, wordBreak: 'break-all' }}>
                      {activeCandidate.artSha256 || 'None'}
                    </code>
                    <p style={{ marginTop: 10, color: 'var(--muted, #94A3B8)', fontSize: '0.8rem' }}>
                      Background generated by gpt-image-2.5-sunburst (text-free) or procedural gradient scrim.
                    </p>
                  </div>
                </div>
              )}

              {/* TAB 3: VISION CRITIC RUBRIC */}
              {activeTab === 'critique' && (
                <div>
                  {latestCritique ? (
                    <div>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: 10,
                        }}
                      >
                        <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>
                          gpt-6-astra Vision Rubric Evaluation
                        </span>
                        <span
                          style={{
                            fontWeight: 700,
                            fontSize: '0.95rem',
                            color: (latestCritique.weightedScore || 0) >= 8.5 ? 'var(--ok-text, #4ADE80)' : 'var(--warn-text, #FBBF24)',
                          }}
                        >
                          Overall Score: {(latestCritique.weightedScore || latestCritique.overall || 0).toFixed(1)} / 10
                        </span>
                      </div>

                      {/* Rubric Score Bars */}
                      {latestCritique.scores && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px 16px', marginBottom: 12 }}>
                          {Object.entries(latestCritique.scores).map(([key, score]) => {
                            const val = typeof score === 'number' ? score : 0;
                            const pct = Math.min(100, Math.max(0, val * 10));
                            const barColor = val >= 8.5 ? '#22C55E' : val >= 7.0 ? '#FBBF24' : '#EF4444';

                            return (
                              <div key={key}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', marginBottom: 2 }}>
                                  <span style={{ textTransform: 'capitalize' }}>{key.replace(/([A-Z])/g, ' $1')}</span>
                                  <strong>{val.toFixed(1)}</strong>
                                </div>
                                <div style={{ width: '100%', height: 6, borderRadius: 3, background: 'var(--soft, #1F242E)' }}>
                                  <div style={{ width: `${pct}%`, height: '100%', borderRadius: 3, background: barColor }} />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Hard Fails & Concrete Revisions */}
                      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                        <div style={{ flex: 1, minWidth: 240, padding: 8, borderRadius: 4, background: 'var(--soft, #1F242E)' }}>
                          <strong style={{ fontSize: '0.8rem', display: 'block', marginBottom: 4 }}>
                            Hard QA Checks:
                          </strong>
                          {(!latestCritique.hardFails || latestCritique.hardFails.length === 0) ? (
                            <span style={{ fontSize: '0.75rem', color: 'var(--ok-text, #4ADE80)' }}>
                              ✓ Zero Hard QA Violations
                            </span>
                          ) : (
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              {latestCritique.hardFails.map((hf) => (
                                <span
                                  key={hf}
                                  style={{
                                    fontSize: '0.7rem',
                                    padding: '1px 5px',
                                    borderRadius: 3,
                                    background: 'var(--bad, #331313)',
                                    color: 'var(--bad-text, #F87171)',
                                  }}
                                >
                                  {hf}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>

                        {latestCritique.revisions && latestCritique.revisions.length > 0 && (
                          <div style={{ flex: 1, minWidth: 240, padding: 8, borderRadius: 4, background: 'var(--soft, #1F242E)' }}>
                            <strong style={{ fontSize: '0.8rem', display: 'block', marginBottom: 4 }}>
                              Revisions Applied:
                            </strong>
                            <ul style={{ margin: 0, paddingLeft: 16, fontSize: '0.75rem', color: 'var(--muted, #94A3B8)' }}>
                              {latestCritique.revisions.map((rev, idx) => (
                                <li key={idx}>
                                  <strong>{rev.element}:</strong> {rev.change} ({rev.target})
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <span style={{ fontSize: '0.85rem', color: 'var(--muted, #94A3B8)' }}>
                      Critique stage not yet reached for this candidate.
                    </span>
                  )}
                </div>
              )}

              {/* TAB 4: DETERMINISTIC METRICS */}
              {activeTab === 'metrics' && (
                <div>
                  {activeCandidate.metrics ? (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                      <div style={{ padding: 10, borderRadius: 4, background: 'var(--soft, #1F242E)' }}>
                        <span style={{ fontSize: '0.75rem', color: 'var(--muted, #94A3B8)' }}>Alignment Score</span>
                        <div style={{ fontSize: '1.25rem', fontWeight: 700, marginTop: 4 }}>
                          {(activeCandidate.metrics.alignmentScore || 0).toFixed(2)}
                        </div>
                      </div>

                      <div style={{ padding: 10, borderRadius: 4, background: 'var(--soft, #1F242E)' }}>
                        <span style={{ fontSize: '0.75rem', color: 'var(--muted, #94A3B8)' }}>Whitespace Ratio</span>
                        <div style={{ fontSize: '1.25rem', fontWeight: 700, marginTop: 4 }}>
                          {((activeCandidate.metrics.whitespaceRatio || 0) * 100).toFixed(0)}%
                        </div>
                      </div>

                      <div style={{ padding: 10, borderRadius: 4, background: 'var(--soft, #1F242E)' }}>
                        <span style={{ fontSize: '0.75rem', color: 'var(--muted, #94A3B8)' }}>Title APCA</span>
                        <div
                          style={{
                            fontSize: '1.25rem',
                            fontWeight: 700,
                            marginTop: 4,
                            color: Math.abs(activeCandidate.metrics.apcaTitle || 0) >= 60 ? 'var(--ok-text, #4ADE80)' : 'var(--warn-text, #FBBF24)',
                          }}
                        >
                          {(activeCandidate.metrics.apcaTitle || 0).toFixed(1)} Lc
                        </div>
                      </div>

                      <div style={{ padding: 10, borderRadius: 4, background: 'var(--soft, #1F242E)' }}>
                        <span style={{ fontSize: '0.75rem', color: 'var(--muted, #94A3B8)' }}>Body APCA</span>
                        <div
                          style={{
                            fontSize: '1.25rem',
                            fontWeight: 700,
                            marginTop: 4,
                            color: Math.abs(activeCandidate.metrics.apcaBody || 0) >= 45 ? 'var(--ok-text, #4ADE80)' : 'var(--warn-text, #FBBF24)',
                          }}
                        >
                          {(activeCandidate.metrics.apcaBody || 0).toFixed(1)} Lc
                        </div>
                      </div>
                    </div>
                  ) : (
                    <span style={{ fontSize: '0.85rem', color: 'var(--muted, #94A3B8)' }}>
                      Deterministic spatial metrics not recorded yet.
                    </span>
                  )}
                </div>
              )}

              {/* ART DIRECTOR FEEDBACK FORM */}
              <div
                style={{
                  marginTop: 14,
                  padding: 10,
                  borderRadius: 6,
                  background: 'var(--soft, #1F242E)',
                  borderTop: '1px solid var(--line, #29303D)',
                }}
              >
                <h5 style={{ margin: '0 0 8px 0', fontSize: '0.85rem', color: '#FFF' }}>
                  Art Director Feedback (Durable Learning Loop)
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

                  <label style={{ fontSize: '0.8rem', marginLeft: 8 }}>Rating (1–10):</label>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={feedbackRating}
                    onChange={(e) => setFeedbackRating(Number(e.target.value))}
                    style={{
                      width: 45,
                      padding: '2px 4px',
                      background: 'var(--dark, #12141A)',
                      color: '#FFF',
                      border: '1px solid var(--line, #29303D)',
                      borderRadius: 3,
                    }}
                  />

                  <input
                    type="text"
                    placeholder="Artistic rationale or critique notes for exemplar memory..."
                    value={feedbackNotes}
                    onChange={(e) => setFeedbackNotes(e.target.value)}
                    style={{
                      flex: 1,
                      minWidth: 200,
                      padding: '5px 8px',
                      borderRadius: 4,
                      background: 'var(--dark, #12141A)',
                      color: '#FFF',
                      border: '1px solid var(--line, #29303D)',
                      fontSize: '0.8rem',
                    }}
                  />

                  <button
                    className="btn"
                    disabled={busy || feedbackSubmitted}
                    onClick={handleSubmitFeedback}
                    style={{
                      padding: '5px 14px',
                      borderRadius: 4,
                      background: feedbackSubmitted ? '#137333' : 'var(--warn-text, #FBBF24)',
                      color: '#0A1628',
                      fontWeight: 700,
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

      {/* ZOOM MODAL */}
      {zoomModalUrl && (
        <div
          role="dialog"
          aria-label="High Resolution Candidate Inspection"
          onClick={() => setZoomModalUrl(null)}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(5, 10, 18, 0.88)',
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'relative',
              maxWidth: '90vw',
              maxHeight: '90vh',
              borderRadius: 8,
              overflow: 'hidden',
              boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
              background: '#0B131F',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '8px 12px',
                background: 'var(--soft, #1F242E)',
                borderBottom: '1px solid var(--line, #29303D)',
              }}
            >
              <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>High-Resolution Layout Inspection</span>
              <button
                onClick={() => setZoomModalUrl(null)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#FFF',
                  fontSize: '1.1rem',
                  cursor: 'pointer',
                }}
              >
                ✕
              </button>
            </div>
            <div style={{ overflow: 'auto', padding: 12, display: 'flex', justifyContent: 'center' }}>
              <img
                src={zoomModalUrl}
                alt="Zoomed candidate"
                style={{ maxHeight: '80vh', maxWidth: '80vw', objectFit: 'contain' }}
              />
            </div>
          </div>
        </div>
      )}

      {/* FEEDBACK STATUS MESSAGE */}
      {message && (
        <div
          role="status"
          style={{
            marginTop: 10,
            padding: '6px 12px',
            borderRadius: 4,
            background: 'var(--soft, #1F242E)',
            color: 'var(--ink, #F1F3F7)',
            fontSize: '0.8rem',
            border: '1px solid var(--line, #29303D)',
          }}
        >
          {message}
        </div>
      )}
    </section>
  );
};
