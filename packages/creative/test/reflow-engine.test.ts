import { describe, it, expect } from 'vitest';
import {
  reflowCanvasNodes,
  FORMAT_SPECS,
  type ReflowableNode,
  type AspectFormat,
} from '../src/reflow-engine.js';

describe('Constraint-Based Multi-Artboard Auto-Reflow Engine', () => {
  const sampleFeedNodes: ReflowableNode[] = [
    {
      id: 'node_bg',
      name: 'Dynamic Backdrop',
      role: 'image_custom',
      x: 0,
      y: 0,
      width: 480,
      height: 600,
      zIndex: 0,
      visible: true,
      svgContent: '<rect width="480" height="600" fill="#01585F"/>',
    },
    {
      id: 'node_logo',
      name: 'Client Logo',
      role: 'logo',
      x: 350,
      y: 40,
      width: 100,
      height: 36,
      zIndex: 10,
      visible: true,
    },
    {
      id: 'node_headline',
      name: 'Main Headline',
      role: 'headline',
      x: 28,
      y: 100,
      width: 424,
      height: 70,
      zIndex: 20,
      fontSize: 26,
      lineHeight: 1.52,
      visible: true,
      textCkb: 'داشکاندنی سەرەتای وەرز بۆ دکتۆر و نەخۆشخانەکان',
      textEn: 'Special Seasonal Promotion for Medical Centers',
    },
    {
      id: 'node_copy',
      name: 'Price & CTA Badge',
      role: 'copy',
      x: 28,
      y: 510,
      width: 380,
      height: 48,
      zIndex: 30,
      fontSize: 14,
      visible: true,
      textCkb: 'نرخی تایبەت: ٤٥،٠٠٠ دینار',
      textEn: 'Special Offer: 45,000 IQD',
    },
    {
      id: 'node_shape',
      name: 'Accent Pill',
      role: 'shape_custom',
      x: 300,
      y: 250,
      width: 120,
      height: 120,
      zIndex: 15,
      visible: true,
      backgroundColor: '#FFB200',
    },
  ];

  it('preserves node count and identities without mutation across reflow', () => {
    const reflowed = reflowCanvasNodes(sampleFeedNodes, 'feed', 'story');
    expect(reflowed.length).toBe(sampleFeedNodes.length);
    expect(reflowed.map((n) => n.id)).toEqual(sampleFeedNodes.map((n) => n.id));
    // Verify source array is not mutated
    expect(sampleFeedNodes[0].width).toBe(480);
  });

  it('reflows from Feed (4:5) to Story (9:16) clearing Instagram Story danger zones', () => {
    const storyNodes = reflowCanvasNodes(sampleFeedNodes, 'feed', 'story');
    const storySpec = FORMAT_SPECS.story;

    const headline = storyNodes.find((n) => n.role === 'headline')!;
    const topDangerPx = Math.round(storySpec.height * storySpec.socialTopDangerRatio); // ~95px
    const bottomDangerPx = Math.round(storySpec.height * storySpec.socialBottomDangerRatio); // ~135px

    // Headline must start below top danger zone
    expect(headline.y).toBeGreaterThan(topDangerPx);
    // Headline must fit within horizontal safe margins
    expect(headline.width).toBeLessThanOrEqual(storySpec.width - storySpec.safeMarginSides * 2);

    const copyBadge = storyNodes.find((n) => n.role === 'copy')!;
    // Copy badge bottom edge must stay above bottom danger zone (675 - 135 = 540)
    expect(copyBadge.y + copyBadge.height).toBeLessThanOrEqual(storySpec.height - bottomDangerPx);

    // Full backdrop should fill target dimensions
    const bg = storyNodes.find((n) => n.role === 'image_custom')!;
    expect(bg.width).toBe(storySpec.width);
    expect(bg.height).toBe(storySpec.height);
  });

  it('reflows to Landscape (16:9) adapting headline font size and badge bounds', () => {
    const landscapeNodes = reflowCanvasNodes(sampleFeedNodes, 'feed', 'landscape');
    const landscapeSpec = FORMAT_SPECS.landscape;

    const headline = landscapeNodes.find((n) => n.role === 'headline')!;
    expect(headline.fontSize).toBe(20);
    expect(headline.width).toBe(landscapeSpec.width - landscapeSpec.safeMarginSides * 2);

    const copyBadge = landscapeNodes.find((n) => n.role === 'copy')!;
    expect(copyBadge.width).toBeLessThanOrEqual(320);
    expect(copyBadge.y + copyBadge.height).toBeLessThanOrEqual(landscapeSpec.height);
  });

  it('reflows to Square (1:1) with balanced symmetrical proportions', () => {
    const squareNodes = reflowCanvasNodes(sampleFeedNodes, 'feed', 'square');
    const squareSpec = FORMAT_SPECS.square;

    const bg = squareNodes.find((n) => n.role === 'image_custom')!;
    expect(bg.width).toBe(480);
    expect(bg.height).toBe(480);

    const headline = squareNodes.find((n) => n.role === 'headline')!;
    expect(headline.y).toBeGreaterThanOrEqual(squareSpec.safeMarginTop);
  });

  it('handles identity reflow without altering positions when source and target match', () => {
    const unchanged = reflowCanvasNodes(sampleFeedNodes, 'story', 'story');
    expect(unchanged).toEqual(sampleFeedNodes);
  });
});
