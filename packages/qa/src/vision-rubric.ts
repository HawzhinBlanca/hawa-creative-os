/**
 * Hawa Creative OS — Multilingual Visual QA Vision Rubric Scorer
 * FR-039, FR-041, Invariant #9, Gate E
 * Evaluates Kurdish diacritic clearance, exact copy/price preservation,
 * WCAG 2.2 contrast adherence, and social UI collisions with cryptographic SHA-256 seal.
 */

import crypto from 'node:crypto';
import { getContrastRatio } from './contrast.js';

export interface RubricCanvasNode {
  id?: string;
  role?: string;
  text?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  background?: string;
  fontSize?: number;
  lineHeight?: number;
  fontFamily?: string;
  [key: string]: any;
}

export interface QualityEvaluationCandidate {
  taskId: string;
  revisionId: string;
  clientId: string;
  format: 'story' | 'feed' | 'square' | 'landscape';
  nodes: RubricCanvasNode[];
  brandColors?: string[];
  approvedCopy?: {
    headlineEn?: string;
    headlineCkb?: string;
    copyEn?: string;
    copyCkb?: string;
    prices?: string[];
    phones?: string[];
    disclaimers?: string[];
  };
  dimensions: { width: number; height: number };
}

export interface RubricFinding {
  severity: 'error' | 'warning' | 'info';
  category: 'copy' | 'typography' | 'contrast' | 'safe_zone' | 'brand';
  message: string;
  nodeId?: string;
}

export interface QualityRubricReport {
  reportId: string;
  taskId: string;
  revisionId: string;
  clientId: string;
  format: string;
  evaluatedAt: string;
  overallScore: number; // 0 - 100
  grade: 'AAA' | 'AA' | 'A' | 'B' | 'FAIL';
  passed: boolean;
  hardFailures: string[];
  criteriaScores: {
    copyFidelity: number;       // 30 pts max
    kurdishTypography: number;  // 25 pts max
    colorContrast: number;      // 25 pts max
    layoutSafeZones: number;    // 20 pts max
  };
  findings: RubricFinding[];
  cryptographicSeal: string;
}

const KURDISH_SPECIFIC_CHARS = /[\u0698\u067E\u0686\u06AF\u06A9\u06CC\u06C6\u06D5\u06B5\u06B5\u0695]/;
const ARABIC_NON_STANDARD = /[\u0643\u064A\u0649\u0629]/;

/**
 * Evaluates candidate artboard against deterministic & visual QA rubric.
 */
export function evaluateVisionRubric(candidate: QualityEvaluationCandidate): QualityRubricReport {
  const reportId = `qcr_${crypto.randomUUID().substring(0, 8)}`;
  const findings: RubricFinding[] = [];
  const hardFailures: string[] = [];

  let copyScore = 30;
  let typographyScore = 25;
  let contrastScore = 25;
  let safeZoneScore = 20;

  const { width, height } = candidate.dimensions;
  const nodes = candidate.nodes || [];
  const textNodes = nodes.filter((n) => n.text && n.text.trim().length > 0);

  // --- 1. Exact Copy & Protected Tokens Verification (30 pts) ---
  if (candidate.approvedCopy) {
    const allRenderedText = textNodes.map((n) => n.text || '').join(' ');

    // Check price tokens
    if (candidate.approvedCopy.prices) {
      for (const price of candidate.approvedCopy.prices) {
        if (!allRenderedText.includes(price)) {
          hardFailures.push(`Missing mandatory approved price token: '${price}'`);
          findings.push({
            severity: 'error',
            category: 'copy',
            message: `Exact approved price '${price}' missing from rendered design`,
          });
          copyScore = Math.max(0, copyScore - 15);
        }
      }
    }

    // Check phone numbers
    if (candidate.approvedCopy.phones) {
      for (const phone of candidate.approvedCopy.phones) {
        // Strip spaces/dashes for comparison
        const cleanPhone = phone.replace(/[\s-]/g, '');
        const cleanRendered = allRenderedText.replace(/[\s-]/g, '');
        if (!cleanRendered.includes(cleanPhone)) {
          hardFailures.push(`Missing mandatory contact phone number: '${phone}'`);
          findings.push({
            severity: 'error',
            category: 'copy',
            message: `Approved contact phone '${phone}' missing from design`,
          });
          copyScore = Math.max(0, copyScore - 15);
        }
      }
    }

    // Check headline presence
    if (candidate.approvedCopy.headlineCkb) {
      const cleanHead = candidate.approvedCopy.headlineCkb.trim();
      if (!allRenderedText.includes(cleanHead)) {
        findings.push({
          severity: 'warning',
          category: 'copy',
          message: `Approved Kurdish headline '${cleanHead}' not fully matched in canvas nodes`,
        });
        copyScore = Math.max(0, copyScore - 8);
      }
    }
  }

  // --- 2. Kurdish Typography & Diacritic Clearance (25 pts) ---
  for (const node of textNodes) {
    const text = node.text || '';

    // Check for Arabic non-standard substitutions (e.g. ك instead of ک)
    if (ARABIC_NON_STANDARD.test(text)) {
      typographyScore = Math.max(0, typographyScore - 5);
      findings.push({
        severity: 'warning',
        category: 'typography',
        message: `Non-standard Arabic character found in Kurdish text node (${node.id || 'text'}). Replace with standardized Sorani glyphs.`,
        nodeId: node.id,
      });
    }

    // Kurdish diacritic vertical headroom check
    if (KURDISH_SPECIFIC_CHARS.test(text)) {
      const lh = node.lineHeight || 1.2;
      if (lh < 1.42) {
        typographyScore = Math.max(0, typographyScore - 4);
        findings.push({
          severity: 'warning',
          category: 'typography',
          message: `Line height ${lh} on Kurdish text is below 1.45 safe headroom; vertical diacritics (ڵ/ۆ/ێ/ڕ) risk clipping.`,
          nodeId: node.id,
        });
      }
    }
  }

  // --- 3. Color Contrast & Brand Palette Adherence (25 pts) ---
  for (const node of textNodes) {
    if (node.color && (node.background || '#0B0F19')) {
      const fg = node.color;
      const bg = node.background || '#0B0F19';
      try {
        const ratio = getContrastRatio(fg, bg);
        const isLarge = (node.fontSize || 14) >= 18;
        const minRatio = isLarge ? 3.0 : 4.5;

        if (ratio < minRatio) {
          contrastScore = Math.max(0, contrastScore - 6);
          findings.push({
            severity: 'error',
            category: 'contrast',
            message: `Text contrast ratio ${ratio.toFixed(2)}:1 between ${fg} and ${bg} fails WCAG 2.2 AA threshold (${minRatio}:1)`,
            nodeId: node.id,
          });
        }
      } catch {
        // Skip unparseable gradient strings safely
      }
    }
  }

  // --- 4. Social UI Safe-Zone Collision Check (20 pts) ---
  let topDanger = 0;
  let bottomDanger = 0;

  if (candidate.format === 'story') {
    topDanger = 240;
    bottomDanger = 320;
  } else if (candidate.format === 'feed') {
    topDanger = 120;
    bottomDanger = 160;
  } else if (candidate.format === 'square') {
    topDanger = 80;
    bottomDanger = 100;
  } else {
    topDanger = 60;
    bottomDanger = 80;
  }

  for (const node of nodes) {
    const nodeTop = node.y;
    const nodeBottom = node.y + node.height;
    const isBackground = (node.role || '').toLowerCase() === 'background' || (node.width >= width && node.height >= height);

    if (isBackground) continue;

    // Check top social danger zone overlap
    if (nodeTop < topDanger && (node.role === 'headline' || node.role === 'logo' || node.role === 'copy')) {
      safeZoneScore = Math.max(0, safeZoneScore - 4);
      findings.push({
        severity: 'warning',
        category: 'safe_zone',
        message: `Node '${node.id || node.role}' at y=${nodeTop}px encroaches upon top social UI danger zone (0-${topDanger}px)`,
        nodeId: node.id,
      });
    }

    // Check bottom social danger zone overlap
    if (nodeBottom > height - bottomDanger && (node.role === 'copy' || node.role === 'badge' || node.role === 'badge_custom')) {
      safeZoneScore = Math.max(0, safeZoneScore - 4);
      findings.push({
        severity: 'warning',
        category: 'safe_zone',
        message: `Node '${node.id || node.role}' at bottom=${nodeBottom}px encroaches upon bottom social UI danger zone (${height - bottomDanger}-${height}px)`,
        nodeId: node.id,
      });
    }
  }

  const overallScore = Math.round(copyScore + typographyScore + contrastScore + safeZoneScore);
  const passed = hardFailures.length === 0 && overallScore >= 80;

  let grade: QualityRubricReport['grade'] = 'FAIL';
  if (passed) {
    if (overallScore >= 95) grade = 'AAA';
    else if (overallScore >= 88) grade = 'AA';
    else grade = 'A';
  } else if (hardFailures.length > 0) {
    grade = 'FAIL';
  } else {
    grade = overallScore >= 65 ? 'B' : 'FAIL';
  }

  const evaluatedAt = new Date().toISOString();
  const payloadToHash = `${candidate.taskId}:${candidate.revisionId}:${overallScore}:${hardFailures.join(',')}:${evaluatedAt}`;
  const cryptographicSeal = crypto.createHash('sha256').update(payloadToHash).digest('hex');

  return {
    reportId,
    taskId: candidate.taskId,
    revisionId: candidate.revisionId,
    clientId: candidate.clientId,
    format: candidate.format,
    evaluatedAt,
    overallScore,
    grade,
    passed,
    hardFailures,
    criteriaScores: {
      copyFidelity: copyScore,
      kurdishTypography: typographyScore,
      colorContrast: contrastScore,
      layoutSafeZones: safeZoneScore,
    },
    findings,
    cryptographicSeal,
  };
}
