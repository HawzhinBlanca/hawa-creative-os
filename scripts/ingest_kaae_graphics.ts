#!/usr/bin/env tsx
/**
 * Hawa Creative OS — KAAE Reference Graphics Ingestion & Learning CLI
 * Analyzes reference graphic designs and extracts brand patterns, typography, and compositional blueprints.
 * 
 * Usage:
 *   npx tsx scripts/ingest_kaae_graphics.ts
 *   npx tsx scripts/ingest_kaae_graphics.ts --sync
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KaaeGraphicsLearningEngine } from '../packages/creative/src/kaae-graphics-learning.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const referencesDir = path.join(rootDir, 'data', 'kaae-graphics', 'references');
const outputKnowledgePath = path.join(rootDir, 'data', 'kaae-graphics', 'learned_knowledge.json');
const dnaPath = path.join(rootDir, 'config', 'clients', 'kaae.dna.json');

async function main() {
  console.log('======================================================');
  console.log('KAAE GRAPHICS REFERENCE LEARNING & INGESTION DAEMON');
  console.log('Client: Kurdistan Accrediting Association for Education');
  console.log('ID:     c1000000-0000-4000-8000-000000000002');
  console.log('======================================================\n');

  if (!fs.existsSync(referencesDir)) {
    fs.mkdirSync(referencesDir, { recursive: true });
  }

  const engine = new KaaeGraphicsLearningEngine();

  console.log(`[1/3] Scanning references directory: ${referencesDir}`);
  const files = fs.readdirSync(referencesDir).filter((f) => !f.startsWith('.'));
  console.log(`      Found ${files.length} design reference file(s) on disk.\n`);

  if (files.length === 0) {
    console.log('ℹ️  No reference graphic files found in data/kaae-graphics/references/.');
    console.log('    Drop high-resolution PNGs, SVGs, or PDFs into that folder to learn from them.');
    console.log('    Google Drive Folder ID: 1Y_koOMLeX32OwxqLx70agz8L1wrRVriX\n');
  }

  console.log('[2/3] Extracting visual tokens, layout hierarchies, and brand patterns...');
  const knowledge = engine.analyzeDirectory(referencesDir);

  console.log(`      ✓ Analyzed ${knowledge.totalReferencesAnalyzed} graphics successfully.`);
  console.log(`      ✓ Extracted ${knowledge.extractedColorPalette.length} brand color tokens.`);
  console.log(`      ✓ Identified ${knowledge.layoutArchetypes.length} canonical layout archetypes.`);
  console.log(`      ✓ Formulated ${knowledge.compositionalInvariants.length} compositional invariants.\n`);

  console.log('[3/3] Codifying learned intelligence...');
  engine.exportLearnedKnowledge(knowledge, outputKnowledgePath);
  console.log(`      ✓ Saved learned knowledge graph to: ${path.relative(rootDir, outputKnowledgePath)}`);

  engine.updateClientDna(knowledge, dnaPath);
  console.log(`      ✓ Synchronized updated invariants into: ${path.relative(rootDir, dnaPath)}\n`);

  console.log('======================================================');
  console.log('LEARNED KAAE DESIGN ARCHETYPES:');
  for (const arch of knowledge.layoutArchetypes) {
    console.log(`  • [${arch.aspectRatio}] ${arch.title} (${arch.width}x${arch.height})`);
    console.log(`    Use: ${arch.recommendedUse}`);
  }
  console.log('======================================================');
  console.log('COMPOSITIONAL INVARIANTS:');
  for (const inv of knowledge.compositionalInvariants) {
    console.log(`  ✓ ${inv}`);
  }
  console.log('======================================================\n');
  console.log('Status: KAAE Graphics Learning Engine qualification COMPLETE.\n');
}

main().catch((err) => {
  console.error('Fatal error during ingestion:', err);
  process.exit(1);
});
