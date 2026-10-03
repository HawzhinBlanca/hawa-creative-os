import { KAAE_TEST_CLIENT_LOGO } from './fixtures/kaae-logo.js';
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  artDirectionRulesFromRaw,
  creativeAssetPath,
  NEUTRAL_STYLE_SPEC,
  pageGrammarFromRaw,
  resolveOrnamentSettings,
  studioReferenceFromRaw,
  type StudioLayoutV2,
  type StyleSpec,
} from '@hawa/creative';
import type { ClientRule } from '@hawa/db';
import type { BriefProposalInput } from '@hawa/domain';
import type { CandidateState, CreativeBrief, StageContext } from '../src/services/design-studio/types.js';
import {
  houseRulesFor,
  layoutBriefV3,
  rankStudioCandidatesV3,
  runBriefStage,
  runLayoutsStage,
  runRenderStage,
  runVisualReviewStageV3,
} from '../src/services/design-studio/stages/index.js';
import { requestedBackgroundFor } from '../src/services/design-studio/stages/brief.stage.js';
import { buildRunBriefContract } from '../src/services/design-studio/brief-contract.js';
import { packagedAdmittedDisplayFonts } from '../src/services/design-studio/design-studio-service.js';
import { contextWithClientRules } from '../src/services/rule-effect.js';

/**
 * ADR-291: does an active office rule change the next draft? A free, deterministic harness.
 *
 * For each kind of rule an office gives, the rule is put on a studio run the way `withClientRules`
 * puts it (the DB half is rule-effect-learned-rules.test.ts and client-rules.test.ts), and the run is
 * taken through the real stage code up to each model call, with a recording client that answers
 * without a model:
 *
 * 1. Reach: is the rule in the brief's prompts, the brief contract, the layout model's prompt, the
 *    visual review's prompt and the judge's house rules, with the rule and without it?
 * 2. Code reading: with a brief model that ignores the rule, does any code still apply it? (No code
 *    reads a rule's words; every rule is unverifiable without a model up to the brief.)
 * 3. Enforcement after the brief: where the rule maps to a style value the brief can set
 *    (StyleSpec), give the layout stage the value a faithful brief sets, and measure the prepared
 *    layouts against the same run without it, on both paths production takes for a text-only
 *    design: a model-drawn layout (a DNA client, no page grammar) and KAAE's composed poster (page
 *    grammar with poster rules, ADR-271; no layout model is called).
 *
 * HAWA_RULE_EFFECT_OUT=<dir> writes the measured table (rule-effect.json) there.
 */

const REFERENCE = JSON.parse(readFileSync(creativeAssetPath('kaae-reference.json'), 'utf8'));
const PALETTE: string[] = REFERENCE.rules.palette;
const GRAMMAR = pageGrammarFromRaw(REFERENCE)!;
const BASE_RULES = studioReferenceFromRaw(REFERENCE).promotedRules;
const RECEIPT = { responseId: 'resp_rule_effect', xRequestId: null, model: 'recorded', inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0, latencyMs: 0 };
const OUT = process.env.HAWA_RULE_EFFECT_OUT;

const MIDNIGHT = '#0A1628';
const ROYAL = '#1E3A5F';
const BLUE = '#4770A3';
const GOLD = '#F7B500';
const CREAM = '#FDF8F3';
const WHITE = '#FFFFFF';

const COPY = ['Quality Assurance Workshop', 'For school principals', '22 October 2026 · 10:00 AM', 'Divan Hotel, Erbil', 'Seats are limited, please register early'];
const ROLES = ['title', 'subtitle', 'date', 'venue', 'body'] as const;

// ---- what a layout model proposes (model-drawn path): three light pages, as kaae-2025-guideline.test.ts ----
const text = (copyIndex: number, role: string, box: [number, number, number, number], px: number, color: string, opts: Record<string, unknown> = {}) => ({
  copyIndex, role, x: box[0], y: box[1], width: box[2], height: box[3], fontSize: px / 1350, lineHeight: role === 'title' ? 1.2 : 1.45,
  letterSpacing: 0, fontFamily: role === 'title' || role === 'subtitle' ? 'Crimson Pro' : 'Inter', color, align: 'left',
  bold: role === 'title' || role === 'date', italic: false, rtl: false, ...opts,
});
const shape = (role: 'panel' | 'rule' | 'accent', box: [number, number, number, number], color: string) => ({
  x: box[0], y: box[1], width: box[2], height: box[3], kind: 'rect', color, opacity: 1, radius: 0, strokeWidth: null, strokeColor: null, role,
});
const drawn = (id: string, archetype: string, background: string, logo: [number, number], shapes: unknown[], texts: unknown[]) => ({
  id, conceptTitle: id, compositionArchetype: archetype, typeScale: { base: 22, ratio: 1.333 },
  grid: { margin: 0.07, columns: 12, gutter: 0.02, baseline: 0.006 }, background: { color: background },
  logo: { x: logo[0], y: logo[1], width: 0.12, height: 0.096 }, art: null, photos: [], shapes, text: texts,
});
const LAYOUT_ANSWER = {
  layouts: [
    drawn('band', 'split_statutory_banner', WHITE, [0.08, 0.055], [
      shape('panel', [0, 0, 1, 0.4], ROYAL), shape('rule', [0.08, 0.345, 0.11, 0.003], GOLD),
      shape('rule', [0.08, 0.705, 0.84, 0.0015], GOLD), shape('panel', [0, 0.965, 1, 0.035], ROYAL),
    ], [
      text(0, 'title', [0.08, 0.2, 0.84, 0.125], 66, WHITE), text(1, 'subtitle', [0.08, 0.455, 0.84, 0.04], 34, BLUE, { italic: true }),
      text(2, 'date', [0.08, 0.545, 0.84, 0.035], 30, MIDNIGHT), text(3, 'venue', [0.08, 0.6, 0.84, 0.035], 28, BLUE),
      text(4, 'body', [0.08, 0.735, 0.84, 0.035], 24, MIDNIGHT),
    ]),
    drawn('cream', 'monolith_centered', CREAM, [0.44, 0.07], [
      shape('rule', [0.45, 0.415, 0.1, 0.003], GOLD), shape('panel', [0.15, 0.55, 0.7, 0.17], WHITE), shape('rule', [0.45, 0.86, 0.1, 0.003], GOLD),
    ], [
      text(0, 'title', [0.1, 0.25, 0.8, 0.14], 70, BLUE, { align: 'center' }), text(1, 'subtitle', [0.1, 0.44, 0.8, 0.045], 34, BLUE, { align: 'center', italic: true }),
      text(2, 'date', [0.18, 0.585, 0.64, 0.04], 30, MIDNIGHT, { align: 'center' }), text(3, 'venue', [0.18, 0.645, 0.64, 0.035], 28, BLUE, { align: 'center' }),
      text(4, 'body', [0.1, 0.785, 0.8, 0.035], 24, MIDNIGHT, { align: 'center' }),
    ]),
    drawn('editorial', 'asymmetric_editorial', WHITE, [0.08, 0.06], [
      shape('accent', [0.08, 0.235, 0.008, 0.27], BLUE), shape('panel', [0, 0.69, 1, 0.31], ROYAL), shape('rule', [0.08, 0.86, 0.1, 0.003], GOLD),
    ], [
      text(0, 'title', [0.115, 0.235, 0.8, 0.2], 78, BLUE), text(1, 'subtitle', [0.115, 0.455, 0.8, 0.045], 34, BLUE, { italic: true }),
      text(2, 'date', [0.08, 0.74, 0.84, 0.04], 34, WHITE), text(3, 'venue', [0.08, 0.795, 0.84, 0.035], 28, CREAM),
      text(4, 'body', [0.08, 0.885, 0.84, 0.035], 24, WHITE),
    ]),
  ],
};

/** A brief model that read the request and ignored every rule: no style values, no ground. */
const IGNORING_BRIEF = {
  occasion: 'KAAE workshop', audience: 'school principals', formality: 4, toneWords: ['formal', 'clear', 'calm'],
  readingOrder: [0, 1, 2, 3, 4], roles: ROLES.map((role, copyIndex) => ({ copyIndex, role, importance: copyIndex === 0 ? 5 : 3 })),
  must: [], mustNot: [], imageryStrategy: 'none', imageryRationale: '', kurdishLeads: false, riskFlags: [], requestedBackground: '',
  referenceRole: 'none', referenceNotes: '', imageRoles: [], subjectTags: [], styleSpec: NEUTRAL_STYLE_SPEC,
};

/** Answers every model call the stages make without a model, and records what each was sent. */
function recordingClient() {
  const calls: Array<{ kind: 'brief' | 'layout' | 'review' | 'other'; system: string; prompt: string }> = [];
  const flatten = (v: unknown): string => typeof v === 'string' ? v : Array.isArray(v) ? v.map(flatten).join('\n') : v && typeof v === 'object' ? Object.values(v).map(flatten).join('\n') : '';
  return {
    calls,
    completeJson: async (req: any) => {
      calls.push({ kind: req.schemaName === 'CreativeBrief' ? 'brief' : 'other', system: String(req.system ?? ''), prompt: String(req.prompt ?? '') });
      return { data: structuredClone(IGNORING_BRIEF), rawText: '', receipt: RECEIPT };
    },
    createStructuredCompletion: async (req: any) => {
      const name = String(req.jsonSchema?.name ?? req.schemaName ?? '');
      const review = name === 'VisualDesignReview';
      calls.push({ kind: review ? 'review' : 'layout', system: flatten(req.messages?.[0]?.content ?? req.system), prompt: flatten(req.messages?.slice(1) ?? req.prompt) });
      const data = review ? { assessment: 'Recorded; no model.', fixes: [] } : structuredClone(LAYOUT_ANSWER);
      return { data, rawText: JSON.stringify(data), receipt: RECEIPT };
    },
  };
}

function briefWith(over: Partial<CreativeBrief> = {}): CreativeBrief {
  return { ...structuredClone(IGNORING_BRIEF), ...over } as unknown as CreativeBrief;
}

/** A text-only design's stage context. `grammar`: KAAE's composed poster path; without, a model-drawn one. */
function stageContext(grammar: boolean, client: ReturnType<typeof recordingClient>): StageContext {
  return {
    runId: randomUUID(), tenantId: randomUUID(), taskId: randomUUID(), clientId: REFERENCE.clientId, actorId: 'rule-effect',
    width: 1080, height: 1350, tier: 'standard', instructions: 'A poster for our quality assurance workshop',
    copyBlocks: COPY.map((t) => ({ text: t, script: 'latin' as const })),
    referencePack: { palette: PALETTE, referenceFonts: { latin: 'Inter', arabic: 'Noto Sans Arabic' }, clientId: REFERENCE.clientId,
      admittedDisplayFonts: packagedAdmittedDisplayFonts(REFERENCE), logoConstraints: REFERENCE.rules.logoConstraints },
    promotedRules: BASE_RULES, latinFont: 'Inter', arabicFont: 'Noto Sans Arabic', logoAspect: 1,
    ...(grammar ? { pageGrammar: GRAMMAR } : {}),
    logo: KAAE_TEST_CLIENT_LOGO, pipelineV3: true, imageryStrategy: 'none',
    ornament: resolveOrnamentSettings({}),
    artDirectionRules: artDirectionRulesFromRaw(REFERENCE),
    client: client as any,
  } as StageContext;
}

const rule = (humanRule: string): ClientRule => ({ id: randomUUID(), clientId: REFERENCE.clientId, humanRule, category: 'general', machineRule: {}, createdAt: new Date('2026-10-01T00:00:00Z') });

// ---- the rule kinds an office gives, and what a faithful brief makes of each --------------------

type Check = (l: StudioLayoutV2) => boolean;
interface RuleKind {
  kind: string;
  rule: string;
  /** The style value a brief that follows the rule sets; absent when StyleSpec has no such value. */
  style?: Partial<StyleSpec>;
  /** The ground a brief that follows the rule asks for (requestedBackground). */
  ground?: string;
  /** Whether a prepared layout shows the rule. */
  holds?: Check;
}

const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;
const titleOf = (l: StudioLayoutV2) => l.text.find((t) => t.role === 'title');
const SANS = new Set(['Verdana', 'Noto Sans Arabic', 'Inter', 'IBM Plex Sans Arabic']);
const fullBleed = (l: StudioLayoutV2, s: { width: number; height: number }) => s.width >= 0.98 * l.width && s.height >= 0.98 * l.height;

const KINDS: RuleKind[] = [
  { kind: 'logo placement', rule: 'Always put the logo in the bottom-right corner', style: { logoCorner: 'bottom-right' },
    holds: (l) => Boolean(l.logo) && l.logo!.x + l.logo!.width >= l.width - l.grid.margin - 2 && l.logo!.y + l.logo!.height >= l.height - l.grid.margin - 2 },
  { kind: 'typeface', rule: 'Use sans-serif type only, no serif faces', style: { typeface: 'sans' },
    holds: (l) => l.text.every((t) => SANS.has(t.fontFamily)) },
  { kind: 'type weight', rule: 'Set titles in a regular weight, not bold', style: { titleWeight: 'regular' },
    holds: (l) => titleOf(l)?.bold === false && (titleOf(l)?.fontWeight === undefined || titleOf(l)!.fontWeight! < 600) },
  { kind: 'alignment', rule: 'Centre every line of text', style: { alignment: 'center' },
    holds: (l) => l.text.every((t) => t.align === 'center') },
  { kind: 'title colour', rule: 'Titles in our darkest navy', style: { titleColor: 'dark' },
    holds: (l) => titleOf(l)?.color?.toUpperCase() === MIDNIGHT },
  { kind: 'forbidden element: dividers', rule: 'No divider lines between the blocks', style: { dividers: 'no' },
    holds: (l) => !(l.shapes || []).some((s) => s.role === 'rule' || s.role === 'accent') },
  { kind: 'forbidden element: cards', rule: 'No boxes or cards behind the copy', style: { panels: 'none' },
    holds: (l) => !(l.shapes || []).some((s) => (s.role === 'panel' || s.role === 'frame') && !fullBleed(l, s)) },
  { kind: 'background colour', rule: 'Always on our cream background', ground: CREAM,
    holds: (l) => l.background.color.toUpperCase() === CREAM },
  { kind: 'type case', rule: 'Titles always in capital letters' },
  { kind: 'forbidden colour pairing', rule: 'Never gold text on white' },
  { kind: 'wording', rule: 'Never use exclamation marks' },
  { kind: 'imagery', rule: 'No stock photos of people' },
];

/**
 * Measured on 2026-10-03 (ADR-291 section 4): [candidates showing the rule with it, without it,
 * whether the layouts changed at all], of three, on each path.
 */
const EXPECTED: Record<string, { modelDrawn: [number, number, boolean] | null; composedPoster: [number, number, boolean] | null }> = {
  // Preparation drops the corner on two of three model layouts, where moving the logo adds a defect.
  'logo placement': { modelDrawn: [1, 0, true], composedPoster: [0, 0, false] },
  // The composed poster's heavy sans display (ADR-275) is sans with or without the rule.
  typeface: { modelDrawn: [3, 0, true], composedPoster: [3, 3, false] },
  'type weight': { modelDrawn: [3, 0, true], composedPoster: [0, 0, false] },
  alignment: { modelDrawn: [3, 1, true], composedPoster: [0, 0, false] },
  // Dark on the navy band is unreadable, so that candidate's title keeps its white.
  'title colour': { modelDrawn: [2, 0, true], composedPoster: [0, 0, false] },
  'forbidden element: dividers': { modelDrawn: [3, 0, true], composedPoster: [0, 0, false] },
  'forbidden element: cards': { modelDrawn: [3, 0, true], composedPoster: [1, 1, false] },
  // The one value the composed poster takes: the ground decides which compositions are offered.
  'background colour': { modelDrawn: [3, 1, true], composedPoster: [3, 1, true] },
  'type case': { modelDrawn: null, composedPoster: null },
  'forbidden colour pairing': { modelDrawn: null, composedPoster: null },
  wording: { modelDrawn: null, composedPoster: null },
  imagery: { modelDrawn: null, composedPoster: null },
};

const layoutsOf = (cands: CandidateState[]) => cands.map((c) => c.currentLayout);
const same = (a: StudioLayoutV2[], b: StudioLayoutV2[]) => JSON.stringify(a) === JSON.stringify(b);

async function layoutRun(grammar: boolean, kind: RuleKind | undefined) {
  const client = recordingClient();
  const ctx = stageContext(grammar, client);
  if (kind) contextWithClientRules(ctx, [rule(kind.rule)]);
  const brief = briefWith(kind?.ground ? { requestedBackground: kind.ground } : {});
  ctx.style = { ...NEUTRAL_STYLE_SPEC, ...(kind?.style ?? {}) };
  ctx.requestedBackground = requestedBackgroundFor(brief, PALETTE);
  const candidates = await runLayoutsStage(ctx, brief, [], [0, 1, 2].map((ordinal) => ({ id: randomUUID(), ordinal })));
  return { ctx, client, brief, candidates, layouts: layoutsOf(candidates) };
}

interface Measured {
  kind: string;
  rule: string;
  reach: Record<string, boolean>;
  readByCode: boolean;
  styleValue: string | null;
  modelDrawn?: { with: number; without: number; of: number; changed: boolean };
  composedPoster?: { with: number; without: number; of: number; changed: boolean };
  misses?: Array<Record<string, unknown>>;
  status: string;
}
const table: Measured[] = [];

afterAll(() => {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'rule-effect.json'), `${JSON.stringify({ measuredAt: new Date().toISOString(), table }, null, 2)}\n`);
});

describe('ADR-291: what an active office rule does to the next draft', () => {
  for (const kind of KINDS) {
    it(`${kind.kind}: "${kind.rule}"`, async () => {
      const words = `"${kind.rule}"`;
      // ---- 1. reach, with the rule and without it ------------------------------------------------
      const reachOf = async (withRule: boolean) => {
        const client = recordingClient();
        const ctx = stageContext(true, client);
        if (withRule) contextWithClientRules(ctx, [rule(kind.rule)]);
        const brief = await runBriefStage(ctx);
        const briefCall = client.calls.find((c) => c.kind === 'brief')!;
        const contract = buildRunBriefContract(ctx, brief as unknown as BriefProposalInput, 'source_copy');
        const layoutPrompt = layoutBriefV3(brief, ctx);
        // The visual review, through the stage, on the composed candidates rendered as the client sees them.
        ctx.style = brief.styleSpec;
        const cands = await runRenderStage(ctx, await runLayoutsStage(ctx, brief, [], [0, 1, 2].map((ordinal) => ({ id: randomUUID(), ordinal }))));
        await runVisualReviewStageV3(ctx, cands, { rounds: 1, candidates: 1, maxUsd: 1 }, brief);
        const review = client.calls.find((c) => c.kind === 'review');
        return {
          brief,
          ctx,
          layoutCalls: client.calls.filter((c) => c.kind === 'layout').length,
          reach: {
            briefSystemPrompt: briefCall.system.includes(words),
            briefAskedForStyleValues: /standing rules for this client/.test(briefCall.prompt),
            briefContract: contract.items.some((i) => i.id === 'rule/client' && i.enforcedBy.includes('model_instruction_only')),
            layoutModelPrompt: layoutPrompt.includes(words),
            visualReview: Boolean(review && review.prompt.includes(words)),
            judgeHouseRules: (houseRulesFor(ctx).houseRules ?? []).some((r) => r.includes(kind.rule)),
          },
        };
      };
      const withRule = await reachOf(true);
      const without = await reachOf(false);
      for (const v of Object.values(without.reach)) expect(v).toBe(false);
      expect(withRule.reach).toEqual({
        briefSystemPrompt: true, briefAskedForStyleValues: true, briefContract: true, layoutModelPrompt: true, visualReview: true,
        // The v3 judge chooses the winner with the client's art-direction and guideline rules only.
        judgeHouseRules: false,
      });
      // KAAE's text-only poster is composed: the layout prompt that carries the rule is never sent.
      expect(withRule.layoutCalls).toBe(0);

      // ---- 2. with a brief model that ignores the rule, no code applies it --------------------------
      expect(withRule.brief.styleSpec).toEqual({ ...NEUTRAL_STYLE_SPEC, ...withRule.brief.styleSpec, ...NEUTRAL_STYLE_SPEC });
      expect(withRule.brief.tonePreference).toBeUndefined();
      expect(withRule.brief.requestedBackground ?? '').toBe('');
      const readByCode = JSON.stringify(withRule.brief.styleSpec) !== JSON.stringify(without.brief.styleSpec) || Boolean(withRule.brief.tonePreference);
      expect(readByCode).toBe(false);

      // ---- 3. enforcement of the value a faithful brief sets ----------------------------------------
      const measured: Measured = { kind: kind.kind, rule: kind.rule, reach: withRule.reach, readByCode,
        styleValue: kind.style ? Object.entries(kind.style).map(([k, v]) => `${k}=${v}`).join(', ') : kind.ground ? `requestedBackground=${kind.ground}` : null, status: '' };
      if (kind.holds) {
        for (const grammar of [false, true]) {
          const a = await layoutRun(grammar, kind);
          const b = await layoutRun(grammar, undefined);
          const count = (ls: StudioLayoutV2[]) => ls.filter(kind.holds!).length;
          const result = { with: count(a.layouts), without: count(b.layouts), of: a.layouts.length, changed: !same(a.layouts, b.layouts) };
          if (grammar) measured.composedPoster = result; else measured.modelDrawn = result;
          // What a layout the rule did not reach looks like, for the record (HAWA_RULE_EFFECT_OUT).
          a.layouts.forEach((l, i) => {
            if (kind.holds!(l)) return;
            const t = titleOf(l);
            (measured.misses ??= []).push({ path: grammar ? 'composed' : 'model-drawn', candidate: a.candidates[i].concept?.name ?? String(i),
              canvas: `${l.width}x${l.height} margin ${l.grid.margin}`, logo: l.logo ? [l.logo.x, l.logo.y, l.logo.width, l.logo.height] : null,
              background: l.background.color, title: t ? { color: t.color, bold: t.bold, fontWeight: t.fontWeight ?? null, fontFamily: t.fontFamily, align: t.align } : null });
          });
        }
      }
      const md = measured.modelDrawn, cp = measured.composedPoster;
      const on = (r: NonNullable<Measured['modelDrawn']>, where: string) =>
        !r.changed ? (r.with === r.of && r.without === r.of ? `already so on ${where}, rule or not` : `ignored on ${where}`)
          : r.with > r.without ? `${r.with === r.of ? 'enforced' : `enforced on ${r.with} of ${r.of}`} on ${where}` : `changed, not toward the rule, on ${where}`;
      measured.status = !md ? 'prompt-only: StyleSpec has no value for it; unverifiable without a model'
        : `prompt-only up to the brief; then ${on(md, 'model-drawn layouts')}; ${on(cp!, 'the composed KAAE poster')}`;
      table.push(measured);
      // The measured table, pinned: a change to any path flips this test and must update ADR-291.
      expect({ modelDrawn: md ? [md.with, md.without, md.changed] : null, composedPoster: cp ? [cp.with, cp.without, cp.changed] : null })
        .toEqual(EXPECTED[kind.kind]);
    });
  }
});

describe('ADR-291: the DNA values code enforces change the next draft without a model', () => {
  const colours = (l: StudioLayoutV2) => [l.background.color, ...l.text.map((t) => t.color), ...(l.shapes || []).map((s) => s.color)]
    .map((c) => String(c).toUpperCase());

  it('palette: every colour of every candidate is in the client\'s palette, on both paths, and a narrower palette changes the draft', async () => {
    const narrower = PALETTE.filter((c) => c !== ROYAL && c !== BLUE);
    for (const grammar of [false, true]) {
      const run = async (palette: string[]) => {
        const ctx = stageContext(grammar, recordingClient());
        ctx.referencePack = { ...ctx.referencePack, palette };
        ctx.style = { ...NEUTRAL_STYLE_SPEC };
        return layoutsOf(await runLayoutsStage(ctx, briefWith(), [], [0, 1, 2].map((ordinal) => ({ id: randomUUID(), ordinal }))));
      };
      const full = await run(PALETTE);
      const narrow = await run(narrower);
      const allowed = new Set(narrower.map((c) => c.toUpperCase()));
      for (const l of narrow) for (const c of colours(l)) expect(allowed.has(c)).toBe(true);
      expect(same(full, narrow)).toBe(false);
    }
  });

  it('logo minimum width: the composed poster sets the logo at the client\'s minimum; a model-drawn layout is held by hard QA, not resized', async () => {
    const widths = async (grammar: boolean, minimumWidthPx: number) => {
      const ctx = stageContext(grammar, recordingClient());
      ctx.referencePack = { ...ctx.referencePack, logoConstraints: { ...REFERENCE.rules.logoConstraints, minimumWidthPx } };
      ctx.style = { ...NEUTRAL_STYLE_SPEC };
      const cands = await runLayoutsStage(ctx, briefWith(), [], [0, 1, 2].map((ordinal) => ({ id: randomUUID(), ordinal })));
      return { widths: layoutsOf(cands).map((l) => l.logo!.width), ranked: rankStudioCandidatesV3(ctx, await runRenderStage(ctx, cands)) };
    };
    const composed = await widths(true, 240);
    for (const w of composed.widths) expect(w).toBeGreaterThanOrEqual(240);
    const drawnRun = await widths(false, 240);
    // Preparation does not grow a model's logo to the client's minimum (its house minimum is 100px
    // or 8% of the width); hard QA then refuses the candidates whose logo is under it.
    expect(drawnRun.widths.some((w) => w < 240)).toBe(true);
    for (const r of drawnRun.ranked) {
      if (r.candidate.currentLayout.logo!.width >= 240) continue;
      expect(r.hardQa?.passed).toBe(false);
      expect(r.hardQa?.defectCodes).toContain('LOGO');
    }
  });
});
