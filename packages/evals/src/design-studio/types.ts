export interface CopyBlock {
  copyIndex: number;
  text: string;
  role: string;
  script: 'latin' | 'arabic';
}

export interface StudioGoldenBrief {
  id: string;
  compareId?: string;
  name: string;
  language: 'en' | 'ckb' | 'mixed';
  clientId: string;
  width: number;
  height: number;
  aspectLabel: string;
  instructions: string;
  rawRequestText: string;
  copyBlocks: CopyBlock[];
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

export interface CanaryResult {
  winnerId: string;
  passed: boolean;
  scoreAgainstDegraded1Normal: number;
  scoreAgainstDegraded1Swapped: number;
  scoreAgainstDegraded2Normal: number;
  scoreAgainstDegraded2Swapped: number;
  verdict: 'RELIABLE' | 'UNRELIABLE';
}

export interface TournamentResult {
  winnerId: string;
  candidateScores: Record<string, number>;
  swapConsistencyRate: number;
  pairwiseRounds: number;
}

export interface ParityResult {
  parity: 'match' | 'minor' | 'major';
  divergences: Array<{
    what: string;
    region?: { x: number; y: number; w: number; h: number };
    severity: 'minor' | 'major';
  }>;
  fontSubstituted: boolean;
  textReflowed: boolean;
  copyVisibleIdentical: boolean;
}

export interface StudioEvalRunResult {
  briefId: string;
  briefName: string;
  language: string;
  dimensions: string;
  status: 'transferred' | 'degraded' | 'failed';
  ladderRung: number;
  rungsTriggered: string[];
  callsCount: number;
  spentUsd: number;
  durationMs: number;
  winnerScore: number;
  canary: CanaryResult;
  tournament: TournamentResult;
  hardQaEscapes: number;
  canvaDesignId?: string;
  previewSha256?: string;
  parity?: ParityResult;
  fontFidelity: 'exact' | 'stand-in';
}

export interface StudioEvalReport {
  timestamp: string;
  mode: 'offline' | 'live';
  totalBriefs: number;
  completedBriefs: number;
  degradedBriefs: number;
  failedBriefs: number;
  canaryPassRate: number;
  tournamentSwapConsistencyRate: number;
  meanWinnerScore: number;
  minWinnerScore: number;
  hardQaEscapeCount: number;
  totalSpentUsd: number;
  meanSpentUsd: number;
  meanDurationSeconds: number;
  parityVerdicts: {
    match: number;
    minor: number;
    major: number;
  };
  results: StudioEvalRunResult[];
}

export interface HumanRatingRow {
  pairId: string;
  briefId: string;
  choice: 'A' | 'B' | 'tie';
  ratingA: number;
  ratingB: number;
  notes?: string;
}

export interface BootstrapConfidenceInterval {
  pointEstimate: number;
  ciLower95: number;
  ciUpper95: number;
  standardError: number;
}

export interface RatingsIntakeResult {
  totalPairs: number;
  v2WinCount: number;
  v1WinCount: number;
  tieCount: number;
  preferenceRateV2: BootstrapConfidenceInterval;
  meanRatingV1: BootstrapConfidenceInterval;
  meanRatingV2: BootstrapConfidenceInterval;
  /** Null when no pair in the key carries judge scores; never derived from invented ones. */
  spearmanRhoWithJudge: BootstrapConfidenceInterval | null;
  judgeAgreementRate: BootstrapConfidenceInterval | null;
  pairsWithJudgeScores: number;
}
