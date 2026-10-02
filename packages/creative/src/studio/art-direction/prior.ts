import { HERO_SHARP_UPSCALE, HERO_SOFT_UPSCALE, RECIPE_IDS, type RecipeId, type StudioLayoutV2 } from '../layout-v2.js';

/**
 * ADR-170: the art-direction prior that decides between two art-directed candidates when the judge
 * does not. In the paid live trials of 2026-09-30 the pairwise judge chose whichever design it was
 * shown second in two of five runs; the tie then fell to the typographic composite, which rewards
 * centred mass, and a centred title plate beat the office's own report layout (example 3) both times.
 *
 * The prior is deterministic and says why it chose: first loaded subject-relevant references for this client (ADR181), then how sharp the hero is (its enlargement over its own
 * pixels). Faces are not weighed here: the solver refuses any recipe whose copy covers a detected
 * face, so every candidate that reaches the judge already keeps them clear.
 */

/** Historical office lookup retained for reference tooling; not a global runtime preference. */
export const SUBJECT_RECIPES: ReadonlyArray<readonly [readonly string[], readonly RecipeId[]]> = [
  [['report_release', 'field_visit'], ['hero_fade_report']],
  [['meeting', 'officials', 'government', 'high_level_visit'], ['scrim_caption']],
  [['event_forum', 'speaker', 'conference'], ['cutout_speaker', 'hero_plate']],
  [['occasion', 'holiday', 'eid', 'greeting'], ['sky_title']],
  [['partnership', 'collaboration', 'international', 'global'], ['hero_plate']],
  [['carousel', 'values', 'accreditation'], ['hero_card']],
  [['call_for_applications', 'recruitment', 'peer_evaluators'], ['fade_to_paper']],
];

/** Historical reference lookup only. Runtime preference requires scopedReferenceRecipes. */
export function houseRecipesFor(subjects: readonly string[] | undefined): RecipeId[] {
  const out: RecipeId[] = [];
  for (const tag of subjects ?? []) {
    for (const [tags, recipes] of SUBJECT_RECIPES) {
      if (!tags.includes(tag)) continue;
      for (const r of recipes) if (!out.includes(r)) out.push(r);
    }
  }
  return out;
}

/** Current-client admitted reference evidence, not model assertions or global subject templates. */
export interface RecipePreferenceContext {
  clientId: string;
  referenceClientId: string;
  policySha256: string;
  loadedIds: readonly string[];
  matches: ReadonlyArray<{ id: string; recipe?: RecipeId; subjectMatches?: readonly string[] }>;
}
export function scopedReferenceRecipes(subjects: readonly string[] | undefined, context?: RecipePreferenceContext): RecipeId[] {
  if (!context?.clientId || context.clientId !== context.referenceClientId || !/^[a-f0-9]{64}$/i.test(context.policySha256)) return [];
  const loaded = new Set(context.loadedIds.slice(0, 20));
  const current = new Set(subjects ?? []), out: RecipeId[] = [];
  for (const match of context.matches.slice(0, 20)) {
    if (!loaded.has(match.id) || !match.recipe || !(RECIPE_IDS as readonly string[]).includes(match.recipe)
      || !match.subjectMatches?.some(tag => current.has(tag))) continue;
    if (!out.includes(match.recipe)) out.push(match.recipe);
  }
  return out;
}

/** 0 sharp (up to 1.3x), 1 acceptable (up to 1.5x), 2 soft. Missing measurements are unknown and cannot decide a comparison. */
export function sharpnessClass(upscale: number): 0 | 1 | 2 {
  if (upscale <= HERO_SHARP_UPSCALE) return 0;
  return upscale <= HERO_SOFT_UPSCALE ? 1 : 2;
}

export interface ArtDirectionPriorDecision {
  /** The candidate the prior prefers, or null when it sees no difference. */
  winner: 'a' | 'b' | null;
  /** Client-scoped reference/gradient guideline evidence; no global subject preference. */
  basis: 'client_reference' | 'sharpness' | 'guideline' | null;
  /** Why, in words the office can read. */
  reason: string;
}

type Candidate = Pick<StudioLayoutV2, 'artDirection'>;

/**
 * ADR-238: the guideline prior, for a client whose reference carries a page grammar (KAAE's 2025
 * guideline). A design composed whole from the grammar is the guideline's own page or cover, so it
 * is preferred over one that is not. Between two that are not, the one with fewer departures from
 * the grammar (`deviations`, from page-grammar.ts guidelineDeviations) is preferred.
 *
 * ADR-262: it is a tie-break only. selectWinnerV3 consults it where the judge did not decide or failed
 * its canary; a reliable judge's pick stands. (It used to stand unless the judge chose the other by a
 * clear margin in both orders, GUIDELINE_CLEAR_MARGIN, which kept the restrained document page
 * against bolder posters.)
 */
export function guidelinePrior(
  a: Pick<StudioLayoutV2, 'composition'>,
  b: Pick<StudioLayoutV2, 'composition'>,
  deviations?: { a: string[]; b: string[] }
): ArtDirectionPriorDecision {
  const ca = Boolean(a.composition);
  const cb = Boolean(b.composition);
  if (ca !== cb) {
    const winner = ca ? 'a' : 'b';
    const kind = (ca ? a : b).composition!.grammar;
    return { winner, basis: 'guideline', reason: `it is the client guideline's own ${kind}, composed from its page grammar` };
  }
  if (deviations && deviations.a.length !== deviations.b.length) {
    const winner = deviations.a.length < deviations.b.length ? 'a' : 'b';
    const loser = winner === 'a' ? deviations.b : deviations.a;
    return { winner, basis: 'guideline', reason: `the other departs from the client guideline: ${loser.join('; ')}` };
  }
  return { winner: null, basis: null, reason: 'equally faithful to the client guideline' };
}

/**
 * The share of the judge's votes (weighted on a photo brief) a candidate needed in each presentation
 * order to overrule the guideline prior: four of five dimensions. ADR-262 retired that override
 * (the prior only breaks ties now); kept for reading selections recorded under ADR-238.
 */
export const GUIDELINE_CLEAR_MARGIN = 0.75;

/** Whether the judge chose `candidateId` by a clear margin (GUIDELINE_CLEAR_MARGIN) in both orders. */
export function judgeClearMargin(
  match: {
    orderAB: { candidateAId: string | number; winnerVotesA: number; winnerVotesB: number; weightedVotesA?: number; weightedVotesB?: number };
    orderBA: { candidateAId: string | number; winnerVotesA: number; winnerVotesB: number; weightedVotesA?: number; weightedVotesB?: number };
  },
  candidateId: string | number
): boolean {
  const share = (o: typeof match.orderAB) => {
    const asA = o.candidateAId === candidateId;
    const [mine, theirs] = o.weightedVotesA !== undefined && o.weightedVotesB !== undefined
      ? asA ? [o.weightedVotesA, o.weightedVotesB] : [o.weightedVotesB, o.weightedVotesA]
      : asA ? [o.winnerVotesA, o.winnerVotesB] : [o.winnerVotesB, o.winnerVotesA];
    return mine + theirs > 0 ? mine / (mine + theirs) : 0;
  };
  return share(match.orderAB) >= GUIDELINE_CLEAR_MARGIN && share(match.orderBA) >= GUIDELINE_CLEAR_MARGIN;
}

export function artDirectionPrior(a: Candidate, b: Candidate, subjects: readonly string[] | undefined, preferences?: RecipePreferenceContext): ArtDirectionPriorDecision {
  const ra = a.artDirection?.recipe;
  const rb = b.artDirection?.recipe;
  if (!ra || !rb) return { winner: null, basis: null, reason: 'not two art-directed candidates' };
  const house = scopedReferenceRecipes(subjects, preferences);
  const rank = (r: RecipeId) => (house.includes(r) ? house.indexOf(r) : house.length);
  if (rank(ra) !== rank(rb)) {
    const [winner, recipe] = rank(ra) < rank(rb) ? (['a', ra] as const) : (['b', rb] as const);
    return { winner, basis: 'client_reference', reason: `${recipe} matches loaded subject-relevant references for this client (policy ${preferences!.policySha256.slice(0, 12)})` };
  }
  const ua = a.artDirection?.heroUpscale;
  const ub = b.artDirection?.heroUpscale;
  if (ua !== undefined && ub !== undefined && sharpnessClass(ua) !== sharpnessClass(ub)) {
    const winner = sharpnessClass(ua) < sharpnessClass(ub) ? 'a' : 'b';
    return { winner, basis: 'sharpness', reason: `its hero is enlarged ${winner === 'a' ? ua : ub}x against ${winner === 'a' ? ub : ua}x` };
  }
  return { winner: null, basis: null, reason: 'same house fit and hero sharpness' };
}
