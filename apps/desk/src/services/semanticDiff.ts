/**
 * Client-side Semantic Document Diff Service
 * Computes structured delta between design revisions (text, style, spatial, and layer hierarchy).
 */

export interface TextDelta {
  nodeId: string;
  label: string;
  oldText: string;
  newText: string;
}

export interface StyleDelta {
  nodeId: string;
  property: string;
  oldVal: string;
  newVal: string;
}

export interface SemanticDiffResult {
  hasChanges: boolean;
  totalChanges: number;
  textDeltas: TextDelta[];
  styleDeltas: StyleDelta[];
  summary: string;
}

export interface DocumentSnapshot {
  headline: string;
  copy: string;
  fontFamily: string;
  fontWeight: number;
  textColor: string;
  accentColor: string;
  bgColor: string;
  variant: string;
}

export function computeSemanticDiff(
  base: DocumentSnapshot,
  current: DocumentSnapshot
): SemanticDiffResult {
  const textDeltas: TextDelta[] = [];
  const styleDeltas: StyleDelta[] = [];

  // Check text deltas
  if (base.headline !== current.headline) {
    textDeltas.push({
      nodeId: 'node_headline',
      label: 'Headline Copy',
      oldText: base.headline,
      newText: current.headline,
    });
  }

  if (base.copy !== current.copy) {
    textDeltas.push({
      nodeId: 'node_copy',
      label: 'Body / Price Copy',
      oldText: base.copy,
      newText: current.copy,
    });
  }

  // Check style deltas
  if (base.fontFamily !== current.fontFamily) {
    styleDeltas.push({
      nodeId: 'node_typography',
      property: 'Font Family',
      oldVal: base.fontFamily,
      newVal: current.fontFamily,
    });
  }

  if (base.fontWeight !== current.fontWeight) {
    styleDeltas.push({
      nodeId: 'node_typography',
      property: 'Font Weight',
      oldVal: String(base.fontWeight),
      newVal: String(current.fontWeight),
    });
  }

  if (base.textColor !== current.textColor) {
    styleDeltas.push({
      nodeId: 'node_colors',
      property: 'Text Color',
      oldVal: base.textColor,
      newVal: current.textColor,
    });
  }

  if (base.accentColor !== current.accentColor) {
    styleDeltas.push({
      nodeId: 'node_shape_accent',
      property: 'Accent Color',
      oldVal: base.accentColor,
      newVal: current.accentColor,
    });
  }

  if (base.variant !== current.variant) {
    styleDeltas.push({
      nodeId: 'node_canvas_format',
      property: 'Variant Aspect Ratio',
      oldVal: base.variant,
      newVal: current.variant,
    });
  }

  const totalChanges = textDeltas.length + styleDeltas.length;
  const hasChanges = totalChanges > 0;

  const summary = hasChanges
    ? `Revision Delta: ${textDeltas.length} text updates, ${styleDeltas.length} style/spatial adjustments`
    : 'Identical to Candidate Revision 1 (zero semantic drift)';

  return {
    hasChanges,
    totalChanges,
    textDeltas,
    styleDeltas,
    summary,
  };
}
