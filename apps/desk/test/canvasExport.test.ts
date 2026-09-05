import { describe, it, expect } from 'vitest';
import {
  generateHycPackageData,
  generateSvgData,
  importFromHycPackage,
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
});
