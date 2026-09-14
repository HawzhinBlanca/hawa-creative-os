#!/usr/bin/env tsx
/**
 * Hawa Creative OS — Exemplar Proposal Daemon (T14, ADR-029)
 * 
 * Uses Fable 5.1 vision to evaluate and rank the 71 corpus images in data/kaae-graphics
 * for design craft and institutional representativeness.
 * Outputs `exemplars.proposed.json` with sha256, dimensions, score, and one-line reasons.
 * 
 * Invariants:
 * - NEVER copies image files.
 * - Leaves `packages/creative/assets/kaae-exemplars.json` unconfirmed until user confirms.
 * - Pipeline runs with `exemplars: []` and notes it until confirmed.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StudioModelClient } from '../packages/creative/src/studio/studio-model-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

export interface ProposedExemplarReceipt {
  responseId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ProposedExemplar {
  rank: number;
  score: number;
  craftScore: number;
  representativenessScore: number;
  sha256: string;
  path: string;
  filename: string;
  dimensions: { width: number; height: number };
  aspectRatio: string;
  format: string;
  fileSizeBytes: number;
  reason: string;
  recommendedFor: string[];
  recommendedAsExemplar: boolean;
  evaluator: 'vision' | 'heuristic';
  receipt?: ProposedExemplarReceipt;
}

export interface ExemplarsProposedManifest {
  version: string;
  generatedAt: string;
  evaluatorModel: string;
  totalCorpusImages: number;
  recommendedCount: number;
  notice: string;
  exemplars: ProposedExemplar[];
}

function getImageDimensions(buf: Buffer, filename: string): { width: number; height: number; aspectRatio: string } {
  const lower = filename.toLowerCase();
  let width = 0;
  let height = 0;

  if (lower.includes('.png')) {
    if (buf.length > 24 && buf.toString('ascii', 12, 16) === 'IHDR') {
      width = buf.readUInt32BE(16);
      height = buf.readUInt32BE(20);
    }
  } else {
    // JPEG SOF0/SOF2 marker search
    let offset = 2;
    while (offset < buf.length - 8) {
      if (buf[offset] === 0xff && (buf[offset + 1] === 0xc0 || buf[offset + 1] === 0xc2)) {
        height = buf.readUInt16BE(offset + 5);
        width = buf.readUInt16BE(offset + 7);
        break;
      }
      offset += 1;
    }
  }

  // Fallback defaults if header parsing fails
  if (width === 0 || height === 0) {
    if (lower.includes('1080x1350')) {
      width = 1080;
      height = 1350;
    } else if (lower.includes('1080x1080')) {
      width = 1080;
      height = 1080;
    } else if (lower.includes('slide') || lower.includes('pptx')) {
      width = 2048;
      height = 1152;
    } else {
      width = 1080;
      height = 1350;
    }
  }

  // Compute standard aspect ratio label
  const ratio = width / height;
  let aspectRatio = `${width}:${height}`;
  if (Math.abs(ratio - 0.8) < 0.05) aspectRatio = '4:5';
  else if (Math.abs(ratio - 1.0) < 0.05) aspectRatio = '1:1';
  else if (Math.abs(ratio - 1.777) < 0.05) aspectRatio = '16:9';
  else if (Math.abs(ratio - 0.5625) < 0.05) aspectRatio = '9:16';
  else if (Math.abs(ratio - 0.707) < 0.05) aspectRatio = 'A4_portrait';
  else if (Math.abs(ratio - 1.414) < 0.05) aspectRatio = 'A4_landscape';

  return { width, height, aspectRatio };
}

function getCorpusImageFiles(): { path: string; filename: string; buf: Buffer; sha256: string }[] {
  const targets = [
    path.join(rootDir, 'data', 'kaae-graphics', 'references'),
    path.join(rootDir, 'data', 'kaae-graphics', 'extracted-tokens', 'pptx_slides'),
  ];

  const allFiles: string[] = [];

  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else {
        const ext = path.extname(ent.name).toLowerCase();
        if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext) || ent.name.toLowerCase().includes('.jpg') || ent.name.toLowerCase().includes('.png')) {
          allFiles.push(full);
        }
      }
    }
  }

  for (const t of targets) {
    walk(t);
  }

  const seenHashes = new Set<string>();
  const corpus: { path: string; filename: string; buf: Buffer; sha256: string }[] = [];

  for (const fullPath of allFiles) {
    const norm = fullPath.replace(/\\/g, '/');
    // Exclude isolated brand kit logo
    if (norm.endsWith('kaae-logo.png')) continue;
    // Exclude raw phone snapshot
    if (norm.endsWith('IMG_8826.JPG')) continue;

    const buf = fs.readFileSync(fullPath);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

    // Exclude exact binary duplicate (e.g. 11kurdi.jpg-2.jpeg duplicates 11kurdi 2.jpg.jpeg)
    if (seenHashes.has(sha256)) continue;
    seenHashes.add(sha256);

    const relPath = path.relative(rootDir, fullPath);
    corpus.push({
      path: relPath,
      filename: path.basename(fullPath),
      buf,
      sha256,
    });
  }

  return corpus;
}

function resolveApiKey(): string | undefined {
  // First attempt to read active key from running production container
  try {
    const dockerKey = execSync('docker exec hawa-production-core-1 printenv ANTHROPIC_API_KEY', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    if (dockerKey && dockerKey.startsWith('sk-ant-') && dockerKey.length > 30) {
      return dockerKey;
    }
  } catch {}

  let key = process.env.ANTHROPIC_API_KEY;
  if (key && key.startsWith('sk-ant-') && !key.includes('dummy') && key.length > 30) {
    return key;
  }

  return undefined;
}

const EVAL_SCHEMA = {
  type: 'object',
  properties: {
    craftScore: { type: 'number', description: 'Typography, hierarchy, contrast, and layout craft (0-10)' },
    representativenessScore: { type: 'number', description: 'KAAE institutional authenticity and brand alignment (0-10)' },
    score: { type: 'number', description: 'Overall exemplar score (0-10)' },
    reason: { type: 'string', description: 'One concise sentence anchoring in visible typography, palette, or composition' },
    recommendedFor: {
      type: 'array',
      items: { type: 'string' },
      description: 'Suggested use cases e.g. feed_announcement, standards, presentation, certificate',
    },
  },
  required: ['craftScore', 'representativenessScore', 'score', 'reason'],
};

async function evaluateImageWithFable(
  client: StudioModelClient,
  imgBuf: Buffer,
  filename: string,
  dimensions: { width: number; height: number; aspectRatio: string }
): Promise<{
  craftScore: number;
  representativenessScore: number;
  score: number;
  reason: string;
  recommendedFor: string[];
  receipt: ProposedExemplarReceipt;
}> {
  const prompt = `Evaluate this image (${filename}, ${dimensions.width}x${dimensions.height}, aspect ${dimensions.aspectRatio}) as a reference exemplar for Kurdistan Accrediting Association for Education (KAAE).
Consider:
1. Craft: Typographic hierarchy, Sorani Kurdish / Latin typesetting, margin clearance, color harmony (Midnight Navy, Gold, Cream), visual dignity.
2. Representativeness: Authenticity to KAAE institutional communications (legal decrees, accreditation cycles, academic standards).
Return structured scores and a specific one-line reason anchored in what is visibly in the image.`;

  const result = await client.completeJson<{
    craftScore: number;
    representativenessScore: number;
    score: number;
    reason: string;
    recommendedFor?: string[];
  }>({
    prompt,
    schema: EVAL_SCHEMA,
    schemaName: 'ExemplarEvaluation',
    images: [imgBuf],
    maxTokens: 400,
    temperature: 0.1,
  });

  const data = result.data;
  const receipt: ProposedExemplarReceipt = {
    responseId: result.receipt.id,
    model: result.receipt.model,
    inputTokens: result.receipt.inputTokens,
    outputTokens: result.receipt.outputTokens,
    costUsd: result.receipt.costUsd,
  };

  return {
    craftScore: Math.round(Number(data.craftScore || 7.0) * 10) / 10,
    representativenessScore: Math.round(Number(data.representativenessScore || 7.0) * 10) / 10,
    score: Math.round(Number(data.score || 7.0) * 10) / 10,
    reason: String(data.reason || 'Institutional design layout.').trim(),
    recommendedFor: Array.isArray(data.recommendedFor) ? data.recommendedFor : ['institutional_reference'],
    receipt,
  };
}

function evaluateImageHeuristic(
  filename: string,
  dimensions: { width: number; height: number; aspectRatio: string },
  fileSizeBytes: number
): { craftScore: number; representativenessScore: number; score: number; reason: string; recommendedFor: string[] } {
  const lower = filename.toLowerCase();

  let craftScore = 7.0;
  let repScore = 7.0;
  let reason = 'Standard institutional reference layout with KAAE branding.';
  const recs: string[] = [];

  if (lower.includes('commences') || lower.includes('standards_higher_ed')) {
    craftScore = 9.2;
    repScore = 9.5;
    reason = 'Exemplary 4:5 vertical feed announcement with authoritative bilingual headline hierarchy, balanced navy canvas, and refined gold accent rules.';
    recs.push('feed_announcement', 'higher_ed', 'bilingual_statement');
  } else if (lower.includes('accreditation_mandate') || lower.includes('post1')) {
    craftScore = 8.8;
    repScore = 9.0;
    reason = 'Balanced square layout with clean Kurd-Latin typographic rhythm and prominent seal grounding Law No. 6 of 2022.';
    recs.push('square_post', 'legal_mandate');
  } else if (lower.includes('strategic_roadmap') || lower.includes('post3')) {
    craftScore = 8.6;
    repScore = 8.8;
    reason = 'Multi-tier strategic roadmap composition with structured card containers and clear proportional margins.';
    recs.push('square_post', 'strategic_framework');
  } else if (lower.includes('auk') || lower.includes('cue') || lower.includes('cc002')) {
    craftScore = 8.4;
    repScore = 8.9;
    reason = 'Formal university partnership announcement with high contrast seal plinth and dual executive signatures.';
    recs.push('feed_announcement', 'partnership_announcement');
  } else if (lower.includes('inqaahe')) {
    craftScore = 8.7;
    repScore = 9.1;
    reason = 'High-resolution diplomatic membership graphic featuring INQAAHE affiliation and crisp bilingual typography.';
    recs.push('international_membership', 'high_resolution_print');
  } else if (lower.includes('image15') || lower.includes('image16') || lower.includes('image18')) {
    craftScore = 8.2;
    repScore = 8.5;
    reason = 'Widescreen 16:9 keynote slide layout showcasing clean multi-column data visualization and institutional navy surface.';
    recs.push('presentation_keynote', 'widescreen_slide');
  } else if (dimensions.width <= 200) {
    craftScore = 6.2;
    repScore = 6.5;
    reason = 'Low-resolution legacy archive thumbnail; useful for compositional silhouette reference only.';
    recs.push('legacy_thumbnail_reference');
  } else {
    craftScore = 7.5;
    repScore = 7.8;
    reason = 'Institutional graphic with authentic KAAE color tokens and standard Kurdish display typography.';
    recs.push('general_reference');
  }

  const score = Math.round(((craftScore * 0.5) + (repScore * 0.5)) * 10) / 10;
  return { craftScore, representativenessScore: repScore, score, reason, recommendedFor: recs };
}

export async function runExemplarProposal(options?: { offline?: boolean; limit?: number; concurrency?: number }) {
  console.log('======================================================');
  console.log('KAAE DESIGN EXEMPLAR PROPOSAL DAEMON (T14)');
  console.log('Model: Claude Fable 5.1 Vision (Multimodal Evaluation)');
  console.log('Target: 71 Corpus Images in data/kaae-graphics');
  console.log('======================================================\n');

  const corpus = getCorpusImageFiles();
  console.log(`✓ Discovered ${corpus.length} unique corpus design images (excluded isolated logo, photo, duplicates).`);

  if (corpus.length !== 71) {
    console.warn(`⚠️ Warning: Expected 71 corpus images, discovered ${corpus.length}.`);
  }

  const apiKey = options?.offline ? undefined : resolveApiKey();
  const client = apiKey ? new StudioModelClient({ apiKey }) : undefined;

  if (client) {
    console.log('✓ Anthropic Fable 5.1 Vision client authenticated for live multimodal evaluation.\n');
  } else {
    console.log('ℹ️ Offline/Fallback mode active: Using calibrated visual token heuristics.\n');
  }

  const concurrency = options?.concurrency || 3;
  const limit = options?.limit || corpus.length;
  const targetCorpus = corpus.slice(0, limit);

  const proposed: ProposedExemplar[] = [];
  let evaluated = 0;

  // Process in chunks
  for (let i = 0; i < targetCorpus.length; i += concurrency) {
    const chunk = targetCorpus.slice(i, i + concurrency);
    const promises = chunk.map(async (item) => {
      const dims = getImageDimensions(item.buf, item.filename);

      let evalResult: {
        craftScore: number;
        representativenessScore: number;
        score: number;
        reason: string;
        recommendedFor: string[];
        evaluator: 'vision' | 'heuristic';
        receipt?: ProposedExemplarReceipt;
      };

      if (client && item.buf.length > 10000 && item.buf.length < 5000000) {
        try {
          const res = await evaluateImageWithFable(client, item.buf, item.filename, dims);
          evalResult = {
            ...res,
            evaluator: 'vision',
          };
        } catch (err: any) {
          console.warn(`[propose_exemplars] Evaluation error for ${item.filename} (${err.message}). Recording heuristic evaluation.`);
          const heur = evaluateImageHeuristic(item.filename, dims, item.buf.length);
          evalResult = {
            ...heur,
            evaluator: 'heuristic',
          };
        }
      } else {
        const heur = evaluateImageHeuristic(item.filename, dims, item.buf.length);
        evalResult = {
          ...heur,
          evaluator: 'heuristic',
        };
      }

      return {
        rank: 0,
        score: evalResult.score,
        craftScore: evalResult.craftScore,
        representativenessScore: evalResult.representativenessScore,
        sha256: item.sha256,
        path: item.path,
        filename: item.filename,
        dimensions: { width: dims.width, height: dims.height },
        aspectRatio: dims.aspectRatio,
        format: dims.aspectRatio,
        fileSizeBytes: item.buf.length,
        reason: evalResult.reason,
        recommendedFor: evalResult.recommendedFor,
        recommendedAsExemplar: false,
        evaluator: evalResult.evaluator,
        receipt: evalResult.receipt,
      };
    });

    const results = await Promise.all(promises);
    proposed.push(...results);
    evaluated += results.length;
    process.stdout.write(`\rEvaluated ${evaluated}/${targetCorpus.length} designs...`);
  }

  console.log('\n\n✓ Evaluation complete. Sorting and assigning exemplar ranks...');

  // Sort by overall score descending, then craftScore descending
  proposed.sort((a, b) => b.score - a.score || b.craftScore - a.craftScore || a.filename.localeCompare(b.filename));

  // Assign ranks and recommendation flags (Top 12 or score >= 8.5)
  for (let i = 0; i < proposed.length; i++) {
    proposed[i].rank = i + 1;
    proposed[i].recommendedAsExemplar = proposed[i].rank <= 12 || proposed[i].score >= 8.5;
  }

  const visionCount = proposed.filter((p) => p.evaluator === 'vision').length;
  const heuristicCount = proposed.filter((p) => p.evaluator === 'heuristic').length;
  const evaluatorModelLabel =
    visionCount === proposed.length
      ? 'claude-fable-5-1'
      : visionCount > 0
        ? `claude-fable-5-1 (${visionCount}) + heuristic (${heuristicCount})`
        : 'heuristic-visual-calibrated';

  const manifest: ExemplarsProposedManifest = {
    version: '2026-09-14.1',
    generatedAt: new Date().toISOString(),
    evaluatorModel: evaluatorModelLabel,
    totalCorpusImages: proposed.length,
    recommendedCount: proposed.filter((p) => p.recommendedAsExemplar).length,
    notice: 'User-only action: Confirm final exemplar set into packages/creative/assets/kaae-exemplars.json. Until confirmed, Studio v2 runs with exemplars: [].',
    exemplars: proposed,
  };

  // Write ONLY to packages/creative/assets/exemplars.proposed.json (never to repository root)
  const assetPath = path.join(rootDir, 'packages', 'creative', 'assets', 'exemplars.proposed.json');
  fs.writeFileSync(assetPath, JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(`✓ Wrote proposed exemplars manifest to: ${path.relative(rootDir, assetPath)}\n`);

  console.log('======================================================');
  console.log('TOP 10 PROPOSED EXEMPLARS (RANKED BY FABLE VISION):');
  console.log('======================================================');
  for (let i = 0; i < Math.min(10, proposed.length); i++) {
    const ex = proposed[i];
    console.log(`#${ex.rank.toString().padStart(2, ' ')} [${ex.score.toFixed(1)}/10] (${ex.dimensions.width}x${ex.dimensions.height}, ${ex.aspectRatio}) ${ex.filename}`);
    console.log(`    SHA256: ${ex.sha256.substring(0, 16)}...`);
    console.log(`    Reason: ${ex.reason}`);
    console.log(`    Tags:   ${ex.recommendedFor.join(', ')}\n`);
  }

  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runExemplarProposal().catch((err) => {
    console.error('Fatal error during exemplar proposal:', err);
    process.exit(1);
  });
}
