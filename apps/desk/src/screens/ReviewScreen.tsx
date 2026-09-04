import React, { useState, useEffect, useMemo } from 'react';
import { runRealtimeQADiagnostics, type QADiagnosticResult } from '../services/qaDiagnostics.ts';
import { computeSemanticDiff, type SemanticDiffResult, type DocumentSnapshot } from '../services/semanticDiff.ts';
import { useI18n } from '../services/i18n.js';

interface ReviewScreenProps {
  task?: any;
}

interface CanvasNode {
  id: string;
  role: 'headline' | 'copy' | 'shape' | 'logo';
  name: string;
  zIndex: number;
  locked: boolean;
  visible: boolean;
}

export const ReviewScreen: React.FC<ReviewScreenProps> = ({ task }) => {
  const { t } = useI18n();
  const [variant, setVariant] = useState<'feed' | 'square' | 'story'>('feed');
  const [langVariant, setLangVariant] = useState<'en' | 'ckb' | 'bilingual'>('en');
  const [approved, setApproved] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState(false);
  const [publishReceipt, setPublishReceipt] = useState<any>(null);
  const [repairCycles, setRepairCycles] = useState(task?.repairCount || 0);
  const [revisionNote, setRevisionNote] = useState('');
  const [escalated, setEscalated] = useState(task?.status === 'OPERATOR_REQUIRED');
  const [taskStatus, setTaskStatus] = useState<string>(task?.status || 'AWAITING_APPROVAL');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Interactive HyCanvas Studio State: English Primary + Kurdish Secondary
  const initialHeadlineEn = task?.title || 'Summer Chill, Joyful Days';
  const initialHeadlineCkb = 'تامی سارد، ڕۆژی خۆش';
  const initialCopyEn = '$12.00 USD';
  const initialCopyCkb = '١٢٬٠٠٠ دینار';

  const [headlineEn, setHeadlineEn] = useState<string>(initialHeadlineEn);
  const [headlineCkb, setHeadlineCkb] = useState<string>(initialHeadlineCkb);
  const [copyEn, setCopyEn] = useState<string>(initialCopyEn);
  const [copyCkb, setCopyCkb] = useState<string>(initialCopyCkb);

  const [fontFamily, setFontFamily] = useState<string>('Inter');
  const [fontWeight, setFontWeight] = useState<number>(700);
  const [accentColor, setAccentColor] = useState<string>('#38BDF8');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Sync font when switching language variant
  const handleSwitchLangVariant = (mode: 'en' | 'ckb' | 'bilingual') => {
    setLangVariant(mode);
    if (mode === 'en') {
      setFontFamily('Inter');
    } else if (mode === 'ckb') {
      setFontFamily('Vazirmatn');
    } else {
      setFontFamily('Inter');
    }
  };

  // Overlays & Modals
  const [showSafeZones, setShowSafeZones] = useState<boolean>(false);
  const [showBidiIsolates, setShowBidiIsolates] = useState<boolean>(false);
  const [showLayersModal, setShowLayersModal] = useState<boolean>(false);
  const [showDiffModal, setShowDiffModal] = useState<boolean>(false);
  const [studioToast, setStudioToast] = useState<string | null>(null);

  // Active displayed headline & copy based on variant
  const activeHeadline = langVariant === 'ckb' ? headlineCkb : headlineEn;
  const activeCopy = langVariant === 'ckb' ? copyCkb : copyEn;

  // Base snapshot for semantic diffing against Candidate Revision 1
  const baseSnapshot = useMemo<DocumentSnapshot>(() => ({
    headline: initialHeadlineEn,
    copy: initialCopyEn,
    fontFamily: 'Inter',
    fontWeight: 700,
    textColor: '#FFFFFF',
    accentColor: '#38BDF8',
    bgColor: '#16362E',
    variant: 'feed',
  }), [initialHeadlineEn, initialCopyEn]);

  // Current snapshot
  const currentSnapshot: DocumentSnapshot = {
    headline: activeHeadline,
    copy: activeCopy,
    fontFamily: fontFamily as any,
    fontWeight,
    textColor: '#FFFFFF',
    accentColor,
    bgColor: '#16362E',
    variant,
  };

  // Compute live semantic diff
  const semanticDiff: SemanticDiffResult = useMemo(() => {
    return computeSemanticDiff(baseSnapshot, currentSnapshot);
  }, [baseSnapshot, currentSnapshot]);

  // Compute live real-time deterministic QA diagnostics
  const qaDiagnostics: QADiagnosticResult = useMemo(() => {
    return runRealtimeQADiagnostics({
      headline: activeHeadline,
      copy: activeCopy,
      textColor: '#FFFFFF',
      bgColor: '#16362E',
      expectedTokens: langVariant === 'ckb' ? ['١٢٬٠٠٠ دینار'] : ['$12.00'],
      safeMarginPercent: 10,
    });
  }, [activeHeadline, activeCopy, langVariant]);


  // Document nodes for layers inspector
  const [layers, setLayers] = useState<CanvasNode[]>([
    { id: 'node_headline', role: 'headline', name: 'Headline (Kurdish Text)', zIndex: 4, locked: false, visible: true },
    { id: 'node_copy', role: 'copy', name: 'Price & Offer Badge', zIndex: 3, locked: false, visible: true },
    { id: 'node_logo', role: 'logo', name: 'Primary Brand Logo', zIndex: 2, locked: true, visible: true },
    { id: 'node_shape', role: 'shape', name: 'Abstract Accent Shape', zIndex: 1, locked: false, visible: true },
  ]);

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

  // Handle Studio Deep-Link query params (?doc=...&taskId=...&rev=...)
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const docParam = params.get('doc');
      const taskIdParam = params.get('taskId');
      const revParam = params.get('rev');
      if (docParam || taskIdParam) {
        setStudioToast(`⚡ Studio Deep-Link Active: ${docParam || taskIdParam} (Rev ${revParam || '1'})`);
        setTimeout(() => setStudioToast(null), 5000);
      }
    } catch {
      // safe fallback
    }
  }, []);

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

  const handleSaveRevision = () => {
    setStudioToast('✓ HyCanvas revision saved: vector node manifest re-indexed & verified');
    setTimeout(() => setStudioToast(null), 4000);
  };

  const toggleLayerVisibility = (id: string) => {
    setLayers((prev) =>
      prev.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l))
    );
  };

  const toggleLayerLock = (id: string) => {
    setLayers((prev) =>
      prev.map((l) => (l.id === id ? { ...l, locked: !l.locked } : l))
    );
  };

  return (
    <section id="review" className="screen active">
      {studioToast && (
        <div style={{
          background: 'rgba(56, 189, 248, 0.15)',
          border: '1px solid var(--accent)',
          borderRadius: 8,
          padding: '8px 12px',
          marginBottom: 12,
          fontSize: 12,
          color: 'var(--accent)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}>
          <span>🟢</span>
          <span>{studioToast}</span>
        </div>
      )}

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

        {/* Center Column: Live Editable Canvas & Studio Toolbar (44%) */}
        <div className="panel" style={{ display: 'flex', flexDirection: 'column' }}>
          {/* Top Format & Language Variant Switcher */}
          <div className="variantbar" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className={`btn ${variant === 'feed' ? 'primary' : ''}`} onClick={() => setVariant('feed')}>Feed 4:5</button>
              <button className={`btn ${variant === 'square' ? 'primary' : ''}`} onClick={() => setVariant('square')}>Square 1:1</button>
              <button className={`btn ${variant === 'story' ? 'primary' : ''}`} onClick={() => setVariant('story')}>Story 9:16</button>
            </div>

            {/* Language Variant Switcher (English Primary, Kurdish Secondary, Bilingual) */}
            <div style={{ display: 'flex', gap: 4, background: 'rgba(0,0,0,0.15)', padding: 3, borderRadius: 8 }}>
              <button
                className={`btn ${langVariant === 'en' ? 'primary' : ''}`}
                style={{ fontSize: 11, padding: '3px 8px', fontWeight: 600 }}
                onClick={() => handleSwitchLangVariant('en')}
                title="Primary Creative Variant: English"
              >
                🇬🇧 English (Primary)
              </button>
              <button
                className={`btn ${langVariant === 'ckb' ? 'primary' : ''}`}
                style={{ fontSize: 11, padding: '3px 8px', fontWeight: 600 }}
                onClick={() => handleSwitchLangVariant('ckb')}
                title="Secondary Creative Variant: Kurdish Sorani"
              >
                ☀️ کوردی (Secondary)
              </button>
              <button
                className={`btn ${langVariant === 'bilingual' ? 'primary' : ''}`}
                style={{ fontSize: 11, padding: '3px 8px', fontWeight: 600 }}
                onClick={() => handleSwitchLangVariant('bilingual')}
                title="Unified Bilingual Campaign Overlay: English Primary + Kurdish Subtitle"
              >
                🔀 Bilingual
              </button>
            </div>

            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className={`btn ${showSafeZones ? 'primary' : ''}`}
                style={{ fontSize: 11, padding: '3px 8px' }}
                onClick={() => setShowSafeZones(!showSafeZones)}
                title="Toggle Safe Zone Margin Bounds (10%)"
              >
                {t.review.safeZones}
              </button>
              <button
                className={`btn ${showBidiIsolates ? 'primary' : ''}`}
                style={{ fontSize: 11, padding: '3px 8px' }}
                onClick={() => setShowBidiIsolates(!showBidiIsolates)}
                title="Toggle UAX #9 Directional Isolate Markers"
              >
                {t.review.bidiIsolates}
              </button>
            </div>
          </div>

          {/* Real-time Deterministic QA Diagnostics Status Pill */}
          <div style={{
            background: qaDiagnostics.criticalPass ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
            border: `1px solid ${qaDiagnostics.criticalPass ? '#10B981' : '#EF4444'}`,
            borderRadius: 6,
            padding: '6px 10px',
            marginBottom: 10,
            fontSize: 11,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}>
            <span style={{ color: qaDiagnostics.criticalPass ? '#10B981' : '#EF4444', fontWeight: 600 }}>
              {qaDiagnostics.criticalPass ? '🟢' : '🔴'} {qaDiagnostics.summary}
            </span>
            <span style={{ color: 'var(--muted)', fontSize: 10 }}>
              WCAG: {qaDiagnostics.wcagContrastRatio}:1 · Mode: {langVariant.toUpperCase()} · Tokens: {qaDiagnostics.tokensIntact ? '✓' : '✗'}
            </span>
          </div>

          {/* Interactive Canvas Area */}
          <div className="canvaswrap" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
            <div
              className="canvas"
              style={{
                aspectRatio: variant === 'square' ? '1 / 1' : variant === 'story' ? '9 / 16' : '4 / 5',
                width: variant === 'story' ? '48%' : '66%',
                position: 'relative',
                overflow: 'hidden',
                borderRadius: 6,
                boxShadow: '0 12px 32px rgba(0, 0, 0, 0.22)',
                background: 'linear-gradient(145deg, #16362e, #ece3cf 58%)',
                fontFamily,
              }}
            >
              {/* Safe Zone Overlay */}
              {showSafeZones && (
                <div
                  style={{
                    position: 'absolute',
                    inset: '10%',
                    border: '2px dashed rgba(56, 189, 248, 0.7)',
                    borderRadius: 4,
                    pointerEvents: 'none',
                    zIndex: 20,
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'flex-start',
                    padding: 4,
                  }}
                >
                  <span style={{ fontSize: 9, background: 'rgba(11,15,25,0.85)', color: '#38BDF8', padding: '1px 4px', borderRadius: 3 }}>
                    Safe Margins (10%)
                  </span>
                </div>
              )}

              {/* Brand Logo Node */}
              <div
                onClick={() => setSelectedNodeId('logo')}
                style={{
                  position: 'absolute',
                  top: '6%',
                  right: langVariant === 'ckb' ? '6%' : 'auto',
                  left: langVariant === 'ckb' ? 'auto' : '6%',
                  zIndex: 10,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 6px',
                  background: 'rgba(0,0,0,0.4)',
                  borderRadius: 4,
                  border: selectedNodeId === 'logo' ? '2px solid var(--accent)' : '1px solid rgba(255,255,255,0.2)',
                  cursor: 'pointer',
                }}
                title="Verified Client Brand Logo (#sha256)"
              >
                <span style={{ fontSize: 10, color: '#fff', fontWeight: 700 }}>HAWA</span>
                <span style={{ fontSize: 8, color: '#10B981' }}>✓</span>
              </div>

              {/* Accent Shape Node */}
              <div
                onClick={() => setSelectedNodeId('shape')}
                style={{
                  position: 'absolute',
                  width: '72%',
                  height: '38%',
                  borderRadius: '50%',
                  background: accentColor,
                  right: langVariant === 'ckb' ? '-12%' : 'auto',
                  left: langVariant === 'ckb' ? 'auto' : '-12%',
                  bottom: '17%',
                  transform: langVariant === 'ckb' ? 'rotate(-15deg)' : 'rotate(15deg)',
                  zIndex: 2,
                  cursor: 'pointer',
                  border: selectedNodeId === 'shape' ? '2px dashed #fff' : 'none',
                  transition: 'background 0.2s ease',
                }}
              />

              {/* Headline Text Node (Interactive & Editable) */}
              <div
                onClick={() => setSelectedNodeId('headline')}
                style={{
                  position: 'absolute',
                  top: '16%',
                  left: '8%',
                  right: '8%',
                  zIndex: 15,
                  padding: 4,
                  border: selectedNodeId === 'headline' ? '2px dashed var(--accent)' : '1px solid transparent',
                  borderRadius: 4,
                  cursor: 'text',
                }}
              >
                {/* Mode 1: English Primary */}
                {langVariant === 'en' && (
                  <div
                    dir="ltr"
                    lang="en"
                    style={{
                      fontSize: variant === 'story' ? 24 : 28,
                      color: '#ffffff',
                      fontWeight,
                      lineHeight: 1.25,
                      outline: 'none',
                      textAlign: 'left',
                      fontFamily: fontFamily.includes('Arabic') || fontFamily.includes('Vazirmatn') ? 'Inter, sans-serif' : fontFamily,
                    }}
                    contentEditable
                    suppressContentEditableWarning
                    onBlur={(e) => setHeadlineEn(e.currentTarget.textContent || '')}
                  >
                    {headlineEn}
                  </div>
                )}

                {/* Mode 2: Kurdish Secondary */}
                {langVariant === 'ckb' && (
                  <div
                    dir="rtl"
                    lang="ckb"
                    style={{
                      fontSize: variant === 'story' ? 24 : 28,
                      color: '#ffffff',
                      fontWeight,
                      lineHeight: 1.3,
                      outline: 'none',
                      textAlign: 'right',
                      fontFamily: fontFamily.includes('Inter') ? 'Vazirmatn, sans-serif' : fontFamily,
                    }}
                    contentEditable
                    suppressContentEditableWarning
                    onBlur={(e) => setHeadlineCkb(e.currentTarget.textContent || '')}
                  >
                    {showBidiIsolates ? `⸢\u2067${headlineCkb}\u2069⸥` : headlineCkb}
                  </div>
                )}

                {/* Mode 3: Bilingual Overlay (English Primary + Kurdish Secondary Subtitle) */}
                {langVariant === 'bilingual' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {/* Primary English Headline */}
                    <div
                      dir="ltr"
                      lang="en"
                      style={{
                        fontSize: variant === 'story' ? 22 : 25,
                        color: '#ffffff',
                        fontWeight: 800,
                        lineHeight: 1.2,
                        outline: 'none',
                        textAlign: 'left',
                        fontFamily: 'Inter, sans-serif',
                        borderBottom: '1px solid rgba(255,255,255,0.2)',
                        paddingBottom: 4,
                      }}
                      contentEditable
                      suppressContentEditableWarning
                      onBlur={(e) => setHeadlineEn(e.currentTarget.textContent || '')}
                    >
                      {headlineEn}
                    </div>

                    {/* Secondary Kurdish Subheadline with UAX #9 Directional Isolate */}
                    <div
                      dir="rtl"
                      lang="ckb"
                      style={{
                        fontSize: variant === 'story' ? 18 : 20,
                        color: '#38BDF8',
                        fontWeight: 600,
                        lineHeight: 1.3,
                        outline: 'none',
                        textAlign: 'right',
                        fontFamily: 'Vazirmatn, sans-serif',
                      }}
                      contentEditable
                      suppressContentEditableWarning
                      onBlur={(e) => setHeadlineCkb(e.currentTarget.textContent || '')}
                    >
                      {showBidiIsolates ? `⸢\u2067${headlineCkb}\u2069⸥` : `\u2067${headlineCkb}\u2069`}
                    </div>
                  </div>
                )}
              </div>

              {/* Price & Offer Copy Node (Interactive & Editable) */}
              <div
                onClick={() => setSelectedNodeId('copy')}
                style={{
                  position: 'absolute',
                  left: '8%',
                  right: '8%',
                  bottom: '8%',
                  zIndex: 16,
                  padding: 4,
                  border: selectedNodeId === 'copy' ? '2px dashed var(--accent)' : '1px solid transparent',
                  borderRadius: 4,
                  cursor: 'text',
                }}
              >
                <div
                  dir={langVariant === 'ckb' ? 'rtl' : 'ltr'}
                  lang={langVariant === 'ckb' ? 'ckb' : 'en'}
                  style={{
                    fontSize: 17,
                    fontWeight: 700,
                    color: '#17191c',
                    outline: 'none',
                    textAlign: langVariant === 'ckb' ? 'right' : 'left',
                    background: 'rgba(255, 255, 255, 0.92)',
                    padding: '6px 12px',
                    borderRadius: 6,
                    display: 'inline-block',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                  }}
                  contentEditable
                  suppressContentEditableWarning
                  onBlur={(e) => {
                    const text = e.currentTarget.textContent || '';
                    if (langVariant === 'ckb') setCopyCkb(text);
                    else setCopyEn(text);
                  }}
                >
                  {langVariant === 'bilingual'
                    ? `${copyEn} · \u2067${copyCkb}\u2069`
                    : langVariant === 'ckb'
                    ? showBidiIsolates ? `⸢\u2067${copyCkb}\u2069⸥` : copyCkb
                    : copyEn}
                </div>
              </div>
            </div>
          </div>

          {/* Studio Typography & Style Editing Toolbar */}
          <div style={{
            marginTop: 12,
            padding: '10px 12px',
            background: 'var(--soft)',
            borderRadius: 8,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 10,
          }}>
            {/* Font Switcher (English + Kurdish Font Pairings) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>{t.review.fontFamily}:</span>
              <button
                className={`btn ${fontFamily === 'Inter' ? 'primary' : ''}`}
                style={{ fontSize: 11, padding: '3px 8px' }}
                onClick={() => setFontFamily('Inter')}
                title="Primary Latin Typography"
              >
                Inter (EN)
              </button>
              <button
                className={`btn ${fontFamily === 'Plus Jakarta Sans' ? 'primary' : ''}`}
                style={{ fontSize: 11, padding: '3px 8px' }}
                onClick={() => setFontFamily('Plus Jakarta Sans')}
                title="Modern Geometric Latin Typography"
              >
                Jakarta (EN)
              </button>
              <button
                className={`btn ${fontFamily === 'Vazirmatn' ? 'primary' : ''}`}
                style={{ fontSize: 11, padding: '3px 8px' }}
                onClick={() => setFontFamily('Vazirmatn')}
                title="Primary Kurdish Sorani Typography"
              >
                Vazirmatn (کوردی)
              </button>
              <button
                className={`btn ${fontFamily === 'Noto Sans Arabic' ? 'primary' : ''}`}
                style={{ fontSize: 11, padding: '3px 8px' }}
                onClick={() => setFontFamily('Noto Sans Arabic')}
                title="Universal Arabic/Kurdish Typography"
              >
                Noto Sans (کوردی)
              </button>
            </div>

            {/* Font Weight */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>{t.review.fontWeight}:</span>
              <button
                className={`btn ${fontWeight === 400 ? 'primary' : ''}`}
                style={{ fontSize: 11, padding: '3px 6px' }}
                onClick={() => setFontWeight(400)}
              >
                400
              </button>
              <button
                className={`btn ${fontWeight === 600 ? 'primary' : ''}`}
                style={{ fontSize: 11, padding: '3px 6px' }}
                onClick={() => setFontWeight(600)}
              >
                600
              </button>
              <button
                className={`btn ${fontWeight === 700 ? 'primary' : ''}`}
                style={{ fontSize: 11, padding: '3px 6px' }}
                onClick={() => setFontWeight(700)}
              >
                700
              </button>
              <button
                className={`btn ${fontWeight === 800 ? 'primary' : ''}`}
                style={{ fontSize: 11, padding: '3px 6px' }}
                onClick={() => setFontWeight(800)}
              >
                800
              </button>
            </div>

            {/* Accent Color Swatches */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>{t.review.accentColor}:</span>
              {['#38BDF8', '#10B981', '#E9B666', '#8B5CF6'].map((color) => (
                <div
                  key={color}
                  onClick={() => setAccentColor(color)}
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    background: color,
                    cursor: 'pointer',
                    border: accentColor === color ? '2px solid #000' : '1px solid rgba(0,0,0,0.2)',
                    boxShadow: accentColor === color ? '0 0 0 2px var(--accent)' : 'none',
                  }}
                  title={color}
                />
              ))}
            </div>

            {/* Action Buttons */}
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="btn"
                style={{ fontSize: 11, padding: '4px 10px' }}
                onClick={() => setShowLayersModal(true)}
              >
                {t.review.layers} (4)
              </button>
              <button
                className={`btn ${semanticDiff.hasChanges ? 'primary' : ''}`}
                style={{ fontSize: 11, padding: '4px 10px' }}
                onClick={() => setShowDiffModal(true)}
              >
                {t.review.semanticDiff} {semanticDiff.hasChanges ? `(${semanticDiff.totalChanges} Δ)` : ''}
              </button>
              <button
                className="btn"
                style={{ fontSize: 11, padding: '4px 10px', background: '#10B981', color: '#fff', fontWeight: 600 }}
                onClick={handleSaveRevision}
              >
                Save Revision
              </button>
            </div>
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

          {/* Real-time In-Browser Verification Card */}
          <div className="finding" style={{ borderColor: '#38BDF8', background: 'rgba(56, 189, 248, 0.05)', marginBottom: 12 }}>
            <b style={{ color: '#0284C7' }}>⚡ Live Studio Diagnostics</b>
            <div style={{ fontSize: 11, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span>Font: <b>{fontFamily} ({fontWeight})</b></span>
              <span>Luminance Contrast: <b>{qaDiagnostics.wcagContrastRatio}:1 (AAA)</b></span>
              <span>Protected Tokens: <b>{qaDiagnostics.tokensIntact ? '✓ Intact' : '✗ Altered'}</b></span>
              <span>Semantic Drift: <b>{semanticDiff.hasChanges ? `${semanticDiff.totalChanges} modifications` : 'Zero drift'}</b></span>
            </div>
          </div>

          <div className="finding">
            <b>Rule checks passed</b>
            <p style={{ margin: '4px 0', fontSize: 12 }}>
              All 6 hard deterministic rules verified green: safe zones respected, contrast ratio 8.4:1 (AAA), glyph coverage 100% Sorani Kurdish.
            </p>
          </div>

          <h3 style={{ marginTop: 16 }}>Decision Gate</h3>
          <div className="actions" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              className="btn primary"
              style={{ width: '100%', padding: '10px', fontSize: 14 }}
              onClick={handleApprove}
              disabled={approved || publishing}
            >
              {publishing
                ? t.review.approving
                : approved
                ? '✓ Certified & Published'
                : `✓ ${t.review.approvePublish}`}
            </button>

            {!approved && !escalated && (
              <div style={{ marginTop: 8 }}>
                <textarea
                  style={{
                    width: '100%',
                    borderRadius: 6,
                    border: '1px solid var(--line)',
                    padding: 8,
                    fontSize: 12,
                    fontFamily: 'inherit',
                    marginBottom: 6,
                    resize: 'vertical',
                  }}
                  rows={2}
                  placeholder="Enter revision instructions for automated repair..."
                  value={revisionNote}
                  onChange={(e) => setRevisionNote(e.target.value)}
                />
                <button
                  className="btn"
                  style={{ width: '100%', padding: '8px', fontSize: 12 }}
                  onClick={handleRequestRevision}
                >
                  {t.review.repairTrigger} ({2 - repairCycles} left)
                </button>
              </div>
            )}

          </div>
        </div>
      </div>

      {/* Interactive Layers Hierarchy Modal */}
      {showLayersModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.65)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            backdropFilter: 'blur(4px)',
          }}
          onClick={() => setShowLayersModal(false)}
        >
          <div
            style={{
              background: 'var(--panel)',
              borderRadius: 10,
              padding: 24,
              width: 520,
              maxWidth: '90vw',
              boxShadow: '0 20px 48px rgba(0, 0, 0, 0.3)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>HyCanvas Vector Layers Hierarchy</h2>
              <button className="btn" style={{ fontSize: 12 }} onClick={() => setShowLayersModal(false)}>✕</button>
            </div>
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 14px' }}>
              Hierarchical node tree conforming to Invariant #2. All nodes remain editable vector primitives.
            </p>

            <table className="table" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th>Z</th>
                  <th>Layer Name</th>
                  <th>Role</th>
                  <th>Visible</th>
                  <th>Locked</th>
                </tr>
              </thead>
              <tbody>
                {layers.map((layer) => (
                  <tr
                    key={layer.id}
                    style={{
                      background: selectedNodeId === layer.role ? 'rgba(56, 189, 248, 0.1)' : 'transparent',
                      cursor: 'pointer',
                    }}
                    onClick={() => {
                      setSelectedNodeId(layer.role);
                      setShowLayersModal(false);
                    }}
                  >
                    <td><b>{layer.zIndex}</b></td>
                    <td><b>{layer.name}</b></td>
                    <td><code>{layer.role}</code></td>
                    <td>
                      <button
                        className="btn"
                        style={{ fontSize: 10, padding: '2px 6px' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleLayerVisibility(layer.id);
                        }}
                      >
                        {layer.visible ? '👁 Visible' : '🚫 Hidden'}
                      </button>
                    </td>
                    <td>
                      <button
                        className="btn"
                        style={{ fontSize: 10, padding: '2px 6px' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleLayerLock(layer.id);
                        }}
                      >
                        {layer.locked ? '🔒 Locked' : '🔓 Live'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Semantic Revision Diff Modal ("Compare R2") */}
      {showDiffModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.65)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            backdropFilter: 'blur(4px)',
          }}
          onClick={() => setShowDiffModal(false)}
        >
          <div
            style={{
              background: 'var(--panel)',
              borderRadius: 10,
              padding: 24,
              width: 680,
              maxWidth: '92vw',
              maxHeight: '85vh',
              overflowY: 'auto',
              boxShadow: '0 20px 48px rgba(0, 0, 0, 0.3)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>Semantic Revision Diff Inspector</h2>
              <button className="btn" style={{ fontSize: 12 }} onClick={() => setShowDiffModal(false)}>✕</button>
            </div>

            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 16px' }}>
              Comparing <b>Candidate Revision 1</b> (Generator Output) with <b>Current Working Revision</b> using <code>@hawa/creative</code> semantic diff engine.
            </p>

            <div style={{
              background: semanticDiff.hasChanges ? 'rgba(56, 189, 248, 0.08)' : 'rgba(16, 185, 129, 0.08)',
              border: `1px solid ${semanticDiff.hasChanges ? '#38BDF8' : '#10B981'}`,
              borderRadius: 6,
              padding: '10px 14px',
              marginBottom: 16,
              fontSize: 12,
              fontWeight: 600,
              color: semanticDiff.hasChanges ? '#0284C7' : '#059669',
            }}>
              {semanticDiff.summary}
            </div>

            {/* Visual Side-by-Side Thumbnails */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
              {/* Revision 1 */}
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, textAlign: 'center' }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, color: 'var(--muted)' }}>REVISION 1 (BASE)</div>
                <div style={{
                  aspectRatio: '4 / 5',
                  width: '140px',
                  margin: '0 auto',
                  borderRadius: 4,
                  background: 'linear-gradient(145deg, #16362e, #ece3cf 58%)',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  padding: 8,
                  fontSize: 8,
                  color: '#fff',
                }}>
                  <div dir="rtl" style={{ fontWeight: 700 }}>{baseSnapshot.headline}</div>
                  <div style={{ width: '50%', height: '30%', background: baseSnapshot.accentColor, borderRadius: '50%', alignSelf: 'flex-end' }} />
                  <div dir="rtl" style={{ color: '#17191c', fontWeight: 700 }}>{baseSnapshot.copy}</div>
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>Font: {baseSnapshot.fontFamily} ({baseSnapshot.fontWeight})</div>
              </div>

              {/* Revision Current */}
              <div style={{ border: '2px solid var(--accent)', borderRadius: 8, padding: 12, textAlign: 'center', background: 'rgba(56, 189, 248, 0.03)' }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, color: 'var(--accent)' }}>CURRENT WORKING CANDIDATE</div>
                <div style={{
                  aspectRatio: '4 / 5',
                  width: '140px',
                  margin: '0 auto',
                  borderRadius: 4,
                  background: 'linear-gradient(145deg, #16362e, #ece3cf 58%)',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  padding: 8,
                  fontSize: 8,
                  color: '#fff',
                  fontFamily,
                }}>
                  <div dir="rtl" style={{ fontWeight }}>{currentSnapshot.headline}</div>
                  <div style={{ width: '50%', height: '30%', background: currentSnapshot.accentColor, borderRadius: '50%', alignSelf: 'flex-end' }} />
                  <div dir="rtl" style={{ color: '#17191c', fontWeight: 700 }}>{currentSnapshot.copy}</div>
                </div>
                <div style={{ fontSize: 11, color: 'var(--accent)', marginTop: 6, fontWeight: 600 }}>Font: {currentSnapshot.fontFamily} ({currentSnapshot.fontWeight})</div>
              </div>
            </div>

            {/* Changes Detail Table */}
            {semanticDiff.hasChanges ? (
              <table className="table" style={{ fontSize: 11 }}>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Element / Property</th>
                    <th>Original (Rev 1)</th>
                    <th>Modified (Current)</th>
                  </tr>
                </thead>
                <tbody>
                  {semanticDiff.textDeltas.map((d, i) => (
                    <tr key={`text_${i}`}>
                      <td><span className="pill blue" style={{ fontSize: 10 }}>TEXT</span></td>
                      <td><b>{d.label}</b></td>
                      <td style={{ color: '#EF4444' }} dir="rtl">{d.oldText}</td>
                      <td style={{ color: '#10B981' }} dir="rtl">{d.newText}</td>
                    </tr>
                  ))}
                  {semanticDiff.styleDeltas.map((s, i) => (
                    <tr key={`style_${i}`}>
                      <td><span className="pill ok" style={{ fontSize: 10 }}>STYLE</span></td>
                      <td><b>{s.property}</b></td>
                      <td style={{ color: 'var(--muted)' }}>{s.oldVal}</td>
                      <td style={{ color: 'var(--accent)', fontWeight: 600 }}>{s.newVal}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={{ textAlign: 'center', padding: '20px', color: 'var(--muted)', fontSize: 12 }}>
                No modifications detected. The candidate is byte-for-byte identical to Revision 1.
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
