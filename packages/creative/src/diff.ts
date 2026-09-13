import type { NeutralManifest } from '@hawa/contracts';

export interface TextChange {
  nodeId: string;
  role?: string;
  oldText: string;
  newText: string;
}

export interface SpatialChange {
  nodeId: string;
  role?: string;
  oldBox: { x: number; y: number; width: number; height: number };
  newBox: { x: number; y: number; width: number; height: number };
  deltaX: number;
  deltaY: number;
  deltaWidth: number;
  deltaHeight: number;
}

export interface AssetChange {
  nodeId: string;
  role?: string;
  oldAssetSha256?: string;
  newAssetSha256?: string;
}

export interface LockChange {
  nodeId: string;
  role?: string;
  wasLocked: boolean;
  isLocked: boolean;
}

export interface SemanticDocumentDiff {
  hasChanges: boolean;
  summary: string;
  addedNodes: NeutralManifest['nodes'];
  removedNodeIds: string[];
  textChanges: TextChange[];
  spatialChanges: SpatialChange[];
  assetChanges: AssetChange[];
  lockChanges: LockChange[];
}

/**
 * Computes a semantic diff between two revisions of a structured document manifest.
 * Distinguishes text edits, spatial reflows, asset replacements, and structural tree additions/deletions.
 */
export function diffDocumentManifests(
  base: NeutralManifest,
  target: NeutralManifest
): SemanticDocumentDiff {
  const baseNodeMap = new Map(base.nodes.map((n) => [n.id, n]));
  const targetNodeMap = new Map(target.nodes.map((n) => [n.id, n]));

  const addedNodes: NeutralManifest['nodes'] = [];
  const removedNodeIds: string[] = [];
  const textChanges: TextChange[] = [];
  const spatialChanges: SpatialChange[] = [];
  const assetChanges: AssetChange[] = [];
  const lockChanges: LockChange[] = [];

  // Check added or modified nodes
  for (const targetNode of target.nodes) {
    const baseNode = baseNodeMap.get(targetNode.id);
    if (!baseNode) {
      addedNodes.push(targetNode);
      continue;
    }

    // Check text change
    if ((baseNode.text || '') !== (targetNode.text || '')) {
      textChanges.push({
        nodeId: targetNode.id,
        role: targetNode.role,
        oldText: baseNode.text || '',
        newText: targetNode.text || '',
      });
    }

    // Check spatial change
    if (baseNode.box && targetNode.box) {
      const deltaX = targetNode.box.x - baseNode.box.x;
      const deltaY = targetNode.box.y - baseNode.box.y;
      const deltaW = targetNode.box.width - baseNode.box.width;
      const deltaH = targetNode.box.height - baseNode.box.height;

      if (deltaX !== 0 || deltaY !== 0 || deltaW !== 0 || deltaH !== 0) {
        spatialChanges.push({
          nodeId: targetNode.id,
          role: targetNode.role,
          oldBox: { ...baseNode.box },
          newBox: { ...targetNode.box },
          deltaX,
          deltaY,
          deltaWidth: deltaW,
          deltaHeight: deltaH,
        });
      }
    }

    // Check asset change
    if (baseNode.assetSha256 !== targetNode.assetSha256) {
      assetChanges.push({
        nodeId: targetNode.id,
        role: targetNode.role,
        oldAssetSha256: baseNode.assetSha256,
        newAssetSha256: targetNode.assetSha256,
      });
    }

    // Check lock change
    if (baseNode.locked !== targetNode.locked) {
      lockChanges.push({
        nodeId: targetNode.id,
        role: targetNode.role,
        wasLocked: baseNode.locked,
        isLocked: targetNode.locked,
      });
    }
  }

  // Check removed nodes
  for (const baseNode of base.nodes) {
    if (!targetNodeMap.has(baseNode.id)) {
      removedNodeIds.push(baseNode.id);
    }
  }

  const hasChanges =
    addedNodes.length > 0 ||
    removedNodeIds.length > 0 ||
    textChanges.length > 0 ||
    spatialChanges.length > 0 ||
    assetChanges.length > 0 ||
    lockChanges.length > 0;

  const parts: string[] = [];
  if (addedNodes.length > 0) parts.push(`${addedNodes.length} added`);
  if (removedNodeIds.length > 0) parts.push(`${removedNodeIds.length} removed`);
  if (textChanges.length > 0) parts.push(`${textChanges.length} copy edits`);
  if (spatialChanges.length > 0) parts.push(`${spatialChanges.length} spatial shifts`);
  if (assetChanges.length > 0) parts.push(`${assetChanges.length} asset updates`);
  if (lockChanges.length > 0) parts.push(`${lockChanges.length} lock changes`);

  const summary = hasChanges ? parts.join(', ') : 'No semantic changes detected';

  return {
    hasChanges,
    summary,
    addedNodes,
    removedNodeIds,
    textChanges,
    spatialChanges,
    assetChanges,
    lockChanges,
  };
}
