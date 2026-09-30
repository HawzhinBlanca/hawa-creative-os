import { RECIPE_IDS, type RecipeId } from '../layout-v2.js';

/**
 * ADR-170: the art-direction recipes. A recipe is a named composition the office's designers use
 * over and over (studied from ~20 of their published photo designs, 2025-2026): the layout model
 * picks one and assigns the photos and the copy to it, and a deterministic solver computes the
 * geometry. The model never writes a coordinate for a recipe design, which is how the drafts before
 * this came to be grids of equal tiles.
 *
 * Each recipe says when it is eligible (photo count, a cut-out, a quiet area), what it is for, and
 * how it reaches Canva, so the prompt, the solver and the transfer read one description.
 */


/** The photo recipes: every recipe but `typographic`. */
export const PHOTO_RECIPE_IDS = RECIPE_IDS.filter((r): r is Exclude<RecipeId, 'typographic'> => r !== 'typographic');

/** What the brief says a photo shows (CREATIVE_BRIEF_SCHEMA imageRoles[].shot). */
export const PHOTO_SHOTS = [
  'classroom_or_interior',
  'group_or_crowd',
  'portrait',
  'event_or_stage',
  'scenic_or_building',
  'top_down',
  'detail_or_object',
  'other',
] as const;
export type PhotoShot = (typeof PHOTO_SHOTS)[number];

/** Where a photo is calm enough for a title (the brief's reading, checked by the local analysis). */
export const QUIET_AREAS = ['top', 'bottom', 'left', 'right', 'none'] as const;
export type QuietArea = (typeof QUIET_AREAS)[number];

export interface RecipeSpec {
  id: RecipeId;
  /** Reference example on the office sheet (scratchpad/office_reference_sheet.png, 2026-09-30). */
  reference: string;
  /** One line for the art-director prompt. */
  summary: string;
  /** When a designer reaches for it. */
  bestFor: string;
  /** The fewest photos it uses (hero; texture is optional). */
  minPhotos: number;
  /** Whether a second photo may be blended into the text zone as a texture. */
  texture: boolean;
  /** Whether it needs a person cut out of their photo. */
  needsCutout: boolean;
  /** Shots it suits best; any shot is allowed, these rank first. */
  shots: PhotoShot[];
  /** How the design is carried into Canva, editable. */
  canva: string;
}

export const RECIPES: Record<RecipeId, RecipeSpec> = {
  hero_storyboard: {
    id: 'hero_storyboard',
    reference: 'ADR-171 engineering composition; human creative qualification pending',
    summary: 'A dominant hero next to a supporting image sequence, with measured live copy on a solid brand surface. Uses every required photo exactly once.',
    bestFor: 'multi-photo reports, visits and event narratives with required image coverage',
    minPhotos: 2,
    texture: false,
    needsCutout: false,
    shots: ['classroom_or_interior', 'group_or_crowd', 'event_or_stage'],
    canva: 'every photo is a native re-croppable image; text and brand surfaces remain native',
  },
  hero_fade_report: {
    id: 'hero_fade_report',
    reference: 'example 3 (KAAE K-12 Pilot Study / Field Visit Report)',
    summary: 'Full-bleed hero photo; a navy gradient fade over the bottom 40-50%; optionally a second photo blended into the fade; a two-colour title on the fade (white line + gold line), body text, a call-to-action pill.',
    bestFor: 'report releases, studies, field visits, news with a strong scene photo',
    minPhotos: 1,
    texture: true,
    needsCutout: false,
    shots: ['classroom_or_interior', 'group_or_crowd', 'event_or_stage', 'scenic_or_building'],
    canva: 'hero is a native re-croppable image; the fade is its own transparent PNG above it; the blended photo is its own alpha-faded PNG; the pill is a native shape; text is native',
  },
  hero_card: {
    id: 'hero_card',
    reference: 'examples 1-2 (Why Accreditation? carousel)',
    summary: 'Full-bleed hero photo inside a gold outer frame; a cream card over the bottom 22-25% holding the title and body in navy; a navy tab holding the logo straddles the card\'s top edge.',
    bestFor: 'carousels, series, explainers, educational posts',
    minPhotos: 1,
    texture: false,
    needsCutout: false,
    shots: ['scenic_or_building', 'classroom_or_interior', 'portrait', 'detail_or_object'],
    canva: 'hero native image; frame, card and tab native shapes; text native',
  },
  hero_plate: {
    id: 'hero_plate',
    reference: 'example 8 (Global Partnership)',
    summary: 'Full-bleed hero photo; a navy title plate with a soft shadow set in the photo\'s quiet top or bottom (sky, wall, floor), never on the people; supporting lines on a bottom scrim. Needs a hero with a quiet top or bottom.',
    bestFor: 'partnerships, agreements, headline statements over a busy or top-down photo',
    minPhotos: 1,
    texture: false,
    needsCutout: false,
    shots: ['top_down', 'group_or_crowd', 'event_or_stage', 'classroom_or_interior'],
    canva: 'hero native image; plate native shape with shadow; scrim its own transparent PNG; text native',
  },
  scrim_caption: {
    id: 'scrim_caption',
    reference: 'example 7 (event photo with bottom caption)',
    summary: 'An untouched group or event photo; a bottom navy scrim; the caption on it and a short gold rule.',
    bestFor: 'meetings, visits, delegations, events where the people are the news',
    minPhotos: 1,
    texture: false,
    needsCutout: false,
    shots: ['group_or_crowd', 'event_or_stage', 'portrait'],
    canva: 'photo native image; scrim its own transparent PNG; rule native shape; text native',
  },
  sky_title: {
    id: 'sky_title',
    reference: 'example 11 (Eid greeting, title in the sky)',
    summary: 'A scenic full-bleed photo; the title set in the photo\'s quiet sky or wall region on a soft scrim.',
    bestFor: 'occasions, greetings, statements with a calm scenic photo',
    minPhotos: 1,
    texture: false,
    needsCutout: false,
    shots: ['scenic_or_building'],
    canva: 'photo native image; scrim its own transparent PNG; text native',
  },
  cutout_speaker: {
    id: 'cutout_speaker',
    reference: 'examples 4-5 (speaker cut-out on navy with rays)',
    summary: 'A person cut out of their photo at the bottom corner, bleeding off the edge, on navy with a sunburst motif behind; the text block beside them.',
    bestFor: 'speakers, forums, webinars, interviews: one person is the news',
    minPhotos: 1,
    texture: false,
    needsCutout: true,
    shots: ['portrait'],
    canva: 'person a transparent PNG; motif art layer; text native',
  },
  fade_to_paper: {
    id: 'fade_to_paper',
    reference: 'example 6 (photo fading into grid paper)',
    summary: 'A photo fading into cream paper; the title on a navy plate and the text on the paper.',
    bestFor: 'calls for applications, notices, announcements with a supporting photo',
    minPhotos: 1,
    texture: false,
    needsCutout: false,
    shots: ['detail_or_object', 'classroom_or_interior', 'other'],
    canva: 'photo an alpha-faded PNG; plate native shape; text native',
  },
  typographic: {
    id: 'typographic',
    reference: 'the typographic archetypes',
    summary: 'No photograph: type, rules and brand ornament.',
    bestFor: 'designs with no photo',
    minPhotos: 0,
    texture: false,
    needsCutout: false,
    shots: [],
    canva: 'shapes and text native',
  },
};

/** What the brief and the local analysis say about one photo, for eligibility and ranking. */
export interface PhotoFacts {
  photoIndex: number;
  width?: number;
  height?: number;
  /** 1..5, the brief's reading of how literally the photo shows the subject. */
  subjectFit?: number;
  shot?: PhotoShot;
  quietArea?: QuietArea;
  /** 0..1 from the local Laplacian analysis. */
  sharpness?: number;
  /** Where the local analysis found the photo calm, if anywhere. */
  localQuiet?: QuietArea;
  /** A face was found (the detector's focus point). */
  faces?: boolean;
  /** A person cut out of this photo passed its checks. */
  cutout?: boolean;
}

/** The recipes eligible for a request with these photos. `typographic` only when there are none. */
export function eligibleRecipes(photos: PhotoFacts[], minimum = 1): RecipeId[] {
  if (!photos.length) return ['typographic'];
  const out: RecipeId[] = [];
  for (const id of PHOTO_RECIPE_IDS) {
    const spec = RECIPES[id];
    if (photos.length < spec.minPhotos) continue;
    if (minimum > 1 && id !== 'hero_storyboard') continue;
    if (spec.needsCutout && !photos.some((p) => p.cutout)) continue;
    // A title in the sky, or a title plate, needs a photo calm at its top or bottom, by the brief or
    // the pixels: a plate anywhere else sits on what the photo shows (live trial, 2026-09-30).
    if ((id === 'sky_title' || id === 'hero_plate') && !photos.some((p) => isCalmTopOrBottom(p))) continue;
    out.push(id);
  }
  return out;
}

function isCalmTopOrBottom(p: PhotoFacts): boolean {
  const areas = [p.quietArea, p.localQuiet];
  return areas.includes('top') || areas.includes('bottom');
}

/**
 * The photos ranked for the hero (rulebook item 10): subject fit first, then sharpness, quiet space
 * for a title, faces and resolution. Deterministic: ties keep the order the client sent them in.
 */
export function rankPhotosForHero(photos: PhotoFacts[]): PhotoFacts[] {
  const score = (p: PhotoFacts) => {
    const fit = ((p.subjectFit ?? 3) - 1) / 4;
    const sharp = p.sharpness ?? 0.5;
    const quiet = p.quietArea && p.quietArea !== 'none' ? 1 : p.localQuiet && p.localQuiet !== 'none' ? 0.7 : 0;
    const megapixels = p.width && p.height ? Math.min(1, (p.width * p.height) / 2_000_000) : 0.5;
    return 0.5 * fit + 0.2 * sharp + 0.12 * quiet + 0.08 * (p.faces ? 1 : 0) + 0.1 * megapixels;
  };
  return [...photos].sort((a, b) => score(b) - score(a) || a.photoIndex - b.photoIndex);
}

/** The recipe a subject's pattern points to first, for the default choice when the model's is unusable. */
export function defaultRecipeFor(photos: PhotoFacts[], eligible: RecipeId[]): RecipeId {
  const hero = rankPhotosForHero(photos)[0];
  const byShot = PHOTO_RECIPE_IDS.filter((id) => eligible.includes(id) && hero?.shot && RECIPES[id].shots.includes(hero.shot));
  if (eligible.includes('hero_fade_report')) return byShot.includes('hero_fade_report') || !byShot.length ? 'hero_fade_report' : byShot[0];
  return byShot[0] ?? eligible[0] ?? 'typographic';
}
