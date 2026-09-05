/**
 * Immutable Structural-Sharing History Tree Engine
 * Supports non-destructive branching, zero-drift deduplication,
 * timeline scrubbing, and named revision snapshots.
 */

export interface HistoryNodeState {
  headlineEn: string;
  headlineCkb: string;
  copyEn: string;
  copyCkb: string;
  fontFamily: string;
  fontWeight: number;
  accentColor: string;
  brandKitId: string;
  format: string;
  langVariant: 'en' | 'ckb' | 'bilingual';
  nodes: any[];
}

export interface HistoryTreeNode {
  id: string;
  parentId: string | null;
  childrenIds: string[];
  timestamp: number;
  actionName: string;
  state: HistoryNodeState;
}

export interface HistoryTree {
  rootId: string;
  currentNodeId: string;
  nodes: Record<string, HistoryTreeNode>;
}

/**
 * Generates a unique node ID
 */
function generateId(): string {
  return 'hist_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);
}

/**
 * Checks deep structural equality of two history states to prevent redundant drift
 */
export function areStatesEqual(a: HistoryNodeState, b: HistoryNodeState): boolean {
  if (!a || !b) return a === b;
  if (
    a.headlineEn !== b.headlineEn ||
    a.headlineCkb !== b.headlineCkb ||
    a.copyEn !== b.copyEn ||
    a.copyCkb !== b.copyCkb ||
    a.fontFamily !== b.fontFamily ||
    a.fontWeight !== b.fontWeight ||
    a.accentColor !== b.accentColor ||
    a.brandKitId !== b.brandKitId ||
    a.format !== b.format ||
    a.langVariant !== b.langVariant
  ) {
    return false;
  }

  if (a.nodes.length !== b.nodes.length) return false;

  for (let i = 0; i < a.nodes.length; i++) {
    const na = a.nodes[i];
    const nb = b.nodes[i];
    if (JSON.stringify(na) !== JSON.stringify(nb)) {
      return false;
    }
  }

  return true;
}

/**
 * Initializes a new history tree with root snapshot
 */
export function createHistoryTree(initialState: HistoryNodeState, actionName: string = 'Initial Document'): HistoryTree {
  const rootId = generateId();
  const rootNode: HistoryTreeNode = {
    id: rootId,
    parentId: null,
    childrenIds: [],
    timestamp: Date.now(),
    actionName,
    state: JSON.parse(JSON.stringify(initialState)),
  };

  return {
    rootId,
    currentNodeId: rootId,
    nodes: {
      [rootId]: rootNode,
    },
  };
}

/**
 * Appends a new revision snapshot to the current branch.
 * Zero-Drift Rule: If state is identical to the current node, returns unchanged tree.
 */
export function pushHistoryTree(
  tree: HistoryTree,
  nextState: HistoryNodeState,
  actionName: string = 'Edit Canvas'
): HistoryTree {
  const currentNode = tree.nodes[tree.currentNodeId];
  if (currentNode && areStatesEqual(currentNode.state, nextState)) {
    return tree; // Zero-drift: no redundant history entry
  }

  const newNodeId = generateId();
  const newNode: HistoryTreeNode = {
    id: newNodeId,
    parentId: tree.currentNodeId,
    childrenIds: [],
    timestamp: Date.now(),
    actionName,
    state: JSON.parse(JSON.stringify(nextState)),
  };

  const updatedCurrentNode = {
    ...currentNode,
    childrenIds: [...(currentNode?.childrenIds || []), newNodeId],
  };

  return {
    ...tree,
    currentNodeId: newNodeId,
    nodes: {
      ...tree.nodes,
      [tree.currentNodeId]: updatedCurrentNode,
      [newNodeId]: newNode,
    },
  };
}

/**
 * Navigates to the parent revision (Undo)
 */
export function undoHistoryTree(tree: HistoryTree): { tree: HistoryTree; state: HistoryNodeState | null } {
  const current = tree.nodes[tree.currentNodeId];
  if (!current || !current.parentId) {
    return { tree, state: null };
  }

  const parentId = current.parentId;
  const parentNode = tree.nodes[parentId];
  if (!parentNode) {
    return { tree, state: null };
  }

  return {
    tree: {
      ...tree,
      currentNodeId: parentId,
    },
    state: JSON.parse(JSON.stringify(parentNode.state)),
  };
}

/**
 * Navigates to the forward child revision (Redo)
 */
export function redoHistoryTree(
  tree: HistoryTree,
  branchIndex?: number
): { tree: HistoryTree; state: HistoryNodeState | null } {
  const current = tree.nodes[tree.currentNodeId];
  if (!current || current.childrenIds.length === 0) {
    return { tree, state: null };
  }

  // Default to the most recent child branch
  const idx = branchIndex !== undefined && branchIndex < current.childrenIds.length
    ? branchIndex
    : current.childrenIds.length - 1;

  const nextId = current.childrenIds[idx];
  const nextNode = tree.nodes[nextId];
  if (!nextNode) {
    return { tree, state: null };
  }

  return {
    tree: {
      ...tree,
      currentNodeId: nextId,
    },
    state: JSON.parse(JSON.stringify(nextNode.state)),
  };
}

/**
 * Jumps directly to any revision node in the tree (Timeline Scrubbing)
 */
export function jumpToHistoryNode(
  tree: HistoryTree,
  targetNodeId: string
): { tree: HistoryTree; state: HistoryNodeState | null } {
  const target = tree.nodes[targetNodeId];
  if (!target) {
    return { tree, state: null };
  }

  return {
    tree: {
      ...tree,
      currentNodeId: targetNodeId,
    },
    state: JSON.parse(JSON.stringify(target.state)),
  };
}

/**
 * Returns the linear revision path from root to the active node for timeline scrubbing
 */
export function getHistoryLinearPath(tree: HistoryTree): HistoryTreeNode[] {
  const path: HistoryTreeNode[] = [];
  let curr: HistoryTreeNode | undefined = tree.nodes[tree.currentNodeId];

  while (curr) {
    path.unshift(curr);
    curr = curr.parentId ? tree.nodes[curr.parentId] : undefined;
  }

  return path;
}
