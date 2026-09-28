import type { ExemplarRetrievalEvidence } from '@hawa/creative';
import type { StudioLayoutV2 } from '@hawa/creative';
import type { LayoutMetrics, TextMeasurement } from '@hawa/creative';
import type { OpenAiStudioClient } from '@hawa/creative';
import type { OpenAiImageProvider } from '@hawa/creative';
import type { DesignStudioRepository } from '@hawa/db';

export { StudioBudgetExhaustedError } from '@hawa/domain';

/** Stop every fallback when task authority ends or a paid call requires reconciliation. */
export function isModelCallHoldError(err: unknown): boolean {
  return !!err && typeof err === 'object' &&
    ('isUncertain' in err && err.isUncertain === true ||
      'code' in err && (err.code === 'MODEL_CALL_ADMISSION_CONFLICT' ||
        err.code === 'MODEL_STAGE_REPLAY_UNSAFE' || err.code === 'STUDIO_VISUAL_INPUTS_UNSAFE' || err.code === 'BRIEF_CONTRACT_CHANGED' || err.code === 'STUDIO_RUN_STATUS_CHANGED' || err.code === 'NATIVE_REVISION_HANDOFF_REQUIRED' ||
        err.code === 'MODEL_CALL_FINALIZATION_CONFLICT' || err.code === 'MODEL_CALL_ACCOUNTING_FAILED' ||
        err.code === 'TASK_GENERATION_BLOCKED' ||
        err.code === 'STUDIO_BUDGET_INVALID' || err.code === 'STUDIO_BUDGET_UNQUOTABLE' ||
        err.code === 'STUDIO_BUDGET_RESERVATION_EXCEEDED' || err.code === 'STUDIO_BUDGET_HISTORY_INCOMPLETE'));
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
  /** Brand-palette hex the client explicitly asked for as the background; '' when they did not. Absent on briefs before 2026-09-18. */
  requestedBackground?: string;
  /** What an attached image is: the client's logo, a style reference, or nothing to design from. Absent before 2026-09-19. */
  referenceRole?: 'none' | 'logo' | 'style_reference';
  /** What to take from a style reference: composition, colour placement, ornament, mood. */
  referenceNotes?: string;
  /** Whether the brief saw an attached image. False when a photo arrived after it ran. */
  referenceSeen?: boolean;
  /**
   * What each image the request carries is, by arrival order. The model looks at them: "I attached
   * the panelists pictures and a reference for the graphic" with three images is two photos to place
   * and one design to follow, which no keyword can tell apart. Absent before 2026-09-22.
   */
  imageRoles?: Array<{ index: number; role: ImageRole; notes: string }>;
  /** How many content photos the run was given; recorded for the requester's note. */
  photosSent?: number;
  /** Visual decisions read from the reference and instructions, enforced in preparation. Absent before 2026-09-19. */
  styleSpec?: import('@hawa/creative').StyleSpec;
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

export type MotifKind = 'guilloche' | 'sun-rays' | 'thin-rules' | 'gradient-wash' | 'diagonal-lines';

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
  textMeasurements: TextMeasurement[];
  messages: string[];
}

export interface ParityResult {
  parity: 'match' | 'minor' | 'major';
  divergences: Array<{ what: string; region: { x: number; y: number; w: number; h: number }; severity: 'minor' | 'major' }>;
  fontSubstituted: boolean;
  textReflowed: boolean;
  copyVisibleIdentical: boolean;
}

export type CopyBlock = {
  text: string;
  script: 'latin' | 'arabic' | 'mixed';
  /** Language from an explicitly labelled saved copy field, bound to its original text. */
  locale?: string;
  localeCopySha256?: string;
};

export interface ReferencePack {
  palette: string[];
  referenceFonts?: { latin?: string; arabic?: string };
  admittedDisplayFonts?: { latin: string[]; arabic: string[] };
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
  /** The office's standing rules for this client, numbered, as the models read them; '' when none. */
  clientRules?: string;
  latinFont: string;
  arabicFont: string;
  logoAspect?: number;
  logo?: { bytes: Buffer; sha256: string; mimeType: 'image/png' | 'image/jpeg' };
  exemplars?: Array<{ path: string; label: string; sha256?: string; bytes?: Buffer; mimeType?: string }>;
  /** Current exemplar admission policy identity; not sent to models as prompt content. */
  exemplarPolicySha256?: string;
  exemplarRetrieval?: ExemplarRetrievalEvidence & { loadedIds: string[]; unavailableIds: string[] };
  client: OpenAiStudioClient;
  artProvider?: OpenAiImageProvider;
  ledger?: DesignStudioRepository;
  /** This run executes the v3 pipeline. Fixed at run creation; see isPipelineV3Run. */
  pipelineV3?: boolean;
  /** Brief decision applied to optional artwork; required client photos remain content. */
  imageryStrategy?: CreativeBrief['imageryStrategy'];
  /** The palette colour the client asked for as the background, applied to every layout in code. */
  requestedBackground?: string;
  /** An image the requester attached (data: URL), whatever it shows. The brief says what it is. */
  attachedImage?: string;
  /**
   * Photographs the request asked to have in the design ("with these texts and two pictures"),
   * by photoIndex. Content, not style: every one is placed once, or the layout is refused.
   */
  photos?: ContentPhoto[];
  /** Hash-verified conditioning pixels retained before the first layout call. */
  visualInputs?: import('@hawa/creative').LayoutVisualInput[];
  /**
   * The people in each photo cut out of its background (ADR-032), by photoIndex; present only for a
   * cut-out that passed its checks. Set when the request, the reference or the design being changed
   * calls for cut-outs.
   */
  photoCutouts?: Array<import('@hawa/creative').PhotoCutoutAsset | undefined>;
  /** What became of each photo's cut-out, passed or not and why, by photoIndex. */
  cutoutOutcomes?: import('./photo-cutouts.js').CutoutOutcome[];
  /** Every image the request carries, oldest first, for the brief to classify. Set only at briefing. */
  requestImages?: string[];
  /** The attached image when the brief read it as a style reference, with what to take from it. */
  reference?: import('@hawa/creative').ClientReference;
  /** Brand ornament (texture, gold dividers) added to layouts that lack it; HAWA_DESIGN_*. */
  ornament?: import('@hawa/creative').OrnamentSettings;
  /** The brief's style spec, applied to every layout in preparation. */
  style?: import('@hawa/creative').StyleSpec;
  /** The run's recorded executable brief contract (ADR-125); set before the first layout call. */
  briefContract?: import('@hawa/domain').ExecutableBriefContract;
}

export type ImageRole = 'content_photo' | 'style_reference' | 'logo' | 'unrelated';

export interface ContentPhoto {
  /** Subject/crop meaning from the same brief that classified this image as content. */
  notes?: string;
  dataUrl: string;
  bytes: Buffer;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  width?: number;
  height?: number;
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
