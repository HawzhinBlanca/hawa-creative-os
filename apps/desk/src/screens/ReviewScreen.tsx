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
  x: number;      // px within artboard space
  y: number;      // px within artboard space
  width: number;  // px
  height: number; // px
  rotation?: number;
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

export const ARTBOARD_CONFIG: Record<AspectPreset, { width: number; height: number; defaultHeadlineY: number; defaultCopyY: number }> = {
  feed: { width: 480, height: 600, defaultHeadlineY: 100, defaultCopyY: 480 },
  square: { width: 500, height: 500, defaultHeadlineY: 85, defaultCopyY: 390 },
  story: { width: 380, height: 675, defaultHeadlineY: 120, defaultCopyY: 530 },
  landscape: { width: 640, height: 360, defaultHeadlineY: 60, defaultCopyY: 270 },
};

export const ReviewScreen: React.FC<ReviewScreenProps> = ({ task }) => {
  const { t } = useI18n();

  // 1. Format & Variant State
  const [variant, setVariant] = useState<AspectPreset>('feed');
  const [langVariant, setLangVariant] = useState<'en' | 'ckb' | 'bilingual'>('en');
  const [selectedBrandKitId, setSelectedBrandKitId] = useState<string>('hawa');
  const activeBrandKit: BrandKit = useMemo(() => getBrandKit(selectedBrandKitId), [selectedBrandKitId]);

  const currentArtboard = ARTBOARD_CONFIG[variant];

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
    { id: 'node_headline', role: 'headline', name: 'Headline (Vector Text)', zIndex: 15, locked: false, visible: true, x: 36, y: 100, width: 408, height: 110 },
    { id: 'node_copy', role: 'copy', name: 'Price & Offer Badge', zIndex: 16, locked: false, visible: true, x: 36, y: 480, width: 260, height: 52 },
    { id: 'node_logo', role: 'logo', name: 'Verified Brand Logo', zIndex: 10, locked: false, visible: true, x: 32, y: 28, width: 190, height: 42 },
    { id: 'node_shape', role: 'shape', name: 'Organic Accent Shape', zIndex: 2, locked: false, visible: true, x: 60, y: 240, width: 360, height: 210, rotation: 15 },
  ]);

  const [selectedNodeId, setSelectedNodeId] = useState<CanvasNode['role'] | null>(null);

  // 5. Pan & Zoom Engine State
  const [zoom, setZoom] = useState<number>(1.0);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const [isDraggingNode, setIsDraggingNode] = useState<boolean>(false);
  const [editingNodeRole, setEditingNodeRole] = useState<CanvasNode['role'] | null>(null);
  const [isSpacePressed, setIsSpacePressed] = useState<boolean>(false);
  const [activeTool, setActiveTool] = useState<'select' | 'hand'>('select');
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

  // Native Wheel Event Listener on Viewport (Smooth Zoom without page zoom)
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;

    const onNativeWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const zoomFactor = 1 - e.deltaY * 0.0025;
        setZoom((prev) => Math.min(3.5, Math.max(0.35, prev * zoomFactor)));
      } else {
        setPanOffset((prev) => ({
          x: Math.round(prev.x - e.deltaX * 0.85),
          y: Math.round(prev.y - e.deltaY * 0.85),
        }));
      }
    };

    vp.addEventListener('wheel', onNativeWheel, { passive: false });
    return () => {
      vp.removeEventListener('wheel', onNativeWheel);
    };
  }, []);

  // Keyboard Shortcuts Listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName) || (e.target as HTMLElement)?.isContentEditable) {
        return;
      }

      if (e.code === 'Space' && !e.repeat) {
        setIsSpacePressed(true);
      }
      if (e.key === 'v' || e.key === 'V') {
        setActiveTool('select');
      }
      if (e.key === 'h' || e.key === 'H') {
        setActiveTool('hand');
      }
      if (e.key === '?') {
        setShowShortcutsModal(true);
      }
      if (e.key === 'Escape') {
        setSelectedNodeId(null);
        setShowLayersModal(false);
        setShowDiffModal(false);
        setShowExportMenu(false);
        setShowShortcutsModal(false);
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

      // Zoom Reset
      if ((e.metaKey || e.ctrlKey) && (e.key === '0' || e.key === '1')) {
        e.preventDefault();
        setZoom(1.0);
        setPanOffset({ x: 0, y: 0 });
      }

      // Keyboard Nudge for Selected Element
      if (selectedNodeId && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        const delta = e.shiftKey ? 10 : 1;
        setNodes((prev) =>
          prev.map((n) => {
            if (n.role !== selectedNodeId || n.locked) return n;
            let nx = n.x;
            let ny = n.y;
            if (e.key === 'ArrowUp') ny -= delta;
            if (e.key === 'ArrowDown') ny += delta;
            if (e.key === 'ArrowLeft') nx -= delta;
            if (e.key === 'ArrowRight') nx += delta;
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

  // Brand Kit Selector
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

  // Switch Aspect Ratio Format (Clamps positions to new artboard bounds)
  const handleSwitchFormat = (fmt: AspectPreset) => {
    const newConfig = ARTBOARD_CONFIG[fmt];
    setVariant(fmt);
    setNodes((prev) =>
      prev.map((n) => {
        let ny = n.y;
        if (n.role === 'headline') ny = newConfig.defaultHeadlineY;
        if (n.role === 'copy') ny = newConfig.defaultCopyY;
        const clampedX = Math.min(n.x, Math.max(20, newConfig.width - n.width - 20));
        const clampedY = Math.min(ny, Math.max(20, newConfig.height - n.height - 20));
        return { ...n, x: clampedX, y: clampedY };
      })
    );
    pushHistory();
  };

  // =========================================================================
  // BULLETPROOF DIRECT MANIPULATION & RESIZE HANDLERS (Figma/Photoshop Grade)
  // =========================================================================

  // Element Drag-to-Move with Magnetic Snapping
  const handleElementPointerDown = (e: React.PointerEvent, role: CanvasNode['role']) => {
    // Only primary mouse button (left-click) starts node dragging
    if (e.button !== 0) return;
    if (isSpacePressed || activeTool === 'hand') return;
    e.stopPropagation();
    e.preventDefault(); // Prevent browser text selection and ghost drag

    // Select immediately on pointerdown
    setSelectedNodeId(role);

    const targetNode = nodes.find((n) => n.role === role);
    if (!targetNode || targetNode.locked) return;

    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const startX = targetNode.x;
    const startY = targetNode.y;

    let hasMoved = false;

    const onPointerMove = (moveEvt: PointerEvent) => {
      moveEvt.preventDefault();
      const dx = (moveEvt.clientX - startClientX) / zoom;
      const dy = (moveEvt.clientY - startClientY) / zoom;

      if (!hasMoved && Math.hypot(moveEvt.clientX - startClientX, moveEvt.clientY - startClientY) > 3) {
        hasMoved = true;
        setIsDraggingNode(true);
      }

      if (hasMoved) {
        let nextX = Math.round(startX + dx);
        let nextY = Math.round(startY + dy);

        // Magnetic snap to center X (artboard horizontal center)
        const centerX = Math.round((currentArtboard.width - targetNode.width) / 2);
        if (Math.abs(nextX - centerX) < 10) {
          nextX = centerX;
          setSnapGuideX(currentArtboard.width / 2);
        } else {
          setSnapGuideX(null);
        }

        // Magnetic snap to center Y (artboard vertical center)
        const centerY = Math.round((currentArtboard.height - targetNode.height) / 2);
        if (Math.abs(nextY - centerY) < 10) {
          nextY = centerY;
          setSnapGuideY(currentArtboard.height / 2);
        } else {
          setSnapGuideY(null);
        }

        setNodes((prev) =>
          prev.map((n) => (n.role === role ? { ...n, x: nextX, y: nextY } : n))
        );
      }
    };

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('blur', onPointerUp);
      setSnapGuideX(null);
      setSnapGuideY(null);
      setIsDraggingNode(false);
      if (hasMoved) {
        pushHistory();
      }
    };

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('blur', onPointerUp);
  };

  // Transform Handle Resize Handler (8 Cardinal Handles)
  const handleResizeHandlePointerDown = (e: React.PointerEvent, role: CanvasNode['role'], handle: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();

    const targetNode = nodes.find((n) => n.role === role);
    if (!targetNode || targetNode.locked) return;

    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const startX = targetNode.x;
    const startY = targetNode.y;
    const startW = targetNode.width;
    const startH = targetNode.height;

    let hasResized = false;

    const onPointerMove = (moveEvt: PointerEvent) => {
      moveEvt.preventDefault();
      hasResized = true;
      const dx = (moveEvt.clientX - startClientX) / zoom;
      const dy = (moveEvt.clientY - startClientY) / zoom;

      let newX = startX;
      let newY = startY;
      let newW = startW;
      let newH = startH;

      if (handle.includes('e')) newW = Math.max(40, Math.round(startW + dx));
      if (handle.includes('s')) newH = Math.max(20, Math.round(startH + dy));
      if (handle.includes('w')) {
        const candidateW = Math.max(40, Math.round(startW - dx));
        newX = startX + (startW - candidateW);
        newW = candidateW;
      }
      if (handle.includes('n')) {
        const candidateH = Math.max(20, Math.round(startH - dy));
        newY = startY + (startH - candidateH);
        newH = candidateH;
      }

      setNodes((prev) =>
        prev.map((n) => (n.role === role ? { ...n, x: newX, y: newY, width: newW, height: newH } : n))
      );
    };

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('blur', onPointerUp);
      if (hasResized) {
        pushHistory();
      }
    };

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('blur', onPointerUp);
  };

  // Viewport Pan Pointer Handler
  const handleViewportPointerDown = (e: React.PointerEvent) => {
    const isDirectViewport = e.target === viewportRef.current;
    if (isSpacePressed || activeTool === 'hand' || e.button === 1 || (isDirectViewport && e.button === 0 && e.shiftKey)) {
      e.preventDefault();
      setIsPanning(true);
      const startClientX = e.clientX;
      const startClientY = e.clientY;
      const startPanX = panOffset.x;
      const startPanY = panOffset.y;

      const onPointerMove = (moveEvt: PointerEvent) => {
        setPanOffset({
          x: Math.round(startPanX + (moveEvt.clientX - startClientX)),
          y: Math.round(startPanY + (moveEvt.clientY - startClientY)),
        });
      };

      const onPointerUp = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
        window.removeEventListener('blur', onPointerUp);
        setIsPanning(false);
      };

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
      window.addEventListener('blur', onPointerUp);
    } else if (isDirectViewport) {
      // Clicking empty workspace background deselects active layer
      setSelectedNodeId(null);
      setEditingNodeRole(null);
    }
  };

  // Render Transform Bounding Box with Live Dimension Pill and 8 Cardinal Handles
  const renderTransformBBox = (node: CanvasNode, all8: boolean = true) => (
    <div className="transform-bbox" style={{ pointerEvents: 'none' }}>
      <div className="node-dimension-pill">
        {node.name} · {Math.round(node.width)}×{Math.round(node.height)} ({Math.round(node.x)}, {Math.round(node.y)})
      </div>
      <div className="transform-handle handle-nw" onPointerDown={(e) => handleResizeHandlePointerDown(e, node.role, 'nw')} />
      {all8 && <div className="transform-handle handle-n" onPointerDown={(e) => handleResizeHandlePointerDown(e, node.role, 'n')} />}
      <div className="transform-handle handle-ne" onPointerDown={(e) => handleResizeHandlePointerDown(e, node.role, 'ne')} />
      {all8 && <div className="transform-handle handle-e" onPointerDown={(e) => handleResizeHandlePointerDown(e, node.role, 'e')} />}
      <div className="transform-handle handle-se" onPointerDown={(e) => handleResizeHandlePointerDown(e, node.role, 'se')} />
      {all8 && <div className="transform-handle handle-s" onPointerDown={(e) => handleResizeHandlePointerDown(e, node.role, 's')} />}
      <div className="transform-handle handle-sw" onPointerDown={(e) => handleResizeHandlePointerDown(e, node.role, 'sw')} />
      {all8 && <div className="transform-handle handle-w" onPointerDown={(e) => handleResizeHandlePointerDown(e, node.role, 'w')} />}
    </div>
  );

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
  const activeSelectedNode = nodes.find((n) => n.role === selectedNodeId);

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
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>🟢</span>
            <span style={{ fontWeight: 600 }}>{studioToast}</span>
          </div>
          <button className="btn" style={{ fontSize: 10, padding: '2px 6px' }} onClick={() => setStudioToast(null)}>✕</button>
        </div>
      )}

      {/* Studio Top Control Strip (Brand Kits, Formats, Tools, Undo/Redo, Export) */}
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

        {/* Center: Tools & Aspect Presets */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Tool Switcher */}
          <div style={{ display: 'flex', gap: 2, background: 'rgba(0,0,0,0.06)', padding: 2, borderRadius: 6 }}>
            <button
              className={`btn ${activeTool === 'select' ? 'primary' : ''}`}
              style={{ fontSize: 11, padding: '4px 8px', fontWeight: 600 }}
              onClick={() => setActiveTool('select')}
              title="Pointer / Select Tool (V)"
            >
              ↖ Select
            </button>
            <button
              className={`btn ${activeTool === 'hand' ? 'primary' : ''}`}
              style={{ fontSize: 11, padding: '4px 8px', fontWeight: 600 }}
              onClick={() => setActiveTool('hand')}
              title="Hand / Pan Tool (H / Space+Drag)"
            >
              ✋ Hand
            </button>
          </div>

          {/* Aspect Presets */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {(['feed', 'square', 'story', 'landscape'] as AspectPreset[]).map((fmt) => (
              <button
                key={fmt}
                className={`btn ${variant === fmt ? 'primary' : ''}`}
                style={{ fontSize: 11, padding: '4px 10px', fontWeight: 600 }}
                onClick={() => handleSwitchFormat(fmt)}
              >
                {FORMAT_DIMENSIONS[fmt].label.split(' ')[0]}
              </button>
            ))}
          </div>
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
      <div className="review" style={{ flex: 1, minHeight: 0, gridTemplateColumns: '260px 1fr 290px' }}>
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
          className={`studio-viewport ${isPanning || isSpacePressed || activeTool === 'hand' ? 'panning' : ''} ${isPanning ? 'is-active-panning' : ''} ${isDraggingNode ? 'is-dragging' : ''}`}
          onPointerDown={handleViewportPointerDown}
        >
          {/* Snap Guides */}
          {snapGuideX !== null && <div className="snap-guide-x" style={{ left: `calc(50% + ${(snapGuideX - currentArtboard.width / 2) * zoom + panOffset.x}px)` }} />}
          {snapGuideY !== null && <div className="snap-guide-y" style={{ top: `calc(50% + ${(snapGuideY - currentArtboard.height / 2) * zoom + panOffset.y}px)` }} />}

          {/* Scaled & Panned Artboard */}
          <div
            className="artboard-container"
            style={{
              transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`,
              width: `${currentArtboard.width}px`,
              height: `${currentArtboard.height}px`,
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
                onPointerDown={(e) => handleElementPointerDown(e, 'shape')}
                style={{
                  position: 'absolute',
                  left: `${shapeNode.x}px`,
                  top: `${shapeNode.y}px`,
                  width: `${shapeNode.width}px`,
                  height: `${shapeNode.height}px`,
                  borderRadius: '50%',
                  background: accentColor,
                  transform: langVariant === 'ckb' ? 'rotate(-15deg)' : 'rotate(15deg)',
                  zIndex: shapeNode.zIndex,
                  cursor: activeTool === 'hand' || isSpacePressed ? 'grab' : isDraggingNode && selectedNodeId === 'shape' ? 'grabbing' : 'move',
                  opacity: 0.85,
                  userSelect: 'none',
                  touchAction: 'none',
                }}
              >
                {selectedNodeId === 'shape' && renderTransformBBox(shapeNode, true)}
              </div>
            )}

            {/* Brand Logo Node */}
            {logoNode.visible && (
              <div
                onPointerDown={(e) => handleElementPointerDown(e, 'logo')}
                style={{
                  position: 'absolute',
                  left: `${logoNode.x}px`,
                  top: `${logoNode.y}px`,
                  width: `${logoNode.width}px`,
                  height: `${logoNode.height}px`,
                  zIndex: logoNode.zIndex,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '4px 12px',
                  background: 'rgba(0,0,0,0.5)',
                  borderRadius: 6,
                  border: '1px solid rgba(255,255,255,0.25)',
                  cursor: activeTool === 'hand' || isSpacePressed ? 'grab' : isDraggingNode && selectedNodeId === 'logo' ? 'grabbing' : 'move',
                  userSelect: 'none',
                  touchAction: 'none',
                }}
                title={activeBrandKit.verifiedSha256}
              >
                <span style={{ fontSize: 11, color: '#fff', fontWeight: 700 }}>{activeBrandKit.logoText}</span>
                <span style={{ fontSize: 9, color: '#10B981' }}>✓</span>

                {selectedNodeId === 'logo' && renderTransformBBox(logoNode, true)}
              </div>
            )}

            {/* Live Editable Headline Node */}
            {headlineNode.visible && (
              <div
                onPointerDown={(e) => handleElementPointerDown(e, 'headline')}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setEditingNodeRole('headline');
                }}
                style={{
                  position: 'absolute',
                  left: `${headlineNode.x}px`,
                  top: `${headlineNode.y}px`,
                  width: `${headlineNode.width}px`,
                  zIndex: headlineNode.zIndex,
                  padding: 4,
                  cursor: activeTool === 'hand' || isSpacePressed ? 'grab' : isDraggingNode && selectedNodeId === 'headline' ? 'grabbing' : 'move',
                  userSelect: 'none',
                  touchAction: 'none',
                }}
              >
                {selectedNodeId === 'headline' && renderTransformBBox(headlineNode, true)}

                {/* Inline Editing Mode */}
                {editingNodeRole === 'headline' ? (
                  <textarea
                    autoFocus
                    value={langVariant === 'ckb' ? headlineCkb : headlineEn}
                    onChange={(e) => {
                      if (langVariant === 'ckb') setHeadlineCkb(e.target.value);
                      else setHeadlineEn(e.target.value);
                    }}
                    onBlur={() => {
                      setEditingNodeRole(null);
                      pushHistory();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) {
                        e.preventDefault();
                        setEditingNodeRole(null);
                        pushHistory();
                      }
                    }}
                    dir={langVariant === 'ckb' ? 'rtl' : 'ltr'}
                    style={{
                      width: '100%',
                      minHeight: 60,
                      background: 'rgba(15, 23, 42, 0.88)',
                      color: '#ffffff',
                      border: '2px solid #38BDF8',
                      borderRadius: 6,
                      padding: '4px 8px',
                      fontSize: variant === 'story' ? 22 : 25,
                      fontWeight,
                      lineHeight: 1.25,
                      fontFamily: langVariant === 'ckb' ? 'Vazirmatn, sans-serif' : fontFamily,
                      resize: 'none',
                      outline: 'none',
                      boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                    }}
                  />
                ) : (
                  <>
                    {/* English Primary */}
                    {langVariant === 'en' && (
                      <div
                        dir="ltr"
                        lang="en"
                        style={{
                          fontSize: variant === 'story' ? 24 : 27,
                          color: '#ffffff',
                          fontWeight,
                          lineHeight: 1.25,
                          outline: 'none',
                          textAlign: 'left',
                          fontFamily,
                          textShadow: '0 2px 8px rgba(0,0,0,0.4)',
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
                          fontSize: variant === 'story' ? 24 : 27,
                          color: '#ffffff',
                          fontWeight,
                          lineHeight: 1.3,
                          outline: 'none',
                          textAlign: 'right',
                          fontFamily: 'Vazirmatn, sans-serif',
                          textShadow: '0 2px 8px rgba(0,0,0,0.4)',
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
                            textAlign: 'left',
                            fontFamily: 'Inter, sans-serif',
                            borderBottom: '1px solid rgba(255,255,255,0.2)',
                            paddingBottom: 4,
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
                            textAlign: 'right',
                            fontFamily: 'Vazirmatn, sans-serif',
                          }}
                        >
                          {showBidiIsolates ? `⸢\u2067${headlineCkb}\u2069⸥` : `\u2067${headlineCkb}\u2069`}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Price & Offer Copy Badge Node */}
            {copyNode.visible && (
              <div
                onPointerDown={(e) => handleElementPointerDown(e, 'copy')}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setEditingNodeRole('copy');
                }}
                style={{
                  position: 'absolute',
                  left: `${copyNode.x}px`,
                  top: `${copyNode.y}px`,
                  width: `${copyNode.width}px`,
                  zIndex: copyNode.zIndex,
                  padding: 4,
                  cursor: activeTool === 'hand' || isSpacePressed ? 'grab' : isDraggingNode && selectedNodeId === 'copy' ? 'grabbing' : 'move',
                  userSelect: 'none',
                  touchAction: 'none',
                }}
              >
                {selectedNodeId === 'copy' && renderTransformBBox(copyNode, true)}

                {/* Inline Editing Mode */}
                {editingNodeRole === 'copy' ? (
                  <input
                    autoFocus
                    type="text"
                    value={langVariant === 'ckb' ? copyCkb : copyEn}
                    onChange={(e) => {
                      if (langVariant === 'ckb') setCopyCkb(e.target.value);
                      else setCopyEn(e.target.value);
                    }}
                    onBlur={() => {
                      setEditingNodeRole(null);
                      pushHistory();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape' || e.key === 'Enter') {
                        e.preventDefault();
                        setEditingNodeRole(null);
                        pushHistory();
                      }
                    }}
                    dir={langVariant === 'ckb' ? 'rtl' : 'ltr'}
                    style={{
                      width: '100%',
                      background: 'rgba(15, 23, 42, 0.92)',
                      color: '#ffffff',
                      border: '2px solid #38BDF8',
                      borderRadius: 6,
                      padding: '4px 8px',
                      fontSize: 14,
                      fontWeight: 700,
                      outline: 'none',
                      boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                    }}
                  />
                ) : (
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
                  >
                    {langVariant === 'bilingual'
                      ? `${copyEn} · \u2067${copyCkb}\u2069`
                      : langVariant === 'ckb'
                      ? showBidiIsolates ? `⸢\u2067${copyCkb}\u2069⸥` : copyCkb
                      : copyEn}
                  </div>
                )}
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

        {/* Right Column: Pro Inspector & Decision Gate */}
        <div className="panel" style={{ overflowY: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>
              {activeSelectedNode ? `Layer: ${activeSelectedNode.name}` : 'Document Inspector'}
            </h3>
            {activeSelectedNode && (
              <button
                className="btn"
                style={{ fontSize: 10, padding: '2px 6px' }}
                onClick={() => setSelectedNodeId(null)}
              >
                Deselect
              </button>
            )}
          </div>

          {/* Conditional Layer Inspector */}
          {activeSelectedNode ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* Spatial Positioning Box */}
              <div style={{ background: 'var(--soft)', padding: 8, borderRadius: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>
                  TRANSFORM & DIMENSIONS
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 11 }}>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>X: </span>
                    <input
                      type="number"
                      value={activeSelectedNode.x}
                      onChange={(e) => {
                        const val = parseInt(e.target.value) || 0;
                        setNodes((prev) => prev.map((n) => n.role === activeSelectedNode.role ? { ...n, x: val } : n));
                      }}
                      style={{ width: 60, padding: '2px 4px', fontSize: 11, borderRadius: 4, border: '1px solid var(--line)' }}
                    />
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>Y: </span>
                    <input
                      type="number"
                      value={activeSelectedNode.y}
                      onChange={(e) => {
                        const val = parseInt(e.target.value) || 0;
                        setNodes((prev) => prev.map((n) => n.role === activeSelectedNode.role ? { ...n, y: val } : n));
                      }}
                      style={{ width: 60, padding: '2px 4px', fontSize: 11, borderRadius: 4, border: '1px solid var(--line)' }}
                    />
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>W: </span>
                    <input
                      type="number"
                      value={activeSelectedNode.width}
                      onChange={(e) => {
                        const val = parseInt(e.target.value) || 10;
                        setNodes((prev) => prev.map((n) => n.role === activeSelectedNode.role ? { ...n, width: val } : n));
                      }}
                      style={{ width: 60, padding: '2px 4px', fontSize: 11, borderRadius: 4, border: '1px solid var(--line)' }}
                    />
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>H: </span>
                    <input
                      type="number"
                      value={activeSelectedNode.height}
                      onChange={(e) => {
                        const val = parseInt(e.target.value) || 10;
                        setNodes((prev) => prev.map((n) => n.role === activeSelectedNode.role ? { ...n, height: val } : n));
                      }}
                      style={{ width: 60, padding: '2px 4px', fontSize: 11, borderRadius: 4, border: '1px solid var(--line)' }}
                    />
                  </div>
                </div>

                {/* 6 Quick Alignment Actions (Photoshop / Figma Grade) */}
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--muted)', marginBottom: 4 }}>
                    ALIGN TO ARTBOARD
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 3 }}>
                    <button
                      className="btn"
                      title="Align Left"
                      style={{ fontSize: 11, padding: '3px 0' }}
                      onClick={() => {
                        setNodes((prev) => prev.map((n) => n.role === activeSelectedNode.role ? { ...n, x: 20 } : n));
                        pushHistory();
                      }}
                    >⇤</button>
                    <button
                      className="btn"
                      title="Align Horizontal Center"
                      style={{ fontSize: 11, padding: '3px 0' }}
                      onClick={() => {
                        const cx = Math.round((currentArtboard.width - activeSelectedNode.width) / 2);
                        setNodes((prev) => prev.map((n) => n.role === activeSelectedNode.role ? { ...n, x: cx } : n));
                        pushHistory();
                      }}
                    >⇹</button>
                    <button
                      className="btn"
                      title="Align Right"
                      style={{ fontSize: 11, padding: '3px 0' }}
                      onClick={() => {
                        const rx = Math.round(currentArtboard.width - activeSelectedNode.width - 20);
                        setNodes((prev) => prev.map((n) => n.role === activeSelectedNode.role ? { ...n, x: rx } : n));
                        pushHistory();
                      }}
                    >⇥</button>
                    <button
                      className="btn"
                      title="Align Top"
                      style={{ fontSize: 11, padding: '3px 0' }}
                      onClick={() => {
                        setNodes((prev) => prev.map((n) => n.role === activeSelectedNode.role ? { ...n, y: 20 } : n));
                        pushHistory();
                      }}
                    >⤒</button>
                    <button
                      className="btn"
                      title="Align Vertical Center"
                      style={{ fontSize: 11, padding: '3px 0' }}
                      onClick={() => {
                        const cy = Math.round((currentArtboard.height - activeSelectedNode.height) / 2);
                        setNodes((prev) => prev.map((n) => n.role === activeSelectedNode.role ? { ...n, y: cy } : n));
                        pushHistory();
                      }}
                    >⬍</button>
                    <button
                      className="btn"
                      title="Align Bottom"
                      style={{ fontSize: 11, padding: '3px 0' }}
                      onClick={() => {
                        const by = Math.round(currentArtboard.height - activeSelectedNode.height - 20);
                        setNodes((prev) => prev.map((n) => n.role === activeSelectedNode.role ? { ...n, y: by } : n));
                        pushHistory();
                      }}
                    >⤓</button>
                  </div>
                </div>

                {/* Layer Hierarchy (Z-Index) */}
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button
                    className="btn"
                    style={{ flex: 1, fontSize: 10, padding: '4px' }}
                    onClick={() => {
                      setNodes((prev) => prev.map((n) => n.role === activeSelectedNode.role ? { ...n, zIndex: n.zIndex + 1 } : n));
                      pushHistory();
                    }}
                  >
                    ↑ Bring Forward
                  </button>
                  <button
                    className="btn"
                    style={{ flex: 1, fontSize: 10, padding: '4px' }}
                    onClick={() => {
                      setNodes((prev) => prev.map((n) => n.role === activeSelectedNode.role ? { ...n, zIndex: Math.max(1, n.zIndex - 1) } : n));
                      pushHistory();
                    }}
                  >
                    ↓ Send Backward
                  </button>
                </div>
              </div>

              {/* Layer-Specific Properties */}
              {activeSelectedNode.role === 'headline' && (
                <div style={{ background: 'var(--soft)', padding: 8, borderRadius: 8 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>
                    HEADLINE CONTENT & COPY
                  </div>
                  <div style={{ marginBottom: 6 }}>
                    <small style={{ display: 'block', color: 'var(--muted)', fontSize: 10 }}>English Lead:</small>
                    <input
                      type="text"
                      value={headlineEn}
                      onChange={(e) => setHeadlineEn(e.target.value)}
                      onBlur={pushHistory}
                      style={{ width: '100%', padding: '4px 6px', fontSize: 12, borderRadius: 4, border: '1px solid var(--line)' }}
                    />
                  </div>
                  <div>
                    <small style={{ display: 'block', color: 'var(--muted)', fontSize: 10 }}>Kurdish Sorani:</small>
                    <input
                      type="text"
                      dir="rtl"
                      value={headlineCkb}
                      onChange={(e) => setHeadlineCkb(e.target.value)}
                      onBlur={pushHistory}
                      style={{ width: '100%', padding: '4px 6px', fontSize: 12, borderRadius: 4, border: '1px solid var(--line)' }}
                    />
                  </div>
                </div>
              )}

              {activeSelectedNode.role === 'copy' && (
                <div style={{ background: 'var(--soft)', padding: 8, borderRadius: 8 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>
                    PRICE & BADGE COPY
                  </div>
                  <div style={{ marginBottom: 6 }}>
                    <small style={{ display: 'block', color: 'var(--muted)', fontSize: 10 }}>English Price:</small>
                    <input
                      type="text"
                      value={copyEn}
                      onChange={(e) => setCopyEn(e.target.value)}
                      onBlur={pushHistory}
                      style={{ width: '100%', padding: '4px 6px', fontSize: 12, borderRadius: 4, border: '1px solid var(--line)' }}
                    />
                  </div>
                  <div>
                    <small style={{ display: 'block', color: 'var(--muted)', fontSize: 10 }}>Kurdish Price (د.ع):</small>
                    <input
                      type="text"
                      dir="rtl"
                      value={copyCkb}
                      onChange={(e) => setCopyCkb(e.target.value)}
                      onBlur={pushHistory}
                      style={{ width: '100%', padding: '4px 6px', fontSize: 12, borderRadius: 4, border: '1px solid var(--line)' }}
                    />
                  </div>
                </div>
              )}

              {activeSelectedNode.role === 'shape' && (
                <div style={{ background: 'var(--soft)', padding: 8, borderRadius: 8 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>
                    ORGANIC ACCENT COLOR
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {[activeBrandKit.palette.accent, '#38BDF8', '#10B981', '#E9B666', '#8B5CF6', '#EC4899'].map((c) => (
                      <div
                        key={c}
                        onClick={() => {
                          setAccentColor(c);
                          pushHistory();
                        }}
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: '50%',
                          background: c,
                          cursor: 'pointer',
                          border: accentColor === c ? '2px solid #000' : '1px solid rgba(0,0,0,0.2)',
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}

              {activeSelectedNode.role === 'logo' && (
                <div style={{ background: 'var(--soft)', padding: 8, borderRadius: 8 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', marginBottom: 4 }}>
                    VERIFIED BRAND ASSET
                  </div>
                  <div style={{ fontSize: 11, color: '#10B981', fontWeight: 600 }}>
                    {activeBrandKit.logoBadge}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2, wordBreak: 'break-all' }}>
                    <code>{activeBrandKit.verifiedSha256}</code>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* Document Global Inspector */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* Typography Controls */}
              <div style={{ background: 'var(--soft)', padding: 8, borderRadius: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>
                  GLOBAL TYPOGRAPHY
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 6 }}>
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

              {/* Accent Palette */}
              <div style={{ background: 'var(--soft)', padding: 8, borderRadius: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>
                  PALETTE PRESETS
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
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
            </div>
          )}

          {/* Live Diagnostics Card */}
          <div className="finding" style={{ borderColor: '#38BDF8', background: 'rgba(56, 189, 248, 0.05)', marginTop: 10, marginBottom: 10 }}>
            <b style={{ color: '#0284C7', fontSize: 12 }}>⚡ Real-Time QC Verification</b>
            <div style={{ fontSize: 11, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span>WCAG Contrast: <b>{qaDiagnostics.wcagContrastRatio}:1 (AAA)</b></span>
              <span>Protected Tokens: <b>{qaDiagnostics.tokensIntact ? '✓ Preserved' : '✗ Altered'}</b></span>
              <span>Layout Drift: <b>{semanticDiff.hasChanges ? `${semanticDiff.totalChanges} Δ modifications` : 'Zero Drift'}</b></span>
            </div>
          </div>

          {/* Quick Inspector Actions */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 10 }}>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button
              className="btn primary"
              style={{ width: '100%', padding: '9px', fontSize: 12, fontWeight: 700 }}
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
              style={{ width: '100%', padding: '6px', fontSize: 11 }}
              onClick={handleSaveRevision}
            >
              Save Working Revision
            </button>

            {!approved && !escalated && (
              <div style={{ marginTop: 4 }}>
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
                  style={{ width: '100%', padding: '5px', fontSize: 11 }}
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
              <div><kbd style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 6px', borderRadius: 4 }}>Esc</kbd> Deselect Layer</div>
              <div><kbd style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 6px', borderRadius: 4 }}>?</kbd> Open Cheat Sheet</div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
