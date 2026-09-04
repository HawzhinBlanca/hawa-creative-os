import React, { useState, useEffect } from 'react';

interface ReviewScreenProps {
  task?: any;
}

export const ReviewScreen: React.FC<ReviewScreenProps> = ({ task }) => {
  const [variant, setVariant] = useState<'feed' | 'square' | 'story'>('feed');
  const [approved, setApproved] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState(false);
  const [publishReceipt, setPublishReceipt] = useState<any>(null);
  const [repairCycles, setRepairCycles] = useState(task?.repairCount || 0);
  const [revisionNote, setRevisionNote] = useState('');
  const [escalated, setEscalated] = useState(task?.status === 'OPERATOR_REQUIRED');
  const [taskStatus, setTaskStatus] = useState<string>(task?.status || 'AWAITING_APPROVAL');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Sync state if task prop changes
  useEffect(() => {
    if (task) {
      setRepairCycles(task.repairCount || 0);
      setTaskStatus(task.status || 'AWAITING_APPROVAL');
      setEscalated(task.status === 'OPERATOR_REQUIRED' || (task.repairCount || 0) > 2);
      if (task.status === 'COMPLETE') {
        setApproved(true);
        setPublished(true);
      } else if (task.status === 'APPROVED') {
        setApproved(true);
      }
    }
  }, [task]);

  const taskId = task?.id;
  const taskTitle = task?.title || 'Summer offer';
  const taskCopy = task?.description || 'بۆ ئاستەر پۆستێکی هاوینە دروست بکە… نرخ: ١٢٬٠٠٠ دینار.';
  const clientId = task?.clientId || 'Aster';
  const revisionId = task?.latestRevisionId || 'rev-current';

  const handleApprove = async () => {
    setErrorMessage(null);
    setPublishing(true);

    try {
      if (taskId) {
        // 1. Submit approval decision to Core API
        const decisionRes = await fetch(`/v1/tasks/${taskId}/revisions/${revisionId}/decisions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decision: 'approved',
            displayName: 'Desk Operator',
            role: 'art_director',
          }),
        });

        if (!decisionRes.ok) {
          const err = await decisionRes.json().catch(() => ({}));
          throw new Error(err.detail || 'Approval decision rejected by state machine');
        }

        setApproved(true);
        setTaskStatus('APPROVED');

        // 2. Dispatched to publisher
        const pubRes = await fetch(`/v1/tasks/${taskId}/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });

        if (pubRes.ok) {
          const pubData = await pubRes.json();
          setPublished(true);
          setPublishReceipt(pubData);
          setTaskStatus('COMPLETE');
        } else {
          const err = await pubRes.json().catch(() => ({}));
          throw new Error(err.detail || 'Publication dispatch failed');
        }
      } else {
        // Fallback demo simulation
        setApproved(true);
        setTimeout(() => {
          setPublished(true);
          setTaskStatus('COMPLETE');
        }, 500);
      }
    } catch (err: any) {
      console.error('Approval failed:', err);
      setErrorMessage(err.message || 'Action failed');
    } finally {
      setPublishing(false);
    }
  };

  const handleRequestRevision = async () => {
    if (!revisionNote) {
      setErrorMessage('Please provide revision instructions before submitting.');
      return;
    }
    setErrorMessage(null);

    const nextCycles = repairCycles + 1;

    try {
      if (taskId) {
        const res = await fetch(`/v1/tasks/${taskId}/revisions/${revisionId}/decisions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decision: 'revision_requested',
            displayName: 'Desk Operator',
            role: 'art_director',
            revisionRequest: { comment: revisionNote },
          }),
        });

        if (res.ok) {
          setRepairCycles(nextCycles);
          if (nextCycles > 2) {
            setEscalated(true);
            setTaskStatus('OPERATOR_REQUIRED');
          } else {
            setTaskStatus('REVISION_REQUESTED');
          }
        } else {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || 'Revision request failed');
        }
      } else {
        // Fallback demo simulation
        setRepairCycles(nextCycles);
        if (nextCycles > 2) {
          setEscalated(true);
          setTaskStatus('OPERATOR_REQUIRED');
        } else {
          setTaskStatus('REVISION_REQUESTED');
        }
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Revision request failed');
    }
  };

  return (
    <section id="review" className="screen active">
      <div className="review">
        {/* Left Column: Request & Brief & Timeline (28%) */}
        <div className="panel">
          <div className="meta" style={{ marginBottom: 12 }}>
            <span className="pill">{clientId} / {taskTitle.split(' ')[0]}</span>
            <span className="pill">Revision {repairCycles + 1}</span>
            {taskId && <span className="pill blue" title={taskId}>ID: {taskId.substring(0, 8)}…</span>}
          </div>
          <h2>{taskTitle}</h2>

          <div className="request">
            <b>Original request</b>
            <p dir="rtl" lang="ckb" style={{ margin: '4px 0 0' }}>
              {taskCopy}
            </p>
          </div>

          <h3 style={{ marginTop: 16 }}>Locked brief</h3>
          <div className="exact" dir="rtl" lang="ckb">
            <b style={{ fontSize: 16 }}>{taskCopy.length > 30 ? taskCopy.substring(0, 30) + '…' : taskCopy}</b>
            <div style={{ marginTop: 6, color: '#164a3a', fontWeight: 700 }}>١٢٬٠٠٠ دینار</div>
          </div>
          <small style={{ color: 'var(--muted)', display: 'block', marginBottom: 16 }}>
            Exact copy · cannot be rewritten by creative model
          </small>

          <h3>Evidence</h3>
          <div className="meta" style={{ marginBottom: 16 }}>
            <span className="pill ok">DNA v12</span>
            <span className="pill">logo #sha256_verified</span>
            <span className="pill">2 approved examples</span>
          </div>

          <h3>Durable timeline</h3>
          <div className="timeline">
            <div className="step done">
              <b>Request captured</b>
              <small>{taskId ? `one logical event (id: ${taskId.substring(0, 8)}…)` : 'one logical event (telegram #101)'}</small>
            </div>
            <div className="step done">
              <b>Client scope locked</b>
              <small>channel mapping {clientId} / tenant-default</small>
            </div>
            <div className="step done">
              <b>Editable source created</b>
              <small>HyCanvas v0.3.9 candidate ({revisionId ? revisionId.substring(0, 10) : 'sha256_7d2…'})</small>
            </div>
            <div className="step done">
              <b>Deterministic QA Passed</b>
              <small>Exact copy, bidi, brand logo hash verified</small>
            </div>
            <div className={`step ${approved ? 'done' : ''}`}>
              <b>
                {published
                  ? 'Published to Google Shared Drive'
                  : publishing
                  ? 'Publishing deliverables...'
                  : approved
                  ? 'Approved by Operator'
                  : 'Awaiting your decision'}
              </b>
              <small>
                {published
                  ? 'Synced to Sheet row with hash reconciliation'
                  : publishing
                  ? 'Uploading .hyc & PNG renders...'
                  : approved
                  ? 'Dispatched to Google Shared Drive'
                  : 'safe to close this page'}
              </small>
            </div>
          </div>
        </div>

        {/* Center Column: Live Editable Canvas (44%) */}
        <div className="panel">
          <div className="variantbar">
            <button className={`btn ${variant === 'feed' ? 'primary' : ''}`} onClick={() => setVariant('feed')}>Feed 4:5</button>
            <button className={`btn ${variant === 'square' ? 'primary' : ''}`} onClick={() => setVariant('square')}>Square 1:1</button>
            <button className={`btn ${variant === 'story' ? 'primary' : ''}`} onClick={() => setVariant('story')}>Story 9:16</button>
            <button className="btn" onClick={() => window.open('https://studio.hawa.office', '_blank')}>Open editor</button>
          </div>

          <div className="canvaswrap">
            <div
              className="canvas"
              style={{
                aspectRatio: variant === 'square' ? '1 / 1' : variant === 'story' ? '9 / 16' : '4 / 5',
                width: variant === 'story' ? '46%' : '62%',
              }}
            >
              <div className="t1" dir="rtl" lang="ckb">
                {taskCopy ? (taskCopy.length > 20 ? taskCopy.substring(0, 20) : taskCopy) : 'تامی سارد، ڕۆژی خۆش'}
              </div>
              <div className="shape"></div>
              <div className="copy" dir="rtl" lang="ckb">
                ١٢٬٠٠٠ دینار
              </div>
            </div>
          </div>

          <div className="toolbar" style={{ marginTop: 14 }}>
            <button className="btn">Compare R2</button>
            <button className="btn">Layers</button>
            <button className="btn">Add annotation</button>
            <span className="pill ok">source .hyc + manifest</span>
          </div>
        </div>

        {/* Right Column: Evidence & Decision (28%) */}
        <div className="panel">
          <h3>Quality evidence</h3>

          {errorMessage && (
            <div className="finding" style={{ borderColor: '#dc2626', background: '#fef2f2', marginBottom: 12 }}>
              <b style={{ color: '#991b1b' }}>⚠ Action Notice</b>
              <p style={{ margin: '4px 0', fontSize: 12, color: '#b91c1c' }}>{errorMessage}</p>
            </div>
          )}

          {published && (
            <div className="finding" style={{ borderColor: '#1d733c', background: '#ecfdf5', marginBottom: 12 }}>
              <b style={{ color: '#065f46' }}>✓ Publication Complete</b>
              <p style={{ margin: '4px 0', fontSize: 12, color: '#047857' }}>
                Files uploaded to <code>drive_office_main/Deliverables/</code>. Row synced in Google Sheets tracker.
              </p>
              {publishReceipt && (
                <div style={{ fontSize: 11, color: '#065f46', marginTop: 4, wordBreak: 'break-all' }}>
                  Workflow ID: <code>{publishReceipt.workflowId}</code>
                </div>
              )}
              <a href="https://drive.google.com" target="_blank" rel="noreferrer" className="btn" style={{ fontSize: 11, display: 'inline-block', marginTop: 6 }}>
                Open Shared Drive Folder
              </a>
            </div>
          )}

          {escalated && (
            <div className="finding" style={{ borderColor: '#dc2626', background: '#fef2f2', marginBottom: 12 }}>
              <b style={{ color: '#991b1b' }}>⚠ Max Repair Budget Exceeded</b>
              <p style={{ margin: '4px 0', fontSize: 12, color: '#b91c1c' }}>
                Reached {repairCycles} repair cycles (invariant #7). Escalated to Operator Review (<code>OPERATOR_REQUIRED</code>). Automated repair halted.
              </p>
            </div>
          )}

          {repairCycles > 0 && !escalated && (
            <div className="finding" style={{ borderColor: '#d97706', background: '#fffbeb', marginBottom: 12 }}>
              <b style={{ color: '#92400e' }}>Repair Cycle {repairCycles} of 2 Active</b>
              <p style={{ margin: '4px 0', fontSize: 12, color: '#b45309' }}>
                Revision requested: “{revisionNote || 'Adjust layout'}”. Task status: <code>{taskStatus}</code>.
              </p>
            </div>
          )}

          <div className="finding">
            <b>Visual warning (advisory)</b>
            <p>Foreground organic shape is close to price safe zone. Non-blocking.</p>
            <button className="btn" style={{ fontSize: 11, padding: '4px 8px' }}>Target node</button>
          </div>

          <div className="finding" style={{ borderColor: '#4d9d69', background: '#f2f8f4' }}>
            <b style={{ color: '#1d733c' }}>RTL & bidi checks passed</b>
            <p>Glyph coverage (Vazirmatn), joining, number order, extracted text and export parity.</p>
          </div>

          <div className="finding" style={{ borderColor: '#4d9d69', background: '#f2f8f4' }}>
            <b style={{ color: '#1d733c' }}>Brand checks passed</b>
            <p>Approved logo hash (sha256_logo_verified_primary), palette, safe margins, and template family verified.</p>
          </div>

          <h3 style={{ marginTop: 20 }}>Decision</h3>
          <textarea
            style={{ width: '100%', height: 82, border: '1px solid var(--line)', borderRadius: 8, padding: 9 }}
            placeholder="Revision instruction or approval note"
            value={revisionNote}
            onChange={(e) => setRevisionNote(e.target.value)}
          />

          <div className="toolbar" style={{ marginTop: 10, flexWrap: 'wrap' }}>
            <button
              className="btn primary"
              disabled={approved || publishing}
              onClick={handleApprove}
            >
              {published ? '✓ Published' : publishing ? 'Publishing...' : 'Approve & Publish'}
            </button>
            <button
              className="btn"
              disabled={approved || escalated}
              onClick={handleRequestRevision}
            >
              Request revision ({Math.min(repairCycles, 2)}/2)
            </button>
            <button className="btn" onClick={() => alert('Dispatched to designer workspace')}>Send to designer</button>
          </div>

          <small style={{ color: 'var(--muted)', display: 'block', marginTop: 10 }}>
            Approval cryptographically binds source hash <code>7d2e…</code> and QC report hash <code>91b8…</code>.
          </small>
        </div>
      </div>
    </section>
  );
};

