import type { StudioOperation } from '@hawa/contracts';
import { assert, describe, it, expect } from 'vitest';
import {
  BriefBuilder,
  DesignRouter,
  CreativeDirectorRunner,
  CANONICAL_FORMATS,
  KAAE_PRIMARY_LOGO_SHA256,
} from '../src/index.js';
import type { CanonicalFormat } from '../src/creative-director.js';

describe('Milestone 4: Multi-Format Composition & Layout Engine', () => {
  const briefBuilder = new BriefBuilder();
  const router = new DesignRouter();
  const director = new CreativeDirectorRunner();

  it('1. Verifies exact specifications for all 4 canonical formats', () => {
    // Feed 4:5
    const feed = CANONICAL_FORMATS.feed;
    expect(feed.width).toBe(1080);
    expect(feed.height).toBe(1350);
    expect(feed.aspectRatio).toBe('4:5');
    expect(feed.dpi).toBe(72);
    expect(feed.isPrint).toBe(false);

    // Story 9:16 with top (270px / 14%) and bottom (384px / 20%) danger zones
    const story = CANONICAL_FORMATS.story;
    expect(story.width).toBe(1080);
    expect(story.height).toBe(1920);
    expect(story.aspectRatio).toBe('9:16');
    expect(story.safeMarginTop).toBe(270);
    expect(story.safeMarginBottom).toBe(384);

    // Landscape 16:9
    const landscape = CANONICAL_FORMATS.landscape;
    expect(landscape.width).toBe(1920);
    expect(landscape.height).toBe(1080);
    expect(landscape.aspectRatio).toBe('16:9');

    // Print A4 (300 DPI)
    const printA4 = CANONICAL_FORMATS.print_a4;
    expect(printA4.width).toBe(2480);
    expect(printA4.height).toBe(3508);
    expect(printA4.dpi).toBe(300);
    expect(printA4.isPrint).toBe(true);
  });

  it('2. DesignRouter: accurately detects omnichannel multi-format requests', () => {
    const briefRes = briefBuilder.build({
      taskId: 't-omnichannel-1',
      clientId: 'c1000000-0000-4000-8000-000000000002',
      clientDnaVersion: 1,
      objective: 'Omnichannel Institutional Campaign across all formats',
      rawRequestText: 'بانگەوازی نیشتمانی بۆ خوێندنی باڵا: سەرجەم قەبارەکان (ستۆری، پۆست، پانۆراما و چاپی A4)',
    });

    expect(briefRes.ok).toBe(true); assert(briefRes.ok);
    if (!briefRes.ok) return;

    const resolution = router.resolveRoute(briefRes.value, []);
    expect(resolution.route).toBe('multi_format_composition');
    expect(resolution.confidence).toBeGreaterThanOrEqual(0.95);
    expect(resolution.detectedFormats).toContain('feed');
    expect(resolution.detectedFormats).toContain('story');
    expect(resolution.detectedFormats).toContain('landscape');
    expect(resolution.detectedFormats).toContain('print_a4');
  });

  it('3. CreativeDirectorRunner: creates tailored layout zones with danger zone clearance', () => {
    const briefRes = briefBuilder.build({
      taskId: 't-zones-1',
      clientId: 'c1000000-0000-4000-8000-000000000002',
      clientDnaVersion: 1,
      objective: 'KAAE Evaluator Recruitment Campaign',
      rawRequestText: 'دەستەی متمانەبەخشی: بانگەواز بۆ هەڵسەنگێنەرانی نیشتمانی لە هەولێر و سلێمانی',
    });

    expect(briefRes.ok).toBe(true); assert(briefRes.ok);
    if (!briefRes.ok) return;

    const brief = briefRes.value;

    // 3a. Story Plan (9:16)
    const storyPlan = director.createDesignPlan(brief, ['#0A1628', '#D4A94C'], 'story');
    expect(storyPlan.zones.length).toBe(3);
    const storyHeader = storyPlan.zones.find((z) => z.id === 'zone_header')!;
    const storyContent = storyPlan.zones.find((z) => z.id === 'zone_content')!;
    // Header must clear top danger zone (y >= 270)
    expect(storyHeader.y).toBeGreaterThanOrEqual(270);
    // Content must clear bottom danger zone (y + height <= 1920 - 384 = 1536)
    expect(storyContent.y + storyContent.height).toBeLessThanOrEqual(1536);

    // 3b. Landscape Plan (16:9)
    const landscapePlan = director.createDesignPlan(brief, ['#0A1628', '#D4A94C'], 'landscape');
    expect(landscapePlan.topology).toBe('modular_field');
    const landscapeHero = landscapePlan.zones.find((z) => z.id === 'zone_hero')!;
    const landscapeContent = landscapePlan.zones.find((z) => z.id === 'zone_content')!;
    // Split layout: hero and content side-by-side (different X coordinates)
    expect(landscapeHero.x).not.toBe(landscapeContent.x);
    expect(landscapeHero.width).toBeGreaterThanOrEqual(800);
    expect(landscapeContent.width).toBeGreaterThanOrEqual(800);

    // 3c. Print A4 Plan (300 DPI)
    const printPlan = director.createDesignPlan(brief, ['#0A1628', '#D4A94C'], 'print_a4');
    expect(printPlan.zones.find((z) => z.id === 'zone_content')!.width).toBe(2120);
    expect(printPlan.artDirectionReference?.shippedInArtifact).toBe(false);
  });

  it('4. CreativeDirectorRunner: verifies Kurdish Sorani typography reflow & diacritic headroom', () => {
    const briefRes = briefBuilder.build({
      taskId: 't-typo-reflow-1',
      clientId: 'c1000000-0000-4000-8000-000000000002',
      clientDnaVersion: 1,
      objective: 'KAAE Quality Assurance Decree',
      rawRequestText: 'بڕیاری فەرمی دەستەی متمانەبەخشین: ستانداردە نوێیەکانی پەروەردە و فێرکردن ڕاگەیەندرا',
    });

    expect(briefRes.ok).toBe(true); assert(briefRes.ok);
    if (!briefRes.ok) return;

    const brief = briefRes.value;
    const formats: CanonicalFormat[] = ['feed', 'story', 'landscape', 'print_a4'];

    for (const fmt of formats) {
      const plan = director.createDesignPlan(brief, ['#0A1628', '#D4A94C'], fmt);
      const ops = director.generateStudioOperations(brief, plan, KAAE_PRIMARY_LOGO_SHA256, fmt);

      // Background must match exact dimensions
      const bgOp = ops.find((o): o is Extract<StudioOperation, {op: 'addVector'}> => o.op === 'addVector' && o.nodeId === 'node_bg');
      expect(bgOp).toBeDefined();
      expect(bgOp?.width).toBe(CANONICAL_FORMATS[fmt].width);
      expect(bgOp?.height).toBe(CANONICAL_FORMATS[fmt].height);

      // Text operations
      const textOps = ops.filter((o) => o.op === 'addText');
      expect(textOps.length).toBeGreaterThan(0);

      for (const textOp of textOps) {
        // Invariant 3: Live text must be editable
        expect(textOp.locked).toBe(false);

        const style = (textOp as any).style;
        // Kurdish Sorani must be right-aligned
        expect(style.textAlign).toBe('right');
        // KAAE's Sorani headline: the 2025 guideline's bold sans (p.10), IBM Plex Sans Arabic
        if ((textOp as any).role === 'headline') {
          expect(style.fontFamily).toBe('IBM Plex Sans Arabic');
          expect(style.fontSize).toBe(CANONICAL_FORMATS[fmt].typographyScale.headlineSize);
        }
        // Diacritic headroom: line-height must be >= 1.38
        expect(style.lineHeight).toBeGreaterThanOrEqual(1.38);
      }
    }
  });

  it('5. Generates full multi-format batch in a single pass across all 4 canonical formats', () => {
    const briefRes = briefBuilder.build({
      taskId: 't-batch-all-4',
      clientId: 'c1000000-0000-4000-8000-000000000002',
      clientDnaVersion: 1,
      objective: 'Omnichannel National Evaluation Launch',
      rawRequestText: 'دەستەی متمانەبەخشی: بانگەوازی هەڵسەنگێنەران بۆ زانکۆکانی هەرێمی کوردستان',
    });

    expect(briefRes.ok).toBe(true); assert(briefRes.ok);
    if (!briefRes.ok) return;

    const batch = director.generateMultiFormatStudioOperations(briefRes.value, KAAE_PRIMARY_LOGO_SHA256);

    expect(Object.keys(batch)).toEqual(['feed', 'story', 'landscape', 'print_a4']);

    // Check each format bundle
    const feedBundle = batch.feed;
    expect(feedBundle.formatSpec.width).toBe(1080);
    expect(feedBundle.formatSpec.height).toBe(1350);
    expect(feedBundle.operations.length).toBeGreaterThanOrEqual(3);

    const storyBundle = batch.story;
    expect(storyBundle.formatSpec.width).toBe(1080);
    expect(storyBundle.formatSpec.height).toBe(1920);

    const landscapeBundle = batch.landscape;
    expect(landscapeBundle.formatSpec.width).toBe(1920);
    expect(landscapeBundle.formatSpec.height).toBe(1080);

    const printBundle = batch.print_a4;
    expect(printBundle.formatSpec.width).toBe(2480);
    expect(printBundle.formatSpec.height).toBe(3508);
    expect(printBundle.formatSpec.dpi).toBe(300);

    // Invariant 4 check on all plans
    for (const fmt of ['feed', 'story', 'landscape', 'print_a4'] as CanonicalFormat[]) {
      expect(batch[fmt].plan.artDirectionReference?.shippedInArtifact).toBe(false);
    }
  });
});
