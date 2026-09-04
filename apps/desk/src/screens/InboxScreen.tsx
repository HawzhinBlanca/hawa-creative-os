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
        <button
          className="btn"
          style={{ fontSize: 12, padding: '4px 10px' }}
          onClick={fetchTasks}
          disabled={loading}
        >
          {loading ? 'Syncing…' : '↻ Sync Board'}
        </button>
      </div>

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
              <span className="pill bad">routing blocked</span>
              <h3>“Make the same one again”</h3>
              <p>Two clients are allowed; no referenced design.</p>
              <button className="btn" onClick={() => alert('Ambiguity resolution modal: select client Aster or Nova')}>Choose client</button>
            </div>
            <div className="task">
              <span className="pill warn">missing fact</span>
              <h3>Event poster</h3>
              <p>Location and time conflict between message and attachment.</p>
              <button className="btn" onClick={() => alert('Fact clarification requested via outbound Telegram message')}>Resolve facts</button>
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
    </section>
  );
};


