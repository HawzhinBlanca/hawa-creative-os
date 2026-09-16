import type { StudioLayoutV2 } from '@hawa/creative';
import type { LayoutMetrics } from '@hawa/creative';
import type { OpenAiStudioClient } from '@hawa/creative';
import type { GeminiImageProvider, OpenAiImageProvider } from '@hawa/creative';
import type { DesignStudioRepository } from '@hawa/db';

export class StudioBudgetExhaustedError extends Error {
  readonly code = 'BUDGET_EXHAUSTED';
  constructor(message = 'BUDGET_EXHAUSTED') {
    super(message);
    this.name = 'StudioBudgetExhaustedError';
  }
}

export interface CreativeBriefRole {
  copyIndex: number;
  role: 'eyebrow' | 'title' | 'subtitle' | 'body' | 'date' | 'venue' | 'cta' | 'footer' | 'other';
  importance: 1 | 2 | 3 | 4 | 5;
}

export interface CreativeBrief {
  occasion: string;
  audience: string;
  formality: 1 | 2 | 3 | 4 | 5;
  toneWords: [string, string, string];
  readingOrder: number[];
  roles: CreativeBriefRole[];
  must: string[];
  mustNot: string[];
  imageryStrategy: 'none' | 'abstract' | 'photographic';
  imageryRationale: string;
  kurdishLeads: boolean;
  riskFlags: string[];
}

export type Archetype =
  | 'editorial-centered'
  | 'asymmetric-grid'
  | 'typographic-poster'
  | 'framed-invitation'
  | 'split-band'
  | 'full-bleed-art-with-scrim'
  | 'monumental-title'
  | 'ribbon-and-rules';

export type MotifKind = 'guilloche' | 'sun-rays' | 'thin-rules' | 'gradient-wash';

export interface Concept {
  id: string;
  name: string;
  archetype: Archetype;
  artStrategy: 'none' | 'procedural' | 'generated';
  motif?: MotifKind;
  artPrompt?: string;
  typographicScale: { ratio: number; titleSize: number; bodySize: number };
  colourRoles: { background: string; title: string; body: string; accent: string; rule: string };
  layoutIdea: string;
  whyDifferent: string;
}

export interface Critique {
  observations: Array<{ text: string; region: { x: number; y: number; w: number; h: number } }>;
  scores: {
    hierarchy: number;
    typography: number;
    composition: number;
    whitespace: number;
    brandFidelity: number;
    legibility: number;
    craft: number;
  };
  evidence: {
    hierarchy: string;
    typography: string;
    composition: string;
    whitespace: string;
    brandFidelity: string;
    legibility: string;
    craft: string;
  };
  hardFails: string[];
  revisions: Array<{ element: string; change: string; target: string }>;
  weightedScore: number;
  overall?: number;
}

export interface PairwiseVerdict {
  winner: 'A' | 'B' | 'tie' | 'both_unacceptable';
  confidence: number;
  reasons: string[];
  hardFails: { A: string[]; B: string[] };
}

export interface CanaryResult {
  passed: boolean;
  judgeStatus: 'RELIABLE' | 'UNRELIABLE';
  details: Array<{ perturbation: number; orderSwapped: boolean; verdict: PairwiseVerdict; winnerWon: boolean }>;
}

export interface HardQAResult {
  passed: boolean;
  defectCodes: string[];
  metrics: LayoutMetrics;
}

export interface ParityResult {
  parity: 'match' | 'minor' | 'major';
  divergences: Array<{ what: string; region: { x: number; y: number; w: number; h: number }; severity: 'minor' | 'major' }>;
  fontSubstituted: boolean;
  textReflowed: boolean;
  copyVisibleIdentical: boolean;
}

export type CopyBlock = { text: string; script: 'latin' | 'arabic' | 'mixed' };

export interface ReferencePack {
  palette: string[];
  referenceFonts?: { latin?: string; arabic?: string };
  exemplars?: Array<{ path: string; label: string; sha256?: string }>;
  [key: string]: unknown;
}

export interface StageContext {
  runId: string;
  tenantId: string;
  taskId: string;
  clientId: string;
  actorId: string;
  width: number;
  height: number;
  tier: 'standard' | 'premium';
  instructions: string;
  copyBlocks: CopyBlock[];
  referencePack: ReferencePack;
  promotedRules: string;
  latinFont: string;
  arabicFont: string;
  logoAspect?: number;
  logo?: { bytes: Buffer; sha256: string; mimeType: 'image/png' | 'image/jpeg' };
  exemplars?: Array<{ path: string; label: string; sha256?: string; bytes?: Buffer; mimeType?: string }>;
  client: OpenAiStudioClient;
  artProvider?: OpenAiImageProvider | GeminiImageProvider;
  ledger?: DesignStudioRepository;
}

export interface StageExecutionReceipt {
  stage: string;
  startedAt: string;
  finishedAt: string;
  callIds: string[];
  usdEstimate: number;
  status: 'ok' | 'degraded' | 'failed';
  diagnostic?: string;
}

export interface CandidateState {
  id: string;
  ordinal: number;
  concept: Concept;
  layouts: StudioLayoutV2[];
  currentLayout: StudioLayoutV2;
  artPng?: Buffer | null;
  artSha256?: string | null;
  artProvenance?: Record<string, unknown> | null;
  previewPng?: Buffer | null;
  previewSha256?: string | null;
  compositePng?: Buffer | null;
  metrics?: LayoutMetrics | null;
  critiques: Critique[];
  score?: number | null;
  rank?: number | null;
  status: 'draft' | 'active' | 'eliminated' | 'winner' | 'runner_up';
  diagnostics?: string[];
  validation?: any;
}
