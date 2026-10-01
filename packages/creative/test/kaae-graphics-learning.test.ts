import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import {
  KaaeGraphicsLearningEngine,
  type GraphicFeatureExtraction,
  type KaaeLearnedKnowledgeGraph,
} from '../src/index.js';

describe('KaaeGraphicsLearningEngine Unit & Integration Test', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const referencesDir = path.join(repoRoot, 'data/kaae-graphics/references');
  const engine = new KaaeGraphicsLearningEngine();

  it('initializes engine successfully', () => {
    expect(engine).toBeDefined();
  });

  it('analyzes an existing reference graphic file with accurate dimensions', () => {
    if (!fs.existsSync(referencesDir)) {
      return;
    }
    const sampleFile = path.join(referencesDir, 'KAAE_Commences_2026_Cycle_1080x1350.png');
    if (!fs.existsSync(sampleFile)) return;

    const extraction: GraphicFeatureExtraction = engine.analyzeReferenceFile(sampleFile);

    expect(extraction).toBeDefined();
    expect(extraction.sourceFile).toBe('KAAE_Commences_2026_Cycle_1080x1350.png');
    expect(extraction.sha256).toBeDefined();
    expect(extraction.dimensions.width).toBe(1080);
    expect(extraction.dimensions.height).toBe(1350);
    expect(extraction.format).toBe('feed');
    expect(extraction.detectedColors.length).toBeGreaterThanOrEqual(3);
    expect(extraction.typography.primaryFont).toBe('Inter');
    expect(extraction.typography.displayFont).toBe('IBM Plex Sans Arabic');
    expect(extraction.typography.bodyFont).toBe('Noto Sans Arabic');
    expect(extraction.learnedRules.length).toBeGreaterThanOrEqual(4);
  });

  it('recursively scans and analyzes all archive reference graphics', () => {
    const sampleFile = path.join(referencesDir, 'KAAE_Commences_2026_Cycle_1080x1350.png');
    if (!fs.existsSync(referencesDir) || !fs.existsSync(sampleFile)) {
      return;
    }
    const knowledge: KaaeLearnedKnowledgeGraph = engine.analyzeDirectory(referencesDir);

    expect(knowledge).toBeDefined();
    expect(knowledge.clientId).toBe('c1000000-0000-4000-8000-000000000002');
    expect(knowledge.clientName).toContain('Kurdistan Accrediting Association for Education');
    expect(knowledge.officialSlogan.en).toBe('Empowering Education, Inspiring the Future');
    expect(knowledge.officialSlogan.ckb).toContain('بەهێزکردنی پەروەردە');
    expect(knowledge.totalReferencesAnalyzed).toBeGreaterThanOrEqual(50);
    expect(knowledge.extractedColorPalette.length).toBeGreaterThanOrEqual(5);
    expect(knowledge.layoutArchetypes.length).toBe(8);
    expect(knowledge.compositionalInvariants.length).toBe(6);
    expect(knowledge.compositionalInvariants.some(inv => inv.includes('Law No. 6 of 2022'))).toBe(true);
    expect(knowledge.compositionalInvariants.some(inv => inv.includes('Empowering Education'))).toBe(true);
  });

  it('exports learned knowledge graph to JSON', () => {
    const sampleFile = path.join(referencesDir, 'KAAE_Commences_2026_Cycle_1080x1350.png');
    if (!fs.existsSync(referencesDir) || !fs.existsSync(sampleFile)) {
      return;
    }
    const knowledge = engine.analyzeDirectory(referencesDir);
    const testOutPath = path.join(repoRoot, 'data/kaae-graphics/test_learned_knowledge.json');

    try {
      engine.exportLearnedKnowledge(knowledge, testOutPath);
      expect(fs.existsSync(testOutPath)).toBe(true);
      const readBack = JSON.parse(fs.readFileSync(testOutPath, 'utf-8'));
      expect(readBack.clientId).toBe('c1000000-0000-4000-8000-000000000002');
      expect(readBack.officialSlogan.en).toBe('Empowering Education, Inspiring the Future');
    } finally {
      if (fs.existsSync(testOutPath)) {
        fs.unlinkSync(testOutPath);
      }
    }
  });

  it('updates client DNA with learned compositional invariants', () => {
    if (!fs.existsSync(referencesDir)) {
      return;
    }
    const knowledge = engine.analyzeDirectory(referencesDir);
    const tempDnaPath = path.join(repoRoot, 'data/kaae-graphics/test_dna.json');

    try {
      const mockDna = {
        clientId: 'c1000000-0000-4000-8000-000000000002',
        name: 'KAAE',
        guidelines: { layoutRules: ['Preserve sun seal'] },
        version: 1,
      };
      fs.writeFileSync(tempDnaPath, JSON.stringify(mockDna, null, 2), 'utf-8');

      engine.updateClientDna(knowledge, tempDnaPath);

      const updated = JSON.parse(fs.readFileSync(tempDnaPath, 'utf-8'));
      expect(updated.version).toBe(2);
      expect(updated.guidelines.layoutRules.length).toBeGreaterThan(1);
      expect(updated.guidelines.layoutRules).toContain(knowledge.compositionalInvariants[0]);
    } finally {
      if (fs.existsSync(tempDnaPath)) {
        fs.unlinkSync(tempDnaPath);
      }
    }
  });

  it('accurately parses SVG dimensions and detects landscape format', () => {
    const tempSvg = path.join(repoRoot, 'packages/creative/test/fixtures_temp_widescreen.svg');
    try {
      fs.writeFileSync(
        tempSvg,
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080"><rect width="1920" height="1080" fill="#0A1628"/></svg>'
      );
      const extraction = engine.analyzeReferenceFile(tempSvg);
      expect(extraction.dimensions.width).toBe(1920);
      expect(extraction.dimensions.height).toBe(1080);
      expect(extraction.format).toBe('landscape');
      expect(extraction.aspectRatio).toContain('16:9');
      // KAAE Brand Guidelines, Excellence Edition (KAAE_Guidelines4.pdf, 2025): palette pp.7-8, Sorani sans p.10.
      const hexes = extraction.detectedColors.map((c) => c.hex);
      expect(hexes).toEqual(expect.arrayContaining(['#4770A3', '#F7B500', '#0A1628', '#FFFFFF', '#FDF8F3']));
      expect(extraction.detectedColors.find((c) => c.role === 'primary')?.hex).toBe('#4770A3');
      expect(extraction.typography.primaryFont).toBe('Inter');
      expect(extraction.typography.displayFont).toBe('IBM Plex Sans Arabic');
      expect(extraction.typography.bodyFont).toBe('Noto Sans Arabic');
    } finally {
      if (fs.existsSync(tempSvg)) {
        fs.unlinkSync(tempSvg);
      }
    }
  });

  it('carries only the 2025 guideline palette and fonts, none of the withdrawn guideline', () => {
    // The withdrawn guideline's values and stale KAAE values, split so that a repository grep for them
    // finds only the code that still carries them.
    const withdrawn = new RegExp(['1708 7A', '3833 A3', '0F73 DE', 'E8B8 5C', 'FFF2 DB', '1608 74', '3530 9B', '0020 50',
      'C5A0 59', 'D4A9 4C', 'FFD1 5C', '2D4A 73', 'Verd ana', 'Cai ro', 'Nas kh', 'Min ion'].map((v) => v.replace(' ', '')).join('|'), 'i');
    const archetypes = engine.getFifteenGraphicArchetypes();
    expect(JSON.stringify(archetypes)).not.toMatch(withdrawn);
    const source = fs.readFileSync(path.join(repoRoot, 'packages/creative/src/kaae-graphics-learning.ts'), 'utf8');
    expect(source).not.toMatch(withdrawn);
  });

  it('accurately parses square SVG dimensions from viewBox', () => {
    const tempSvg = path.join(repoRoot, 'packages/creative/test/fixtures_temp_square.svg');
    try {
      fs.writeFileSync(
        tempSvg,
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080"><rect width="1080" height="1080" fill="#1E3A5F"/></svg>'
      );
      const extraction = engine.analyzeReferenceFile(tempSvg);
      expect(extraction.dimensions.width).toBe(1080);
      expect(extraction.dimensions.height).toBe(1080);
      expect(extraction.format).toBe('square');
      expect(extraction.aspectRatio).toContain('1:1');
    } finally {
      if (fs.existsSync(tempSvg)) {
        fs.unlinkSync(tempSvg);
      }
    }
  });
});
