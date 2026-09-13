import { describe, it, expect } from 'vitest';
import {
  generateVectorBackdropSvg,
  generateSmartContrastScrim,
  calculateContrastRatio,
  getRelativeLuminance,
  buildCompositedVisualBackdrop,
} from '../src/vector-compositor.js';
import {
  COMFY_WORKFLOW_TEMPLATES,
  buildComfyWorkflowForTemplate,
  ComfySandboxValidator,
} from '../src/comfy-sandbox.js';

describe('Vector Compositor & Dynamic Contrast Engine (Invariant #4)', () => {
  it('computes accurate relative luminance and WCAG 2.1 contrast ratios', () => {
    const whiteOnBlack = calculateContrastRatio('#FFFFFF', '#000000');
    expect(whiteOnBlack).toBeCloseTo(21, 1);

    // Drustee Navy vs Amber
    const drusteeContrast = calculateContrastRatio('#FFB200', '#0B192C');
    expect(drusteeContrast).toBeGreaterThan(7.0); // WCAG AAA compliant

    // White text on dark slate
    const whiteOnSlate = calculateContrastRatio('#FFFFFF', '#0F172A');
    expect(whiteOnSlate).toBeGreaterThan(14.0);
  });

  it('generates pristine vector backdrop SVGs for all 4 vetted templates', () => {
    const templates = [
      'clinical_podium_mesh',
      'kurdish_geometric_luxury',
      'tech_isometric_grid',
      'editorial_scrim_gradient',
    ] as const;

    for (const templateId of templates) {
      const svg = generateVectorBackdropSvg({
        templateId,
        width: 1080,
        height: 1350,
        primaryColor: '#0B192C',
        accentColor: '#FFB200',
        backgroundColor: '#030712',
        graphHash: 'hash_test_12345678',
      });

      expect(svg).toContain('<svg viewBox="0 0 1080 1350"');
      expect(svg).toContain(`data-template-id="${templateId}"`);
      expect(svg).toContain('data-graph-hash="hash_test_12345678"');

      // INVARIANT #4 STRICT CHECK: No raster text or embedded fonts inside background asset
      expect(svg).not.toContain('<text');
      expect(svg).not.toContain('<tspan');
      expect(svg).not.toContain('font-family');
    }
  });

  it('generates unflattened smart contrast scrim plates for text protection', () => {
    const topScrim = generateSmartContrastScrim({
      width: 1080,
      height: 1920,
      textPosition: 'top',
      scrimColor: '#000000',
      scrimOpacity: 0.6,
    });
    expect(topScrim).toContain('<linearGradient');
    expect(topScrim).toContain('stop-opacity="0.6"');

    const centerScrim = generateSmartContrastScrim({
      width: 1080,
      height: 1080,
      textPosition: 'center',
      scrimColor: '#0F172A',
      scrimOpacity: 0.5,
    });
    expect(centerScrim).toContain('<radialGradient');
    expect(centerScrim).toContain('<rect width="1080" height="1080"');
  });

  it('buildCompositedVisualBackdrop seamlessly layers backdrop and smart scrim', () => {
    const composite = buildCompositedVisualBackdrop({
      templateId: 'clinical_podium_mesh',
      width: 1080,
      height: 1350,
      primaryColor: '#0B192C',
      accentColor: '#FFB200',
      applySmartScrim: true,
      scrimPosition: 'top',
      scrimOpacity: 0.55,
    });

    expect(composite.scrimApplied).toBe(true);
    expect(composite.guaranteedWcagLevel).toBe('AAA');
    expect(composite.svg).toContain('data-template-id="clinical_podium_mesh"');
    expect(composite.svg).toContain('<linearGradient');
    expect(composite.svg).toContain('stop-color="#000000"');
  });

  it('buildComfyWorkflowForTemplate builds valid, allowlisted graphs for all templates', () => {
    const validator = new ComfySandboxValidator();
    const templateIds = Object.keys(COMFY_WORKFLOW_TEMPLATES) as Array<keyof typeof COMFY_WORKFLOW_TEMPLATES>;

    for (const templateId of templateIds) {
      const workflow = buildComfyWorkflowForTemplate({
        templateId,
        aspectRatio: 'feed',
        customPrompt: 'Drustee Vitamin D3 packaging',
      });

      const validation = validator.validateWorkflow(workflow);
      expect(validation.ok).toBe(true);
      if (validation.ok) {
        expect(validation.value.valid).toBe(true);
        expect(validation.value.quarantinedNodes).toHaveLength(0);
        expect(validation.value.prohibitedNodesFound).toHaveLength(0);
      }
    }
  });

  it('accurately computes contrast for shorthand hex codes and CSS named colors without NaN', () => {
    expect(calculateContrastRatio('#fff', '#000')).toBeCloseTo(21, 1);
    expect(calculateContrastRatio('white', 'black')).toBeCloseTo(21, 1);
    expect(getRelativeLuminance('#fff')).toBeCloseTo(1, 2);
    expect(getRelativeLuminance('black')).toBe(0);
  });

  it('generates deterministic identical SVGs across multiple invocations with graphHash', () => {
    const r1 = buildCompositedVisualBackdrop({
      templateId: 'editorial_scrim_gradient',
      width: 1080,
      height: 1080,
      graphHash: 'pinned_graph_hash_001',
    });
    const r2 = buildCompositedVisualBackdrop({
      templateId: 'editorial_scrim_gradient',
      width: 1080,
      height: 1080,
      graphHash: 'pinned_graph_hash_001',
    });
    expect(r1.svg).toBe(r2.svg);
  });
});
