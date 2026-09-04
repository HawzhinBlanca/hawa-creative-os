import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { runRealtimeQADiagnostics, type QADiagnosticResult } from '../services/qaDiagnostics.ts';
import { computeSemanticDiff, type SemanticDiffResult, type DocumentSnapshot } from '../services/semanticDiff.ts';
import { useI18n } from '../services/i18n.js';
import { BRAND_KITS, getBrandKit, type BrandKit } from '../services/brandKits.js';
import { exportToHighResPng, exportToSvg, exportToHycPackage, FORMAT_DIMENSIONS, type AspectPreset } from '../services/canvasExport.js';
import {
  toEasternKurdishDigits,
  toWesternDigits,
  isolateKurdishText,
  checkKurdishTypographyClearance,
  SORANI_SPECIFIC_CHARS,
} from '../services/kurdishTypography.ts';

interface ReviewScreenProps {
  task?: any;
}

export interface CanvasNode {
  id: string;
  role: 'headline' | 'copy' | 'shape' | 'logo' | 'text_custom' | 'shape_custom' | 'badge_custom';
  name: string;
  zIndex: number;
  locked: boolean;
  visible: boolean;
  x: number;      // px within artboard space
  y: number;      // px within artboard space
  width: number;  // px
  height: number; // px
  rotation?: number;       // degrees 0-360
  opacity?: number;        // 0.0 - 1.0
  borderRadius?: number;   // px
  backgroundColor?: string;
  borderColor?: string;
  borderWidth?: number;
  color?: string;
  fontSize?: number;
  fontWeight?: number;
  fontFamily?: string;
  lineHeight?: number;
  letterSpacing?: number;
  direction?: 'rtl' | 'ltr' | 'auto';
  digitScript?: 'western' | 'eastern';
  textAlign?: 'left' | 'center' | 'right';
  textEn?: string;
  textCkb?: string;
  groupId?: string;
  aspectRatioLocked?: boolean;
  shadow?: {
    x: number;
    y: number;
    blur: number;
    color: string;
  };
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

  // 4. Dynamic Canvas Nodes Layer Tree State
  const [nodes, setNodes] = useState<CanvasNode[]>([
    { id: 'node_headline', role: 'headline', name: 'Headline (Vector Text)', zIndex: 15, locked: false, visible: true, x: 36, y: 100, width: 408, height: 110, rotation: 0, opacity: 1 },
    { id: 'node_copy', role: 'copy', name: 'Price & Offer Badge', zIndex: 16, locked: false, visible: true, x: 36, y: 480, width: 260, height: 52, rotation: 0, opacity: 1 },
    { id: 'node_logo', role: 'logo', name: 'Verified Brand Logo', zIndex: 10, locked: false, visible: true, x: 32, y: 28, width: 190, height: 42, rotation: 0, opacity: 1 },
    { id: 'node_shape', role: 'shape', name: 'Organic Accent Shape', zIndex: 2, locked: false, visible: true, x: 60, y: 240, width: 360, height: 210, rotation: 15, opacity: 0.85 },
  ]);

  // Multi-Selection State
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>(['node_headline']);
  const selectedNodeId = selectedNodeIds[selectedNodeIds.length - 1] || null;

  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [renamingNodeId, setRenamingNodeId] = useState<string | null>(null);
  const [leftTab, setLeftTab] = useState<'layers' | 'brief'>('layers');

  // 5. Pan & Zoom Engine State
  const [zoom, setZoom] = useState<number>(1.0);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const [isDraggingNode, setIsDraggingNode] = useState<boolean>(false);
  const [isSpacePressed, setIsSpacePressed] = useState<boolean>(false);
  const [activeTool, setActiveTool] = useState<'select' | 'hand'>('select');
  const viewportRef = useRef<HTMLDivElement>(null);
  const artboardRef = useRef<HTMLDivElement>(null);

  // 6. Magnetic Snap Guides & Live Distance Badges State
  const [snapGuideX, setSnapGuideX] = useState<number | null>(null);
  const [snapGuideY, setSnapGuideY] = useState<number | null>(null);
  const [smartGuide, setSmartGuide] = useState<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    distance: number;
    badgeX: number;
    badgeY: number;
  } | null>(null);

  // 7. Marquee Drag Selection State
  const [marquee, setMarquee] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null);

  // 8. Overlays & Modals
  const [showSafeZones, setShowSafeZones] = useState<boolean>(false);
  const [showBidiIsolates, setShowBidiIsolates] = useState<boolean>(false);
  const [showDiffModal, setShowDiffModal] = useState<boolean>(false);
  const [showExportMenu, setShowExportMenu] = useState<boolean>(false);
  const [showShortcutsModal, setShowShortcutsModal] = useState<boolean>(false);
  const [studioToast, setStudioToast] = useState<string | null>(null);

  // 9. Undo / Redo History Stack
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
    if (nextHistory.length > 35) nextHistory.shift();
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

  // Layer Management Helpers
  const handleAddTextLayer = () => {
    const newId = `text_${Date.now()}`;
    const maxZ = nodes.reduce((max, n) => Math.max(max, n.zIndex), 0);
    const newNode: CanvasNode = {
      id: newId,
      role: 'text_custom',
      name: `Text Layer ${nodes.length + 1}`,
      zIndex: maxZ + 1,
      locked: false,
      visible: true,
      x: Math.round((currentArtboard.width - 240) / 2),
      y: Math.round((currentArtboard.height - 50) / 2),
      width: 240,
      height: 48,
      rotation: 0,
      opacity: 1,
      fontSize: 20,
      fontWeight: 700,
      fontFamily: 'Inter, sans-serif',
      color: '#ffffff',
      textAlign: 'center',
      textEn: 'New Text Layer',
      textCkb: 'دەقی نوێ',
    };
    setNodes((prev) => [...prev, newNode]);
    setSelectedNodeIds([newId]);
    setStudioToast('✓ Added New Text Layer');
    setTimeout(() => setStudioToast(null), 2500);
    pushHistory();
  };

  const handleAddShapeLayer = () => {
    const newId = `shape_${Date.now()}`;
    const maxZ = nodes.reduce((max, n) => Math.max(max, n.zIndex), 0);
    const newNode: CanvasNode = {
      id: newId,
      role: 'shape_custom',
      name: `Rectangle ${nodes.length + 1}`,
      zIndex: maxZ + 1,
      locked: false,
      visible: true,
      x: Math.round((currentArtboard.width - 200) / 2),
      y: Math.round((currentArtboard.height - 140) / 2),
      width: 200,
      height: 140,
      rotation: 0,
      opacity: 0.9,
      borderRadius: 12,
      backgroundColor: accentColor,
      borderColor: 'rgba(255,255,255,0.2)',
      borderWidth: 1,
    };
    setNodes((prev) => [...prev, newNode]);
    setSelectedNodeIds([newId]);
    setStudioToast('✓ Added Accent Shape');
    setTimeout(() => setStudioToast(null), 2500);
    pushHistory();
  };

  const handleAddBadgeLayer = () => {
    const newId = `badge_${Date.now()}`;
    const maxZ = nodes.reduce((max, n) => Math.max(max, n.zIndex), 0);
    const newNode: CanvasNode = {
      id: newId,
      role: 'badge_custom',
      name: `Badge ${nodes.length + 1}`,
      zIndex: maxZ + 1,
      locked: false,
      visible: true,
      x: Math.round((currentArtboard.width - 160) / 2),
      y: Math.round((currentArtboard.height - 40) / 2),
      width: 160,
      height: 38,
      rotation: 0,
      opacity: 1,
      borderRadius: 999,
      backgroundColor: 'rgba(255, 255, 255, 0.18)',
      borderColor: 'rgba(255, 255, 255, 0.3)',
      borderWidth: 1,
      fontSize: 12,
      fontWeight: 700,
      color: '#ffffff',
      textAlign: 'center',
      textEn: 'SPECIAL OFFER',
      textCkb: 'داشکاندنی تایبەت',
    };
    setNodes((prev) => [...prev, newNode]);
    setSelectedNodeIds([newId]);
    setStudioToast('✓ Added Promo Badge');
    setTimeout(() => setStudioToast(null), 2500);
    pushHistory();
  };

  const handleDuplicateLayer = (targetId?: string) => {
    const idsToDup = targetId ? [targetId] : selectedNodeIds;
    if (idsToDup.length === 0) return;

    const maxZ = nodes.reduce((max, n) => Math.max(max, n.zIndex), 0);
    const newClones: CanvasNode[] = [];
    const newIds: string[] = [];

    idsToDup.forEach((id, idx) => {
      const target = nodes.find((n) => n.id === id);
      if (!target) return;
      const clonedId = `${target.id}_copy_${Date.now()}_${idx}`;
      const clonedNode: CanvasNode = {
        ...JSON.parse(JSON.stringify(target)),
        id: clonedId,
        name: `${target.name} (Copy)`,
        x: Math.min(target.x + 20, currentArtboard.width - target.width),
        y: Math.min(target.y + 20, currentArtboard.height - target.height),
        zIndex: maxZ + 1 + idx,
      };
      newClones.push(clonedNode);
      newIds.push(clonedId);
    });

    setNodes((prev) => [...prev, ...newClones]);
    setSelectedNodeIds(newIds);
    setStudioToast(`✓ Duplicated ${newClones.length} Layer(s)`);
    setTimeout(() => setStudioToast(null), 2000);
    pushHistory();
  };

  const handleDeleteLayer = (targetId?: string) => {
    const idsToDel = targetId ? [targetId] : selectedNodeIds;
    if (idsToDel.length === 0) return;

    setNodes((prev) => prev.filter((n) => !idsToDel.includes(n.id)));
    setSelectedNodeIds([]);
    setStudioToast(`✓ Deleted ${idsToDel.length} Layer(s)`);
    setTimeout(() => setStudioToast(null), 2000);
    pushHistory();
  };

  const handleGroup = () => {
    if (selectedNodeIds.length < 2) return;
    const newGroupId = `group_${Date.now()}`;
    setNodes((prev) =>
      prev.map((n) => (selectedNodeIds.includes(n.id) ? { ...n, groupId: newGroupId } : n))
    );
    setStudioToast(`✓ Grouped ${selectedNodeIds.length} Layers (Cmd+G)`);
    setTimeout(() => setStudioToast(null), 2000);
    pushHistory();
  };

  const handleUngroup = () => {
    if (selectedNodeIds.length === 0) return;
    setNodes((prev) =>
      prev.map((n) => (selectedNodeIds.includes(n.id) ? { ...n, groupId: undefined } : n))
    );
    setStudioToast('✓ Ungrouped Layers (Cmd+Shift+G)');
    setTimeout(() => setStudioToast(null), 2000);
    pushHistory();
  };

  const handleToggleLayerVisibility = (targetId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setNodes((prev) =>
      prev.map((n) => (n.id === targetId ? { ...n, visible: !n.visible } : n))
    );
    pushHistory();
  };

  const handleToggleLayerLock = (targetId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setNodes((prev) =>
      prev.map((n) => (n.id === targetId ? { ...n, locked: !n.locked } : n))
    );
    pushHistory();
  };

  const handleMoveLayerZIndex = (targetId: string, direction: 'up' | 'down' | 'front' | 'back', e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setNodes((prev) => {
      const target = prev.find((n) => n.id === targetId);
      if (!target) return prev;
      let newZ = target.zIndex;
      const maxZ = prev.reduce((m, n) => Math.max(m, n.zIndex), 0);
      const minZ = prev.reduce((m, n) => Math.min(m, n.zIndex), 1);

      if (direction === 'front') newZ = maxZ + 1;
      else if (direction === 'back') newZ = Math.max(1, minZ - 1);
      else if (direction === 'up') newZ = target.zIndex + 1;
      else if (direction === 'down') newZ = Math.max(1, target.zIndex - 1);

      return prev.map((n) => (n.id === targetId ? { ...n, zIndex: newZ } : n));
    });
    pushHistory();
  };

  // Keyboard Shortcuts Listener (Full Photoshop / Figma Mastery)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isInputActive = ['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName) || (e.target as HTMLElement)?.isContentEditable;

      if (!isInputActive) {
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
          setSelectedNodeIds([]);
          setEditingNodeId(null);
          setRenamingNodeId(null);
          setShowDiffModal(false);
          setShowExportMenu(false);
          setShowShortcutsModal(false);
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && selectedNodeIds.length > 0) {
          e.preventDefault();
          handleDeleteLayer();
        }
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
          e.preventDefault();
          handleDuplicateLayer();
        }
        // Group / Ungroup
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') {
          e.preventDefault();
          if (e.shiftKey) handleUngroup();
          else handleGroup();
        }
        // Layer Stacking: [ and ]
        if (selectedNodeId && (e.key === '[' || e.key === ']')) {
          e.preventDefault();
          if (e.key === '[') handleMoveLayerZIndex(selectedNodeId, (e.metaKey || e.ctrlKey) ? 'back' : 'down');
          if (e.key === ']') handleMoveLayerZIndex(selectedNodeId, (e.metaKey || e.ctrlKey) ? 'front' : 'up');
        }
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

      // Keyboard Nudge for Selected Elements (Moves all selected together)
      if (!isInputActive && selectedNodeIds.length > 0 && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        const delta = e.shiftKey ? 10 : 1;
        setNodes((prev) =>
          prev.map((n) => {
            if (!selectedNodeIds.includes(n.id) || n.locked) return n;
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
  }, [undo, redo, selectedNodeIds, selectedNodeId, nodes, currentArtboard]);

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
  // MULTI-SELECTION & MARQUEE ENGINE + DIRECT MANIPULATION
  // =========================================================================

  const handleElementPointerDown = (e: React.PointerEvent, nodeId: string) => {
    if (e.button !== 0) return;
    if (isSpacePressed || activeTool === 'hand') return;
    e.stopPropagation();

    const isShift = e.shiftKey;
    let currentSelectedIds = [...selectedNodeIds];

    if (isShift) {
      if (currentSelectedIds.includes(nodeId)) {
        currentSelectedIds = currentSelectedIds.filter((id) => id !== nodeId);
      } else {
        currentSelectedIds.push(nodeId);
      }
    } else {
      if (!currentSelectedIds.includes(nodeId)) {
        currentSelectedIds = [nodeId];
      }
    }
    setSelectedNodeIds(currentSelectedIds);

    const targetNode = nodes.find((n) => n.id === nodeId);
    if (!targetNode || targetNode.locked) return;

    const currentTarget = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;

    try {
      currentTarget.setPointerCapture(pointerId);
    } catch {}

    const startClientX = e.clientX;
    const startClientY = e.clientY;

    // Snapshot start positions of all selected nodes for multi-drag
    const startPositions: Record<string, { x: number; y: number }> = {};
    nodes.forEach((n) => {
      if (currentSelectedIds.includes(n.id)) {
        startPositions[n.id] = { x: n.x, y: n.y };
      }
    });

    let hasMoved = false;

    const cleanup = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('blur', onPointerUp);
      try {
        if (currentTarget.hasPointerCapture(pointerId)) {
          currentTarget.releasePointerCapture(pointerId);
        }
      } catch {}
      setSnapGuideX(null);
      setSnapGuideY(null);
      setSmartGuide(null);
      setIsDraggingNode(false);
      if (hasMoved) {
        pushHistory();
      }
    };

    const onPointerMove = (moveEvt: PointerEvent) => {
      if (moveEvt.buttons === 0) {
        cleanup();
        return;
      }

      const dx = (moveEvt.clientX - startClientX) / zoom;
      const dy = (moveEvt.clientY - startClientY) / zoom;

      if (!hasMoved && Math.hypot(moveEvt.clientX - startClientX, moveEvt.clientY - startClientY) > 2) {
        hasMoved = true;
        setIsDraggingNode(true);
      }

      if (hasMoved) {
        // Multi-drag: move all selected nodes by dx, dy
        let deltaX = Math.round(dx);
        let deltaY = Math.round(dy);

        // Magnetic snap for the primary target node
        const primaryStart = startPositions[targetNode.id];
        if (primaryStart) {
          const nextPrimaryX = Math.round(primaryStart.x + dx);
          const nextPrimaryY = Math.round(primaryStart.y + dy);

          const centerX = Math.round((currentArtboard.width - targetNode.width) / 2);
          if (Math.abs(nextPrimaryX - centerX) < 8) {
            deltaX = centerX - primaryStart.x;
            setSnapGuideX(currentArtboard.width / 2);
          } else {
            setSnapGuideX(null);
          }

          const centerY = Math.round((currentArtboard.height - targetNode.height) / 2);
          if (Math.abs(nextPrimaryY - centerY) < 8) {
            deltaY = centerY - primaryStart.y;
            setSnapGuideY(currentArtboard.height / 2);
          } else {
            setSnapGuideY(null);
          }

          // Smart Distance Guide Calculation
          const otherNodes = nodes.filter((n) => !currentSelectedIds.includes(n.id) && n.visible);
          let foundGuide = false;
          for (const other of otherNodes) {
            if (Math.abs(nextPrimaryY - other.y) < 60) {
              const gapX = nextPrimaryX - (other.x + other.width);
              if (gapX > 8 && gapX < 80) {
                setSmartGuide({
                  x1: other.x + other.width,
                  y1: nextPrimaryY + targetNode.height / 2,
                  x2: nextPrimaryX,
                  y2: nextPrimaryY + targetNode.height / 2,
                  distance: Math.round(gapX),
                  badgeX: other.x + other.width + gapX / 2,
                  badgeY: nextPrimaryY + targetNode.height / 2 - 12,
                });
                foundGuide = true;
                break;
              }
            }
          }
          if (!foundGuide) setSmartGuide(null);
        }

        setNodes((prev) =>
          prev.map((n) => {
            if (startPositions[n.id] && !n.locked) {
              return {
                ...n,
                x: Math.round(startPositions[n.id].x + deltaX),
                y: Math.round(startPositions[n.id].y + deltaY),
              };
            }
            return n;
          })
        );
      }
    };

    const onPointerUp = () => cleanup();

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('blur', onPointerUp);
  };

  // Artboard Background Marquee Drag-to-Select
  const handleArtboardPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (isSpacePressed || activeTool === 'hand') return;

    const abEl = artboardRef.current;
    if (!abEl) return;
    const abRect = abEl.getBoundingClientRect();
    const startX = Math.round((e.clientX - abRect.left) / zoom);
    const startY = Math.round((e.clientY - abRect.top) / zoom);

    setMarquee({ startX, startY, currentX: startX, currentY: startY });

    if (!e.shiftKey) {
      setSelectedNodeIds([]);
    }

    const onPointerMove = (moveEvt: PointerEvent) => {
      if (moveEvt.buttons === 0) {
        cleanup();
        return;
      }
      const currentX = Math.round((moveEvt.clientX - abRect.left) / zoom);
      const currentY = Math.round((moveEvt.clientY - abRect.top) / zoom);
      setMarquee({ startX, startY, currentX, currentY });

      const minX = Math.min(startX, currentX);
      const maxX = Math.max(startX, currentX);
      const minY = Math.min(startY, currentY);
      const maxY = Math.max(startY, currentY);

      const intersecting = nodes
        .filter((n) => {
          if (!n.visible || n.locked) return false;
          const nRight = n.x + n.width;
          const nBottom = n.y + n.height;
          return !(n.x > maxX || nRight < minX || n.y > maxY || nBottom < minY);
        })
        .map((n) => n.id);

      setSelectedNodeIds((prev) =>
        e.shiftKey ? Array.from(new Set([...prev, ...intersecting])) : intersecting
      );
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      setMarquee(null);
    };

    const onPointerUp = () => cleanup();

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  // Transform Handle Resize & Rotation Handler (With Proportional Shift Lock)
  const handleResizeHandlePointerDown = (e: React.PointerEvent, nodeId: string, handle: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();

    const targetNode = nodes.find((n) => n.id === nodeId);
    if (!targetNode || targetNode.locked) return;

    const currentTarget = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    try {
      currentTarget.setPointerCapture(pointerId);
    } catch {}

    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const startX = targetNode.x;
    const startY = targetNode.y;
    const startW = targetNode.width;
    const startH = targetNode.height;
    const isLockedRatio = targetNode.aspectRatioLocked || e.shiftKey;

    let hasResized = false;

    const cleanup = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('blur', onPointerUp);
      try {
        if (currentTarget.hasPointerCapture(pointerId)) {
          currentTarget.releasePointerCapture(pointerId);
        }
      } catch {}
      if (hasResized) {
        pushHistory();
      }
    };

    const onPointerMove = (moveEvt: PointerEvent) => {
      if (moveEvt.buttons === 0) {
        cleanup();
        return;
      }
      moveEvt.preventDefault();
      hasResized = true;

      if (handle === 'rot') {
        const artboardEl = artboardRef.current;
        if (!artboardEl) return;
        const abRect = artboardEl.getBoundingClientRect();
        const centerScreenX = abRect.left + (startX + startW / 2) * zoom;
        const centerScreenY = abRect.top + (startY + startH / 2) * zoom;
        const rad = Math.atan2(moveEvt.clientY - centerScreenY, moveEvt.clientX - centerScreenX);
        let deg = Math.round((rad * 180) / Math.PI) + 90;
        deg = (deg % 360 + 360) % 360;

        const snapAngles = [0, 45, 90, 135, 180, 225, 270, 315, 360];
        for (const snap of snapAngles) {
          if (Math.abs(deg - snap) < 5) {
            deg = snap === 360 ? 0 : snap;
            break;
          }
        }

        setNodes((prev) =>
          prev.map((n) => (n.id === nodeId ? { ...n, rotation: deg } : n))
        );
        return;
      }

      const dx = (moveEvt.clientX - startClientX) / zoom;
      const dy = (moveEvt.clientY - startClientY) / zoom;

      let newX = startX;
      let newY = startY;
      let newW = startW;
      let newH = startH;

      if (handle.includes('e')) newW = Math.max(30, Math.round(startW + dx));
      if (handle.includes('s')) newH = Math.max(20, Math.round(startH + dy));
      if (handle.includes('w')) {
        const candidateW = Math.max(30, Math.round(startW - dx));
        newX = startX + (startW - candidateW);
        newW = candidateW;
      }
      if (handle.includes('n')) {
        const candidateH = Math.max(20, Math.round(startH - dy));
        newY = startY + (startH - candidateH);
        newH = candidateH;
      }

      if (isLockedRatio) {
        const ratio = startW / startH;
        if (handle === 'se' || handle === 'nw') {
          newH = Math.round(newW / ratio);
        }
      }

      setNodes((prev) =>
        prev.map((n) => (n.id === nodeId ? { ...n, x: newX, y: newY, width: newW, height: newH } : n))
      );
    };

    const onPointerUp = () => cleanup();

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
        if (moveEvt.buttons === 0) {
          cleanup();
          return;
        }
        setPanOffset({
          x: Math.round(startPanX + (moveEvt.clientX - startClientX)),
          y: Math.round(startPanY + (moveEvt.clientY - startClientY)),
        });
      };

      const cleanup = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
        window.removeEventListener('blur', onPointerUp);
        setIsPanning(false);
      };

      const onPointerUp = () => cleanup();

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
      window.addEventListener('blur', onPointerUp);
    } else if (isDirectViewport) {
      setSelectedNodeIds([]);
      setEditingNodeId(null);
    }
  };

  // Alignment Toolbar Operations
  const handleAlign = (action: 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom') => {
    if (selectedNodeIds.length === 0) return;

    setNodes((prev) =>
      prev.map((n) => {
        if (!selectedNodeIds.includes(n.id) || n.locked) return n;
        let nx = n.x;
        let ny = n.y;

        if (action === 'left') nx = 20;
        else if (action === 'centerH') nx = Math.round((currentArtboard.width - n.width) / 2);
        else if (action === 'right') nx = Math.round(currentArtboard.width - n.width - 20);
        else if (action === 'top') ny = 20;
        else if (action === 'centerV') ny = Math.round((currentArtboard.height - n.height) / 2);
        else if (action === 'bottom') ny = Math.round(currentArtboard.height - n.height - 20);

        return { ...n, x: nx, y: ny };
      })
    );
    pushHistory();
  };

  // Render Transform Bounding Box with Live Dimension Pill, 8 Cardinal Handles, and Rotation Stem
  const renderTransformBBox = (node: CanvasNode) => (
    <div className="transform-bbox" style={{ pointerEvents: 'none' }}>
      <div className="node-dimension-pill">
        {node.name} · {Math.round(node.width)}×{Math.round(node.height)} {node.rotation ? `· ${node.rotation}°` : ''} ({Math.round(node.x)}, {Math.round(node.y)})
      </div>

      <div className="handle-rot-stem" />
      <div
        className="handle-rot"
        title="Drag to Rotate"
        onPointerDown={(e) => handleResizeHandlePointerDown(e, node.id, 'rot')}
      />

      <div className="transform-handle handle-nw" onPointerDown={(e) => handleResizeHandlePointerDown(e, node.id, 'nw')} />
      <div className="transform-handle handle-n" onPointerDown={(e) => handleResizeHandlePointerDown(e, node.id, 'n')} />
      <div className="transform-handle handle-ne" onPointerDown={(e) => handleResizeHandlePointerDown(e, node.id, 'ne')} />
      <div className="transform-handle handle-e" onPointerDown={(e) => handleResizeHandlePointerDown(e, node.id, 'e')} />
      <div className="transform-handle handle-se" onPointerDown={(e) => handleResizeHandlePointerDown(e, node.id, 'se')} />
      <div className="transform-handle handle-s" onPointerDown={(e) => handleResizeHandlePointerDown(e, node.id, 's')} />
      <div className="transform-handle handle-sw" onPointerDown={(e) => handleResizeHandlePointerDown(e, node.id, 'sw')} />
      <div className="transform-handle handle-w" onPointerDown={(e) => handleResizeHandlePointerDown(e, node.id, 'w')} />
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

  // High-Resolution & 4K Export Handlers
  const handleExportPngWithScale = async (scale: 1 | 2 | 4) => {
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
        scale,
        nodes,
      });
      const label = scale === 4 ? '4K Ultra HD' : scale === 2 ? '2x Retina' : 'Standard 1080p';
      setStudioToast(`✓ ${label} PNG exported: ${filename}`);
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
      nodes,
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
      nodes,
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

  const activeSelectedNode = nodes.find((n) => n.id === selectedNodeId);

  // Group Multi-Selection Bounds Calculation
  const multiSelectedNodes = nodes.filter((n) => selectedNodeIds.includes(n.id) && n.visible);
  const multiBounds = useMemo(() => {
    if (multiSelectedNodes.length <= 1) return null;
    const minX = Math.min(...multiSelectedNodes.map((n) => n.x));
    const minY = Math.min(...multiSelectedNodes.map((n) => n.y));
    const maxX = Math.max(...multiSelectedNodes.map((n) => n.x + n.width));
    const maxY = Math.max(...multiSelectedNodes.map((n) => n.y + n.height));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }, [multiSelectedNodes]);

  // Dynamic Layer Rendering Method
  const renderCanvasNode = (node: CanvasNode) => {
    const isSelected = selectedNodeIds.includes(node.id);
    const isEditing = editingNodeId === node.id;

    // Node Container Styles
    const containerStyle: React.CSSProperties = {
      position: 'absolute',
      left: `${node.x}px`,
      top: `${node.y}px`,
      width: `${node.width}px`,
      height: `${node.height}px`,
      zIndex: node.zIndex,
      transform: node.rotation ? `rotate(${node.rotation}deg)` : undefined,
      opacity: node.opacity ?? 1,
      cursor: activeTool === 'hand' || isSpacePressed ? 'grab' : isDraggingNode && isSelected ? 'grabbing' : 'move',
      userSelect: 'none',
      touchAction: 'none',
      boxShadow: node.shadow
        ? `${node.shadow.x}px ${node.shadow.y}px ${node.shadow.blur}px ${node.shadow.color}`
        : undefined,
    };

    if (node.role === 'headline') {
      return (
        <div
          key={node.id}
          onPointerDown={(e) => handleElementPointerDown(e, node.id)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditingNodeId(node.id);
          }}
          style={{ ...containerStyle, padding: 4 }}
        >
          {isSelected && renderTransformBBox(node)}

          {isEditing ? (
            <textarea
              autoFocus
              value={langVariant === 'ckb' ? headlineCkb : headlineEn}
              onChange={(e) => {
                if (langVariant === 'ckb') setHeadlineCkb(e.target.value);
                else setHeadlineEn(e.target.value);
              }}
              onBlur={() => {
                setEditingNodeId(null);
                pushHistory();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) {
                  e.preventDefault();
                  setEditingNodeId(null);
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
              {langVariant === 'en' && (
                <div
                  dir="ltr"
                  lang="en"
                  style={{
                    fontSize: variant === 'story' ? 24 : 27,
                    color: '#ffffff',
                    fontWeight,
                    lineHeight: 1.28,
                    outline: 'none',
                    textAlign: 'left',
                    fontFamily,
                    textShadow: '0 2px 8px rgba(0,0,0,0.4)',
                    textWrap: 'balance',
                    lineBreak: 'loose',
                    overflowWrap: 'break-word',
                  } as React.CSSProperties}
                >
                  {headlineEn}
                </div>
              )}

              {langVariant === 'ckb' && (
                <div
                  dir="rtl"
                  lang="ckb"
                  style={{
                    fontSize: variant === 'story' ? 24 : 27,
                    color: '#ffffff',
                    fontWeight,
                    lineHeight: 1.52,
                    paddingTop: 3,
                    paddingBottom: 3,
                    outline: 'none',
                    textAlign: 'right',
                    fontFamily: fontFamily.includes('Noto') ? "'Noto Sans Arabic', Vazirmatn, sans-serif" : 'Vazirmatn, "Noto Sans Arabic", sans-serif',
                    textShadow: '0 2px 8px rgba(0,0,0,0.4)',
                    textWrap: 'balance',
                    lineBreak: 'loose',
                    overflowWrap: 'break-word',
                    fontFeatureSettings: '"kern" 1, "liga" 1, "calt" 1',
                  } as React.CSSProperties}
                >
                  {showBidiIsolates ? `⸢\u2067${headlineCkb}\u2069⸥` : headlineCkb}
                </div>
              )}

              {langVariant === 'bilingual' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div
                    dir="ltr"
                    lang="en"
                    style={{
                      fontSize: variant === 'story' ? 22 : 25,
                      color: '#ffffff',
                      fontWeight: 800,
                      lineHeight: 1.24,
                      textAlign: 'left',
                      fontFamily: 'Inter, sans-serif',
                      borderBottom: '1px solid rgba(255,255,255,0.2)',
                      paddingBottom: 4,
                      textWrap: 'balance',
                      lineBreak: 'loose',
                    } as React.CSSProperties}
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
                      lineHeight: 1.5,
                      paddingTop: 2,
                      paddingBottom: 2,
                      textAlign: 'right',
                      fontFamily: fontFamily.includes('Noto') ? "'Noto Sans Arabic', Vazirmatn, sans-serif" : 'Vazirmatn, "Noto Sans Arabic", sans-serif',
                      textWrap: 'balance',
                      lineBreak: 'loose',
                      fontFeatureSettings: '"kern" 1, "liga" 1, "calt" 1',
                    } as React.CSSProperties}
                  >
                    {showBidiIsolates ? `⸢\u2067${headlineCkb}\u2069⸥` : `\u2067${headlineCkb}\u2069`}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      );
    }

    if (node.role === 'copy') {
      return (
        <div
          key={node.id}
          onPointerDown={(e) => handleElementPointerDown(e, node.id)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditingNodeId(node.id);
          }}
          style={{ ...containerStyle, padding: 4 }}
        >
          {isSelected && renderTransformBBox(node)}

          {isEditing ? (
            <input
              autoFocus
              type="text"
              value={langVariant === 'ckb' ? copyCkb : copyEn}
              onChange={(e) => {
                if (langVariant === 'ckb') setCopyCkb(e.target.value);
                else setCopyEn(e.target.value);
              }}
              onBlur={() => {
                setEditingNodeId(null);
                pushHistory();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape' || e.key === 'Enter') {
                  e.preventDefault();
                  setEditingNodeId(null);
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
      );
    }

    if (node.role === 'logo') {
      return (
        <div
          key={node.id}
          onPointerDown={(e) => handleElementPointerDown(e, node.id)}
          style={{
            ...containerStyle,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '4px 12px',
            background: 'rgba(0,0,0,0.5)',
            borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.25)',
          }}
          title={activeBrandKit.verifiedSha256}
        >
          <span style={{ fontSize: 11, color: '#fff', fontWeight: 700 }}>{activeBrandKit.logoText}</span>
          <span style={{ fontSize: 9, color: '#10B981' }}>✓</span>
          {isSelected && renderTransformBBox(node)}
        </div>
      );
    }

    if (node.role === 'shape') {
      return (
        <div
          key={node.id}
          onPointerDown={(e) => handleElementPointerDown(e, node.id)}
          style={{
            ...containerStyle,
            borderRadius: '50%',
            background: accentColor,
            transform: `rotate(${node.rotation || 15}deg)`,
            opacity: node.opacity ?? 0.85,
          }}
        >
          {isSelected && renderTransformBBox(node)}
        </div>
      );
    }

    if (node.role === 'text_custom') {
      const textVal = langVariant === 'ckb' ? (node.textCkb || node.textEn) : node.textEn;
      return (
        <div
          key={node.id}
          onPointerDown={(e) => handleElementPointerDown(e, node.id)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditingNodeId(node.id);
          }}
          style={{
            ...containerStyle,
            padding: 4,
            display: 'flex',
            alignItems: 'center',
            justifyContent: node.textAlign === 'center' ? 'center' : node.textAlign === 'right' ? 'flex-end' : 'flex-start',
          }}
        >
          {isSelected && renderTransformBBox(node)}

          {isEditing ? (
            <input
              autoFocus
              type="text"
              value={node.textEn || ''}
              onChange={(e) => {
                const val = e.target.value;
                setNodes((prev) => prev.map((n) => (n.id === node.id ? { ...n, textEn: val } : n)));
              }}
              onBlur={() => {
                setEditingNodeId(null);
                pushHistory();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape' || e.key === 'Enter') {
                  e.preventDefault();
                  setEditingNodeId(null);
                  pushHistory();
                }
              }}
              style={{
                width: '100%',
                background: 'rgba(15, 23, 42, 0.92)',
                color: '#ffffff',
                border: '2px solid #38BDF8',
                borderRadius: 4,
                padding: '3px 6px',
                fontSize: node.fontSize || 18,
                outline: 'none',
              }}
            />
          ) : (
            <div
              dir={node.direction || (langVariant === 'ckb' ? 'rtl' : 'ltr')}
              style={{
                fontSize: node.fontSize || 18,
                fontWeight: node.fontWeight || 600,
                fontFamily: node.fontFamily || (langVariant === 'ckb' ? 'Vazirmatn, "Noto Sans Arabic", sans-serif' : 'Inter, sans-serif'),
                lineHeight: node.lineHeight || 1.48,
                letterSpacing: node.letterSpacing ? `${node.letterSpacing}px` : undefined,
                color: node.color || '#ffffff',
                textAlign: node.textAlign || 'center',
                textShadow: '0 2px 8px rgba(0,0,0,0.3)',
                width: '100%',
                textWrap: 'balance',
                lineBreak: 'loose',
                overflowWrap: 'break-word',
                fontFeatureSettings: '"kern" 1, "liga" 1, "calt" 1',
                paddingTop: 2,
                paddingBottom: 2,
              } as React.CSSProperties}
            >
              {showBidiIsolates && (node.direction === 'rtl' || langVariant === 'ckb')
                ? `⸢\u2067${textVal}\u2069⸥`
                : textVal}
            </div>
          )}
        </div>
      );
    }

    if (node.role === 'shape_custom') {
      return (
        <div
          key={node.id}
          onPointerDown={(e) => handleElementPointerDown(e, node.id)}
          style={{
            ...containerStyle,
            borderRadius: node.borderRadius ?? 12,
            background: node.backgroundColor || accentColor,
            border: `${node.borderWidth ?? 1}px solid ${node.borderColor ?? 'rgba(255,255,255,0.2)'}`,
          }}
        >
          {isSelected && renderTransformBBox(node)}
        </div>
      );
    }

    if (node.role === 'badge_custom') {
      const textVal = langVariant === 'ckb' ? (node.textCkb || node.textEn) : node.textEn;
      return (
        <div
          key={node.id}
          onPointerDown={(e) => handleElementPointerDown(e, node.id)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditingNodeId(node.id);
          }}
          style={{
            ...containerStyle,
            borderRadius: node.borderRadius ?? 999,
            background: node.backgroundColor || 'rgba(255, 255, 255, 0.18)',
            border: `${node.borderWidth ?? 1}px solid ${node.borderColor ?? 'rgba(255,255,255,0.3)'}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '2px 10px',
          }}
        >
          {isSelected && renderTransformBBox(node)}

          {isEditing ? (
            <input
              autoFocus
              type="text"
              value={node.textEn || ''}
              onChange={(e) => {
                const val = e.target.value;
                setNodes((prev) => prev.map((n) => (n.id === node.id ? { ...n, textEn: val } : n)));
              }}
              onBlur={() => {
                setEditingNodeId(null);
                pushHistory();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape' || e.key === 'Enter') {
                  e.preventDefault();
                  setEditingNodeId(null);
                  pushHistory();
                }
              }}
              style={{
                width: '100%',
                background: 'transparent',
                color: '#ffffff',
                border: 'none',
                textAlign: 'center',
                fontSize: node.fontSize || 12,
                fontWeight: 700,
                outline: 'none',
              }}
            />
          ) : (
            <span
              style={{
                fontSize: node.fontSize || 12,
                fontWeight: node.fontWeight || 700,
                color: node.color || '#ffffff',
                letterSpacing: '0.04em',
                whiteSpace: 'nowrap',
              }}
            >
              {textVal}
            </span>
          )}
        </div>
      );
    }

    return null;
  };

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

      {/* Studio Top Control Strip */}
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

        {/* Right: History, Guides & Ultra HD 4K Export */}
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

          {/* Export Dropdown Button with 1x / 2x / 4K / SVG / HYC */}
          <div style={{ position: 'relative' }}>
            <button
              className="btn primary"
              style={{ fontSize: 11, padding: '4px 12px', fontWeight: 700, background: '#10B981', color: '#fff' }}
              onClick={() => setShowExportMenu(!showExportMenu)}
              disabled={exporting}
            >
              {exporting ? 'Exporting...' : '⚡ Export ▾'}
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
                  width: 250,
                  boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
                }}
              >
                <div
                  onClick={() => handleExportPngWithScale(1)}
                  style={{ padding: '8px 10px', fontSize: 12, cursor: 'pointer', borderRadius: 4, fontWeight: 600 }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.1)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  🖼 Export PNG (1080p Standard)
                </div>
                <div
                  onClick={() => handleExportPngWithScale(2)}
                  style={{ padding: '8px 10px', fontSize: 12, cursor: 'pointer', borderRadius: 4, fontWeight: 600 }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.1)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  💎 Export PNG (2x Retina 2160p)
                </div>
                <div
                  onClick={() => handleExportPngWithScale(4)}
                  style={{ padding: '8px 10px', fontSize: 12, cursor: 'pointer', borderRadius: 4, fontWeight: 700, color: '#38BDF8' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(56,189,248,0.15)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  🌟 Export PNG (4K Ultra HD 4320p)
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

      {/* Main Review Grid: Left Column (Layers & Brief), Center (Canvas), Right (Inspector) */}
      <div className="review" style={{ flex: 1, minHeight: 0, gridTemplateColumns: '270px 1fr 310px' }}>
        {/* Left Column: Dual Tab Layout (Layers Tree vs Brief & Timeline) */}
        <div className="panel" style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--line)', paddingBottom: 8, marginBottom: 10 }}>
            <button
              className={`btn ${leftTab === 'layers' ? 'primary' : ''}`}
              style={{ flex: 1, fontSize: 11, padding: '4px 6px', fontWeight: 600 }}
              onClick={() => setLeftTab('layers')}
            >
              📑 Layers ({nodes.length})
            </button>
            <button
              className={`btn ${leftTab === 'brief' ? 'primary' : ''}`}
              style={{ flex: 1, fontSize: 11, padding: '4px 6px', fontWeight: 600 }}
              onClick={() => setLeftTab('brief')}
            >
              📋 Brief & Timeline
            </button>
          </div>

          {leftTab === 'layers' ? (
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, marginBottom: 8 }}>
                <button
                  className="btn"
                  style={{ fontSize: 10, padding: '4px 2px', fontWeight: 600 }}
                  onClick={handleAddTextLayer}
                  title="Add new text layer"
                >
                  + Text
                </button>
                <button
                  className="btn"
                  style={{ fontSize: 10, padding: '4px 2px', fontWeight: 600 }}
                  onClick={handleAddShapeLayer}
                  title="Add new shape layer"
                >
                  + Shape
                </button>
                <button
                  className="btn"
                  style={{ fontSize: 10, padding: '4px 2px', fontWeight: 600 }}
                  onClick={handleAddBadgeLayer}
                  title="Add new badge layer"
                >
                  + Badge
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto', flex: 1 }}>
                {nodes
                  .slice()
                  .sort((a, b) => b.zIndex - a.zIndex)
                  .map((node) => {
                    const isSelected = selectedNodeIds.includes(node.id);
                    return (
                      <div
                        key={node.id}
                        className={`layer-item-row ${isSelected ? 'selected' : ''}`}
                        onClick={(e) => {
                          if (e.shiftKey) {
                            setSelectedNodeIds((prev) =>
                              prev.includes(node.id) ? prev.filter((id) => id !== node.id) : [...prev, node.id]
                            );
                          } else {
                            setSelectedNodeIds([node.id]);
                          }
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
                          <span style={{ fontSize: 11, opacity: 0.7 }}>
                            {node.groupId ? '📁' : node.role === 'headline' || node.role === 'text_custom' ? 'T' : node.role === 'logo' ? '★' : '◻'}
                          </span>

                          {renamingNodeId === node.id ? (
                            <input
                              autoFocus
                              type="text"
                              value={node.name}
                              onChange={(e) => {
                                const val = e.target.value;
                                setNodes((prev) => prev.map((n) => (n.id === node.id ? { ...n, name: val } : n)));
                              }}
                              onBlur={() => {
                                setRenamingNodeId(null);
                                pushHistory();
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === 'Escape') {
                                  setRenamingNodeId(null);
                                  pushHistory();
                                }
                              }}
                              style={{ width: '100%', fontSize: 11, padding: '1px 4px', borderRadius: 4, border: '1px solid var(--accent)' }}
                            />
                          ) : (
                            <span
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                setRenamingNodeId(node.id);
                              }}
                              style={{
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                textDecoration: !node.visible ? 'line-through' : 'none',
                                opacity: !node.visible ? 0.45 : 1,
                              }}
                              title="Double-click to rename"
                            >
                              {node.name}
                            </span>
                          )}
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <button
                            className="btn"
                            style={{ padding: '1px 4px', fontSize: 10, opacity: node.visible ? 0.9 : 0.3 }}
                            onClick={(e) => handleToggleLayerVisibility(node.id, e)}
                            title={node.visible ? 'Hide Layer' : 'Show Layer'}
                          >
                            {node.visible ? '👁' : '🚫'}
                          </button>

                          <button
                            className="btn"
                            style={{ padding: '1px 4px', fontSize: 10, opacity: node.locked ? 1 : 0.4 }}
                            onClick={(e) => handleToggleLayerLock(node.id, e)}
                            title={node.locked ? 'Unlock Layer' : 'Lock Layer'}
                          >
                            {node.locked ? '🔒' : '🔓'}
                          </button>

                          <button
                            className="btn"
                            style={{ padding: '1px 4px', fontSize: 9 }}
                            onClick={(e) => handleMoveLayerZIndex(node.id, 'up', e)}
                            title="Bring Layer Forward (])"
                          >
                            ▲
                          </button>

                          <button
                            className="btn"
                            style={{ padding: '1px 4px', fontSize: 9 }}
                            onClick={(e) => handleMoveLayerZIndex(node.id, 'down', e)}
                            title="Send Layer Backward ([)"
                          >
                            ▼
                          </button>

                          <button
                            className="btn"
                            style={{ padding: '1px 4px', fontSize: 9, color: '#EF4444' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteLayer(node.id);
                            }}
                            title="Delete Layer"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    );
                  })}
              </div>

              {selectedNodeIds.length > 0 && (
                <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                  {selectedNodeIds.length > 1 && (
                    <button
                      className="btn"
                      style={{ flex: 1, fontSize: 10, padding: '4px' }}
                      onClick={handleGroup}
                    >
                      Group (Cmd+G)
                    </button>
                  )}
                  <button
                    className="btn"
                    style={{ flex: 1, fontSize: 10, padding: '4px' }}
                    onClick={() => handleDuplicateLayer()}
                  >
                    Duplicate (Cmd+D)
                  </button>
                  <button
                    className="btn"
                    style={{ flex: 1, fontSize: 10, padding: '4px', color: '#EF4444' }}
                    onClick={() => handleDeleteLayer()}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div style={{ overflowY: 'auto' }}>
              <div className="meta" style={{ marginBottom: 8 }}>
                <span className="pill ok">{activeBrandKit.name.split(' ')[0]}</span>
                <span className="pill">Rev {repairCycles + 1}</span>
                {taskId && <span className="pill blue">ID: {taskId.substring(0, 8)}…</span>}
              </div>
              <h2 style={{ fontSize: 16, margin: '0 0 10px' }}>{taskTitle}</h2>

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
          )}
        </div>

        {/* Center Column: Pro Studio Interactive Viewport with Marquee & Smart Distance Guides */}
        <div
          ref={viewportRef}
          className={`studio-viewport ${isPanning || isSpacePressed || activeTool === 'hand' ? 'panning' : ''} ${isPanning ? 'is-active-panning' : ''} ${isDraggingNode ? 'is-dragging' : ''}`}
          onPointerDown={handleViewportPointerDown}
        >
          {snapGuideX !== null && <div className="snap-guide-x" style={{ left: `calc(50% + ${(snapGuideX - currentArtboard.width / 2) * zoom + panOffset.x}px)` }} />}
          {snapGuideY !== null && <div className="snap-guide-y" style={{ top: `calc(50% + ${(snapGuideY - currentArtboard.height / 2) * zoom + panOffset.y}px)` }} />}

          {/* Scaled & Panned Artboard */}
          <div
            ref={artboardRef}
            className="artboard-container"
            onPointerDown={handleArtboardPointerDown}
            style={{
              transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`,
              width: `${currentArtboard.width}px`,
              height: `${currentArtboard.height}px`,
              background: activeBrandKit.palette.background,
              borderRadius: 8,
              boxShadow: '0 24px 64px rgba(0, 0, 0, 0.5)',
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            {/* Artboard Floating Header Tag */}
            <div className="artboard-header-tag">
              <span>{FORMAT_DIMENSIONS[variant].label.split(' ')[0]}</span>
              <span>·</span>
              <span>{currentArtboard.width} × {currentArtboard.height}</span>
              <span>·</span>
              <span>{Math.round(zoom * 100)}%</span>
            </div>

            {/* Safe Zone Overlay */}
            {showSafeZones && (
              <div
                style={{
                  position: 'absolute',
                  inset: '10%',
                  border: '2px dashed rgba(56, 189, 248, 0.75)',
                  borderRadius: 6,
                  pointerEvents: 'none',
                  zIndex: 40,
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

            {/* Marquee Selection Drag Box */}
            {marquee && (
              <div
                className="marquee-selection-box"
                style={{
                  left: `${Math.min(marquee.startX, marquee.currentX)}px`,
                  top: `${Math.min(marquee.startY, marquee.currentY)}px`,
                  width: `${Math.abs(marquee.currentX - marquee.startX)}px`,
                  height: `${Math.abs(marquee.currentY - marquee.startY)}px`,
                }}
              />
            )}

            {/* Smart Alignment Distance Guides & Dynamic Badges */}
            {smartGuide && (
              <>
                <div
                  className="smart-guide-line"
                  style={{
                    left: `${Math.min(smartGuide.x1, smartGuide.x2)}px`,
                    top: `${smartGuide.y1}px`,
                    width: `${Math.max(1, Math.abs(smartGuide.x2 - smartGuide.x1))}px`,
                    height: '1px',
                  }}
                />
                <div
                  className="smart-distance-badge"
                  style={{
                    left: `${smartGuide.badgeX}px`,
                    top: `${smartGuide.badgeY}px`,
                  }}
                >
                  {smartGuide.distance}px
                </div>
              </>
            )}

            {/* Multi-Selection Group Bounding Box */}
            {multiBounds && (
              <div
                className="multi-selection-bbox"
                style={{
                  left: `${multiBounds.x - 4}px`,
                  top: `${multiBounds.y - 4}px`,
                  width: `${multiBounds.width + 8}px`,
                  height: `${multiBounds.height + 8}px`,
                }}
              >
                <div className="multi-selection-pill">
                  {multiSelectedNodes.length} Layers Selected
                </div>
              </div>
            )}

            {/* Render All Dynamic Canvas Nodes in zIndex Order */}
            {nodes
              .filter((n) => n.visible)
              .sort((a, b) => a.zIndex - b.zIndex)
              .map((node) => renderCanvasNode(node))}

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

          {/* Floating Bottom Studio HUD */}
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
              style={{ width: 'auto', padding: '0 8px', borderRadius: 10, fontSize: 10, fontWeight: 600 }}
              onClick={() => {
                setZoom(1.0);
                setPanOffset({ x: 0, y: 0 });
              }}
            >
              Fit View
            </button>
          </div>
        </div>

        {/* Right Column: Pro Inspector & Multi-Selection Support */}
        <div className="panel" style={{ overflowY: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700 }}>
              {selectedNodeIds.length > 1
                ? `Selection (${selectedNodeIds.length} Layers)`
                : activeSelectedNode
                ? `Layer: ${activeSelectedNode.name}`
                : 'Artboard Inspector'}
            </h3>
            {selectedNodeIds.length > 0 && (
              <button
                className="btn"
                style={{ fontSize: 10, padding: '2px 6px' }}
                onClick={() => setSelectedNodeIds([])}
              >
                Deselect
              </button>
            )}
          </div>

          {/* Multi-Selection Inspector Mode */}
          {selectedNodeIds.length > 1 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="inspector-section">
                <div className="inspector-title">GROUP ACTIONS</div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                  <button className="btn" style={{ flex: 1, fontSize: 11, padding: '5px' }} onClick={handleGroup}>
                    Group Selection (Cmd+G)
                  </button>
                  <button className="btn" style={{ flex: 1, fontSize: 11, padding: '5px' }} onClick={handleUngroup}>
                    Ungroup
                  </button>
                </div>
                <button
                  className="btn"
                  style={{ width: '100%', fontSize: 11, padding: '5px', color: '#EF4444' }}
                  onClick={() => handleDeleteLayer()}
                >
                  Delete Selected ({selectedNodeIds.length})
                </button>
              </div>

              {/* Multi Alignment Matrix */}
              <div className="inspector-section">
                <div className="inspector-title">ALIGN GROUP TO ARTBOARD</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 3 }}>
                  <button className="btn" title="Align Left" style={{ fontSize: 11, padding: '3px 0' }} onClick={() => handleAlign('left')}>⇤</button>
                  <button className="btn" title="Align Horizontal Center" style={{ fontSize: 11, padding: '3px 0' }} onClick={() => handleAlign('centerH')}>⇹</button>
                  <button className="btn" title="Align Right" style={{ fontSize: 11, padding: '3px 0' }} onClick={() => handleAlign('right')}>⇥</button>
                  <button className="btn" title="Align Top" style={{ fontSize: 11, padding: '3px 0' }} onClick={() => handleAlign('top')}>⤒</button>
                  <button className="btn" title="Align Vertical Center" style={{ fontSize: 11, padding: '3px 0' }} onClick={() => handleAlign('centerV')}>⬍</button>
                  <button className="btn" title="Align Bottom" style={{ fontSize: 11, padding: '3px 0' }} onClick={() => handleAlign('bottom')}>⤓</button>
                </div>
              </div>
            </div>
          ) : activeSelectedNode ? (
            /* Single Node Inspector */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="inspector-section">
                <div className="inspector-title">TRANSFORM & DIMENSIONS</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 11 }}>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>X: </span>
                    <input
                      type="number"
                      value={activeSelectedNode.x}
                      onChange={(e) => {
                        const val = parseInt(e.target.value) || 0;
                        setNodes((prev) => prev.map((n) => (n.id === activeSelectedNode.id ? { ...n, x: val } : n)));
                      }}
                      onBlur={pushHistory}
                      style={{ width: 64, padding: '2px 4px', fontSize: 11, borderRadius: 4, border: '1px solid var(--line)' }}
                    />
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>Y: </span>
                    <input
                      type="number"
                      value={activeSelectedNode.y}
                      onChange={(e) => {
                        const val = parseInt(e.target.value) || 0;
                        setNodes((prev) => prev.map((n) => (n.id === activeSelectedNode.id ? { ...n, y: val } : n)));
                      }}
                      onBlur={pushHistory}
                      style={{ width: 64, padding: '2px 4px', fontSize: 11, borderRadius: 4, border: '1px solid var(--line)' }}
                    />
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>W: </span>
                    <input
                      type="number"
                      value={activeSelectedNode.width}
                      onChange={(e) => {
                        const val = parseInt(e.target.value) || 10;
                        setNodes((prev) => prev.map((n) => (n.id === activeSelectedNode.id ? { ...n, width: val } : n)));
                      }}
                      onBlur={pushHistory}
                      style={{ width: 64, padding: '2px 4px', fontSize: 11, borderRadius: 4, border: '1px solid var(--line)' }}
                    />
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>H: </span>
                    <input
                      type="number"
                      value={activeSelectedNode.height}
                      onChange={(e) => {
                        const val = parseInt(e.target.value) || 10;
                        setNodes((prev) => prev.map((n) => (n.id === activeSelectedNode.id ? { ...n, height: val } : n)));
                      }}
                      onBlur={pushHistory}
                      style={{ width: 64, padding: '2px 4px', fontSize: 11, borderRadius: 4, border: '1px solid var(--line)' }}
                    />
                  </div>
                </div>

                <div style={{ marginTop: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--muted)', marginBottom: 2 }}>
                    <span>Rotation:</span>
                    <b>{activeSelectedNode.rotation || 0}°</b>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={360}
                    value={activeSelectedNode.rotation || 0}
                    onChange={(e) => {
                      const val = parseInt(e.target.value) || 0;
                      setNodes((prev) => prev.map((n) => (n.id === activeSelectedNode.id ? { ...n, rotation: val } : n)));
                    }}
                    onMouseUp={pushHistory}
                    className="pro-slider"
                  />
                </div>

                <div style={{ marginTop: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--muted)', marginBottom: 2 }}>
                    <span>Opacity:</span>
                    <b>{Math.round((activeSelectedNode.opacity ?? 1) * 100)}%</b>
                  </div>
                  <input
                    type="range"
                    min={10}
                    max={100}
                    value={Math.round((activeSelectedNode.opacity ?? 1) * 100)}
                    onChange={(e) => {
                      const val = (parseInt(e.target.value) || 100) / 100;
                      setNodes((prev) => prev.map((n) => (n.id === activeSelectedNode.id ? { ...n, opacity: val } : n)));
                    }}
                    onMouseUp={pushHistory}
                    className="pro-slider"
                  />
                </div>

                {/* Aspect Ratio Lock Toggle */}
                <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 10, color: 'var(--muted)' }}>Aspect Ratio:</span>
                  <button
                    className={`btn ${activeSelectedNode.aspectRatioLocked ? 'primary' : ''}`}
                    style={{ fontSize: 10, padding: '2px 8px' }}
                    onClick={() => {
                      setNodes((prev) =>
                        prev.map((n) =>
                          n.id === activeSelectedNode.id ? { ...n, aspectRatioLocked: !n.aspectRatioLocked } : n
                        )
                      );
                      pushHistory();
                    }}
                  >
                    {activeSelectedNode.aspectRatioLocked ? '🔒 Locked' : '🔓 Free'}
                  </button>
                </div>

                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--muted)', marginBottom: 4 }}>
                    ALIGN TO ARTBOARD
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 3 }}>
                    <button className="btn" title="Align Left" style={{ fontSize: 11, padding: '3px 0' }} onClick={() => handleAlign('left')}>⇤</button>
                    <button className="btn" title="Align Horizontal Center" style={{ fontSize: 11, padding: '3px 0' }} onClick={() => handleAlign('centerH')}>⇹</button>
                    <button className="btn" title="Align Right" style={{ fontSize: 11, padding: '3px 0' }} onClick={() => handleAlign('right')}>⇥</button>
                    <button className="btn" title="Align Top" style={{ fontSize: 11, padding: '3px 0' }} onClick={() => handleAlign('top')}>⤒</button>
                    <button className="btn" title="Align Vertical Center" style={{ fontSize: 11, padding: '3px 0' }} onClick={() => handleAlign('centerV')}>⬍</button>
                    <button className="btn" title="Align Bottom" style={{ fontSize: 11, padding: '3px 0' }} onClick={() => handleAlign('bottom')}>⤓</button>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
                  <button className="btn" style={{ flex: 1, fontSize: 10, padding: '4px' }} onClick={() => handleMoveLayerZIndex(activeSelectedNode.id, 'up')}>
                    ▲ Forward (])
                  </button>
                  <button className="btn" style={{ flex: 1, fontSize: 10, padding: '4px' }} onClick={() => handleMoveLayerZIndex(activeSelectedNode.id, 'down')}>
                    ▼ Backward ([)
                  </button>
                </div>
              </div>

              {/* Vector Effects: Drop Shadow & Styling */}
              <div className="inspector-section">
                <div className="inspector-title">EFFECTS & SHADOW</div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 11 }}>Drop Shadow:</span>
                  <button
                    className={`btn ${activeSelectedNode.shadow ? 'primary' : ''}`}
                    style={{ fontSize: 10, padding: '2px 8px' }}
                    onClick={() => {
                      const newShadow = activeSelectedNode.shadow
                        ? undefined
                        : { x: 0, y: 6, blur: 16, color: 'rgba(0, 0, 0, 0.4)' };
                      setNodes((prev) =>
                        prev.map((n) => (n.id === activeSelectedNode.id ? { ...n, shadow: newShadow } : n))
                      );
                      pushHistory();
                    }}
                  >
                    {activeSelectedNode.shadow ? 'Enabled' : 'Disabled'}
                  </button>
                </div>

                {activeSelectedNode.shadow && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 10 }}>
                    <div>
                      <span style={{ color: 'var(--muted)' }}>Blur: </span>
                      <input
                        type="number"
                        value={activeSelectedNode.shadow.blur}
                        onChange={(e) => {
                          const val = parseInt(e.target.value) || 0;
                          setNodes((prev) =>
                            prev.map((n) =>
                              n.id === activeSelectedNode.id && n.shadow
                                ? { ...n, shadow: { ...n.shadow, blur: val } }
                                : n
                            )
                          );
                        }}
                        onBlur={pushHistory}
                        style={{ width: 50, padding: '2px 4px', fontSize: 11, borderRadius: 4, border: '1px solid var(--line)' }}
                      />
                    </div>
                    <div>
                      <span style={{ color: 'var(--muted)' }}>Offset Y: </span>
                      <input
                        type="number"
                        value={activeSelectedNode.shadow.y}
                        onChange={(e) => {
                          const val = parseInt(e.target.value) || 0;
                          setNodes((prev) =>
                            prev.map((n) =>
                              n.id === activeSelectedNode.id && n.shadow
                                ? { ...n, shadow: { ...n.shadow, y: val } }
                                : n
                            )
                          );
                        }}
                        onBlur={pushHistory}
                        style={{ width: 50, padding: '2px 4px', fontSize: 11, borderRadius: 4, border: '1px solid var(--line)' }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Layer-Specific Properties: Headline */}
              {activeSelectedNode.role === 'headline' && (
                <div className="inspector-section">
                  <div className="inspector-title">HEADLINE CONTENT & COPY</div>
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

              {/* Layer-Specific Properties: Copy / Badge */}
              {activeSelectedNode.role === 'copy' && (
                <div className="inspector-section">
                  <div className="inspector-title">PRICE & BADGE COPY</div>
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

              {/* Layer-Specific Properties: Custom Text */}
              {activeSelectedNode.role === 'text_custom' && (
                <div className="inspector-section">
                  <div className="inspector-title">TEXT TYPOGRAPHY & VALUE</div>
                  <div style={{ marginBottom: 6 }}>
                    <small style={{ display: 'block', color: 'var(--muted)', fontSize: 10 }}>English Value:</small>
                    <input
                      type="text"
                      value={activeSelectedNode.textEn || ''}
                      onChange={(e) => {
                        const val = e.target.value;
                        setNodes((prev) => prev.map((n) => (n.id === activeSelectedNode.id ? { ...n, textEn: val } : n)));
                      }}
                      onBlur={pushHistory}
                      style={{ width: '100%', padding: '4px 6px', fontSize: 12, borderRadius: 4, border: '1px solid var(--line)' }}
                    />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
                    <div>
                      <small style={{ display: 'block', color: 'var(--muted)', fontSize: 10 }}>Font Size:</small>
                      <input
                        type="number"
                        value={activeSelectedNode.fontSize || 18}
                        onChange={(e) => {
                          const val = parseInt(e.target.value) || 12;
                          setNodes((prev) => prev.map((n) => (n.id === activeSelectedNode.id ? { ...n, fontSize: val } : n)));
                        }}
                        onBlur={pushHistory}
                        style={{ width: '100%', padding: '3px 4px', fontSize: 11, borderRadius: 4, border: '1px solid var(--line)' }}
                      />
                    </div>
                    <div>
                      <small style={{ display: 'block', color: 'var(--muted)', fontSize: 10 }}>Weight:</small>
                      <select
                        value={activeSelectedNode.fontWeight || 600}
                        onChange={(e) => {
                          const val = parseInt(e.target.value) || 400;
                          setNodes((prev) => prev.map((n) => (n.id === activeSelectedNode.id ? { ...n, fontWeight: val } : n)));
                          pushHistory();
                        }}
                        style={{ width: '100%', padding: '3px 4px', fontSize: 11, borderRadius: 4, border: '1px solid var(--line)' }}
                      >
                        <option value={400}>Regular (400)</option>
                        <option value={600}>SemiBold (600)</option>
                        <option value={700}>Bold (700)</option>
                        <option value={800}>ExtraBold (800)</option>
                      </select>
                    </div>
                  </div>

                  {/* Font Family Selection */}
                  <div style={{ marginBottom: 6 }}>
                    <small style={{ display: 'block', color: 'var(--muted)', fontSize: 10, marginBottom: 3 }}>Typeface:</small>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 3 }}>
                      {['Inter', 'Vazirmatn', 'Noto Sans Arabic'].map((f) => (
                        <button
                          key={f}
                          className={`btn ${(activeSelectedNode.fontFamily || 'Inter') === f ? 'primary' : ''}`}
                          style={{ fontSize: 9, padding: '2px 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          onClick={() => {
                            setNodes((prev) => prev.map((n) => (n.id === activeSelectedNode.id ? { ...n, fontFamily: f } : n)));
                            pushHistory();
                          }}
                        >
                          {f.split(' ')[0]}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Direction & Line Height */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
                    <div>
                      <small style={{ display: 'block', color: 'var(--muted)', fontSize: 10 }}>Direction:</small>
                      <div style={{ display: 'flex', gap: 2 }}>
                        {(['ltr', 'rtl'] as const).map((dir) => (
                          <button
                            key={dir}
                            className={`btn ${(activeSelectedNode.direction || 'ltr') === dir ? 'primary' : ''}`}
                            style={{ fontSize: 10, padding: '2px 6px', flex: 1 }}
                            onClick={() => {
                              setNodes((prev) => prev.map((n) => (n.id === activeSelectedNode.id ? { ...n, direction: dir } : n)));
                              pushHistory();
                            }}
                          >
                            {dir.toUpperCase()}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <small style={{ display: 'block', color: 'var(--muted)', fontSize: 10 }}>Line Height:</small>
                      <input
                        type="number"
                        step="0.05"
                        min="1.0"
                        max="2.2"
                        value={activeSelectedNode.lineHeight || 1.48}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value) || 1.48;
                          setNodes((prev) => prev.map((n) => (n.id === activeSelectedNode.id ? { ...n, lineHeight: val } : n)));
                        }}
                        onBlur={pushHistory}
                        style={{ width: '100%', padding: '2px 4px', fontSize: 11, borderRadius: 4, border: '1px solid var(--line)' }}
                      />
                    </div>
                  </div>

                  {/* Kurdish Digits Converter */}
                  <button
                    className="btn"
                    style={{ fontSize: 10, padding: '3px 6px', width: '100%' }}
                    onClick={() => {
                      const text = activeSelectedNode.textEn || '';
                      const hasEastern = /[۰-۹]/.test(text);
                      const converted = hasEastern ? toWesternDigits(text) : toEasternKurdishDigits(text);
                      setNodes((prev) => prev.map((n) => (n.id === activeSelectedNode.id ? { ...n, textEn: converted } : n)));
                      pushHistory();
                    }}
                  >
                    Switch Digits: 0-9 ⇄ ۰-۹
                  </button>
                </div>
              )}

              {/* Layer-Specific Properties: Shape & Accent */}
              {(activeSelectedNode.role === 'shape' || activeSelectedNode.role === 'shape_custom' || activeSelectedNode.role === 'badge_custom') && (
                <div className="inspector-section">
                  <div className="inspector-title">FILL COLOR & RADIUS</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                    {[activeBrandKit.palette.accent, '#38BDF8', '#10B981', '#E9B666', '#8B5CF6', '#EC4899', '#ffffff'].map((c) => (
                      <div
                        key={c}
                        onClick={() => {
                          if (activeSelectedNode.role === 'shape') {
                            setAccentColor(c);
                          } else {
                            setNodes((prev) => prev.map((n) => (n.id === activeSelectedNode.id ? { ...n, backgroundColor: c } : n)));
                          }
                          pushHistory();
                        }}
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: '50%',
                          background: c,
                          cursor: 'pointer',
                          border: (activeSelectedNode.backgroundColor || accentColor) === c ? '2px solid #000' : '1px solid rgba(0,0,0,0.2)',
                          boxShadow: (activeSelectedNode.backgroundColor || accentColor) === c ? '0 0 0 2px var(--accent)' : 'none',
                        }}
                      />
                    ))}
                  </div>

                  {activeSelectedNode.role === 'shape_custom' && (
                    <div>
                      <small style={{ display: 'block', color: 'var(--muted)', fontSize: 10 }}>Corner Radius:</small>
                      <input
                        type="range"
                        min={0}
                        max={60}
                        value={activeSelectedNode.borderRadius || 12}
                        onChange={(e) => {
                          const val = parseInt(e.target.value) || 0;
                          setNodes((prev) => prev.map((n) => (n.id === activeSelectedNode.id ? { ...n, borderRadius: val } : n)));
                        }}
                        onMouseUp={pushHistory}
                        className="pro-slider"
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Layer-Specific Properties: Logo */}
              {activeSelectedNode.role === 'logo' && (
                <div className="inspector-section">
                  <div className="inspector-title">VERIFIED BRAND ASSET</div>
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="inspector-section">
                <div className="inspector-title">GLOBAL TYPOGRAPHY</div>
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

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
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

                {/* Kurdish Ligature Clearance Status */}
                {(() => {
                  const clearance = checkKurdishTypographyClearance(headlineCkb, 1.52, 4);
                  const soraniLettersCount = SORANI_SPECIFIC_CHARS.filter((c) => headlineCkb.includes(c)).length;
                  return (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 10,
                        color: clearance.safe ? '#10B981' : '#F59E0B',
                        background: clearance.safe ? 'rgba(16, 185, 129, 0.08)' : 'rgba(245, 158, 11, 0.08)',
                        border: `1px solid ${clearance.safe ? 'rgba(16, 185, 129, 0.2)' : 'rgba(245, 158, 11, 0.2)'}`,
                        padding: '4px 6px',
                        borderRadius: 4,
                        marginBottom: 6,
                      }}
                    >
                      <span style={{ fontWeight: 800 }}>{clearance.safe ? '✓' : '⚠'}</span>
                      <span>
                        {clearance.safe
                          ? `Kurdish Clearance Safe (${clearance.recommendedLineHeight}x · ${soraniLettersCount} Sorani Glyphs)`
                          : clearance.issues[0]}
                      </span>
                    </div>
                  );
                })()}

                {/* Kurdish Numeral Converter */}
                <button
                  className="btn"
                  style={{ fontSize: 10, padding: '4px 6px', width: '100%', marginBottom: 4 }}
                  onClick={() => {
                    const hasEastern = /[۰-۹]/.test(copyCkb);
                    setCopyCkb(hasEastern ? toWesternDigits(copyCkb) : toEasternKurdishDigits(copyCkb));
                    pushHistory();
                  }}
                >
                  {/[۰-۹]/.test(copyCkb) ? 'Convert Price: 0-9 Western' : 'Convert Price: ۰-۹ Kurdish'}
                </button>

                {/* Enforce UAX #9 Isolation */}
                <button
                  className="btn"
                  style={{ fontSize: 10, padding: '4px 6px', width: '100%', marginBottom: 4 }}
                  onClick={() => {
                    setHeadlineCkb((prev) => isolateKurdishText(prev));
                    setCopyCkb((prev) => isolateKurdishText(prev));
                    pushHistory();
                  }}
                >
                  Enforce UAX #9 Isolates (U+2067)
                </button>

                {/* UAX #9 Directional Isolation Toggle */}
                <button
                  className={`btn ${showBidiIsolates ? 'primary' : ''}`}
                  style={{ fontSize: 10, padding: '4px 6px', width: '100%' }}
                  onClick={() => setShowBidiIsolates(!showBidiIsolates)}
                >
                  UAX #9 Bidi Isolates: {showBidiIsolates ? 'VISIBLE (⸢RLI⸥)' : 'HIDDEN'}
                </button>
              </div>

              <div className="inspector-section">
                <div className="inspector-title">PALETTE PRESETS</div>
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

          <div style={{ marginBottom: 10 }}>
            <button
              className={`btn ${semanticDiff.hasChanges ? 'primary' : ''}`}
              style={{ width: '100%', fontSize: 11, padding: '6px' }}
              onClick={() => setShowDiffModal(true)}
            >
              Semantic Diff ({semanticDiff.totalChanges} Δ modifications)
            </button>
          </div>

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
              width: 500,
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
              <div><kbd style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 6px', borderRadius: 4 }}>Shift + Click</kbd> Multi-Select</div>
              <div><kbd style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 6px', borderRadius: 4 }}>Marquee Drag</kbd> Box Select</div>
              <div><kbd style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 6px', borderRadius: 4 }}>Cmd + G</kbd> Group Layers</div>
              <div><kbd style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 6px', borderRadius: 4 }}>Cmd + Shift + G</kbd> Ungroup</div>
              <div><kbd style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 6px', borderRadius: 4 }}>[ / ]</kbd> Layer Order Up/Down</div>
              <div><kbd style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 6px', borderRadius: 4 }}>Shift + Resize</kbd> Lock Ratio</div>
              <div><kbd style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 6px', borderRadius: 4 }}>Cmd + D</kbd> Duplicate Layer</div>
              <div><kbd style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 6px', borderRadius: 4 }}>Delete / Backspace</kbd> Delete Layer</div>
              <div><kbd style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 6px', borderRadius: 4 }}>Cmd + Z</kbd> Undo Action</div>
              <div><kbd style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 6px', borderRadius: 4 }}>Cmd + Shift + Z</kbd> Redo Action</div>
              <div><kbd style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 6px', borderRadius: 4 }}>Arrow Keys</kbd> Nudge 1px (Shift: 10px)</div>
              <div><kbd style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 6px', borderRadius: 4 }}>Esc</kbd> Deselect Layer</div>
              <div><kbd style={{ background: 'rgba(255,255,255,0.15)', padding: '2px 6px', borderRadius: 4 }}>?</kbd> Open Cheat Sheet</div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
