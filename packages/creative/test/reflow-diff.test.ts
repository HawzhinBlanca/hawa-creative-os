import { describe, it, expect } from 'vitest';
import type { NeutralManifest } from '@hawa/contracts';
import { reflowManifest, VARIANT_PRESETS } from '../src/reflow.js';
import { diffDocumentManifests } from '../src/diff.js';

describe('Creative Variant Reflow Engine', () => {
  const sampleSquareManifest: NeutralManifest = {
    pages: [{ id: 'page_1', name: 'Primary Page', width: 1080, height: 1080, unit: 'px' }],
    nodes: [
      {
        id: 'node_bg',
        pageId: 'page_1',
        type: 'vector',
        role: 'background',
        locked: true,
        zIndex: 0,
        box: { x: 0, y: 0, width: 1080, height: 1080 },
      },
      {
        id: 'node_logo',
        pageId: 'page_1',
        type: 'image',
        role: 'official_logo',
        locked: true,
        zIndex: 10,
        box: { x: 60, y: 60, width: 240, height: 80 },
      },
      {
        id: 'node_headline',
        pageId: 'page_1',
        type: 'text',
        role: 'headline',
        text: 'داشکاندنی تایبەتی وەرزی نوێ',
        locked: false,
        zIndex: 20,
        box: { x: 60, y: 850, width: 960, height: 120 },
      },
      {
        id: 'node_hero',
        pageId: 'page_1',
        type: 'image',
        role: 'hero_visual',
        locked: false,
        zIndex: 5,
        box: { x: 140, y: 200, width: 800, height: 600 },
      },
    ],
    fonts: [{ family: 'Rabar', style: 'Bold' }],
    assets: [{ sha256: 'sha256_logo_main', mimeType: 'image/png' }],
    warnings: [],
  };

  it('reflows 1:1 square canvas to 9:16 story respecting story safe zones', () => {
    const result = reflowManifest(sampleSquareManifest, 'story');

    expect(result.dimensions).toEqual({ width: 1080, height: 1920 });
    expect(result.targetPreset).toBe(VARIANT_PRESETS.story.name);
    expect(result.reflowedManifest.pages[0].height).toBe(1920);

    // Background should expand to 1080 x 1920
    const bgNode = result.reflowedManifest.nodes.find((n) => n.id === 'node_bg');
    expect(bgNode?.box).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });

    // Logo should be placed below story top safe zone (250px)
    const logoNode = result.reflowedManifest.nodes.find((n) => n.id === 'node_logo');
    expect(logoNode?.box?.y).toBeGreaterThanOrEqual(250);

    // Headline must stay above the bottom safe zone (1920 - 340 = 1580px max Y + height)
    const headlineNode = result.reflowedManifest.nodes.find((n) => n.id === 'node_headline');
    expect(headlineNode?.box).toBeDefined();
    const bottomEdge = headlineNode!.box!.y + headlineNode!.box!.height;
    expect(bottomEdge).toBeLessThanOrEqual(1920 - 340);

    // Verify operations generated include resizePage and transforms
    expect(result.operations.some((op) => op.op === 'resizePage')).toBe(true);
    expect(result.operations.filter((op) => op.op === 'transform')).toHaveLength(4);
  });

  it('reflows 1:1 square to 4:5 feed portrait and landscape formats', () => {
    const portraitRes = reflowManifest(sampleSquareManifest, 'feed_portrait');
    expect(portraitRes.dimensions).toEqual({ width: 1080, height: 1350 });
    expect(portraitRes.reflowedManifest.pages[0].height).toBe(1350);

    const landscapeRes = reflowManifest(sampleSquareManifest, 'landscape');
    expect(landscapeRes.dimensions).toEqual({ width: 1200, height: 628 });
    expect(landscapeRes.reflowedManifest.pages[0].width).toBe(1200);
    expect(landscapeRes.reflowedManifest.pages[0].height).toBe(628);
  });
});

describe('Semantic Document Diff Engine', () => {
  const baseDoc: NeutralManifest = {
    pages: [{ id: 'p1', name: 'Page 1', width: 1080, height: 1080, unit: 'px' }],
    nodes: [
      {
        id: 'node_1',
        pageId: 'p1',
        type: 'text',
        role: 'headline',
        text: 'نرخی پێشوو: ٢٥،٠٠٠ د.ع',
        locked: false,
        zIndex: 1,
        box: { x: 50, y: 100, width: 400, height: 50 },
      },
      {
        id: 'node_2',
        pageId: 'p1',
        type: 'image',
        role: 'official_logo',
        assetSha256: 'sha256_v1_logo',
        locked: true,
        zIndex: 2,
        box: { x: 50, y: 50, width: 200, height: 60 },
      },
    ],
    fonts: [],
    assets: [],
    warnings: [],
  };

  it('reports no changes for identical document manifests', () => {
    const diff = diffDocumentManifests(baseDoc, JSON.parse(JSON.stringify(baseDoc)));
    expect(diff.hasChanges).toBe(false);
    expect(diff.summary).toBe('No semantic changes detected');
    expect(diff.textChanges).toHaveLength(0);
    expect(diff.spatialChanges).toHaveLength(0);
    expect(diff.addedNodes).toHaveLength(0);
    expect(diff.removedNodeIds).toHaveLength(0);
  });

  it('detects live copy modifications and computes exact textual delta', () => {
    const modifiedDoc: NeutralManifest = {
      ...baseDoc,
      nodes: baseDoc.nodes.map((n) =>
        n.id === 'node_1' ? { ...n, text: 'نرخی نوێ: ١٨،٠٠٠ د.ع' } : n
      ),
    };

    const diff = diffDocumentManifests(baseDoc, modifiedDoc);
    expect(diff.hasChanges).toBe(true);
    expect(diff.textChanges).toHaveLength(1);
    expect(diff.textChanges[0]).toEqual({
      nodeId: 'node_1',
      role: 'headline',
      oldText: 'نرخی پێشوو: ٢٥،٠٠٠ د.ع',
      newText: 'نرخی نوێ: ١٨،٠٠٠ د.ع',
    });
    expect(diff.summary).toContain('1 copy edits');
  });

  it('detects spatial displacements and computes precise pixel deltas', () => {
    const shiftedDoc: NeutralManifest = {
      ...baseDoc,
      nodes: baseDoc.nodes.map((n) =>
        n.id === 'node_1' ? { ...n, box: { x: 100, y: 120, width: 450, height: 50 } } : n
      ),
    };

    const diff = diffDocumentManifests(baseDoc, shiftedDoc);
    expect(diff.hasChanges).toBe(true);
    expect(diff.spatialChanges).toHaveLength(1);
    expect(diff.spatialChanges[0]).toEqual({
      nodeId: 'node_1',
      role: 'headline',
      oldBox: { x: 50, y: 100, width: 400, height: 50 },
      newBox: { x: 100, y: 120, width: 450, height: 50 },
      deltaX: 50,
      deltaY: 20,
      deltaWidth: 50,
      deltaHeight: 0,
    });
    expect(diff.summary).toContain('1 spatial shifts');
  });

  it('detects asset replacements, structural additions and deletions', () => {
    const targetDoc: NeutralManifest = {
      ...baseDoc,
      nodes: [
        // node_1 deleted
        // node_2 asset updated
        {
          id: 'node_2',
          pageId: 'p1',
          type: 'image',
          role: 'official_logo',
          assetSha256: 'sha256_v2_logo_white',
          locked: true,
          zIndex: 2,
          box: { x: 50, y: 50, width: 200, height: 60 },
        },
        // node_3 added
        {
          id: 'node_3',
          pageId: 'p1',
          type: 'vector',
          role: 'cta_button',
          locked: false,
          zIndex: 3,
          box: { x: 50, y: 800, width: 300, height: 80 },
        },
      ],
    };

    const diff = diffDocumentManifests(baseDoc, targetDoc);
    expect(diff.hasChanges).toBe(true);
    expect(diff.removedNodeIds).toEqual(['node_1']);
    expect(diff.addedNodes).toHaveLength(1);
    expect(diff.addedNodes[0].id).toBe('node_3');
    expect(diff.assetChanges).toHaveLength(1);
    expect(diff.assetChanges[0].oldAssetSha256).toBe('sha256_v1_logo');
    expect(diff.assetChanges[0].newAssetSha256).toBe('sha256_v2_logo_white');
    expect(diff.summary).toContain('1 added');
    expect(diff.summary).toContain('1 removed');
    expect(diff.summary).toContain('1 asset updates');
  });
});
