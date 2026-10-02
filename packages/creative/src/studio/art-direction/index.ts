/** ADR-170: art-directed photo compositions. Exported by name: PHOTO_RECIPE_IDS is the exemplar module's. */
export {
  RECIPES,
  PHOTO_SHOTS,
  QUIET_AREAS,
  eligibleRecipes,
  rankPhotosForHero,
  defaultRecipeFor,
  type RecipeSpec,
  type PhotoShot,
  type QuietArea,
  type PhotoFacts,
} from './recipes.js';
export {
  TEXT_SLOTS,
  solveRecipe,
  normalizeSlots,
  brandTones,
  RecipeInfeasibleError,
  type TextSlot,
  type ArtDirectionChoice,
  type ArtDirectionParams,
  type SolverPhoto,
  type SolveRecipeInput,
  type BrandTones,
} from './solver.js';
export {
  settleLogoGround,
  measureLogoGround,
  renderLogoTemplate,
  readRenderedLogoVisibility,
  type RenderedLogoTemplate,
  readLogoGround,
  logoGroundQuiet,
  nativeLogoContrast,
  logoBackingExcess,
  faceBoxesOf,
  LOGO_MIN_CONTRAST,
  LOGO_MAX_BUSYNESS,
  type LogoGroundReading,
  type SettleLogoOptions,
} from './logo-ground.js';
export { compileLogoVisibility, readLogoVisibility, type LogoVisibilityTemplate, type LogoVisibilityReading } from './logo-visibility.js';
export { analysePhotoAsync, analysePixels, ANALYSIS_EDGE, type PhotoAnalysis } from './photo-analysis.js';
export { carrierOf, isSurfaceShape, overlayOpacityOver, shapePaintsOver, OVERLAY_CARRY_MIN_OPACITY } from './surfaces.js';
export {
  ART_DIRECTION_JSON_SCHEMA,
  buildArtDirectorSystemPrompt,
  buildArtDirectorUserPrompt,
  defaultChoice,
  normalizeConcepts,
  solveConcepts,
  generateArtDirectedCandidatesV3,
  type RawArtDirectionConcept,
  type GenerateArtDirectedOptions,
  type GenerateArtDirectedResult,
} from './generate.js';
export { artDirectionPrior, houseRecipesFor, sharpnessClass, SUBJECT_RECIPES, type ArtDirectionPriorDecision, type RecipePreferenceContext, scopedReferenceRecipes } from './prior.js';
export { tonePreferenceFromWords, toneGroundHex, resolveSurfaceTone, DARK_HERO_LUMINANCE, type TonePreference } from './tone.js';
