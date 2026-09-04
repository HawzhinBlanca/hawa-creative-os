import { describe, it, expect } from 'vitest';
import {
  createHistoryTree,
  pushHistoryTree,
  undoHistoryTree,
  redoHistoryTree,
  jumpToHistoryNode,
  getHistoryLinearPath,
  areStatesEqual,
  type HistoryNodeState,
} from '../../../apps/desk/src/services/historyTree.js';

describe('Horizon 3: Immutable Structural-Sharing History Tree Engine', () => {
  const initial: HistoryNodeState = {
    headlineEn: 'Initial Headline',
    headlineCkb: 'سەردێڕی سەرەتایی',
    copyEn: '25,000 IQD',
    copyCkb: '٢٥٬٠٠٠ دینار',
    fontFamily: 'Inter',
    fontWeight: 700,
    accentColor: '#38BDF8',
    brandKitId: 'sebar',
    format: 'feed',
    langVariant: 'en',
    nodes: [
      { id: 'node_1', x: 100, y: 100, width: 200, height: 50, visible: true, locked: false, zIndex: 1, textEn: 'Test' },
    ],
  };

  it('creates root history tree with 1 node', () => {
    const tree = createHistoryTree(initial, 'Create Document');
    expect(tree.rootId).toBeDefined();
    expect(tree.currentNodeId).toBe(tree.rootId);
    expect(tree.nodes[tree.rootId].actionName).toBe('Create Document');
    expect(getHistoryLinearPath(tree).length).toBe(1);
  });

  it('enforces zero-drift: identical states do NOT create duplicate history nodes', () => {
    const tree0 = createHistoryTree(initial, 'Initial');
    const tree1 = pushHistoryTree(tree0, initial, 'Edit Without Change');

    expect(tree1).toBe(tree0);
    expect(Object.keys(tree1.nodes).length).toBe(1);
  });

  it('pushes new state and navigates linear history via undo and redo', () => {
    const tree0 = createHistoryTree(initial, 'Initial');
    const state2: HistoryNodeState = { ...initial, headlineEn: 'Updated Headline' };
    const tree1 = pushHistoryTree(tree0, state2, 'Update Headline');

    expect(tree1.currentNodeId).not.toBe(tree0.rootId);
    expect(tree1.nodes[tree1.currentNodeId].state.headlineEn).toBe('Updated Headline');
    expect(getHistoryLinearPath(tree1).length).toBe(2);

    // Undo
    const { tree: treeUndone, state: undoneState } = undoHistoryTree(tree1);
    expect(undoneState?.headlineEn).toBe('Initial Headline');
    expect(treeUndone.currentNodeId).toBe(tree0.rootId);

    // Redo
    const { tree: treeRedone, state: redoneState } = redoHistoryTree(treeUndone);
    expect(redoneState?.headlineEn).toBe('Updated Headline');
    expect(treeRedone.currentNodeId).toBe(tree1.currentNodeId);
  });

  it('preserves non-destructive branches when edits happen after undo', () => {
    const tree0 = createHistoryTree(initial, 'Initial');
    const stateA: HistoryNodeState = { ...initial, accentColor: '#EF4444' };
    const treeA = pushHistoryTree(tree0, stateA, 'Red Accent');

    // Undo back to root
    const { tree: treeAtRoot } = undoHistoryTree(treeA);
    expect(treeAtRoot.currentNodeId).toBe(tree0.rootId);

    // Branch off with a different edit (Green Accent)
    const stateB: HistoryNodeState = { ...initial, accentColor: '#10B981' };
    const treeB = pushHistoryTree(treeAtRoot, stateB, 'Green Accent');

    // Root should now have 2 child branches (Red and Green), neither was lost!
    const rootNode = treeB.nodes[tree0.rootId];
    expect(rootNode.childrenIds.length).toBe(2);

    // We can jump directly to the alternate branch (Red Accent) without losing anything
    const redNodeId = rootNode.childrenIds[0];
    const { tree: treeJumped, state: jumpedState } = jumpToHistoryNode(treeB, redNodeId);
    expect(jumpedState?.accentColor).toBe('#EF4444');
    expect(treeJumped.currentNodeId).toBe(redNodeId);
  });

  it('accurately tests deep structural equality of node lists', () => {
    const a: HistoryNodeState = { ...initial };
    const b: HistoryNodeState = { ...initial, nodes: [{ ...initial.nodes[0] }] };
    expect(areStatesEqual(a, b)).toBe(true);

    const c: HistoryNodeState = {
      ...initial,
      nodes: [{ ...initial.nodes[0], x: 105 }], // Moved by 5px
    };
    expect(areStatesEqual(a, c)).toBe(false);
  });
});
