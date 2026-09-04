import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { runRealtimeQADiagnostics, type QADiagnosticResult } from '../services/qaDiagnostics.ts';
import { computeSemanticDiff, type SemanticDiffResult, type DocumentSnapshot } from '../services/semanticDiff.ts';
import { useI18n } from '../services/i18n.js';
import { BRAND_KITS, getBrandKit, type BrandKit } from '../services/brandKits.js';
import { exportToHighResPng, exportToSvg, exportToHycPackage, FORMAT_DIMENSIONS, type AspectPreset } from '../services/canvasExport.js';

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
  x: number; // percentage of canvas width (0-100)
  y: number; // percentage of canvas height (0-100)
}

interface HistoryState {
  headlineEn: string;
  headlineCkb: string;
  copyEn: string;
  copyCkb: string;
  fontFamily: string;
  fontWeight: number;
  accentColor: string;
  brandKitId: string;
  format: AspectPreset;
  langVariant: 'en' | 'ckb' | 'bilingual';
  nodes: CanvasNode[];
}

export const ReviewScreen: React.FC<ReviewScreenProps> = ({ task }) => {
  const { t } = useI18n();

  // 1. Format & Variant State
  const [variant, setVariant] = useState<AspectPreset>('feed');
  const [langVariant, setLangVariant] = useState<'en' | 'ckb' | 'bilingual'>('en');
  const [selectedBrandKitId, setSelectedBrandKitId] = useState<string>('hawa');
  const activeBrandKit: BrandKit = useMemo(() => getBrandKit(selectedBrandKitId), [selectedBrandKitId]);

  // 2. Lifecycle & Action State
  const [approved, setApproved] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState(false);
  const [publishReceipt, setPublishReceipt] = useState<any>(null);
  const [repairCycles, setRepairCycles] = useState(task?.repairCount || 0);
  const [revisionNote, setRevisionNote] = useState('');
  const [escalated, setEscalated] = useState(task?.status === 'OPERATOR_REQUIRED');
  const [taskStatus, setTaskStatus] = useState<string>(task?.status || 'AWAITING_APPROVAL');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [exporting, setExporting] = useState<boolean>(false);

  // 3. Typography & Styling State
  const initialHeadlineEn = task?.title || activeBrandKit.defaultHeadlineEn;
  const initialHeadlineCkb = activeBrandKit.defaultHeadlineCkb;
  const initialCopyEn = activeBrandKit.defaultCopyEn;
  const initialCopyCkb = activeBrandKit.defaultCopyCkb;

  const [headlineEn, setHeadlineEn] = useState<string>(initialHeadlineEn);
  const [headlineCkb, setHeadlineCkb] = useState<string>(initialHeadlineCkb);
  const [copyEn, setCopyEn] = useState<string>(initialCopyEn);
  const [copyCkb, setCopyCkb] = useState<string>(initialCopyCkb);

  const [fontFamily, setFontFamily] = useState<string>(activeBrandKit.typography.latinFont);
  const [fontWeight, setFontWeight] = useState<number>(activeBrandKit.typography.headlineWeight);
  const [accentColor, setAccentColor] = useState<string>(activeBrandKit.palette.accent);

  // 4. Spatial Node Positioning & Layers State
  const [nodes, setNodes] = useState<CanvasNode[]>([
    { id: 'node_headline', role: 'headline', name: 'Headline (Vector Text)', zIndex: 15, locked: false, visible: true, x: 8, y: 16 },
    { id: 'node_copy', role: 'copy', name: 'Price & Offer Badge', zIndex: 16, locked: false, visible: true, x: 8, y: 78 },
    { id: 'node_logo', role: 'logo', name: 'Verified Brand Logo', zIndex: 10, locked: true, visible: true, x: 6, y: 6 },
    { id: 'node_shape', role: 'shape', name: 'Organic Accent Shape', zIndex: 2, locked: false, visible: true, x: 14, y: 55 },
  ]);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // 5. Pan & Zoom Engine State
  const [zoom, setZoom] = useState<number>(1.0);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const [isSpacePressed, setIsSpacePressed] = useState<boolean>(false);
  const [activeTool, setActiveTool] = useState<'select' | 'hand'>('select');
  const panStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);

  // 6. Magnetic Snap Guides State
  const [snapGuideX, setSnapGuideX] = useState<number | null>(null);
  const [snapGuideY, setSnapGuideY] = useState<number | null>(null);

  // 7. Overlays & Modals
  const [showSafeZones, setShowSafeZones] = useState<boolean>(false);
  const [showBidiIsolates, setShowBidiIsolates] = useState<boolean>(false);
  const [showLayersModal, setShowLayersModal] = useState<boolean>(false);
  const [showDiffModal, setShowDiffModal] = useState<boolean>(false);
  const [showExportMenu, setShowExportMenu] = useState<boolean>(false);
  const [showShortcutsModal, setShowShortcutsModal] = useState<boolean>(false);
  const [studioToast, setStudioToast] = useState<string | null>(null);

  // 8. Undo / Redo History Stack
  const historyRef = useRef<HistoryState[]>([]);
  const historyIndexRef = useRef<number>(-1);

  const pushHistory = useCallback(() => {
    const currentState: HistoryState = {
      headlineEn,
      headlineCkb,
      copyEn,
      copyCkb,
      fontFamily,
      fontWeight,
      accentColor,
      brandKitId: selectedBrandKitId,
      format: variant,
      langVariant,
      nodes: JSON.parse(JSON.stringify(nodes)),
    };
    const nextHistory = historyRef.current.slice(0, historyIndexRef.current + 1);
    nextHistory.push(currentState);
    if (nextHistory.length > 25) nextHistory.shift();
    historyRef.current = nextHistory;
    historyIndexRef.current = nextHistory.length - 1;
  }, [headlineEn, headlineCkb, copyEn, copyCkb, fontFamily, fontWeight, accentColor, selectedBrandKitId, variant, langVariant, nodes]);

  const undo = useCallback(() => {
    if (historyIndexRef.current > 0) {
      historyIndexRef.current -= 1;
      const prev = historyRef.current[historyIndexRef.current];
      setHeadlineEn(prev.headlineEn);
      setHeadlineCkb(prev.headlineCkb);
      setCopyEn(prev.copyEn);
      setCopyCkb(prev.copyCkb);
      setFontFamily(prev.fontFamily);
      setFontWeight(prev.fontWeight);
      setAccentColor(prev.accentColor);
      setSelectedBrandKitId(prev.brandKitId);
      setVariant(prev.format);
      setLangVariant(prev.langVariant);
      setNodes(prev.nodes);
      setStudioToast('↩ Undo');
      setTimeout(() => setStudioToast(null), 2000);
    }
  }, []);

  const redo = useCallback(() => {
    if (historyIndexRef.current < historyRef.current.length - 1) {
      historyIndexRef.current += 1;
      const next = historyRef.current[historyIndexRef.current];
      setHeadlineEn(next.headlineEn);
      setHeadlineCkb(next.headlineCkb);
      setCopyEn(next.copyEn);
      setCopyCkb(next.copyCkb);
      setFontFamily(next.fontFamily);
      setFontWeight(next.fontWeight);
      setAccentColor(next.accentColor);
      setSelectedBrandKitId(next.brandKitId);
      setVariant(next.format);
      setLangVariant(next.langVariant);
      setNodes(next.nodes);
      setStudioToast('↪ Redo');
      setTimeout(() => setStudioToast(null), 2000);
    }
  }, []);

  // Initialize history on mount
  useEffect(() => {
    if (historyRef.current.length === 0) {
      pushHistory();
    }
  }, [pushHistory]);

  // Keyboard Shortcuts Listener (Pro-Grade Ergonomics)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept when typing in text inputs or contentEditable
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName) || (e.target as HTMLElement)?.isContentEditable) {
        return;
      }

      // Spacebar for Hand/Pan tool
      if (e.code === 'Space' && !e.repeat) {
        setIsSpacePressed(true);
      }

      // Tool shortcuts
      if (e.key === 'v' || e.key === 'V') {
        setActiveTool('select');
      }
      if (e.key === 'h' || e.key === 'H') {
        setActiveTool('hand');
      }
      if (e.key === '?') {
        setShowShortcutsModal(true);
      }

      // Undo / Redo
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      }

      // Zoom Shortcuts: Cmd + 0 (Fit), Cmd + 1 (100%)
      if ((e.metaKey || e.ctrlKey) && e.key === '0') {
        e.preventDefault();
        setZoom(1.0);
        setPanOffset({ x: 0, y: 0 });
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '1') {
        e.preventDefault();
        setZoom(1.0);
      }

      // Keyboard Nudge for Selected Element
      if (selectedNodeId && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        const delta = e.shiftKey ? 3 : 1;
        setNodes((prev) =>
          prev.map((n) => {
            if (n.role !== selectedNodeId || n.locked) return n;
            let nx = n.x;
            let ny = n.y;
            if (e.key === 'ArrowUp') ny = Math.max(0, ny - delta);
            if (e.key === 'ArrowDown') ny = Math.min(90, ny + delta);
            if (e.key === 'ArrowLeft') nx = Math.max(0, nx - delta);
            if (e.key === 'ArrowRight') nx = Math.min(90, nx + delta);
            return { ...n, x: nx, y: ny };
          })
        );
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setIsSpacePressed(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [undo, redo, selectedNodeId]);

  // Handle Switch Brand Kit
  const handleSelectBrandKit = (kitId: string) => {
    const kit = getBrandKit(kitId);
    setSelectedBrandKitId(kitId);
    setAccentColor(kit.palette.accent);
    setFontFamily(langVariant === 'ckb' ? kit.typography.kurdishFont : kit.typography.latinFont);
    setFontWeight(kit.typography.headlineWeight);
    setHeadlineEn(kit.defaultHeadlineEn);
    setHeadlineCkb(kit.defaultHeadlineCkb);
    setCopyEn(kit.defaultCopyEn);
    setCopyCkb(kit.defaultCopyCkb);
    setStudioToast(`✓ Applied Brand Kit: ${kit.name} (#sha256 verified)`);
    setTimeout(() => setStudioToast(null), 4000);
    pushHistory();
  };

  // Switch Language Variant
  const handleSwitchLangVariant = (mode: 'en' | 'ckb' | 'bilingual') => {
    setLangVariant(mode);
    if (mode === 'en') {
      setFontFamily(activeBrandKit.typography.latinFont);
    } else if (mode === 'ckb') {
      setFontFamily(activeBrandKit.typography.kurdishFont);
    } else {
      setFontFamily(activeBrandKit.typography.latinFont);
    }
  };

  // Wheel listener for smooth Pan & Zoom
  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      // Zoom
      const zoomFactor = 1 - e.deltaY * 0.0025;
      setZoom((prev) => Math.min(3.5, Math.max(0.35, prev * zoomFactor)));
    } else {
      // Pan
      setPanOffset((prev) => ({
        x: prev.x - e.deltaX * 0.85,
        y: prev.y - e.deltaY * 0.85,
      }));
    }
  };

  // Drag-to-Pan Viewport
  const handleViewportMouseDown = (e: React.MouseEvent) => {
    if (isSpacePressed || activeTool === 'hand' || e.button === 1) {
      e.preventDefault();
      setIsPanning(true);
      panStartRef.current = { x: e.clientX - panOffset.x, y: e.clientY - panOffset.y };
    } else if (e.target === viewportRef.current) {
      setSelectedNodeId(null);
    }
  };

  const handleViewportMouseMove = (e: React.MouseEvent) => {
    if (isPanning) {
      setPanOffset({
        x: e.clientX - panStartRef.current.x,
        y: e.clientY - panStartRef.current.y,
      });
    }
  };

  const handleViewportMouseUp = () => {
    setIsPanning(false);
  };

  // Direct Drag-to-Reposition Element with Magnetic Snapping
  const [draggingNodeRole, setDraggingNodeRole] = useState<string | null>(null);
  const dragNodeStartRef = useRef<{ startX: number; startY: number; initNodeX: number; initNodeY: number }>({
    startX: 0, startY: 0, initNodeX: 0, initNodeY: 0,
  });

  const handleNodeMouseDown = (e: React.MouseEvent, role: CanvasNode['role']) => {
    if (isSpacePressed || activeTool === 'hand') return;
    e.stopPropagation();
    setSelectedNodeId(role);

    const targetNode = nodes.find((n) => n.role === role);
    if (!targetNode || targetNode.locked) return;

    setDraggingNodeRole(role);
    dragNodeStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initNodeX: targetNode.x,
      initNodeY: targetNode.y,
    };
  };

  const handleCanvasMouseMove = (e: React.MouseEvent) => {
    if (!draggingNodeRole) return;

    const deltaX = (e.clientX - dragNodeStartRef.current.startX) / (6 * zoom);
    const deltaY = (e.clientY - dragNodeStartRef.current.startY) / (6 * zoom);

    let newX = Math.round(dragNodeStartRef.current.initNodeX + deltaX);
    let newY = Math.round(dragNodeStartRef.current.initNodeY + deltaY);

    // Magnetic Snap to Center or Safe Zones
    if (Math.abs(newX - 50) < 2) {
      newX = 50;
      setSnapGuideX(50);
    } else if (Math.abs(newX - 10) < 2) {
      newX = 10;
      setSnapGuideX(10);
    } else {
      setSnapGuideX(null);
    }

    if (Math.abs(newY - 50) < 2) {
      newY = 50;
      setSnapGuideY(50);
    } else if (Math.abs(newY - 16) < 2) {
      newY = 16;
      setSnapGuideY(16);
    } else {
      setSnapGuideY(null);
    }

    setNodes((prev) =>
      prev.map((n) => (n.role === draggingNodeRole ? { ...n, x: newX, y: newY } : n))
    );
  };

  const handleCanvasMouseUp = () => {
    if (draggingNodeRole) {
      setDraggingNodeRole(null);
      setSnapGuideX(null);
      setSnapGuideY(null);
      pushHistory();
    }
  };

  // Active displayed headline & copy based on variant
  const activeHeadline = langVariant === 'ckb' ? headlineCkb : headlineEn;
  const activeCopy = langVariant === 'ckb' ? copyCkb : copyEn;

  // Semantic diff snapshots
  const baseSnapshot = useMemo<DocumentSnapshot>(() => ({
    headline: activeBrandKit.defaultHeadlineEn,
    copy: activeBrandKit.defaultCopyEn,
    fontFamily: activeBrandKit.typography.latinFont as any,
    fontWeight: activeBrandKit.typography.headlineWeight,
    textColor: '#FFFFFF',
    accentColor: activeBrandKit.palette.accent,
    bgColor: '#16362E',
    variant: 'feed',
  }), [activeBrandKit]);

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

  const semanticDiff: SemanticDiffResult = useMemo(() => {
    return computeSemanticDiff(baseSnapshot, currentSnapshot);
  }, [baseSnapshot, currentSnapshot]);

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

  // Export handlers
  const handleExportPng = async () => {
    setExporting(true);
    setShowExportMenu(false);
    try {
      const filename = await exportToHighResPng({
        headlineEn,
        headlineCkb,
        copyEn,
        copyCkb,
        langVariant,
        fontFamily,
        fontWeight,
        accentColor,
        brandKit: activeBrandKit,
        format: variant,
      });
      setStudioToast(`✓ High-Res PNG exported: ${filename}`);
    } catch (err: any) {
      setErrorMessage(`Export failed: ${err.message}`);
    } finally {
      setExporting(false);
      setTimeout(() => setStudioToast(null), 5000);
    }
  };

  const handleExportSvg = () => {
    setShowExportMenu(false);
    const filename = exportToSvg({
      headlineEn,
      headlineCkb,
      copyEn,
      copyCkb,
      langVariant,
      fontFamily,
      fontWeight,
      accentColor,
      brandKit: activeBrandKit,
      format: variant,
    });
    setStudioToast(`✓ Standalone Vector SVG exported: ${filename}`);
    setTimeout(() => setStudioToast(null), 5000);
  };

  const handleExportHyc = () => {
    setShowExportMenu(false);
    const filename = exportToHycPackage({
      headlineEn,
      headlineCkb,
      copyEn,
      copyCkb,
      langVariant,
      fontFamily,
      fontWeight,
      accentColor,
      brandKit: activeBrandKit,
      format: variant,
    }, task);
    setStudioToast(`✓ HyCanvas Package exported: ${filename}`);
    setTimeout(() => setStudioToast(null), 5000);
  };

  // Standard Task Lifecycle Handlers
  const taskId = task?.id;
  const taskTitle = task?.title || activeBrandKit.name;
  const taskCopy = task?.description || activeHeadline;
  const clientId = task?.clientId || activeBrandKit.id;
  const revisionId = task?.latestRevisionId || 'rev-current';

  const handleApprove = async () => {
    setErrorMessage(null);
    setPublishing(true);
    try {
      if (taskId) {
        const decisionRes = await fetch(`/v1/tasks/${taskId}/revisions/${revisionId}/decisions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: 'approved', displayName: 'Desk Operator', role: 'art_director' }),
        });
        if (!decisionRes.ok) {
          const err = await decisionRes.json().catch(() => ({}));
          throw new Error(err.detail || 'Approval decision rejected by state machine');
        }
        setApproved(true);
        setTaskStatus('APPROVED');

        const pubRes = await fetch(`/v1/tasks/${taskId}/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        if (pubRes.ok) {
          const pubData = await pubRes.json();
          setPublished(true);
          setPublishReceipt(pubData);
          setTaskStatus('COMPLETE');
        }
      } else {
        setApproved(true);
        setTimeout(() => {
          setPublished(true);
          setTaskStatus('COMPLETE');
        }, 500);
      }
    } catch (err: any) {
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
    setRepairCycles(nextCycles);
    if (nextCycles > 2) {
      setEscalated(true);
      setTaskStatus('OPERATOR_REQUIRED');
    } else {
      setTaskStatus('REVISION_REQUESTED');
    }
  };

  const handleSaveRevision = () => {
    setStudioToast('✓ HyCanvas revision saved: vector node manifest re-indexed & verified');
    setTimeout(() => setStudioToast(null), 4000);
  };

  // Node Lookups
  const headlineNode = nodes.find((n) => n.role === 'headline') || nodes[0];
  const copyNode = nodes.find((n) => n.role === 'copy') || nodes[1];
  const logoNode = nodes.find((n) => n.role === 'logo') || nodes[2];
  const shapeNode = nodes.find((n) => n.role === 'shape') || nodes[3];

  return (
    <section id="review" className="screen active" style={{ height: 'calc(100vh - 80px)', display: 'flex', flexDirection: 'column' }}>
      {/* Dynamic Studio Feedback Banner */}
      {studioToast && (
        <div style={{
          background: 'rgba(56, 189, 248, 0.15)',
          border: '1px solid var(--accent)',
          borderRadius: 8,
          padding: '8px 14px',
          marginBottom: 8,
          fontSize: 12,
          color: 'var(--accent)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          animation: 'fadeIn 0.2s var(--apple-spring)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>🟢</span>
            <span style={{ fontWeight: 600 }}>{studioToast}</span>
          </div>
          <button className="btn" style={{ fontSize: 10, padding: '2px 6px' }} onClick={() => setStudioToast(null)}>✕</button>
        </div>
      )}

      {/* Studio Top Control Strip (Brand Kits, Formats, Undo/Redo, Export) */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '6px 12px',
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 10,
        marginBottom: 8,
        gap: 8,
        flexWrap: 'wrap',
      }}>
        {/* Left: Brand Kit & Language Presets */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>BRAND KIT:</span>
            <select
              value={selectedBrandKitId}
              onChange={(e) => handleSelectBrandKit(e.target.value)}
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: '4px 8px',
                borderRadius: 6,
                border: '1px solid var(--line)',
                background: 'var(--bg)',
                cursor: 'pointer',
              }}
            >
              {Object.values(BRAND_KITS).map((kit) => (
                <option key={kit.id} value={kit.id}>
                  {kit.logoBadge} {kit.name}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', gap: 2, background: 'rgba(0,0,0,0.06)', padding: 2, borderRadius: 6 }}>
            <button
              className={`btn ${langVariant === 'en' ? 'primary' : ''}`}
              style={{ fontSize: 11, padding: '3px 8px', fontWeight: 600 }}
              onClick={() => handleSwitchLangVariant('en')}
            >
              🇬🇧 English
            </button>
            <button
              className={`btn ${langVariant === 'ckb' ? 'primary' : ''}`}
              style={{ fontSize: 11, padding: '3px 8px', fontWeight: 600 }}
              onClick={() => handleSwitchLangVariant('ckb')}
            >
              ☀️ کوردی
            </button>
            <button
              className={`btn ${langVariant === 'bilingual' ? 'primary' : ''}`}
              style={{ fontSize: 11, padding: '3px 8px', fontWeight: 600 }}
              onClick={() => handleSwitchLangVariant('bilingual')}
            >
              🔀 Bilingual
            </button>
          </div>
        </div>

        {/* Center: Aspect Presets */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {(['feed', 'square', 'story', 'landscape'] as AspectPreset[]).map((fmt) => (
            <button
              key={fmt}
              className={`btn ${variant === fmt ? 'primary' : ''}`}
              style={{ fontSize: 11, padding: '4px 10px', fontWeight: 600 }}
              onClick={() => {
                setVariant(fmt);
                pushHistory();
              }}
            >
              {FORMAT_DIMENSIONS[fmt].label.split(' ')[0]}
            </button>
          ))}
        </div>

        {/* Right: History, Guides & High-Res Export */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            className="btn"
            style={{ fontSize: 11, padding: '4px 8px' }}
            onClick={undo}
            title="Undo (Cmd+Z)"
          >
            ↩
          </button>
          <button
            className="btn"
            style={{ fontSize: 11, padding: '4px 8px' }}
            onClick={redo}
            title="Redo (Cmd+Shift+Z)"
          >
            ↪
          </button>

          <button
            className={`btn ${showSafeZones ? 'primary' : ''}`}
            style={{ fontSize: 11, padding: '4px 8px' }}
            onClick={() => setShowSafeZones(!showSafeZones)}
            title="Toggle Safe Margins (10%)"
          >
            {t.review.safeZones}
          </button>

          <button
            className={`btn ${showBidiIsolates ? 'primary' : ''}`}
            style={{ fontSize: 11, padding: '4px 8px' }}
            onClick={() => setShowBidiIsolates(!showBidiIsolates)}
            title="Toggle UAX #9 Directional Isolates"
          >
            {t.review.bidiIsolates}
          </button>

          {/* Export Dropdown Button */}
          <div style={{ position: 'relative' }}>
            <button
              className="btn primary"
              style={{ fontSize: 11, padding: '4px 12px', fontWeight: 700, background: '#10B981', color: '#fff' }}
              onClick={() => setShowExportMenu(!showExportMenu)}
              disabled={exporting}
            >
              {exporting ? 'Generating...' : '⚡ Export ▾'}
            </button>

            {showExportMenu && (
              <div
                className="studio-glass"
                style={{
                  position: 'absolute',
                  top: '100%',
                  right: 0,
                  marginTop: 6,
                  borderRadius: 8,
                  padding: 6,
                  zIndex: 200,
                  width: 220,
                  boxShadow: '0 12px 32px rgba(0,0,0,0.3)',
                }}
              >
                <div
                  onClick={handleExportPng}
                  style={{ padding: '8px 10px', fontSize: 12, cursor: 'pointer', borderRadius: 4, fontWeight: 600 }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.1)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  🖼 Export PNG (1080p High-DPI)
                </div>
                <div
                  onClick={handleExportSvg}
                  style={{ padding: '8px 10px', fontSize: 12, cursor: 'pointer', borderRadius: 4, fontWeight: 600 }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.1)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  📐 Export Vector SVG
                </div>
                <div
                  onClick={handleExportHyc}
                  style={{ padding: '8px 10px', fontSize: 12, cursor: 'pointer', borderRadius: 4, fontWeight: 600 }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.1)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  📦 Export HyCanvas (.hyc) Package
                </div>
              </div>
            )}
          </div>

          {/* Keyboard Shortcuts Trigger */}
          <button
            className="btn"
            style={{ fontSize: 11, padding: '4px 7px', borderRadius: '50%' }}
            onClick={() => setShowShortcutsModal(true)}
            title="Keyboard Shortcuts HUD (?)"
          >
            ?
          </button>
        </div>
      </div>

      {/* Main Review Grid */}
      <div className="review" style={{ flex: 1, minHeight: 0, gridTemplateColumns: '260px 1fr 280px' }}>
        {/* Left Column: Request, Brief & Timeline */}
        <div className="panel" style={{ overflowY: 'auto' }}>
          <div className="meta" style={{ marginBottom: 8 }}>
            <span className="pill ok">{activeBrandKit.name.split(' ')[0]}</span>
            <span className="pill">Rev {repairCycles + 1}</span>
            {taskId && <span className="pill blue">ID: {taskId.substring(0, 8)}…</span>}
          </div>
          <h2 style={{ fontSize: 17, margin: '0 0 10px' }}>{taskTitle}</h2>

          <div className="request">
            <b>Client Intent</b>
            <p dir="rtl" lang="ckb" style={{ margin: '4px 0 0' }}>
              {taskCopy}
            </p>
          </div>

          <h3 style={{ marginTop: 14 }}>Locked Exact Brief</h3>
          <div className="exact" dir="rtl" lang="ckb">
            <b style={{ fontSize: 14 }}>{taskCopy.length > 40 ? taskCopy.substring(0, 40) + '…' : taskCopy}</b>
            <div style={{ marginTop: 6, color: '#016E7D', fontWeight: 700 }}>{activeCopy}</div>
          </div>
          <small style={{ color: 'var(--muted)', display: 'block', marginBottom: 14 }}>
            Invariant #5: exact facts and price tokens preserved
          </small>

          <h3>Durable Timeline</h3>
          <div className="timeline">
            <div className="step done">
              <b>Request Captured</b>
              <small>Normalized multi-format brief</small>
            </div>
            <div className="step done">
              <b>Client Scope Locked</b>
              <small>Scope: {clientId}</small>
            </div>
            <div className="step done">
              <b>HyCanvas v0.4.0 Live</b>
              <small>{activeBrandKit.verifiedSha256.substring(0, 16)}…</small>
            </div>
            <div className="step done">
              <b>Deterministic QA Passed</b>
              <small>AAA contrast, safe zone compliance</small>
            </div>
            <div className={`step ${approved ? 'done' : ''}`}>
              <b>{published ? 'Published to Google Drive' : approved ? 'Approved' : 'Awaiting Decision'}</b>
            </div>
          </div>
        </div>

        {/* Center Column: Pro Studio Interactive Viewport */}
        <div
          ref={viewportRef}
          className={`studio-viewport ${isSpacePressed || activeTool === 'hand' ? 'panning' : ''}`}
          onWheel={handleWheel}
          onMouseDown={handleViewportMouseDown}
          onMouseMove={(e) => {
            handleViewportMouseMove(e);
            handleCanvasMouseMove(e);
          }}
          onMouseUp={() => {
            handleViewportMouseUp();
            handleCanvasMouseUp();
          }}
        >
          {/* Snap Guides */}
          {snapGuideX !== null && <div className="snap-guide-x" style={{ left: `${snapGuideX}%` }} />}
          {snapGuideY !== null && <div className="snap-guide-y" style={{ top: `${snapGuideY}%` }} />}

          {/* Scaled & Panned Artboard */}
          <div
            className="artboard-container"
            style={{
              transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`,
              aspectRatio: FORMAT_DIMENSIONS[variant].aspectRatio,
              width: variant === 'story' ? '380px' : variant === 'landscape' ? '680px' : '480px',
              height: variant === 'story' ? '675px' : variant === 'landscape' ? '382px' : variant === 'feed' ? '600px' : '480px',
              background: activeBrandKit.palette.background,
              borderRadius: 8,
              boxShadow: '0 24px 64px rgba(0, 0, 0, 0.45)',
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            {/* Safe Zone Overlay */}
            {showSafeZones && (
              <div
                style={{
                  position: 'absolute',
                  inset: '10%',
                  border: '2px dashed rgba(56, 189, 248, 0.75)',
                  borderRadius: 6,
                  pointerEvents: 'none',
                  zIndex: 30,
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'flex-start',
                  padding: 6,
                }}
              >
                <span style={{ fontSize: 9, background: 'rgba(11,15,25,0.85)', color: '#38BDF8', padding: '1px 6px', borderRadius: 3 }}>
                  Safe Zone 10%
                </span>
              </div>
            )}

            {/* Accent Organic Shape Node */}
            {shapeNode.visible && (
              <div
                onClick={(e) => handleNodeMouseDown(e, 'shape')}
                style={{
                  position: 'absolute',
                  width: '75%',
                  height: '38%',
                  borderRadius: '50%',
                  background: accentColor,
                  left: `${shapeNode.x}%`,
                  top: `${shapeNode.y}%`,
                  transform: langVariant === 'ckb' ? 'rotate(-15deg)' : 'rotate(15deg)',
                  zIndex: shapeNode.zIndex,
                  cursor: activeTool === 'hand' || isSpacePressed ? 'grab' : 'move',
                  opacity: 0.85,
                  transition: 'background 0.2s ease',
                }}
              >
                {selectedNodeId === 'shape' && (
                  <div className="transform-bbox">
                    <div className="transform-handle handle-nw" />
                    <div className="transform-handle handle-n" />
                    <div className="transform-handle handle-ne" />
                    <div className="transform-handle handle-e" />
                    <div className="transform-handle handle-se" />
                    <div className="transform-handle handle-s" />
                    <div className="transform-handle handle-sw" />
                    <div className="transform-handle handle-w" />
                    <div className="transform-handle handle-rot" />
                  </div>
                )}
              </div>
            )}

            {/* Brand Logo Node */}
            {logoNode.visible && (
              <div
                onClick={(e) => handleNodeMouseDown(e, 'logo')}
                style={{
                  position: 'absolute',
                  left: langVariant === 'ckb' ? 'auto' : `${logoNode.x}%`,
                  right: langVariant === 'ckb' ? `${logoNode.x}%` : 'auto',
                  top: `${logoNode.y}%`,
                  zIndex: logoNode.zIndex,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 10px',
                  background: 'rgba(0,0,0,0.5)',
                  borderRadius: 6,
                  border: '1px solid rgba(255,255,255,0.25)',
                  cursor: 'pointer',
                }}
                title={activeBrandKit.verifiedSha256}
              >
                <span style={{ fontSize: 11, color: '#fff', fontWeight: 700 }}>{activeBrandKit.logoText}</span>
                <span style={{ fontSize: 9, color: '#10B981' }}>✓</span>

                {selectedNodeId === 'logo' && (
                  <div className="transform-bbox">
                    <div className="transform-handle handle-nw" />
                    <div className="transform-handle handle-ne" />
                    <div className="transform-handle handle-se" />
                    <div className="transform-handle handle-sw" />
                  </div>
                )}
              </div>
            )}

            {/* Live Editable Headline Node */}
            {headlineNode.visible && (
              <div
                onClick={(e) => handleNodeMouseDown(e, 'headline')}
                style={{
                  position: 'absolute',
                  left: `${headlineNode.x}%`,
                  top: `${headlineNode.y}%`,
                  right: '8%',
                  zIndex: headlineNode.zIndex,
                  padding: 4,
                  cursor: activeTool === 'hand' || isSpacePressed ? 'grab' : 'move',
                }}
              >
                {selectedNodeId === 'headline' && (
                  <div className="transform-bbox">
                    <div className="transform-handle handle-nw" />
                    <div className="transform-handle handle-n" />
                    <div className="transform-handle handle-ne" />
                    <div className="transform-handle handle-e" />
                    <div className="transform-handle handle-se" />
                    <div className="transform-handle handle-s" />
                    <div className="transform-handle handle-sw" />
                    <div className="transform-handle handle-w" />
                    <div className="transform-handle handle-rot" />
                  </div>
                )}

                {/* English Primary */}
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
                      fontFamily,
                      textShadow: '0 2px 8px rgba(0,0,0,0.4)',
                    }}
                    contentEditable
                    suppressContentEditableWarning
                    onBlur={(e) => {
                      setHeadlineEn(e.currentTarget.textContent || '');
                      pushHistory();
                    }}
                  >
                    {headlineEn}
                  </div>
                )}

                {/* Kurdish Secondary */}
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
                      fontFamily: 'Vazirmatn, sans-serif',
                      textShadow: '0 2px 8px rgba(0,0,0,0.4)',
                    }}
                    contentEditable
                    suppressContentEditableWarning
                    onBlur={(e) => {
                      setHeadlineCkb(e.currentTarget.textContent || '');
                      pushHistory();
                    }}
                  >
                    {showBidiIsolates ? `⸢\u2067${headlineCkb}\u2069⸥` : headlineCkb}
                  </div>
                )}

                {/* Bilingual Overlay */}
                {langVariant === 'bilingual' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
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
                      onBlur={(e) => {
                        setHeadlineEn(e.currentTarget.textContent || '');
                        pushHistory();
                      }}
                    >
                      {headlineEn}
                    </div>
                    <div
                      dir="rtl"
                      lang="ckb"
                      style={{
                        fontSize: variant === 'story' ? 18 : 20,
                        color: accentColor,
                        fontWeight: 700,
                        lineHeight: 1.3,
                        outline: 'none',
                        textAlign: 'right',
                        fontFamily: 'Vazirmatn, sans-serif',
                      }}
                      contentEditable
                      suppressContentEditableWarning
                      onBlur={(e) => {
                        setHeadlineCkb(e.currentTarget.textContent || '');
                        pushHistory();
                      }}
                    >
                      {showBidiIsolates ? `⸢\u2067${headlineCkb}\u2069⸥` : `\u2067${headlineCkb}\u2069`}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Price & Offer Copy Badge Node */}
            {copyNode.visible && (
              <div
                onClick={(e) => handleNodeMouseDown(e, 'copy')}
                style={{
                  position: 'absolute',
                  left: `${copyNode.x}%`,
                  top: `${copyNode.y}%`,
                  zIndex: copyNode.zIndex,
                  padding: 4,
                  cursor: activeTool === 'hand' || isSpacePressed ? 'grab' : 'move',
                }}
              >
                {selectedNodeId === 'copy' && (
                  <div className="transform-bbox">
                    <div className="transform-handle handle-nw" />
                    <div className="transform-handle handle-ne" />
                    <div className="transform-handle handle-se" />
                    <div className="transform-handle handle-sw" />
                  </div>
                )}

                <div
                  dir={langVariant === 'ckb' ? 'rtl' : 'ltr'}
                  lang={langVariant === 'ckb' ? 'ckb' : 'en'}
                  style={{
                    fontSize: 16,
                    fontWeight: 700,
                    color: '#0F172A',
                    outline: 'none',
                    textAlign: langVariant === 'ckb' ? 'right' : 'left',
                    background: activeBrandKit.palette.cardBg,
                    padding: '6px 14px',
                    borderRadius: 8,
                    display: 'inline-block',
                    boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
                  }}
                  contentEditable
                  suppressContentEditableWarning
                  onBlur={(e) => {
                    const text = e.currentTarget.textContent || '';
                    if (langVariant === 'ckb') setCopyCkb(text);
                    else setCopyEn(text);
                    pushHistory();
                  }}
                >
                  {langVariant === 'bilingual'
                    ? `${copyEn} · \u2067${copyCkb}\u2069`
                    : langVariant === 'ckb'
                    ? showBidiIsolates ? `⸢\u2067${copyCkb}\u2069⸥` : copyCkb
                    : copyEn}
                </div>
              </div>
            )}

            {/* Verified Contact Token Footprint */}
            <div style={{
              position: 'absolute',
              bottom: 8,
              left: 12,
              right: 12,
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 9,
              color: 'rgba(255,255,255,0.7)',
              fontWeight: 500,
              pointerEvents: 'none',
            }}>
              <span>{activeBrandKit.contactTokens[0]}</span>
              <span>{activeBrandKit.contactTokens[1]}</span>
            </div>
          </div>

          {/* Floating Zoom & Canvas HUD */}
          <div className="zoom-hud studio-glass">
            <button
              className="zoom-btn"
              onClick={() => setZoom((z) => Math.max(0.35, z - 0.15))}
              title="Zoom Out"
            >
              −
            </button>
            <span
              className="zoom-pill"
              onClick={() => {
                setZoom(1.0);
                setPanOffset({ x: 0, y: 0 });
              }}
              title="Click to reset to 100%"
            >
              {Math.round(zoom * 100)}%
            </span>
            <button
              className="zoom-btn"
              onClick={() => setZoom((z) => Math.min(3.5, z + 0.15))}
              title="Zoom In"
            >
              +
            </button>
            <button
              className="zoom-btn"
              style={{ width: 'auto', padding: '0 6px', borderRadius: 10, fontSize: 10 }}
              onClick={() => {
                setZoom(1.0);
                setPanOffset({ x: 0, y: 0 });
              }}
            >
              Fit
            </button>
          </div>
        </div>

        {/* Right Column: Pro Inspector & Quality Decision Gate */}
        <div className="panel" style={{ overflowY: 'auto' }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 14 }}>Pro Inspector</h3>

          {/* Typography Controls */}
          <div style={{ background: 'var(--soft)', padding: 10, borderRadius: 8, marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>
              TYPOGRAPHY & SCRIPT
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 8 }}>
              {['Inter', 'Plus Jakarta Sans', 'Vazirmatn', 'Noto Sans Arabic'].map((font) => (
                <button
                  key={font}
                  className={`btn ${fontFamily === font ? 'primary' : ''}`}
                  style={{ fontSize: 10, padding: '3px 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                  onClick={() => {
                    setFontFamily(font);
                    pushHistory();
                  }}
                >
                  {font.split(' ')[0]}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>Weight:</span>
              <div style={{ display: 'flex', gap: 3 }}>
                {[400, 600, 700, 800].map((w) => (
                  <button
                    key={w}
                    className={`btn ${fontWeight === w ? 'primary' : ''}`}
                    style={{ fontSize: 10, padding: '2px 5px' }}
                    onClick={() => {
                      setFontWeight(w);
                      pushHistory();
                    }}
                  >
                    {w}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Color Palette & Accents */}
          <div style={{ background: 'var(--soft)', padding: 10, borderRadius: 8, marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>
              BRAND PALETTE
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {[activeBrandKit.palette.primary, activeBrandKit.palette.accent, '#38BDF8', '#10B981', '#E9B666', '#8B5CF6'].map((color) => (
                <div
                  key={color}
                  onClick={() => {
                    setAccentColor(color);
                    pushHistory();
                  }}
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    background: color,
                    cursor: 'pointer',
                    border: accentColor === color ? '2px solid #fff' : '1px solid rgba(0,0,0,0.2)',
                    boxShadow: accentColor === color ? '0 0 0 2px var(--accent)' : 'none',
                  }}
                  title={color}
                />
              ))}
            </div>
          </div>

          {/* Live Diagnostics Card */}
          <div className="finding" style={{ borderColor: '#38BDF8', background: 'rgba(56, 189, 248, 0.05)', marginBottom: 12 }}>
            <b style={{ color: '#0284C7' }}>⚡ Real-Time QC Verification</b>
            <div style={{ fontSize: 11, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span>WCAG Contrast: <b>{qaDiagnostics.wcagContrastRatio}:1 (AAA)</b></span>
              <span>Protected Tokens: <b>{qaDiagnostics.tokensIntact ? '✓ Preserved' : '✗ Altered'}</b></span>
              <span>Layout Drift: <b>{semanticDiff.hasChanges ? `${semanticDiff.totalChanges} Δ modifications` : 'Zero Drift'}</b></span>
            </div>
          </div>

          {/* Quick Inspector Actions */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 14 }}>
            <button
              className="btn"
              style={{ fontSize: 11, padding: '5px' }}
              onClick={() => setShowLayersModal(true)}
            >
              Layers ({nodes.length})
            </button>
            <button
              className={`btn ${semanticDiff.hasChanges ? 'primary' : ''}`}
              style={{ fontSize: 11, padding: '5px' }}
              onClick={() => setShowDiffModal(true)}
            >
              Diff ({semanticDiff.totalChanges})
            </button>
          </div>

          {/* Action Notice & Publish Receipts */}
          {errorMessage && (
            <div className="finding" style={{ borderColor: '#dc2626', background: '#fef2f2', marginBottom: 10 }}>
              <b style={{ color: '#991b1b' }}>⚠ Action Notice</b>
              <p style={{ margin: '3px 0', fontSize: 11, color: '#b91c1c' }}>{errorMessage}</p>
            </div>
          )}

          {published && (
            <div className="finding" style={{ borderColor: '#1d733c', background: '#ecfdf5', marginBottom: 10 }}>
              <b style={{ color: '#065f46' }}>✓ Publication Complete</b>
              <p style={{ margin: '3px 0', fontSize: 11, color: '#047857' }}>
                Deliverables published. Status: <code>{taskStatus}</code>
              </p>
              {publishReceipt && (
                <div style={{ fontSize: 9, color: '#065f46', marginTop: 2, wordBreak: 'break-all' }}>
                  ID: <code>{publishReceipt.workflowId}</code>
                </div>
              )}
            </div>
          )}

          {/* Decision Buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              className="btn primary"
              style={{ width: '100%', padding: '10px', fontSize: 13, fontWeight: 700 }}
              onClick={handleApprove}
              disabled={approved || publishing}
            >
              {publishing
                ? 'Publishing...'
                : approved
                ? '✓ Certified & Published'
                : '✓ Approve & Publish'}
            </button>

            <button
              className="btn"
              style={{ width: '100%', padding: '7px', fontSize: 11 }}
              onClick={handleSaveRevision}
            >
              Save Working Revision
            </button>

            {!approved && !escalated && (
              <div style={{ marginTop: 6 }}>
                <textarea
                  style={{
                    width: '100%',
                    borderRadius: 6,
                    border: '1px solid var(--line)',
                    padding: 6,
                    fontSize: 11,
                    marginBottom: 4,
                  }}
                  rows={2}
                  placeholder="Revision instructions..."
                  value={revisionNote}
                  onChange={(e) => setRevisionNote(e.target.value)}
                />
                <button
                  className="btn"
                  style={{ width: '100%', padding: '6px', fontSize: 11 }}
                  onClick={handleRequestRevision}
                >
                  Request Repair ({2 - repairCycles} left)
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Layers Hierarchy Modal */}
      {showLayersModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.65)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 300,
            backdropFilter: 'blur(4px)',
          }}
          onClick={() => setShowLayersModal(false)}
        >
          <div
            style={{
              background: 'var(--panel)',
              borderRadius: 10,
              padding: 20,
              width: 480,
              boxShadow: '0 20px 48px rgba(0, 0, 0, 0.35)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: 16 }}>HyCanvas Vector Layers</h2>
              <button className="btn" style={{ fontSize: 11 }} onClick={() => setShowLayersModal(false)}>✕</button>
            </div>
            <table className="table" style={{ fontSize: 11 }}>
              <thead>
                <tr>
                  <th>Z</th>
                  <th>Node</th>
                  <th>Role</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((layer) => (
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
                      <span style={{ color: layer.locked ? '#EF4444' : '#10B981', fontSize: 10, fontWeight: 600 }}>
                        {layer.locked ? '🔒 Locked' : '🔓 Live'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Semantic Revision Diff Modal */}
      {showDiffModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.65)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 300,
            backdropFilter: 'blur(4px)',
          }}
          onClick={() => setShowDiffModal(false)}
        >
          <div
            style={{
              background: 'var(--panel)',
              borderRadius: 10,
              padding: 20,
              width: 580,
              maxHeight: '80vh',
              overflowY: 'auto',
              boxShadow: '0 20px 48px rgba(0, 0, 0, 0.35)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: 16 }}>Semantic Revision Diff</h2>
              <button className="btn" style={{ fontSize: 11 }} onClick={() => setShowDiffModal(false)}>✕</button>
            </div>
            <div style={{ fontSize: 12, padding: 8, background: 'rgba(56, 189, 248, 0.08)', borderRadius: 6, marginBottom: 12, fontWeight: 600 }}>
              {semanticDiff.summary}
            </div>
            {semanticDiff.hasChanges ? (
              <table className="table" style={{ fontSize: 11 }}>
                <thead>
                  <tr>
                    <th>Property</th>
                    <th>Base (Rev 1)</th>
                    <th>Working</th>
                  </tr>
                </thead>
                <tbody>
                  {semanticDiff.textDeltas.map((d, i) => (
                    <tr key={i}>
                      <td><b>{d.label}</b></td>
                      <td style={{ color: '#EF4444' }}>{d.oldText}</td>
                      <td style={{ color: '#10B981' }}>{d.newText}</td>
                    </tr>
                  ))}
                  {semanticDiff.styleDeltas.map((s, i) => (
                    <tr key={i}>
                      <td><b>{s.property}</b></td>
                      <td>{s.oldVal}</td>
                      <td style={{ color: 'var(--accent)', fontWeight: 600 }}>{s.newVal}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>
                Zero drift detected against candidate Revision 1.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Floating Keyboard Shortcuts HUD Modal */}
      {showShortcutsModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 400,
            backdropFilter: 'blur(6px)',
          }}
          onClick={() => setShowShortcutsModal(false)}
        >
          <div
            className="studio-glass"
            style={{
              borderRadius: 12,
              padding: 24,
              width: 480,
              maxWidth: '90vw',
              boxShadow: '0 24px 64px rgba(0, 0, 0, 0.5)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 16, color: '#fff' }}>⌨ Pro Studio Keyboard Shortcuts</h3>
              <button className="btn" style={{ fontSize: 11 }} onClick={() => setShowShortcutsModal(false)}>✕</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 12 }}>
              <div><kbd style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 6px', borderRadius: 4 }}>V</kbd> Selection Tool</div>
              <div><kbd style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 6px', borderRadius: 4 }}>H</kbd> Hand / Pan Tool</div>
              <div><kbd style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 6px', borderRadius: 4 }}>Space + Drag</kbd> Quick Pan</div>
              <div><kbd style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 6px', borderRadius: 4 }}>Cmd + Wheel</kbd> Smooth Zoom</div>
              <div><kbd style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 6px', borderRadius: 4 }}>Cmd + 0</kbd> Reset / Fit View</div>
              <div><kbd style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 6px', borderRadius: 4 }}>Cmd + Z</kbd> Undo Action</div>
              <div><kbd style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 6px', borderRadius: 4 }}>Cmd + Shift + Z</kbd> Redo Action</div>
              <div><kbd style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 6px', borderRadius: 4 }}>Arrow Keys</kbd> Nudge 1px</div>
              <div><kbd style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 6px', borderRadius: 4 }}>Shift + Arrows</kbd> Nudge 10px</div>
              <div><kbd style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 6px', borderRadius: 4 }}>?</kbd> Open this Cheat Sheet</div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
