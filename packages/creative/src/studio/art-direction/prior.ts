import { HERO_SHARP_UPSCALE, HERO_SOFT_UPSCALE, type RecipeId, type StudioLayoutV2 } from '../layout-v2.js';

/**
 * ADR-170: the art-direction prior that decides between two art-directed candidates when the judge
 * does not. In the paid live trials of 2026-09-30 the pairwise judge chose whichever design it was
 * shown second in two of five runs; the tie then fell to the typographic composite, which rewards
 * centred mass, and a centred title plate beat the office's own report layout (example 3) both times.
 *
 * The prior is deterministic and says why it chose: first the house recipe for the brief's subject
 * (the rulebook's per-subject patterns), then how sharp the hero is (its enlargement over its own
 * pixels). Faces are not weighed here: the solver refuses any recipe whose copy covers a detected
 * face, so every candidate that reaches the judge already keeps them clear.
 */

/** The brief's subject tags and the recipes the office uses for them, best first. */
export const SUBJECT_RECIPES: ReadonlyArray<readonly [readonly string[], readonly RecipeId[]]> = [
  [['report_release', 'field_visit'], ['hero_fade_report']],
  [['meeting', 'officials', 'government', 'high_level_visit'], ['scrim_caption']],
  [['event_forum', 'speaker', 'conference'], ['cutout_speaker', 'hero_plate']],
  [['occasion', 'holiday', 'eid', 'greeting'], ['sky_title']],
  [['partnership', 'collaboration', 'international', 'global'], ['hero_plate']],
  [['carousel', 'values', 'accreditation'], ['hero_card']],
  [['call_for_applications', 'recruitment', 'peer_evaluators'], ['fade_to_paper']],
];

/** The house recipes for a brief's subject tags, in the order the tags name them. */
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

/** 0 sharp (up to 1.3x), 1 acceptable (up to 1.5x), 2 soft. Missing measurements are unknown and cannot decide a comparison. */
export function sharpnessClass(upscale: number): 0 | 1 | 2 {
  if (upscale <= HERO_SHARP_UPSCALE) return 0;
  return upscale <= HERO_SOFT_UPSCALE ? 1 : 2;
}

export interface ArtDirectionPriorDecision {
  /** The candidate the prior prefers, or null when it sees no difference. */
  winner: 'a' | 'b' | null;
  basis: 'subject' | 'sharpness' | null;
  /** Why, in words the office can read. */
  reason: string;
}

type Candidate = Pick<StudioLayoutV2, 'artDirection'>;

export function artDirectionPrior(a: Candidate, b: Candidate, subjects: readonly string[] | undefined): ArtDirectionPriorDecision {
  const ra = a.artDirection?.recipe;
  const rb = b.artDirection?.recipe;
  if (!ra || !rb) return { winner: null, basis: null, reason: 'not two art-directed candidates' };
  const house = houseRecipesFor(subjects);
  const rank = (r: RecipeId) => (house.includes(r) ? house.indexOf(r) : house.length);
  if (rank(ra) !== rank(rb)) {
    const [winner, recipe] = rank(ra) < rank(rb) ? (['a', ra] as const) : (['b', rb] as const);
    const tags = (subjects ?? []).filter((t) => SUBJECT_RECIPES.some(([ts, rs]) => ts.includes(t) && rs.includes(recipe)));
    return { winner, basis: 'subject', reason: `${recipe} is the house recipe for ${tags.join(', ')}` };
  }
  const ua = a.artDirection?.heroUpscale;
  const ub = b.artDirection?.heroUpscale;
  if (ua !== undefined && ub !== undefined && sharpnessClass(ua) !== sharpnessClass(ub)) {
    const winner = sharpnessClass(ua) < sharpnessClass(ub) ? 'a' : 'b';
    return { winner, basis: 'sharpness', reason: `its hero is enlarged ${winner === 'a' ? ua : ub}x against ${winner === 'a' ? ub : ua}x` };
  }
  return { winner: null, basis: null, reason: 'same house fit and hero sharpness' };
}
