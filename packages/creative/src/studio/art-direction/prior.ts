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
  basis: 'client_reference' | 'sharpness' | null;
  /** Why, in words the office can read. */
  reason: string;
}

type Candidate = Pick<StudioLayoutV2, 'artDirection'>;

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
