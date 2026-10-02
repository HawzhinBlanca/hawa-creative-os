import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateLayoutV2, type LayoutValidationContext } from '../src/studio/validate-layout-v2.js';
import { logoRuleDefects, studioReferenceFromRaw } from '../src/studio/hard-qa.js';
import { guidelinePrior, judgeClearMargin, GUIDELINE_CLEAR_MARGIN } from '../src/studio/art-direction/prior.js';
import { measureDesignV3, selectWinnerV3, type RankedCandidateV3 } from '../src/studio/pipeline-v3.js';
import { JUDGE_DIMENSIONS, MAX_JUDGE_HOUSE_RULE_CHARS, buildPairwiseJudgeSystemPrompt } from '../src/studio/pairwise-judge-v3.js';
import { reviewCandidateVisuallyV3 } from '../src/studio/visual-review-v3.js';
import { renderLayoutV2 } from '../src/studio/render-layout-v2.js';
import { composeGrammarLayout, guidelineDeviations, guidelineFidelityRule, pageGrammarFromRaw } from '../src/studio/page-grammar.js';
import { HOUSE_RULES, logoClearZone } from '../src/studio/house-rules.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';

/**
 * ADR-238 follow-up (coordinator, 2026-10-02), after proof (c): on the announcement cover the judge
 * chose the model's restyled cover (a flat Midnight panel over the gradient) over the guideline's
 * own composed cover, and the composed cover's title sat low because it kept the house's logo clear
 * space (half the logo's height) rather than the guideline's (the height of the K).
 */

const RAW = JSON.parse(readFileSync(new URL('../assets/kaae-reference.json', import.meta.url), 'utf8'));
const REF = studioReferenceFromRaw(RAW);
const G = pageGrammarFromRaw(RAW)!;
/**
 * ADR-274: KAAE's grammar carries poster rules. These ADR-238/271 cases pin the behaviour a client
 * whose grammar has none keeps, on the same grammar without them.
 */
const G_PAGES = { ...G, poster: undefined };
const COVER = ['Accreditation Cycle 2027', 'Applications now open', 'From 1 November 2026', 'kaae.org'];
const COVER_ROLES = ['title', 'subtitle', 'date', 'footer'];
const WORKSHOP = ['Quality Assurance Workshop', 'For school principals', '22 October 2026 · 10:00 AM', 'Divan Hotel, Erbil', 'Seats are limited, please register early'];
const WORKSHOP_ROLES = ['title', 'subtitle', 'date', 'venue', 'cta'];
const MIDNIGHT = '#0A1628';
const KAAE_FONTS = { latin: ['Crimson Pro', 'Inter'], arabic: ['Noto Sans Arabic', 'IBM Plex Sans Arabic'] };
const copyOf = (lines: string[]) => Object.fromEntries(lines.map((t, i) => [i, t]));
const compose = (lines: string[], roles: string[], tone: 'page' | 'cover', variant?: string) => composeGrammarLayout({
  width: 1080, height: 1350, grammar: G, copy: { text: copyOf(lines) }, roles: Object.fromEntries(roles.map((r, i) => [i, r])),
  logoAspect: 1, logoMinimumWidthPx: 80, logoClearSpaceShare: 0.15, tone, ...(variant ? { variant } : {}),
  fonts: { arabicDisplay: 'IBM Plex Sans Arabic', arabicBody: 'Noto Sans Arabic' },
})!;
const context = (copyCount: number): LayoutValidationContext => ({
  expectedWidth: 1080, expectedHeight: 1350, copyCount, copyScripts: Array(copyCount).fill('latin'), photoCount: 0,
  reference: { rules: { fontFamily: 'Inter', palette: REF.palette, admittedDisplayFonts: KAAE_FONTS }, logoAspect: 1, logoMinimumWidthPx: 80, logoClearSpaceShareOfHeight: 0.15 },
});
/** The model's restyled cover of live trial 7: the gradient ground with a flat Midnight panel laid over it. */
const modelCover = (): StudioLayoutV2 => {
  const l = structuredClone(compose(COVER, COVER_ROLES, 'cover'));
  delete l.composition;
  l.ornaments = [];
  l.shapes.push({ kind: 'rect', role: 'panel', layer: 'overlay', color: MIDNIGHT, x: 90, y: 560, width: 900, height: 520 });
  return l;
};

describe('the guideline prior (ADR-170\'s prior, extended): the guideline\'s own design is preferred', () => {
  it('prefers the design composed from the page grammar, and says why', () => {
    const composed = compose(COVER, COVER_ROLES, 'cover');
    expect(guidelinePrior(modelCover(), composed)).toMatchObject({ winner: 'b', basis: 'guideline', reason: expect.stringMatching(/guideline's own cover/) });
    expect(guidelinePrior(composed, modelCover())).toMatchObject({ winner: 'a', basis: 'guideline' });
  });

  it('between two that are not composed, prefers the one with fewer departures from the grammar', () => {
    const faithful = structuredClone(compose(WORKSHOP, WORKSHOP_ROLES, 'page'));
    delete faithful.composition;
    const bare = structuredClone(faithful);
    bare.shapes = bare.shapes.filter((s) => s.primitive !== 'header_rule' && s.primitive !== 'foot_rule');
    const d = { a: guidelineDeviations(bare, G_PAGES), b: guidelineDeviations(faithful, G_PAGES) };
    expect(d.b).toEqual([]);
    expect(guidelinePrior(bare, faithful, d)).toMatchObject({ winner: 'b', basis: 'guideline', reason: expect.stringMatching(/header rule.*foot/) });
    expect(guidelinePrior(faithful, faithful, { a: [], b: [] })).toMatchObject({ winner: null, basis: null });
  });

  it('names each departure: a flat dark panel on the gradient cover, a missing header rule, bar or foot rule, a face outside the guideline', () => {
    expect(guidelineDeviations(compose(COVER, COVER_ROLES, 'cover'), G_PAGES)).toEqual([]);
    expect(guidelineDeviations(compose(COVER, COVER_ROLES, 'cover', 'sunburst'), G_PAGES)).toEqual([]);
    expect(guidelineDeviations(compose(WORKSHOP, WORKSHOP_ROLES, 'page'), G_PAGES)).toEqual([]);
    expect(guidelineDeviations(modelCover(), G_PAGES)).toEqual(['a flat dark panel on the gradient cover']);
    const page = structuredClone(compose(WORKSHOP, WORKSHOP_ROLES, 'page'));
    page.shapes = page.shapes.filter((s) => !['header_rule', 'header_accent', 'title_bar', 'foot_rule'].includes(s.primitive ?? ''));
    page.text[0].fontFamily = 'Playfair Display';
    expect(guidelineDeviations(page, G_PAGES)).toEqual([
      'no header rule with its gold segment', 'no gold bar under the title', 'no gradient rule at the foot', 'a typeface outside the guideline (Playfair Display)',
    ]);
    const flatNavy = structuredClone(compose(COVER, COVER_ROLES, 'cover'));
    flatNavy.shapes = flatNavy.shapes.filter((s) => s.primitive !== 'cover_ground');
    expect(guidelineDeviations(flatNavy, G_PAGES)).toContain('a dark design without the guideline cover\'s gradient ground');
  });

  it('ADR-274: with poster rules the office\'s own techniques are not departures; the document page and the faces still are', () => {
    // The office's title tab: a flat dark panel on the gradient.
    expect(guidelineDeviations(modelCover(), G)).toEqual([]);
    // A light poster with no gold bar, header rule or foot rule (most office posts have none).
    const bare = structuredClone(compose(WORKSHOP, WORKSHOP_ROLES, 'page'));
    delete bare.composition;
    bare.shapes = bare.shapes.filter((s) => !['header_rule', 'header_accent', 'title_bar', 'foot_rule'].includes(s.primitive ?? ''));
    expect(guidelineDeviations(bare, G)).toEqual([]);
    expect(guidelineDeviations(bare, G_PAGES)).toHaveLength(3);
    // The guideline's own document page is still held to its marks.
    const page = structuredClone(compose(WORKSHOP, WORKSHOP_ROLES, 'page'));
    page.shapes = page.shapes.filter((s) => s.primitive !== 'foot_rule');
    expect(guidelineDeviations(page, G)).toEqual(['no gradient rule at the foot']);
    // A face outside the guideline still counts.
    bare.text[0].fontFamily = 'Playfair Display';
    expect(guidelineDeviations(bare, G)).toEqual(['a typeface outside the guideline (Playfair Display)']);
    // The display faces come from the reference's poster rules, on display blocks only.
    const declared = { ...G, poster: { ...G.poster!, displayFonts: ['Montserrat'] } };
    bare.text[0].fontFamily = 'Montserrat';
    expect(guidelineDeviations(bare, declared)).toEqual([]);
    expect(guidelineDeviations(bare, G)).toEqual(['a typeface outside the guideline (Montserrat)']);
    const body = bare.text.find((t) => t.role === 'cta' || t.role === 'venue')!;
    body.role = 'body';
    body.fontFamily = 'Montserrat';
    bare.text[0].fontFamily = 'Inter';
    expect(guidelineDeviations(bare, declared)).toEqual(['a typeface outside the guideline (Montserrat)']);
    expect(G.poster!.displayFonts).toEqual(['Inter']);
  });

  it('ADR-274: with poster rules the prior no longer prefers a design for being composed from the grammar', () => {
    const composed = compose(COVER, COVER_ROLES, 'cover');
    expect(guidelinePrior(modelCover(), composed, { a: [], b: [] }, { posterRules: true })).toMatchObject({ winner: null, basis: null });
    // A real departure still decides.
    expect(guidelinePrior(modelCover(), composed, { a: ['a typeface outside the guideline (Playfair Display)'], b: [] }, { posterRules: true }))
      .toMatchObject({ winner: 'b', basis: 'guideline', reason: expect.stringMatching(/Playfair/) });
    // Without poster rules, as before.
    expect(guidelinePrior(modelCover(), composed, { a: [], b: [] })).toMatchObject({ winner: 'b', reason: expect.stringMatching(/guideline's own cover/) });
  });

  it('a clear margin is four of five votes, in both presentation orders', () => {
    const order = (a: string, votesA: number) => ({ candidateAId: a, winnerVotesA: votesA, winnerVotesB: 5 - votesA });
    expect(GUIDELINE_CLEAR_MARGIN).toBe(0.75);
    expect(judgeClearMargin({ orderAB: order('x', 4), orderBA: order('y', 1) }, 'x')).toBe(true);
    expect(judgeClearMargin({ orderAB: order('x', 3), orderBA: order('y', 2) }, 'x')).toBe(false);
    expect(judgeClearMargin({ orderAB: order('x', 5), orderBA: order('y', 2) }, 'x')).toBe(false);
    // Weighted votes decide on a photo brief.
    expect(judgeClearMargin({ orderAB: { ...order('x', 3), weightedVotesA: 9, weightedVotesB: 2 }, orderBA: { ...order('y', 2), weightedVotesA: 2, weightedVotesB: 9 } }, 'x')).toBe(true);
  });
});

describe('selection: the judge decides; a composed guideline design wins a tie (ADR-271)', () => {
  const passedQa = { passed: true, defectCodes: [], messages: [], findings: [] } as any;
  const receipt = { model: 'gpt-4.1-mini', responseId: 'r', xRequestId: null, inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 };
  /** A verdict giving `votesA` of the five dimensions to the design shown as A. */
  const verdict = (votesA: number) => ({
    dimensions: Object.fromEntries(JUDGE_DIMENSIONS.map((d, i) => [d, { winner: i < votesA ? 'A' : 'B', rationale: 'r' }])),
    majorityWinner: votesA >= 3 ? 'A' : 'B', summary: 's',
  });
  /**
   * A judge that prefers the model's cover by `votes` of five in both orders (it is shown first, as
   * the higher ranked), then picks the real design over its degraded canary in both orders.
   */
  const judge = (votes: number) => {
    const create = vi.fn()
      .mockResolvedValueOnce({ data: verdict(votes), receipt })
      .mockResolvedValueOnce({ data: verdict(5 - votes), receipt })
      .mockResolvedValueOnce({ data: verdict(5), receipt })
      .mockResolvedValueOnce({ data: verdict(0), receipt });
    return { createStructuredCompletion: create } as any;
  };
  const ranked = (): RankedCandidateV3[] => {
    const model = modelCover();
    const other = structuredClone(model);
    const composed = compose(COVER, COVER_ROLES, 'cover');
    return [
      { sourceIndex: 0, layout: model, metrics: measureDesignV3(model, { text: copyOf(COVER) }), hardQa: passedQa },
      { sourceIndex: 1, layout: other, metrics: measureDesignV3(other, { text: copyOf(COVER) }), hardQa: passedQa },
      { sourceIndex: 2, layout: composed, metrics: measureDesignV3(composed, { text: copyOf(COVER) }), hardQa: passedQa },
    ];
  };
  const select = (votes: number, pageGrammar = true) => selectWinnerV3(ranked(), { text: copyOf(COVER) }, {
    client: judge(votes), model: 'gpt-4.1-mini', renderOptions: { logoDataUri: KAAE_TEST_LOGO }, ...(pageGrammar ? { pageGrammar: G_PAGES } : {}),
  });

  it('the judge sees the best composed design against the best other one, not the top two', async () => {
    const s = await select(3);
    expect([s.match!.candidate1Id, s.match!.candidate2Id]).toEqual(['candidate_0', 'candidate_2']);
  }, 60000);

  it('ADR-271: a reliable judge that prefers the other by three votes of five in both orders decides; the guideline prior no longer overrules it', async () => {
    const s = await select(3);
    expect(s.decidedBy).toBe('judge');
    expect(s.winner.sourceIndex).toBe(0);
    expect(s.prior).toBeUndefined();
    expect(s.judgeReliable).toBe(true);
    // Without a page grammar the same judge decides, as before.
    const plain = await select(3, false);
    expect(plain.decidedBy).toBe('judge');
    expect(plain.winner.sourceIndex).toBe(0);
  }, 60000);

  it('ADR-271: the guideline prior breaks a tie: a judge split across the two orders leaves the composed design', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ data: verdict(3), receipt })
      .mockResolvedValueOnce({ data: verdict(3), receipt })
      .mockResolvedValueOnce({ data: verdict(5), receipt })
      .mockResolvedValueOnce({ data: verdict(0), receipt });
    const s = await selectWinnerV3(ranked(), { text: copyOf(COVER) }, {
      client: { createStructuredCompletion: create } as any, model: 'gpt-4.1-mini', renderOptions: { logoDataUri: KAAE_TEST_LOGO }, pageGrammar: G_PAGES,
    });
    expect(s.winner.sourceIndex).toBe(2);
    expect(s.decidedBy).toBe('art_direction_prior');
    expect(s.prior).toMatchObject({ basis: 'guideline', instead: 'composite_after_tie', reason: expect.stringMatching(/guideline's own cover/) });
    expect(s.humanChoiceRecommended).toBe(true);
  }, 60000);

  it('a judge that prefers the other by a clear margin in both orders, and passes its canary, decides', async () => {
    const s = await select(4);
    expect(s.decidedBy).toBe('judge');
    expect(s.winner.sourceIndex).toBe(0);
    expect(s.prior).toBeUndefined();
  }, 60000);

  it('a judge that picks the composed design decides, as before', async () => {
    const s = await select(1);
    expect(s.decidedBy).toBe('judge');
    expect(s.winner.sourceIndex).toBe(2);
  }, 60000);
});

describe('ADR-274: a poster client\'s judge sees every composed poster, and no composed default', () => {
  const passedQa = { passed: true, defectCodes: [], messages: [], findings: [] } as any;
  const receipt = { model: 'gpt-4.1-mini', responseId: 'r', xRequestId: null, inputTokens: 1, outputTokens: 1, costUsd: 0.0171, latencyMs: 1 };
  const verdict = (votesA: number) => ({
    dimensions: Object.fromEntries(JUDGE_DIMENSIONS.map((d, i) => [d, { winner: i < votesA ? 'A' : 'B', rationale: 'r' }])),
    majorityWinner: votesA >= 3 ? 'A' : 'B', summary: 's',
  });
  /** A judge answering, in call order, with these votes for the design shown as A. */
  const scripted = (votes: number[]) => {
    const create = vi.fn();
    for (const v of votes) create.mockResolvedValueOnce({ data: verdict(v), receipt });
    return create;
  };
  const candidate = (sourceIndex: number, layout: StudioLayoutV2): RankedCandidateV3 =>
    ({ sourceIndex, layout, metrics: measureDesignV3(layout, { text: copyOf(COVER) }), hardQa: passedQa });
  const three = (): RankedCandidateV3[] => {
    const model = modelCover();
    return [candidate(0, model), candidate(1, structuredClone(model)), candidate(2, compose(COVER, COVER_ROLES, 'cover'))];
  };
  const run = (ranked: RankedCandidateV3[], create: ReturnType<typeof vi.fn>, grammar = G) => selectWinnerV3(ranked, { text: copyOf(COVER) }, {
    client: { createStructuredCompletion: create } as any, model: 'gpt-4.1-mini', renderOptions: { logoDataUri: KAAE_TEST_LOGO }, pageGrammar: grammar,
  });

  it('judges all three in a round robin, both orders each, and the third by composite can win: eight calls where there were four', async () => {
    // Pairs in rank order: (0,1), (0,2), (1,2), each AB then BA; then the canary, AB then BA.
    // 0 beats 1; 2 beats 0; 2 beats 1; the pick beats its degraded copy.
    const create = scripted([3, 2, 1, 4, 2, 3, 5, 0]);
    const s = await run(three(), create);
    expect(create).toHaveBeenCalledTimes(8);
    expect(s.decidedBy).toBe('judge');
    expect(s.winner.sourceIndex).toBe(2);
    expect(s.runnerUp!.sourceIndex).toBe(0);
    expect(s.matches!.map((m) => [m.candidate1Id, m.candidate2Id])).toEqual([
      ['candidate_0', 'candidate_1'], ['candidate_0', 'candidate_2'], ['candidate_1', 'candidate_2'],
    ]);
    expect(s.roundRobin).toEqual({ standings: [{ sourceIndex: 2, score: 2 }, { sourceIndex: 0, score: 0 }, { sourceIndex: 1, score: -2 }], pickSourceIndex: 2 });
    expect([s.match!.candidate1Id, s.match!.candidate2Id]).toEqual(['candidate_0', 'candidate_2']);
    expect(s.canary!.subject.sourceIndex).toBe(2);
    expect(s.judgeReliable).toBe(true);
    // The judge's spend: eight calls at the receipt's cost.
    const spent = [...s.matches!.flatMap((m) => [m.orderAB, m.orderBA]), s.canary!.match.orderAB, s.canary!.match.orderBA].reduce((a, o) => a + o.receipt.costUsd, 0);
    expect(spent).toBeCloseTo(8 * 0.0171, 6);
  }, 120000);

  it('a client without poster rules keeps one pair and four calls', async () => {
    const create = scripted([3, 2, 5, 0]);
    const s = await run(three(), create, G_PAGES);
    expect(create).toHaveBeenCalledTimes(4);
    expect(s.matches).toBeUndefined();
    expect(s.roundRobin).toBeUndefined();
  }, 60000);

  it('two eligible posters are judged as ranked, one pair', async () => {
    const create = scripted([3, 2, 5, 0]);
    const s = await run(three().slice(0, 2), create);
    expect(create).toHaveBeenCalledTimes(4);
    expect([s.match!.candidate1Id, s.match!.candidate2Id]).toEqual(['candidate_0', 'candidate_1']);
    expect(s.decidedBy).toBe('judge');
    expect(s.winner.sourceIndex).toBe(0);
  }, 60000);

  it('a cycle leaves no pick; the composed design does not win the tie for being composed (the composite and findings decide)', async () => {
    // The composed cover ranks second. Pairs (0,2), (0,1), (2,1): 0 beats 2, 1 beats 0, 2 beats 1: every score 0.
    const [model, other, composed] = three();
    const create = scripted([3, 2, 2, 3, 3, 2, 5, 0]);
    const s = await run([model, composed, other], create);
    expect(s.roundRobin!.pickSourceIndex).toBeNull();
    expect(s.roundRobin!.standings.map((r) => r.score)).toEqual([0, 0, 0]);
    expect(s.decidedBy).toBe('composite_after_tie');
    expect(s.prior).toBeUndefined();
    expect(s.winner.sourceIndex).toBe(0);
    expect(s.humanChoiceRecommended).toBe(true);
    // The same tie without poster rules (the guideline pair, the composed default) went to the composed cover.
    const before = await run([model, composed, other], scripted([3, 3, 5, 0]), G_PAGES);
    expect(before.winner.sourceIndex).toBe(2);
    expect(before.prior).toMatchObject({ basis: 'guideline', reason: expect.stringMatching(/composed from its page grammar/) });
  }, 120000);

  it('two leaders sharing the best score leave no pick; a pick that fails its canary is not trusted', async () => {
    // 0 and 1 split; both beat 2: scores 1, 1, -2.
    const tie = await run(three(), scripted([3, 3, 3, 2, 3, 2, 5, 0]));
    expect(tie.roundRobin!.pickSourceIndex).toBeNull();
    expect(tie.roundRobin!.standings.map((r) => r.sourceIndex)).toEqual([0, 1, 2]);
    expect(tie.decidedBy).toBe('composite_after_tie');
    expect([tie.match!.candidate1Id, tie.match!.candidate2Id]).toEqual(['candidate_0', 'candidate_1']);
    // 2 wins every match but cannot beat its own degraded copy.
    const unreliable = await run(three(), scripted([3, 2, 1, 4, 2, 3, 0, 5]));
    expect(unreliable.roundRobin!.pickSourceIndex).toBe(2);
    expect(unreliable.decidedBy).toBe('composite_judge_unreliable');
    expect(unreliable.judgeReliable).toBe(false);
  }, 120000);
});

describe('the judge and the visual review read a guideline-fidelity rule', () => {
  it('ADR-274: a poster client\'s rule names only the document page\'s marks and the faces, and allows the office\'s tab and a missing bar', () => {
    const rule = guidelineFidelityRule(G);
    expect(rule.length).toBeLessThanOrEqual(MAX_JUDGE_HOUSE_RULE_CHARS);
    expect(rule).not.toMatch(/flat dark panel/);
    expect(rule).toMatch(/document page lacking header rule, title bar or foot rule/);
    expect(rule).toMatch(/dark title tab or missing bar is fine/);
    expect(rule).toMatch(/Crimson Pro, Inter/);
    const declared = guidelineFidelityRule({ ...G, poster: { ...G.poster!, displayFonts: ['Montserrat'] } });
    expect(declared).toMatch(/Crimson Pro, Inter, Montserrat/);
    expect(declared.length).toBeLessThanOrEqual(MAX_JUDGE_HOUSE_RULE_CHARS);
  });

  it('fits one house rule and names the departures and the guideline\'s faces', async () => {
    const rule = guidelineFidelityRule(G_PAGES);
    expect(rule.length).toBeLessThanOrEqual(MAX_JUDGE_HOUSE_RULE_CHARS);
    expect(rule).toMatch(/flat dark panel on the gradient cover/);
    expect(rule).toMatch(/header rule/);
    expect(rule).toMatch(/gold title bar/);
    expect(rule).toMatch(/foot rule/);
    expect(rule).toMatch(/Crimson Pro, Inter/);
    const prompt = buildPairwiseJudgeSystemPrompt({ photoBrief: false, houseRules: [rule] });
    expect(prompt).toContain(`R1. ${JSON.stringify(rule)}`);
    expect(prompt).toMatch(/they weigh in brand_fit/);
    const layout = compose(COVER, COVER_ROLES, 'cover');
    const create = vi.fn().mockResolvedValue({ data: { assessment: 'a', fixes: [] }, receipt: { model: 'gpt-4.1-mini', responseId: 'r', xRequestId: null, inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 } });
    await reviewCandidateVisuallyV3(
      { sourceIndex: 0, layout, metrics: measureDesignV3(layout, { text: copyOf(COVER) }), renderedPng: renderLayoutV2(layout, { copyText: copyOf(COVER), logoDataUri: KAAE_TEST_LOGO }).png },
      { text: copyOf(COVER) }, { client: { createStructuredCompletion: create }, model: 'gpt-4.1-mini', renderOptions: { logoDataUri: KAAE_TEST_LOGO }, context: { houseRules: [rule] } });
    expect(create.mock.calls[0][0].messages[1].content[0].text).toContain(`- ${rule}`);
  }, 60000);
});

describe('a guideline cover keeps the guideline\'s clear space (the K), and the house\'s 100px minimum width', () => {
  it('sets the composed cover\'s title higher than the house clear space put it', () => {
    const cover = compose(COVER, COVER_ROLES, 'cover');
    const title = cover.text.find((t) => t.copyIndex === 0)!;
    const k = 0.15 * cover.logo.height;
    // 4c95154a: the pattern cover's title at y = 700, under the house's 162px clear space.
    expect(title.y).toBeLessThan(660);
    expect(title.y).toBeGreaterThanOrEqual(cover.logo.y + cover.logo.height + k);
    expect(cover.logo.width).toBeGreaterThanOrEqual(100);
    expect(validateLayoutV2(cover, context(4))).toMatchObject({ ok: true });
  });

  it('the validator and hard QA take the K on a composed cover only; any other design keeps the house clear space', () => {
    const cover = structuredClone(compose(COVER, COVER_ROLES, 'cover'));
    const logo = cover.logo;
    const k = Math.ceil(0.15 * logo.height);
    const title = cover.text.find((t) => t.copyIndex === 0)!;
    title.y = logo.y + logo.height + k + 2;
    expect(validateLayoutV2(cover, context(4))).toMatchObject({ ok: true });
    const notComposed = structuredClone(cover);
    delete notComposed.composition;
    expect(validateLayoutV2(notComposed, context(4))).toMatchObject({ ok: false, code: 'LOGO', message: expect.stringMatching(/clear space/) });
    // A page composed from the grammar keeps the house rule too.
    const asPage = structuredClone(cover);
    asPage.composition = { ...asPage.composition!, grammar: 'page' };
    expect(validateLayoutV2(asPage, context(4))).toMatchObject({ ok: false, code: 'LOGO' });

    const accent = { kind: 'rect' as const, role: 'accent' as const, color: '#F7B500', x: logo.x, y: logo.y + logo.height + k + 2, width: 60, height: 4 };
    expect(logoRuleDefects({ ...cover, shapes: [...cover.shapes, accent] }, 0.15 * logo.height)).toEqual([]);
    expect(logoRuleDefects({ ...notComposed, shapes: [...notComposed.shapes, accent] }, 0.15 * logo.height).map((d) => d.code)).toContain('LOGO_CLEAR_SPACE');
    expect(logoClearZone(logo, 0.15 * logo.height, { clientOnly: true }).y).toBeCloseTo(logo.y - 0.15 * logo.height);
    expect(logoClearZone(logo, 0.15 * logo.height).y).toBeCloseTo(logo.y - HOUSE_RULES.logo.clearSpaceShareOfHeight * logo.height);
  });

  it('never lets a guideline cover\'s logo under the house\'s 100px minimum width', () => {
    const cover = structuredClone(compose(COVER, COVER_ROLES, 'cover'));
    cover.logo = { ...cover.logo, width: 90, height: 90 };
    expect(validateLayoutV2(cover, context(4))).toMatchObject({ ok: false, code: 'LOGO', message: expect.stringMatching(/minimum 100px/) });
  });
});
