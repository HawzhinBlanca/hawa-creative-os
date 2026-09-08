import { describe, it, expect } from 'vitest';
import {
  generateHycPackageData,
  generateSvgData,
  generateStandaloneSvgData,
  importFromHycPackage,
  buildOmnichannelCampaignZip,
  type CanvasExportState,
} from '../src/services/canvasExport';
import { BRAND_KITS } from '../src/services/brandKits';

describe('Canvas Export & HyCanvas Serialization Rigor', () => {
  const drusteeKit = BRAND_KITS.drustee;

  const sampleState: CanvasExportState = {
    format: 'feed',
    brandKit: drusteeKit,
    langVariant: 'ckb',
    headlineEn: 'Pure Vitamin D3 + K2',
    headlineCkb: 'ڤیتامین D3 + K2 ی زانستی',
    copyEn: '$34.00 · Clinical Grade',
    copyCkb: '٣٤ دۆلار · کوالێتی باوەڕپێکراو',
    fontFamily: 'Vazirmatn',
    fontWeight: 700,
    accentColor: '#D4AF37',
    nodes: [
      {
        id: 'node_headline',
        role: 'headline',
        name: 'Headline Text',
        x: 100,
        y: 150,
        width: 400,
        height: 80,
        rotation: 0,
        opacity: 1,
        zIndex: 10,
        locked: false,
        visible: true,
        textEn: 'Pure Vitamin D3 + K2',
        textCkb: 'ڤیتامین D3 + K2 ی زانستی',
        fontFamily: 'Vazirmatn',
        fontSize: 36,
        fontWeight: 700,
        color: '#FFFFFF',
        direction: 'rtl',
        groupId: 'group_header',
        textAlign: 'right',
        shadow: { x: 0, y: 4, blur: 8, color: 'rgba(0,0,0,0.4)' },
        lineHeight: 1.3,
        letterSpacing: 0.5,
      },
      {
        id: 'node_copy',
        role: 'copy',
        name: 'Price Badge',
        x: 50,
        y: 800,
        width: 320,
        height: 70,
        rotation: 0,
        opacity: 1,
        zIndex: 11,
        locked: false,
        visible: true,
        textEn: '$34.00 · Clinical Grade',
        textCkb: '٣٤ دۆلار · کوالێتی باوەڕپێکراو',
        backgroundColor: '#062E1D',
        color: '#D4AF37',
        fontSize: 20,
        fontWeight: 600,
        borderRadius: 14,
        direction: 'rtl',
      },
      {
        id: 'node_custom_seal',
        role: 'badge_custom',
        name: 'Lab Tested Seal',
        x: 350,
        y: 800,
        width: 120,
        height: 50,
        rotation: 0,
        opacity: 0.9,
        zIndex: 12,
        locked: true,
        visible: true,
        textEn: 'GMP Certified',
        textCkb: 'باوەڕپێکراوی GMP',
        backgroundColor: 'rgba(212, 175, 55, 0.2)',
        color: '#D4AF37',
        fontSize: 14,
        fontWeight: 700,
        borderRadius: 25,
      },
    ],
  };

  it('serializes complete vector tree and preserves typography, group, and shadow metadata', () => {
    const { json, package: pkg } = generateHycPackageData(sampleState);

    expect(pkg.formatVersion).toBe('0.4.0');
    expect(pkg.canvas.brandKitId).toBe('drustee');
    expect(pkg.nodes).toHaveLength(3);

    const headline = pkg.nodes.find((n: any) => n.id === 'node_headline');
    expect(headline).toBeDefined();
    expect(headline.groupId).toBe('group_header');
    expect(headline.textAlign).toBe('right');
    expect(headline.shadow).toEqual({ x: 0, y: 4, blur: 8, color: 'rgba(0,0,0,0.4)' });
    expect(headline.lineHeight).toBe(1.3);
    expect(headline.letterSpacing).toBe(0.5);

    // Dynamic quality audit verification
    expect(pkg.qualityAudit.status).toBe('CERTIFIED_PASS');
    expect(pkg.qualityAudit.hardChecks.measuredContrastRatio).toBeGreaterThan(4.5);
    expect(pkg.qualityAudit.hardChecks.wcagContrast).toMatch(/^(AAA|AA)_\d+\.\d+_TO_1$/);
  });

  it('losslessly restores all node properties on importFromHycPackage', async () => {
    const { json } = generateHycPackageData(sampleState);
    const result = await importFromHycPackage(json);

    expect(result.ok).toBe(true);
    expect(result.nodes).toHaveLength(3);

    const headline = result.nodes.find((n) => n.id === 'node_headline');
    expect(headline).toBeDefined();
    expect(headline?.groupId).toBe('group_header');
    expect(headline?.textAlign).toBe('right');
    expect(headline?.shadow).toEqual({ x: 0, y: 4, blur: 8, color: 'rgba(0,0,0,0.4)' });
    expect(headline?.lineHeight).toBe(1.3);
    expect(headline?.letterSpacing).toBe(0.5);
    expect(headline?.direction).toBe('rtl');
    expect(headline?.textCkb).toBe('ڤیتامین D3 + K2 ی زانستی');
  });

  it('embeds Google Fonts and dynamically reflects visibility changes in SVG export', () => {
    // 1. Normal state with visible elements
    const { svgContent: visibleSvg } = generateSvgData(sampleState);
    expect(visibleSvg).toContain('https://fonts.googleapis.com/css2?family=Inter');
    expect(visibleSvg).toContain('Vazirmatn');
    expect(visibleSvg).toContain('ڤیتامین D3 + K2 ی زانستی');
    expect(visibleSvg).toContain('باوەڕپێکراوی GMP');

    // 2. Hide headline and price badge
    const hiddenState: CanvasExportState = {
      ...sampleState,
      nodes: sampleState.nodes!.map((n) =>
        n.role === 'headline' || n.role === 'copy' ? { ...n, visible: false } : n
      ),
    };

    const { svgContent: hiddenSvg } = generateSvgData(hiddenState);
    // Headline and price badge text should NOT be rendered in the SVG
    expect(hiddenSvg).not.toContain('ڤیتامین D3 + K2 ی زانستی');
    expect(hiddenSvg).not.toContain('٣٤ دۆلار · کوالێتی باوەڕپێکراو');
    // But custom badge should still be there
    expect(hiddenSvg).toContain('باوەڕپێکراوی GMP');
  });

  it('generates 4-in-1 Omnichannel Campaign Pack (.zip) with linked variants, SVGs, .hyc, and manifest (FR-033)', async () => {
    const { bundler, manifest, zipFilename } = await buildOmnichannelCampaignZip({
      state: sampleState,
      task: { id: 'task_drustee_campaign_001', title: 'Drustee Vitamin D3 Launch' },
      qaReport: { status: 'PASSED', violations: 0, wcagRatio: 13.11 },
    });

    expect(zipFilename).toContain('hawa-omnichannel-drustee');
    expect(manifest.campaignId).toMatch(/^HAWA-OMNI-/);
    expect(manifest.client.id).toBe('drustee');
    expect(manifest.invariants.fr033_aspect_ratios_linked).toBe('VERIFIED_4_CHANNELS');
    expect(manifest.invariants.invariant2_editable_vector_tree).toBe('VERIFIED_LOSSLESS');
    expect(manifest.channels.length).toBe(4);

    const expectedPresets = ['feed', 'story', 'square', 'landscape'];
    expect(manifest.channels.map((c: any) => c.preset)).toEqual(expectedPresets);

    const zipBlob = bundler.generateZipBlob();
    expect(zipBlob).toBeDefined();
    expect(zipBlob.type).toBe('application/zip');
    expect(zipBlob.size).toBeGreaterThan(500);

    const buffer = await zipBlob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const contentText = new TextDecoder().decode(bytes);

    // Verify all directories and key files are present in the ZIP
    expect(contentText).toContain('01_feed_portrait_4x5/vector_master.svg');
    expect(contentText).toContain('01_feed_portrait_4x5/editable_tree.hyc');
    expect(contentText).toContain('02_story_vertical_9x16/vector_master.svg');
    expect(contentText).toContain('02_story_vertical_9x16/editable_tree.hyc');
    expect(contentText).toContain('03_square_feed_1x1/vector_master.svg');
    expect(contentText).toContain('03_square_feed_1x1/editable_tree.hyc');
    expect(contentText).toContain('04_landscape_billboard_16x9/vector_master.svg');
    expect(contentText).toContain('04_landscape_billboard_16x9/editable_tree.hyc');
    expect(contentText).toContain('campaign_manifest.json');
    expect(contentText).toContain('README_CAMPAIGN.txt');
  });

  it('generates zero-dependency standalone SVG with inlined Base64 Kurdish WOFF2 font', () => {
    const { filename, svgContent } = generateStandaloneSvgData(sampleState);
    expect(filename).toContain('-zero-dep.svg');
    expect(svgContent).toContain('data:font/woff2;charset=utf-8;base64,');
    expect(svgContent).toContain("@font-face");
    expect(svgContent).toContain("font-family: 'Vazirmatn'");
    expect(svgContent).not.toContain('fonts.googleapis.com');
  });

  it('correctly splits and formats multiline custom badges and texts with tspans in SVG export', () => {
    const multilineState: CanvasExportState = {
      ...sampleState,
      nodes: [
        {
          id: 'node_stat_box_1',
          role: 'badge_custom',
          name: 'Stat Badge',
          x: 50,
          y: 200,
          width: 200,
          height: 100,
          visible: true,
          zIndex: 5,
          locked: false,
          textEn: '100%\nStatutory Compliance\nKurdistan Parity',
          backgroundColor: '#0F172A',
          color: '#38BDF8',
          fontSize: 16,
        },
        {
          id: 'node_multiline_text',
          role: 'text_custom',
          name: 'Header Notice',
          x: 50,
          y: 350,
          width: 300,
          height: 100,
          visible: true,
          zIndex: 6,
          locked: false,
          textEn: 'OFFICIAL NOTICE\nMINISTRY DIRECTIVE\nERBIL HEADQUARTERS',
          fontSize: 20,
        },
      ],
    };

    const { svgContent } = generateSvgData(multilineState);
    expect(svgContent).toContain('<tspan');
    expect(svgContent).toContain('>100%</tspan>');
    expect(svgContent).toContain('>Statutory Compliance</tspan>');
    expect(svgContent).toContain('>Kurdistan Parity</tspan>');
    expect(svgContent).toContain('OFFICIAL NOTICE');
    expect(svgContent).toContain('MINISTRY DIRECTIVE');
    expect(svgContent).toContain('ERBIL HEADQUARTERS');
  });

  it('correctly computes WCAG contrast and auto-selects dark text on rgba translucent white backgrounds', () => {
    const translucentState: CanvasExportState = {
      ...sampleState,
      brandKit: {
        ...drusteeKit,
        palette: {
          ...drusteeKit.palette,
          cardBg: 'rgba(255, 255, 255, 0.95)',
        },
      },
      nodes: [
        {
          id: 'node_copy_white',
          role: 'copy',
          name: 'White Translucent Badge',
          x: 50,
          y: 800,
          width: 320,
          height: 70,
          visible: true,
          zIndex: 10,
          locked: false,
          textEn: '$34.00 · Clinical Grade',
          backgroundColor: 'rgba(255, 255, 255, 0.95)',
        },
      ],
    };

    const { svgContent } = generateSvgData(translucentState);
    // Badge on white background must receive dark text, never white text
    expect(svgContent).toContain('fill="#0F172A"');
  });

  it('safely XML-escapes ampersands and angle brackets in SVG export preventing parse errors', () => {
    const specialCharsState: CanvasExportState = {
      ...sampleState,
      langVariant: 'bilingual',
      headlineEn: 'Research & Development <Advanced>',
      headlineCkb: 'توێژینەوە & پەرەپێدان <تایبەت>',
      copyEn: 'Clinical Trials & Standards',
      copyCkb: 'ستانداردەکان & ڕێنماییەکان',
      nodes: undefined,
    };

    const { svgContent } = generateSvgData(specialCharsState);
    // Must contain escaped &amp; and &lt; / &gt;
    expect(svgContent).toContain('Research &amp; Development &lt;Advanced&gt;');
    expect(svgContent).toContain('توێژینەوە &amp; پەرەپێدان &lt;تایبەت&gt;');
    expect(svgContent).toContain('Clinical Trials &amp; Standards');
    // Must NOT contain bare unescaped &
    expect(svgContent).not.toMatch(/Research & Development/);
    // Must preserve UAX #9 isolate entities
    expect(svgContent).toContain('&#x2067;');
    expect(svgContent).toContain('&#x2069;');
  });

  it('losslessly round-trips custom image layers and digitScript metadata in .hyc package', async () => {
    const imageNodeState: CanvasExportState = {
      ...sampleState,
      nodes: [
        {
          id: 'node_custom_photo',
          role: 'image_custom',
          name: 'Hero Product Photo',
          x: 40,
          y: 60,
          width: 400,
          height: 300,
          visible: true,
          zIndex: 5,
          locked: false,
          imageUrl: 'https://storage.hawa.dev/assets/drustee/bottle-hero.webp',
          digitScript: 'eastern',
        } as any,
      ],
    };

    const { json } = generateHycPackageData(imageNodeState);
    const result = await importFromHycPackage(json);

    expect(result.ok).toBe(true);
    expect(result.nodes).toHaveLength(1);
    const restored = result.nodes[0];
    expect(restored.role).toBe('image_custom');
    expect(restored.imageUrl).toBe('https://storage.hawa.dev/assets/drustee/bottle-hero.webp');
    expect(restored.digitScript).toBe('eastern');
  });
});
