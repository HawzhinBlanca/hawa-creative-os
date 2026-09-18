import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PER_BRIEF_CAP_USD = 1.00;
export const OFFICE_DAILY_CAP_USD = 30.00;

export interface CostLedgerEntry {
  callId: string;
  stage: 'P03_LAYOUT' | 'P04_ART' | 'P05_CRITIQUE' | 'P06_REFINE' | 'P07_JUDGE';
  model: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  grossCostUsd: number;
  cacheDiscountUsd: number;
  netCostUsd: number;
  timestamp: string;
}

export interface CostArchitectureState {
  briefId: string;
  accumulatedCostUsd: number;
  perBriefCapUsd: number;
  officeDailyCapUsd: number;
  ledger: CostLedgerEntry[];
  isCapExceeded: boolean;
  degradationReason?: string;
}

/**
 * Byte-stable system prompt prefix (> 1,024 tokens) holding:
 * 1. P0 safety prefix
 * 2. Brand rules (KAAE institutional identity)
 * 3. Typography policy (F12 normative admitted fonts & type scales)
 * 4. P01 metric definitions (LaySPA, balance, alignment, overlap, type-scale, contrast)
 * 5. Dimension-wise evaluation rubric (hierarchy, composition, typographic craft, brand fit, legibility)
 *
 * CRITICAL RULE: NO ids, NO timestamps, NO per-request text inside this block.
 * Dynamic content MUST go last.
 */
export const STABLE_SYSTEM_PROMPT_PREFIX = `[P0_SAFETY_AND_GOVERNANCE_PREFIX]
You are the Senior Typographer, Creative Director, and Automated Verification Engine for KAAE (Kurdistan Accrediting Agency for Education).
You operate under strict institutional governance, non-hallucinatory standards, and zero-compromise architectural invariants.
Every response must be mathematically sound, typographically pure, and compliant with KAAE brand guidelines.
Do not invent facts, unassigned clients, unadmitted fonts, or ungrounded credentials.

[BRAND_RULES_AND_VISUAL_IDENTITY]
- Institution: Kurdistan Accrediting Agency for Education (KAAE) / دەستەی باڵای متمانەبەخشین بە پەروەردە و خوێندنی باڵا
- Legal Foundation: Established under Kurdistan Regional Government Law No. 6 of 2022.
- Institutional Tone: Dignified, academic, authoritative, prestigious, ceremonial, restrained, precise.
- Official Color Palette:
  * Primary Navy: #0A1628 (Deep statutory blue, commanding dignity)
  * Secondary Midnight: #0C2340 (Institutional backdrop field)
  * Academic Gold: #C5A059 (Refined gold for rules, crest accents, and framing hairlines)
  * Warm Parchment / Cream: #FDF8F3 (High-legibility paper tone for content panels)
  * Pure White: #FFFFFF (Crest background and high-contrast title typography)
  * Statutory Slate: #4A5568 (Secondary metadata and date text)
- Prohibited Aesthetics: Neon colors, playful/casual curves, decorative cartoon illustrations, generic commercial banner aesthetics.

[F12_TYPOGRAPHY_AND_ROLE_POLICY]
Typography is normative and character-exact. Only the following approved font families are admitted:
- Body & Footer Roles (role: "body", "footer"):
  * For Latin text: MUST use "Verdana".
  * For Kurdish / Arabic text: MUST use "Noto Sans Arabic".
  * Never use display serifs or high-contrast display fonts for body or footer reading blocks.
- Display & Headline Roles (role: "title", "subtitle", "eyebrow", "cta"):
  * For Latin text: "Cinzel", "Lora", "Playfair Display", "Cormorant Garamond".
  * For Kurdish / Arabic text: "Cairo", "Amiri".
- Type-Scale System:
  * Modular scale ratios: 1.25 (Major Third), 1.333 (Perfect Fourth), 1.414 (Augmented Fourth), 1.5 (Perfect Fifth).
  * Base font size: 14px to 18px.
  * Every text size must correspond strictly to (base * ratio^step).
- Line Heights (Leading):
  * Titles: 1.20 to 1.35.
  * Subtitles: 1.30 to 1.45.
  * Body: 1.40 to 1.60.
  * Footers: 1.30 to 1.45.

[P01_DETERMINISTIC_DESIGN_METRICS_DEFINITIONS]
Every layout is evaluated deterministically against six empirical design quality metrics prior to any visual review:
1. Overlap Rate (arXiv:2402.06945): Sum of intersection areas between non-background boxes divided by total bounding area. Must equal 0.000 for all content elements.
2. Alignment Score (LaySPA): Precision of left, center, right, top, and bottom alignment coordinates across elements along the compositional grid axis. Must be >= 0.900.
3. Balance Score: Center-of-mass equilibrium of visual element weights relative to geometric canvas center (0.5, 0.5). Must be >= 0.850.
4. Regularity Score: Uniformity of element spacing, gutters, and column intervals along the primary flow axis. Must be >= 0.500.
5. Modular Type-Scale Score: Fraction of text elements adhering strictly to declared base * ratio^k steps. Must be >= 0.900.
6. Contrast & Legibility: Luminance contrast between text color and background/panel surface per WCAG 2.1 AA (>= 4.5:1). Must be 1.000.
- Hard Gates: Any candidate with overlap > 0.000, margin violation < 0.05, contrast failure, or unadmitted font fails automatically without model consumption.

[DIMENSION_WISE_EVALUATION_RUBRIC]
When conducting pairwise comparative evaluation, models must score candidates independently across five distinct dimensions:
1. hierarchy: Visual dominance of the title, natural scanning sequence from headline to body to footer, absence of competing focal anchors.
2. composition: Balance, margin breathing room, rule placement, alignment consistency, avoidance of cluttered corners or awkward voids.
3. typographic_craft: Type scale progression, appropriate leading, font pairing restraint, margin relationship to rules and dividers.
4. brand_fit: Alignment with KAAE statutory authority, ceremonial prestige, restrained use of gold and navy, institutional dignity.
5. legibility: Character clarity, line length comfort, background simplicity behind text, absence of text-over-texture collision.
All judgments must evaluate presentation orders AB and BA independently to mitigate position bias. Disagreements must be recorded and discarded.`;

/**
 * Estimates token count of a string (approx. 4 characters per token for English text).
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Validates that the stable prefix meets or exceeds 1,024 tokens and contains no dynamic fields.
 */
export function validateStablePrefix(prefix: string = STABLE_SYSTEM_PROMPT_PREFIX): {
  charCount: number;
  estimatedTokens: number;
  meetsTokenThreshold: boolean;
  containsDynamicPatterns: boolean;
} {
  const charCount = prefix.length;
  const estimatedTokens = estimateTokenCount(prefix);
  const meetsTokenThreshold = estimatedTokens >= 1024;

  // Check for dynamic leaks (ids, timestamps, uuid, date strings)
  const dynamicRegex = /(?:\b\d{4}-\d{2}-\d{2}T|\b[a-f0-9]{8}-[a-f0-9]{4}-|\b(?:task|brief|req|call)_[a-zA-Z0-9_-]{4,})/i;
  const containsDynamicPatterns = dynamicRegex.test(prefix);

  return {
    charCount,
    estimatedTokens,
    meetsTokenThreshold,
    containsDynamicPatterns,
  };
}

/**
 * Recomputes cost from the F11 price table (pricing.json).
 */
export function calculateCallCost(
  model: string,
  usage: {
    inputTokens: number;
    cachedTokens?: number;
    outputTokens: number;
  },
  pricingTable?: any
): {
  grossCostUsd: number;
  cacheDiscountUsd: number;
  netCostUsd: number;
} {
  const defaultPricing = {
    'gpt-6-astra': {
      inputPerMillion: 10.0,
      outputPerMillion: 50.0,
      cacheReadPerMillion: 1.0, // 90% discount on cached reads
    },
  };

  const rates = pricingTable?.models?.[model] || defaultPricing['gpt-6-astra'];

  const inTok = usage.inputTokens || 0;
  const cachedTok = usage.cachedTokens || 0;
  const outTok = usage.outputTokens || 0;
  const regularInTok = Math.max(0, inTok - cachedTok);

  // Gross cost without caching
  const grossInCost = (inTok / 1_000_000) * rates.inputPerMillion;
  const outCost = (outTok / 1_000_000) * rates.outputPerMillion;
  const grossCostUsd = Number((grossInCost + outCost).toFixed(6));

  // Net cost with cached read discount
  const regularInCost = (regularInTok / 1_000_000) * rates.inputPerMillion;
  const cachedInCost = (cachedTok / 1_000_000) * rates.cacheReadPerMillion;
  const netCostUsd = Number((regularInCost + cachedInCost + outCost).toFixed(6));

  const cacheDiscountUsd = Number((grossCostUsd - netCostUsd).toFixed(6));

  return {
    grossCostUsd,
    cacheDiscountUsd,
    netCostUsd,
  };
}

export function getOfficeDailyCapUsd(): number {
  const envVal = process.env.HAWA_DAILY_CAP_USD || process.env.OFFICE_DAILY_CAP_USD || process.env.DAILY_CAP_USD;
  if (envVal !== undefined && envVal !== '') {
    const parsed = parseFloat(envVal);
    if (!isNaN(parsed) && parsed >= 0) return parsed;
  }
  return 30.00;
}

export function getPerBriefCapUsd(): number {
  const envVal = process.env.HAWA_PER_BRIEF_CAP_USD || process.env.PER_BRIEF_CAP_USD;
  if (envVal !== undefined && envVal !== '') {
    const parsed = parseFloat(envVal);
    if (!isNaN(parsed) && parsed >= 0) return parsed;
  }
  return 1.00;
}

export function getLowBalanceWarningThresholdUsd(): number {
  const envVal = process.env.HAWA_LOW_BALANCE_THRESHOLD_USD || process.env.LOW_BALANCE_WARNING_THRESHOLD_USD;
  if (envVal !== undefined && envVal !== '') {
    const parsed = parseFloat(envVal);
    if (!isNaN(parsed) && parsed >= 0) return parsed;
  }
  return 5.00;
}

function getDailySpendFilePath(dateStr?: string): string {
  const today = dateStr || new Date().toISOString().slice(0, 10);
  // HAWA_SPEND_STATE_DIR moves the ledger: tests point it at a throwaway directory, and the
  // in-image qualification points it at a mounted one so the cap persists between containers.
  const stateDir = process.env.HAWA_SPEND_STATE_DIR
    ? path.resolve(process.env.HAWA_SPEND_STATE_DIR)
    : path.resolve(process.cwd(), '.hawa-state', 'spend');
  try {
    fs.mkdirSync(stateDir, { recursive: true });
  } catch {}
  return path.join(stateDir, `daily_spend_${today}.json`);
}

export function getDailyOfficeSpend(dateStr?: string): number {
  const filePath = getDailySpendFilePath(dateStr);
  if (!fs.existsSync(filePath)) return 0;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Number(data.totalSpentUsd || 0);
  } catch {
    return 0;
  }
}

export function resetDailyOfficeSpend(dateStr?: string): void {
  const filePath = getDailySpendFilePath(dateStr);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

export function recordOfficeDailySpend(costUsd: number, entry?: CostLedgerEntry): void {
  const filePath = getDailySpendFilePath();
  let data: { date: string; totalSpentUsd: number; entries: CostLedgerEntry[] } = {
    date: new Date().toISOString().slice(0, 10),
    totalSpentUsd: 0,
    entries: [],
  };
  if (fs.existsSync(filePath)) {
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err: any) {
      // Swallowing this silently reset the day's recorded spend to zero and handed the daily cap
      // a clean slate, which is the opposite of what a budget guard should do when it loses state.
      throw new Error(
        `Daily office spend ledger at ${filePath} is unreadable (${err?.message || err}). ` +
          `Refusing to continue: treating it as zero spent would disable the daily cap. ` +
          `Inspect or remove the file deliberately.`
      );
    }
  }
  data.totalSpentUsd = Number((data.totalSpentUsd + costUsd).toFixed(6));
  if (entry) {
    data.entries.push(entry);
  }
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err: any) {
    // A spend that is not recorded cannot be counted against the cap by the next call, so the cap
    // silently stops working. Fail loudly instead of losing the record.
    throw new Error(
      `Could not record USD ${costUsd.toFixed(6)} of spend to ${filePath} (${err?.message || err}). ` +
        `The daily cap cannot be enforced without it.`
    );
  }
}

export interface OfficeDailyBudgetCheckResult {
  allowed: boolean;
  reason?: string;
  currentSpentUsd: number;
  remainingUsd: number;
  capUsd: number;
  warningTriggered: boolean;
  warningMessage?: string;
}

export async function sendOperatorAlert(text: string): Promise<boolean> {
  // A test must never message the office, whatever happens to be in its environment.
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) return false;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_ALLOWED_USERS?.split(',')[0];
  if (!token || !chat) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function checkOfficeDailyBudget(estimatedCostUsd: number = 0): OfficeDailyBudgetCheckResult {
  const capUsd = getOfficeDailyCapUsd();
  const currentSpentUsd = getDailyOfficeSpend();
  const projectedSpend = Number((currentSpentUsd + estimatedCostUsd).toFixed(6));
  const remainingUsd = Number(Math.max(0, capUsd - currentSpentUsd).toFixed(6));
  const warningThreshold = getLowBalanceWarningThresholdUsd();

  const warningTriggered = remainingUsd <= warningThreshold || (capUsd > 0 && currentSpentUsd >= capUsd * 0.8);
  let warningMessage: string | undefined;
  if (warningTriggered) {
    warningMessage = `⚠️ <b>Hawa Low Balance Alert</b>: Remaining office AI budget is $${remainingUsd.toFixed(2)} (cap: $${capUsd.toFixed(2)}, spent: $${currentSpentUsd.toFixed(2)}, warning threshold: $${warningThreshold.toFixed(2)}).`;
    sendOperatorAlert(warningMessage).catch(() => {});
  }

  if (projectedSpend > capUsd || (capUsd > 0 && estimatedCostUsd > 0 && remainingUsd < estimatedCostUsd)) {
    return {
      allowed: false,
      reason: `DAILY_CAP_EXCEEDED: Daily office spend ($${currentSpentUsd.toFixed(2)} spent + $${estimatedCostUsd.toFixed(2)} required) would breach office daily cap of $${capUsd.toFixed(2)}. Remaining: $${remainingUsd.toFixed(2)}.`,
      currentSpentUsd,
      remainingUsd,
      capUsd,
      warningTriggered: true,
      warningMessage,
    };
  }

  return {
    allowed: true,
    currentSpentUsd,
    remainingUsd,
    capUsd,
    warningTriggered,
    warningMessage,
  };
}

export class PipelineCostGovernorV3 {
  private accumulatedCostUsd = 0;
  private readonly perBriefCapUsd: number;
  private readonly officeDailyCapUsd: number;
  private readonly ledger: CostLedgerEntry[] = [];
  private isCapExceeded = false;
  private degradationReason?: string;

  constructor(private readonly briefId: string) {
    this.perBriefCapUsd = getPerBriefCapUsd();
    this.officeDailyCapUsd = getOfficeDailyCapUsd();
  }

  getState(): CostArchitectureState {
    return {
      briefId: this.briefId,
      accumulatedCostUsd: Number(this.accumulatedCostUsd.toFixed(6)),
      perBriefCapUsd: this.perBriefCapUsd,
      officeDailyCapUsd: this.officeDailyCapUsd,
      ledger: [...this.ledger],
      isCapExceeded: this.isCapExceeded,
      degradationReason: this.degradationReason,
    };
  }

  /**
   * Records a model call into the ledger, verifies budget limits, and triggers degradation if exceeded.
   */
  recordCall(
    stage: CostLedgerEntry['stage'],
    model: string,
    usage: {
      inputTokens: number;
      cachedTokens?: number;
      outputTokens: number;
    },
    callId?: string
  ): {
    entry: CostLedgerEntry;
    isWithinCap: boolean;
    degraded: boolean;
    degradationReason?: string;
  } {
    const cost = calculateCallCost(model, usage);
    const entry: CostLedgerEntry = {
      callId: callId || `call_${crypto.randomUUID().slice(0, 8)}`,
      stage,
      model,
      inputTokens: usage.inputTokens,
      cachedTokens: usage.cachedTokens || 0,
      outputTokens: usage.outputTokens,
      grossCostUsd: cost.grossCostUsd,
      cacheDiscountUsd: cost.cacheDiscountUsd,
      netCostUsd: cost.netCostUsd,
      timestamp: new Date().toISOString(),
    };

    this.ledger.push(entry);
    this.accumulatedCostUsd += cost.netCostUsd;
    recordOfficeDailySpend(cost.netCostUsd, entry);

    const dailySpend = getDailyOfficeSpend();

    if (this.accumulatedCostUsd > this.perBriefCapUsd) {
      this.isCapExceeded = true;
      this.degradationReason = `CAP_EXCEEDED: Brief cost $${this.accumulatedCostUsd.toFixed(
        4
      )} exceeded cap of $${this.perBriefCapUsd.toFixed(
        2
      )}. Halting model calls; completing with best passing candidate.`;
    } else if (dailySpend > this.officeDailyCapUsd) {
      this.isCapExceeded = true;
      this.degradationReason = `OFFICE_DAILY_CAP_EXCEEDED: Total daily spend $${dailySpend.toFixed(
        4
      )} exceeded office daily cap of $${this.officeDailyCapUsd.toFixed(
        2
      )}. Halting all pipeline generation.`;
    }

    const check = checkOfficeDailyBudget(0);
    if (check.warningTriggered && check.warningMessage) {
      sendOperatorAlert(check.warningMessage).catch(() => {});
    }

    return {
      entry,
      isWithinCap: !this.isCapExceeded,
      degraded: this.isCapExceeded,
      degradationReason: this.degradationReason,
    };
  }
}
