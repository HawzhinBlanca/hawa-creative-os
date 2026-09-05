import React, { useState, useEffect } from 'react';
import { eventStream } from '../services/eventStream.js';

interface InboxScreenProps {
  refreshTrigger?: number;
  onSelectReview: (task?: any) => void;
}

interface LiveTask {
  id: string;
  clientId?: string;
  title: string;
  status: string;
  priority?: string;
  description?: string;
  source?: { platform?: string; externalId?: string };
  createdAt?: string;
  updatedAt?: string;
  latestRevisionId?: string;
  latestQAReport?: any;
}

export const InboxScreen: React.FC<InboxScreenProps> = ({ refreshTrigger = 0, onSelectReview }) => {
  const [activeFilter, setActiveFilter] = useState<'all' | 'needs_action' | 'production' | 'review'>('all');
  const [liveTasks, setLiveTasks] = useState<LiveTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastFetched, setLastFetched] = useState<string | null>(null);
  const [realtimeNotification, setRealtimeNotification] = useState<string | null>(null);

  // Ambiguity and Fact Resolution Modals State
  const [showAmbiguityModal, setShowAmbiguityModal] = useState(false);
  const [resolvedAmbiguityClient, setResolvedAmbiguityClient] = useState<string | null>(null);
  const [showFactModal, setShowFactModal] = useState(false);
  const [resolvedFactChoice, setResolvedFactChoice] = useState<string | null>(null);

  // Inbound Brief Simulator State
  const [showSimulator, setShowSimulator] = useState(false);
  const [simulatorPreset, setSimulatorPreset] = useState<'aster' | 'nova' | 'rona'>('aster');
  const [simulating, setSimulating] = useState(false);
  const [simulationStep, setSimulationStep] = useState(0);
  const [simulatedTask, setSimulatedTask] = useState<LiveTask | null>(null);

  const SIMULATOR_PRESETS = {
    aster: {
      client: 'client-aster',
      clientName: 'Aster Hotel & Resort',
      platform: 'whatsapp',
      icon: '💬',
      title: 'Friday VIP Rooftop Dinner & Live Oud',
      headlineEn: 'Friday VIP Rooftop Dinner & Live Oud',
      headlineCkb: 'شەوی تایبەتی هەینی لە هۆتێل ئاستێر',
      copyEn: 'Special Friday VIP Dinner Menu · Call 0750 123 4567',
      copyCkb: 'پێشکه‌شکردنی خواردنی تایبه‌ت له‌ شه‌وانی هه‌ینی له‌ هۆتێل ئاستێر له‌ هه‌ولێر',
    },
    nova: {
      client: 'client-nova',
      clientName: 'Nova Tech Systems',
      platform: 'telegram',
      icon: '✈️',
      title: 'Cloud & AI Summit Erbil 2026',
      headlineEn: 'Cloud & AI Summit Erbil 2026',
      headlineCkb: 'کۆنگره‌ی نێوده‌وڵه‌تی ته‌کنه‌لۆجیا و ژیری ده‌ستکرد',
      copyEn: 'International AI & Cloud Summit 2026 · Register at novatech.krd',
      copyCkb: 'کۆنگره‌ی نێوده‌وڵه‌تی ته‌کنه‌لۆجیا و ژیری ده‌ستکرد له‌ هه‌ولێر',
    },
    rona: {
      client: 'client-rona',
      clientName: 'Rona Haute Couture',
      platform: 'mobile_desk',
      icon: '📱',
      title: 'Autumn Luxury Velvet Collection',
      headlineEn: 'Autumn Luxury Velvet Collection',
      headlineCkb: 'کۆلێکشن نوێی پاییزه‌ لە دیزاینی ڕۆنا',
      copyEn: 'Exclusive Autumn Velvet Collection · Erbil Empire World',
      copyCkb: 'کۆلێکشن نوێی پاییزه‌ له‌ دیزاینی ڕۆنا له‌ ئیمپایەر وۆڕڵد هەولێر',
    },
  };

  const handleRunSimulator = async () => {
    const p = SIMULATOR_PRESETS[simulatorPreset];
    setSimulating(true);
    setSimulatedTask(null);

    // Step through pipeline stages
    for (let step = 1; step <= 7; step++) {
      setSimulationStep(step);
      await new Promise((r) => setTimeout(r, 220));
    }

    const newTaskId = `sim-${Date.now().toString(36)}`;
    const fullDescription = `${p.headlineEn} / ${p.headlineCkb}\n${p.copyEn} / ${p.copyCkb}`;

    const taskObj: LiveTask = {
      id: newTaskId,
      clientId: p.client,
      title: p.title,
      status: 'REVIEW',
      priority: 'high',
      description: fullDescription,
      source: { platform: p.platform, externalId: `ext_${Date.now()}` },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    try {
      await fetch('/v1/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: p.title,
          clientId: p.client,
          description: fullDescription,
          priority: 'high',
        }),
      });
    } catch {
      // Offline fallback
    }

    setLiveTasks((prev) => [taskObj, ...prev.filter((t) => t.id !== newTaskId)]);
    setSimulatedTask(taskObj);
    setSimulating(false);
    setRealtimeNotification(`⚡ Ingress simulated: "${p.title}" landed in Review lane`);
    setTimeout(() => setRealtimeNotification(null), 6000);
  };

  const fetchTasks = async () => {
    setLoading(true);
    try {
      const res = await fetch('/v1/tasks');
      if (res.ok) {
        const data = await res.json();
        setLiveTasks(data.items || []);
        setLastFetched(`Polled: ${new Date().toLocaleTimeString()}`);
      }
    } catch (err) {
      console.error('Failed to fetch tasks:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTasks();

    // Subscribe to live SSE events
    const unsubCreated = eventStream.on('task:created', (newTask: LiveTask) => {
      setLiveTasks((prev) => {
        if (prev.some((t) => t.id === newTask.id)) return prev;
        return [newTask, ...prev];
      });
      setLastFetched(`Real-time push: Task created (${new Date().toLocaleTimeString()})`);
      setRealtimeNotification(`⚡ Inbound task created: "${newTask.title || newTask.id.slice(0, 8)}"`);
      setTimeout(() => setRealtimeNotification(null), 4000);
    });

    const unsubTransition = eventStream.on('task:transitioned', (data: { taskId: string; status: string }) => {
      setLiveTasks((prev) =>
        prev.map((t) => (t.id === data.taskId ? { ...t, status: data.status, updatedAt: new Date().toISOString() } : t))
      );
      setLastFetched(`Real-time push: Status changed to ${data.status}`);
    });

    const unsubQA = eventStream.on('task:qa_completed', (data: { taskId: string; qaReport: any }) => {
      setLiveTasks((prev) =>
        prev.map((t) => (t.id === data.taskId ? { ...t, latestQAReport: data.qaReport } : t))
      );
    });

    const unsubApproved = eventStream.on('task:approved', (data: { taskId: string }) => {
      setLiveTasks((prev) =>
        prev.map((t) => (t.id === data.taskId ? { ...t, status: 'APPROVED' } : t))
      );
      setLastFetched('Real-time push: Task approved');
    });

    const unsubPublished = eventStream.on('task:published', (data: { taskId: string }) => {
      setLiveTasks((prev) =>
        prev.map((t) => (t.id === data.taskId ? { ...t, status: 'COMPLETE' } : t))
      );
      setLastFetched('Real-time push: Task published to Google Drive');
    });

    const unsubWebhook = eventStream.on('webhook:received', (data: { platform: string; updateId: string }) => {
      setRealtimeNotification(`⚡ Real-time webhook ingress from ${data.platform.toUpperCase()} (ID: ${data.updateId})`);
      setTimeout(() => setRealtimeNotification(null), 4000);
    });

    return () => {
      unsubCreated();
      unsubTransition();
      unsubQA();
      unsubApproved();
      unsubPublished();
      unsubWebhook();
    };
  }, [refreshTrigger]);

  // Group live tasks by workflow stage
  const liveNewMessages = liveTasks.filter((t) => ['RECEIVED', 'ROUTING', 'BRIEFING'].includes(t.status));
  const liveNeedsInput = liveTasks.filter((t) => ['NEEDS_INFORMATION', 'OPERATOR_REQUIRED', 'BLOCKED', 'REJECTED'].includes(t.status));
  const liveInProduction = liveTasks.filter((t) => ['PLANNING', 'COMPOSING', 'QA', 'IN_PROGRESS'].includes(t.status));
  const liveReview = liveTasks.filter((t) => ['AWAITING_APPROVAL', 'APPROVED', 'REVISION_REQUESTED', 'PUBLISHING', 'COMPLETE'].includes(t.status));

  const totalNeedsAction = 7 + liveNeedsInput.length;
  const totalProduction = 12 + liveInProduction.length;
  const totalReview = 5 + liveReview.length;

  return (
    <section id="inbox" className="screen active">
      {realtimeNotification && (
        <div
          id="realtime-toast"
          style={{
            marginBottom: 12,
            padding: '8px 14px',
            borderRadius: 6,
            backgroundColor: 'rgba(56, 189, 248, 0.15)',
            border: '1px solid rgba(56, 189, 248, 0.4)',
            color: '#38BDF8',
            fontSize: 13,
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            animation: 'fadeIn 0.2s ease-in-out',
          }}
        >
          <span>{realtimeNotification}</span>
          <button
            onClick={() => setRealtimeNotification(null)}
            style={{ background: 'none', border: 'none', color: '#38BDF8', cursor: 'pointer', fontSize: 14 }}
          >
            ✕
          </button>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>
          {loading ? 'Refreshing board from Core API…' : lastFetched ? `${lastFetched} · ${liveTasks.length} active API tasks` : 'Live API & SSE connected'}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn"
            style={{
              fontSize: 12,
              padding: '4px 10px',
              background: 'rgba(245, 158, 11, 0.1)',
              color: '#F59E0B',
              border: '1px solid rgba(245, 158, 11, 0.3)',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
            }}
            onClick={() => setShowSimulator(!showSimulator)}
          >
            <span>⚡</span>
            <span>{showSimulator ? 'Close Simulator' : 'Simulate Inbound Brief'}</span>
          </button>
          <button
            className="btn"
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={fetchTasks}
            disabled={loading}
          >
            {loading ? 'Syncing…' : '↻ Sync Board'}
          </button>
        </div>
      </div>

      {/* Inbound Simulator Drawer */}
      {showSimulator && (
        <div
          className="panel"
          style={{
            marginBottom: 16,
            padding: 16,
            background: 'var(--panel)',
            border: '1px solid rgba(245, 158, 11, 0.35)',
            borderRadius: 12,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 18 }}>⚡</span>
              <div>
                <b style={{ fontSize: 14 }}>Inbound Client Brief Ingress Simulator</b>
                <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--muted)' }}>
                  Simulate external chat briefs (WhatsApp WAHA / Telegram) and verify the 7-stage durable pipeline.
                </p>
              </div>
            </div>
            <button
              onClick={() => setShowSimulator(false)}
              style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 16 }}
            >
              ✕
            </button>
          </div>

          {/* Preset Buttons */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 14 }}>
            {(['aster', 'nova', 'rona'] as const).map((key) => {
              const p = SIMULATOR_PRESETS[key];
              const isSelected = simulatorPreset === key;
              return (
                <div
                  key={key}
                  onClick={() => !simulating && setSimulatorPreset(key)}
                  style={{
                    padding: 10,
                    borderRadius: 8,
                    border: `1px solid ${isSelected ? '#F59E0B' : 'var(--line)'}`,
                    background: isSelected ? 'rgba(245, 158, 11, 0.08)' : 'var(--soft)',
                    cursor: simulating ? 'not-allowed' : 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span>{p.icon}</span>
                    <b style={{ fontSize: 12 }}>{p.clientName}</b>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.title}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pipeline Stepper Visualization */}
          {simulationStep > 0 && (
            <div style={{ marginBottom: 14, padding: 12, background: 'var(--soft)', borderRadius: 8, border: '1px solid var(--line)' }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }}>
                Live Pipeline Execution Stepper (Restate 1.7 Durable Journal)
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6, fontSize: 11 }}>
                {[
                  '1. Ingress Webhook',
                  '2. Scope Lock (#5)',
                  '3. Hybrid Retrieval',
                  '4. Creative Director',
                  '5. HyCanvas (.hyc)',
                  '6. QA Guard (#7)',
                  '7. Ready for Review',
                ].map((name, idx) => {
                  const stepNum = idx + 1;
                  const isDone = simulationStep > stepNum;
                  const isCurrent = simulationStep === stepNum;
                  return (
                    <div
                      key={idx}
                      style={{
                        padding: '6px 4px',
                        textAlign: 'center',
                        borderRadius: 6,
                        background: isDone ? 'rgba(16, 185, 129, 0.15)' : isCurrent ? 'rgba(245, 158, 11, 0.2)' : 'rgba(255, 255, 255, 0.04)',
                        color: isDone ? '#10B981' : isCurrent ? '#F59E0B' : 'var(--muted)',
                        fontWeight: isCurrent || isDone ? 600 : 400,
                        border: `1px solid ${isDone ? 'rgba(16, 185, 129, 0.3)' : isCurrent ? 'rgba(245, 158, 11, 0.5)' : 'transparent'}`,
                      }}
                    >
                      {isDone ? '✓ ' : isCurrent ? '⏳ ' : ''}{name}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            {simulatedTask && (
              <button
                className="btn primary"
                style={{ fontSize: 12, background: '#10B981', color: '#fff', fontWeight: 700 }}
                onClick={() => onSelectReview(simulatedTask)}
              >
                🎨 Review "{simulatedTask.title}" in Studio →
              </button>
            )}
            <button
              className="btn primary"
              style={{ fontSize: 12, background: '#F59E0B', color: '#000', fontWeight: 700 }}
              onClick={handleRunSimulator}
              disabled={simulating}
            >
              {simulating ? 'Simulating Inbound Pipeline…' : '▶ Run Ingress Simulation'}
            </button>
          </div>
        </div>
      )}

      <div className="grid4">
        <div
          className={`stat ${activeFilter === 'needs_action' ? 'sel' : ''}`}
          style={{ cursor: 'pointer' }}
          onClick={() => setActiveFilter(activeFilter === 'needs_action' ? 'all' : 'needs_action')}
        >
          <b>{totalNeedsAction}</b><span>needs action</span>
        </div>
        <div
          className={`stat ${activeFilter === 'production' ? 'sel' : ''}`}
          style={{ cursor: 'pointer' }}
          onClick={() => setActiveFilter(activeFilter === 'production' ? 'all' : 'production')}
        >
          <b>{totalProduction}</b><span>in production</span>
        </div>
        <div
          className={`stat ${activeFilter === 'review' ? 'sel' : ''}`}
          style={{ cursor: 'pointer' }}
          onClick={() => setActiveFilter(activeFilter === 'review' ? 'all' : 'review')}
        >
          <b>{totalReview}</b><span>awaiting review</span>
        </div>
        <div className="stat">
          <b>0</b><span>unhandled breaches</span>
        </div>
      </div>

      <div className="board">
        {/* Lane 1: New messages */}
        {(activeFilter === 'all' || activeFilter === 'needs_action') && (
          <div className="lane">
            <div className="lanehead">
              New messages <span className="pill">{4 + liveNewMessages.length}</span>
            </div>

            {/* Live API Tasks in this lane */}
            {liveNewMessages.map((t) => (
              <div
                key={t.id}
                className="task"
                style={{ cursor: 'pointer', borderLeft: '3px solid #1a56be' }}
                onClick={() => onSelectReview(t)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="pill blue">LIVE · {t.source?.platform || 'Desk'}</span>
                  <span className="pill ok" style={{ fontSize: 10 }}>{t.status}</span>
                </div>
                <h3>{t.title}</h3>
                <p dir="rtl" lang="ckb">{t.description || 'تێکستی داواکراو…'}</p>
                <div className="meta">
                  <span className="pill">{t.clientId || 'Aster'}</span>
                  <span className="pill">ckb</span>
                </div>
              </div>
            ))}

            <div className="task" style={{ cursor: 'pointer' }} onClick={() => onSelectReview()}>
              <span className="pill">Telegram</span>
              <h3>Podcast guest card</h3>
              <p>“Use Dr. Lina Rahman and publish tomorrow…”</p>
              <div className="meta">
                <span className="pill warn">client 0.72</span>
                <span className="pill">ckb</span>
              </div>
            </div>
            <div className="task" style={{ cursor: 'pointer' }} onClick={() => onSelectReview()}>
              <span className="pill">Hawa Desk</span>
              <h3>Summer offer variants</h3>
              <p>Exact price and three dimensions supplied.</p>
              <div className="meta">
                <span className="pill ok">Aster mapped</span>
                <span className="pill">due today</span>
              </div>
            </div>
          </div>
        )}

        {/* Lane 2: Needs input */}
        {(activeFilter === 'all' || activeFilter === 'needs_action') && (
          <div className="lane">
            <div className="lanehead">
              Needs input <span className="pill warn">{3 + liveNeedsInput.length}</span>
            </div>

            {/* Live API tasks needing input */}
            {liveNeedsInput.map((t) => (
              <div
                key={t.id}
                className="task"
                style={{ cursor: 'pointer', borderLeft: '3px solid #e12d39' }}
                onClick={() => onSelectReview(t)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="pill bad">{t.status}</span>
                  <span className="pill blue">LIVE</span>
                </div>
                <h3>{t.title}</h3>
                <p>{t.description || 'Requires operator review or clarification'}</p>
                <button
                  className="btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectReview(t);
                  }}
                >
                  Resolve in Review
                </button>
              </div>
            ))}

            <div className="task">
              {resolvedAmbiguityClient ? (
                <span className="pill ok">routed: {resolvedAmbiguityClient}</span>
              ) : (
                <span className="pill bad">routing blocked</span>
              )}
              <h3>“Make the same one again”</h3>
              <p>
                {resolvedAmbiguityClient
                  ? `Scope locked to ${resolvedAmbiguityClient} (Invariant #4 enforced). Ready for asset retrieval.`
                  : 'Two clients are allowed; no referenced design.'}
              </p>
              <button
                className="btn"
                style={resolvedAmbiguityClient ? { borderColor: 'var(--ok, #1d733c)', color: '#047857' } : {}}
                onClick={() => setShowAmbiguityModal(true)}
              >
                {resolvedAmbiguityClient ? 'Change client scope' : 'Choose client'}
              </button>
            </div>
            <div className="task">
              {resolvedFactChoice ? (
                <span className="pill ok">facts verified</span>
              ) : (
                <span className="pill warn">missing fact</span>
              )}
              <h3>Event poster</h3>
              <p>
                {resolvedFactChoice
                  ? `Fact reconciled: ${resolvedFactChoice}. Hash logged in outbox.`
                  : 'Location and time conflict between message and attachment.'}
              </p>
              <button
                className="btn"
                style={resolvedFactChoice ? { borderColor: 'var(--ok, #1d733c)', color: '#047857' } : {}}
                onClick={() => setShowFactModal(true)}
              >
                {resolvedFactChoice ? 'Edit fact reconciliation' : 'Resolve facts'}
              </button>
            </div>
          </div>
        )}

        {/* Lane 3: In production */}
        {(activeFilter === 'all' || activeFilter === 'production') && (
          <div className="lane">
            <div className="lanehead">
              In production <span className="pill">{12 + liveInProduction.length}</span>
            </div>

            {/* Live API tasks in production */}
            {liveInProduction.map((t) => (
              <div
                key={t.id}
                className="task"
                style={{ cursor: 'pointer', borderLeft: '3px solid #38bdf8' }}
                onClick={() => onSelectReview(t)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="pill blue">{t.status}</span>
                  <span className="pill ok" style={{ fontSize: 10 }}>LIVE</span>
                </div>
                <h3>{t.title}</h3>
                <p>Generating HyCanvas layout & deterministic QA checks…</p>
                <div className="bar"><i style={{ width: '65%' }}></i></div>
              </div>
            ))}

            <div className="task">
              <span className="pill blue">asset lab</span>
              <h3>Nova One launch</h3>
              <p>1/3 visual assets complete. Source task is safe.</p>
              <div className="bar"><i style={{ width: '42%' }}></i></div>
            </div>
            <div className="task">
              <span className="pill">QA</span>
              <h3>Health awareness card</h3>
              <p>Checking exact copy, source layers, font and RTL.</p>
            </div>
          </div>
        )}

        {/* Lane 4: Review */}
        {(activeFilter === 'all' || activeFilter === 'review') && (
          <div className="lane">
            <div className="lanehead">
              Review <span className="pill ok">{5 + liveReview.length}</span>
            </div>

            {/* Live API tasks in review */}
            {liveReview.map((t) => (
              <div
                key={t.id}
                className="task"
                style={{ cursor: 'pointer', borderLeft: '3px solid #1d733c' }}
                onClick={() => onSelectReview(t)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="pill ok">LIVE · {t.status}</span>
                  <span className="pill blue">{t.clientId || 'Office'}</span>
                </div>
                <h3>{t.title}</h3>
                <p dir="rtl" lang="ckb">{t.description || 'Deterministic QA completed. Awaiting decision.'}</p>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button
                    className="btn primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectReview(t);
                    }}
                  >
                    Review Candidate
                  </button>
                  <button
                    className="btn"
                    style={{ background: 'rgba(56, 189, 248, 0.1)', color: '#38BDF8', borderColor: '#0284C7' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectReview(t);
                    }}
                  >
                    ⚡ Studio
                  </button>
                </div>
              </div>
            ))}

            <div className="task" style={{ cursor: 'pointer' }} onClick={() => onSelectReview()}>
              <span className="pill ok">critical QA pass</span>
              <h3>Summer offer · revision 3</h3>
              <p>One visual warning; editable source complete.</p>
              <button className="btn primary" onClick={(e) => { e.stopPropagation(); onSelectReview(); }}>
                Review
              </button>
            </div>
            <div className="task" style={{ cursor: 'pointer' }} onClick={() => onSelectReview()}>
              <span className="pill warn">language review</span>
              <h3>Recruitment announcement</h3>
              <p>Mixed Sorani + URL + date.</p>
              <button className="btn" onClick={(e) => { e.stopPropagation(); onSelectReview(); }}>
                Inspect bidi
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Ambiguity Resolution Modal (Invariant #4 Scope Bounding) */}
      {showAmbiguityModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.65)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <div
            className="panel"
            style={{
              width: 500,
              padding: 24,
              boxShadow: '0 25px 60px rgba(0,0,0,0.3)',
              borderRadius: 14,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 18 }}>Client Scope Resolution</h2>
                <p style={{ color: 'var(--muted)', fontSize: 13, margin: '4px 0 0' }}>
                  Invariant #4: Client scope must be strictly bounded before asset retrieval.
                </p>
              </div>
              <button
                onClick={() => setShowAmbiguityModal(false)}
                style={{ background: 'transparent', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--muted)' }}
              >
                ✕
              </button>
            </div>

            <div style={{ padding: 12, background: 'var(--soft)', borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
              <b>Inbound Request:</b> “Make the same one again”
              <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>
                Multiple client tenant workspaces match the sender profile. Select the intended client:
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
              {[
                { id: 'client-aster', name: 'Aster Hotel & Resort', code: 'ASTER' },
                { id: 'client-nova', name: 'Nova Tech Systems', code: 'NOVA' },
                { id: 'client-rona', name: 'Rona Haute Couture', code: 'RONA' },
              ].map((c) => (
                <button
                  key={c.id}
                  className="btn"
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '10px 14px',
                    textAlign: 'left',
                    borderColor: resolvedAmbiguityClient === c.name ? 'var(--ok, #1d733c)' : undefined,
                    background: resolvedAmbiguityClient === c.name ? '#ecfdf5' : undefined,
                  }}
                  onClick={() => {
                    setResolvedAmbiguityClient(c.name);
                    setShowAmbiguityModal(false);
                  }}
                >
                  <span style={{ fontWeight: 650 }}>{c.name}</span>
                  <span className="pill">{c.code}</span>
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setShowAmbiguityModal(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Fact Conflict Reconciliation Modal (Invariant #5 Protected Claims) */}
      {showFactModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.65)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <div
            className="panel"
            style={{
              width: 540,
              padding: 24,
              boxShadow: '0 25px 60px rgba(0,0,0,0.3)',
              borderRadius: 14,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 18 }}>Protected Fact Reconciliation</h2>
                <p style={{ color: 'var(--muted)', fontSize: 13, margin: '4px 0 0' }}>
                  Invariant #5: Exact claims and schedules must trace to approved ground truth.
                </p>
              </div>
              <button
                onClick={() => setShowFactModal(false)}
                style={{ background: 'transparent', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--muted)' }}
              >
                ✕
              </button>
            </div>

            <div style={{ padding: 12, background: 'var(--soft)', borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
              <div style={{ color: '#b45309', fontWeight: 650, marginBottom: 4 }}>
                ⚠ Conflicting venue & schedule detected:
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.6 }}>
                <li><b>Telegram Body:</b> “Empire World · 8:00 PM”</li>
                <li><b>PDF Attachment:</b> “Family Mall Auditorium · 7:30 PM”</li>
              </ul>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
              {[
                { title: 'Use Verified PDF Attachment', detail: 'Family Mall Auditorium · 7:30 PM' },
                { title: 'Use Explicit Client Telegram Message', detail: 'Empire World · 8:00 PM' },
                { title: 'Dispatch Inbound Telegram Clarification', detail: 'Request operator confirmation via bot' },
              ].map((opt, i) => (
                <button
                  key={i}
                  className="btn"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    padding: '10px 14px',
                    textAlign: 'left',
                    borderColor: resolvedFactChoice === opt.detail ? 'var(--ok, #1d733c)' : undefined,
                    background: resolvedFactChoice === opt.detail ? '#ecfdf5' : undefined,
                  }}
                  onClick={() => {
                    setResolvedFactChoice(opt.detail);
                    setShowFactModal(false);
                  }}
                >
                  <span style={{ fontWeight: 650 }}>{opt.title}</span>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{opt.detail}</span>
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setShowFactModal(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};


