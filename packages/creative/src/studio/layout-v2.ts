import { z } from 'zod';

export type Hex = string;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GridConfig {
  margin: number;
  columns: 6 | 12;
  gutter: number;
  baseline: number;
}

export interface ArtConfig {
  source: 'generated' | 'procedural';
  prompt?: string;
  motif?: 'guilloche' | 'sun-rays' | 'thin-rules' | 'gradient-wash' | 'diagonal-lines';
  box: Box;
  opacity: number; // 0..1
  scrim?: {
    color: Hex;
    opacityStart: number;
    opacityEnd: number;
    direction: 'vertical' | 'horizontal' | 'radial';
  };
  calmRegion: Box;
}

export interface ShapeElement extends Box {
  kind: 'rect' | 'roundRect' | 'ellipse' | 'line';
  color: Hex;
  opacity?: number;
  radius?: number;
  rotation?: number;
  strokeWidth?: number;
  strokeColor?: Hex;
  role: 'rule' | 'panel' | 'accent' | 'frame';
  /**
   * ADR-170: `overlay` shapes are drawn above the photos and their fades, below the logo and text: a
   * plate, card, tab or pill a title sits on, or a gold frame over a full-bleed photo. Absent is the
   * layer every shape had before, under the photos (a panel drawn over a photo used to hide it).
   */
  layer?: 'overlay';
  /** ADR-170: `none` draws only the stroke, as a frame or an inset line around a photo. */
  fill?: 'none';
  /** ADR-170: what an overlay panel is, for the recipe checks and the Canva object name. */
  surface?: ShapeSurface;
  /** ADR-170: a soft drop shadow under a plate or card. */
  shadow?: ShapeShadow;
}

export const SHAPE_SURFACES = ['plate', 'card', 'tab', 'pill'] as const;
export type ShapeSurface = (typeof SHAPE_SURFACES)[number];

export interface ShapeShadow {
  color: Hex;
  /** 0..1 at the shadow's darkest. */
  opacity: number;
  /** Gaussian blur radius in layout pixels. */
  blur: number;
  /** How far down the shadow falls, in layout pixels. */
  offsetY: number;
}

/**
 * ADR-170: a colour gradient laid over the photos, below the overlay shapes and the text: the navy
 * fade a report title sits on, a bottom scrim under a caption, the cream a photo fades into. Its
 * opacity runs along `direction` through `stops` (each `at` a share of the box, 0..1, ascending).
 */
export interface OverlayElement extends Box {
  kind: 'gradient';
  color: Hex;
  direction: OverlayDirection;
  stops: Array<{ at: number; opacity: number }>;
  /** What the overlay is for: a fade under a title, a scrim under a caption, paper a photo fades into. */
  purpose: 'fade' | 'scrim' | 'paper';
}

export const OVERLAY_DIRECTIONS = ['to-bottom', 'to-top', 'to-left', 'to-right'] as const;
export type OverlayDirection = (typeof OVERLAY_DIRECTIONS)[number];

/**
 * ADR-170: the art-direction recipes, one closed set shared by the layout model, the solver, the
 * validator, the judge and the exemplars. `typographic` is a design with no photograph.
 */
export const RECIPE_IDS = [
  'hero_fade_report',
  'hero_card',
  'hero_plate',
  'scrim_caption',
  'sky_title',
  'cutout_speaker',
  'fade_to_paper',
  'typographic',
] as const;
export type RecipeId = (typeof RECIPE_IDS)[number];

/**
 * ADR-170: which recipe a layout was solved from, and what it decided. A layout with a photo recipe
 * is checked as art direction (text on a fade, plate or card over a photo; the hero bleeding off
 * the edges; photos left out), not as a grid of framed photos.
 */
export interface ArtDirectionRecord {
  recipe: RecipeId;
  /** The model's one-line concept, for the Desk. */
  conceptNote?: string;
  /** The region kept quiet for the title: the fade, the plate, the card or the sky. */
  titleZone: Box;
  heroPhotoIndex?: number;
  texturePhotoIndex?: number;
  cutoutPhotoIndex?: number;
  /** Photos the recipe left out, by photoIndex. */
  omittedPhotos: number[];
  /** Right-to-left form: text blocks mirrored, photos never flipped. */
  rtl: boolean;
  /**
   * How much the hero's own pixels are enlarged to fill its box (1 = shown at its size). Over 1.3 a
   * photo starts to look soft; over 1.5 it is a QA warning and ranks behind a sharper candidate.
   */
  heroUpscale?: number;
}

export interface TextElement extends Box {
  copyIndex: number;
  role: 'eyebrow' | 'title' | 'subtitle' | 'body' | 'date' | 'venue' | 'cta' | 'footer' | 'other';
  fontSize: number;
  lineHeight: number;
  letterSpacing?: number;
  fontFamily: string;
  color: Hex;
  align: 'left' | 'center' | 'right';
  bold?: boolean;
  italic?: boolean;
  opacity?: number;
  rtl?: boolean;
  /** The last paragraph of the copy (after its last line break) in this colour, e.g. a gold edition line. */
  accentColor?: Hex;
  /** Which paragraph accentColor sets apart: the last (default) or the first ("MEET KAAE AT" in gold above the event). */
  accentParagraph?: 'first' | 'last';
  /**
   * The exact words accentColor sets apart, when they are not a paragraph of their own: "MEET KAAE
   * AT" in a one-line title "MEET KAAE AT SAGACON 2026". Takes precedence over accentParagraph.
   * Latin text only; a Kurdish block keeps the paragraph accent.
   */
  accentText?: string;
}

export interface TypeScaleConfig {
  base: number;
  ratio: number;
}

export interface StudioLayoutV2 {
  version: 2;
  width: number;
  height: number;
  genre?: 'social_announcement' | 'invitation' | 'poster' | 'presentation_slide' | 'banner';
  grid: GridConfig;
  background: { color: Hex };
  art?: ArtConfig;
  shapes: ShapeElement[];
  text: TextElement[];
  logo: Box;
  typeScale?: TypeScaleConfig;
  /**
   * Photographs the client sent to appear in the design (a speaker's portrait, a product), each
   * placed once. Until 2026-09-22 a photo sent with a request could only be a style reference, so
   * "a graphic with these texts and two pictures" produced a design with the texts and no pictures.
   */
  photos?: PhotoElement[];
  /** ADR-170: gradients over the photos, below overlay shapes and text. */
  overlays?: OverlayElement[];
  /** ADR-170: the recipe this layout was solved from. Absent: a layout the model drew itself. */
  artDirection?: ArtDirectionRecord;
}

/**
 * How a placed photo is drawn. `framed`: the whole picture, cover-cropped into its box. `cutout`:
 * the person cut out of the picture's background, standing on the design's own background at the
 * bottom of the box (see `cutoutPlacement`), as panelists stand on requesters' reference posters.
 */
export const PHOTO_TREATMENTS = ['framed', 'cutout'] as const;
export type PhotoTreatment = (typeof PHOTO_TREATMENTS)[number];

export interface PhotoElement extends Box {
  /** Index into the request's content photos. */
  photoIndex: number;
  /**
   * `texture` (ADR-170): a second photo blended into a fade under the title, never a cell of its own;
   * it takes a fade and an opacity, and text may sit over it on the fade.
   */
  role: 'hero' | 'portrait' | 'inset' | 'texture';
  /** ADR-170: the photo drawn at this opacity (0.2..1), as a texture blended into a fade. */
  opacity?: number;
  /** Corner radius in px; 0 is square. Round portraits use radius = width / 2. A cut-out has no corners and ignores it. */
  radius?: number;
  /** Absent is framed, as every photo was drawn before cut-outs existed. */
  treatment?: PhotoTreatment;
  /**
   * The point of the source photo to keep in view when a framed photo is cover-cropped into its
   * box, such as the middle of the faces in it (see `coverCrop`). Absent is the centred crop every
   * framed photo had before. A cut-out ignores it.
   */
  focus?: PhotoFocus;
  /**
   * How much tighter than the cover crop a framed photo is cropped, around its focus: 1 is the cover
   * crop, 2 keeps half of it on each side (PHOTO_ZOOM_MIN..PHOTO_ZOOM_MAX). It only chooses which
   * of the photograph's own pixels show. A cut-out ignores it.
   */
  zoom?: number;
  /**
   * A shape a framed photo is cut to instead of its rectangle: `circle` is the ellipse inscribed in
   * the box, `arch` a rectangle whose top is a half-ellipse as wide as the box. It replaces the
   * corner radius. A cut-out already has the person's own edge and refuses one (validation).
   */
  mask?: PhotoMask;
  /** The photo fading into the design's background toward one edge. Framed or cut-out. */
  fade?: PhotoFade;
  /** A colour treatment of the photograph's own pixels. Framed or cut-out. */
  filter?: PhotoFilter;
  /** A line of colour around a cut-out person's silhouette, drawn under them. Cut-outs only. */
  outline?: PhotoOutline;
  /** A soft halo of colour around a cut-out person's silhouette, drawn under them. Cut-outs only. */
  glow?: PhotoGlow;
}

/** A point of a photo as a share (0..1) of its width and height, from the top-left. */
export interface PhotoFocus {
  x: number;
  y: number;
}

/**
 * The limits of the designer treatments. They are deterministic: each one crops, masks, recolours
 * or draws around the photograph's own pixels, and none of them regenerates a person (ADR-032).
 */
export const PHOTO_ZOOM_MIN = 1;
export const PHOTO_ZOOM_MAX = 3;
/** Share of the box the fade runs over. Under 5% it is a hard edge, which a mask already draws. */
export const PHOTO_FADE_LENGTH_MIN = 0.05;
export const PHOTO_FADE_LENGTH_MAX = 1;
/** Outline width in layout pixels. */
export const PHOTO_OUTLINE_WIDTH_MIN = 1;
export const PHOTO_OUTLINE_WIDTH_MAX = 24;
/** Glow reach in layout pixels. */
export const PHOTO_GLOW_RADIUS_MIN = 2;
export const PHOTO_GLOW_RADIUS_MAX = 60;

export const PHOTO_MASKS = ['circle', 'arch'] as const;
export type PhotoMask = (typeof PHOTO_MASKS)[number];

export const PHOTO_FADE_EDGES = ['top', 'bottom', 'left', 'right'] as const;
export type PhotoFadeEdge = (typeof PHOTO_FADE_EDGES)[number];

/**
 * Alpha falls linearly from opaque to fully transparent over the last `length` share of the photo's
 * drawn rectangle toward `edge`, so the background shows through.
 */
export interface PhotoFade {
  edge: PhotoFadeEdge;
  length: number;
}

/**
 * `bw`: Rec. 709 luminance grey. `duotone`: luminance 0..1 mapped onto dark..light. `tint`: each
 * pixel mixed toward `color` by `strength` (0..1).
 */
export type PhotoFilter =
  | { kind: 'bw' }
  | { kind: 'duotone'; dark: Hex; light: Hex }
  | { kind: 'tint'; color: Hex; strength: number };

export interface PhotoOutline {
  color: Hex;
  /** Layout pixels the silhouette is grown by. */
  width: number;
}

export interface PhotoGlow {
  color: Hex;
  /** Layout pixels the glow reaches beyond the silhouette. */
  radius: number;
}

export const typeScaleSchema = z.object({
  base: z.number().positive(),
  ratio: z.number().positive(),
}).strict();

export const hexSchema = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Invalid hex color');

export const boxSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).strict();

export const gridSchema = z.object({
  margin: z.number().int().nonnegative(),
  columns: z.union([z.literal(6), z.literal(12)]),
  gutter: z.number().int().nonnegative(),
  baseline: z.number().int().positive(),
}).strict();

export const scrimSchema = z.object({
  color: hexSchema,
  opacityStart: z.number().min(0).max(1),
  opacityEnd: z.number().min(0).max(1),
  direction: z.enum(['vertical', 'horizontal', 'radial']),
}).strict();

export const artSchema = z.object({
  source: z.enum(['generated', 'procedural']),
  prompt: z.string().optional(),
  motif: z.enum(['guilloche', 'sun-rays', 'thin-rules', 'gradient-wash', 'diagonal-lines']).optional(),
  box: boxSchema,
  opacity: z.number().min(0).max(1),
  scrim: scrimSchema.optional(),
  calmRegion: boxSchema,
}).strict();

export const shapeElementSchema = boxSchema.extend({
  kind: z.enum(['rect', 'roundRect', 'ellipse', 'line']),
  color: hexSchema,
  opacity: z.number().min(0).max(1).optional(),
  radius: z.number().nonnegative().optional(),
  rotation: z.number().optional(),
  strokeWidth: z.number().nonnegative().optional(),
  strokeColor: hexSchema.optional(),
  role: z.enum(['rule', 'panel', 'accent', 'frame']),
  layer: z.literal('overlay').optional(),
  fill: z.literal('none').optional(),
  surface: z.enum(SHAPE_SURFACES).optional(),
  shadow: z.object({
    color: hexSchema,
    opacity: z.number().min(0).max(1),
    blur: z.number().min(0).max(80),
    offsetY: z.number().min(0).max(80),
  }).strict().optional(),
}).strict();

export const overlayElementSchema = boxSchema.extend({
  kind: z.literal('gradient'),
  color: hexSchema,
  direction: z.enum(OVERLAY_DIRECTIONS),
  stops: z.array(z.object({ at: z.number().min(0).max(1), opacity: z.number().min(0).max(1) }).strict()).min(2).max(8),
  purpose: z.enum(['fade', 'scrim', 'paper']),
}).strict();

/** A hero enlarged up to this much stays sharp; recipes plan for it (ADR-170 live trials). */
export const HERO_SHARP_UPSCALE = 1.3;
/** Over this, a hero looks soft: a QA warning, and it ranks behind a sharper candidate. */
export const HERO_SOFT_UPSCALE = 1.5;

export const artDirectionRecordSchema = z.object({
  recipe: z.enum(RECIPE_IDS),
  conceptNote: z.string().max(400).optional(),
  titleZone: boxSchema,
  heroPhotoIndex: z.number().int().nonnegative().optional(),
  texturePhotoIndex: z.number().int().nonnegative().optional(),
  cutoutPhotoIndex: z.number().int().nonnegative().optional(),
  omittedPhotos: z.array(z.number().int().nonnegative()).max(12),
  rtl: z.boolean(),
  heroUpscale: z.number().positive().max(50).optional(),
}).strict();

export const textElementSchema = boxSchema.extend({
  copyIndex: z.number().int().nonnegative(),
  role: z.enum(['eyebrow', 'title', 'subtitle', 'body', 'date', 'venue', 'cta', 'footer', 'other']),
  fontSize: z.number().positive(),
  lineHeight: z.number().positive(),
  letterSpacing: z.number().optional(),
  fontFamily: z.string().min(1),
  color: hexSchema,
  align: z.enum(['left', 'center', 'right']),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  opacity: z.number().min(0).max(1).optional(),
  rtl: z.boolean().optional(),
  accentColor: hexSchema.optional(),
  accentParagraph: z.enum(['first', 'last']).optional(),
  accentText: z.string().max(400).optional(),
}).strict();

export const photoTreatmentSchema = z.enum(PHOTO_TREATMENTS);

export const photoFocusSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
}).strict();

export const photoFadeSchema = z.object({
  edge: z.enum(PHOTO_FADE_EDGES),
  length: z.number().min(PHOTO_FADE_LENGTH_MIN).max(PHOTO_FADE_LENGTH_MAX),
}).strict();

export const photoFilterSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bw') }).strict(),
  z.object({ kind: z.literal('duotone'), dark: hexSchema, light: hexSchema }).strict(),
  z.object({ kind: z.literal('tint'), color: hexSchema, strength: z.number().min(0).max(1) }).strict(),
]);

export const photoOutlineSchema = z.object({
  color: hexSchema,
  width: z.number().min(PHOTO_OUTLINE_WIDTH_MIN).max(PHOTO_OUTLINE_WIDTH_MAX),
}).strict();

export const photoGlowSchema = z.object({
  color: hexSchema,
  radius: z.number().min(PHOTO_GLOW_RADIUS_MIN).max(PHOTO_GLOW_RADIUS_MAX),
}).strict();

export const photoElementSchema = boxSchema.extend({
  photoIndex: z.number().int().nonnegative(),
  role: z.enum(['hero', 'portrait', 'inset', 'texture']),
  opacity: z.number().min(0.2).max(1).optional(),
  radius: z.number().nonnegative().optional(),
  treatment: photoTreatmentSchema.optional(),
  focus: photoFocusSchema.optional(),
  zoom: z.number().min(PHOTO_ZOOM_MIN).max(PHOTO_ZOOM_MAX).optional(),
  mask: z.enum(PHOTO_MASKS).optional(),
  fade: photoFadeSchema.optional(),
  filter: photoFilterSchema.optional(),
  outline: photoOutlineSchema.optional(),
  glow: photoGlowSchema.optional(),
}).strict();

export const studioLayoutV2Schema = z.object({
  version: z.literal(2),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  genre: z.enum(['social_announcement', 'invitation', 'poster', 'presentation_slide', 'banner']).optional(),
  grid: gridSchema,
  background: z.object({ color: hexSchema }).strict(),
  art: artSchema.optional(),
  shapes: z.array(shapeElementSchema).max(40),
  text: z.array(textElementSchema).min(1).max(40),
  logo: boxSchema,
  typeScale: typeScaleSchema.optional(),
  photos: z.array(photoElementSchema).max(6).optional(),
  overlays: z.array(overlayElementSchema).max(6).optional(),
  artDirection: artDirectionRecordSchema.optional(),
}).strict();

/** ADR-170: the recipe of a layout solved as photo art direction, or undefined (typographic or model-drawn). */
export function photoRecipeOf(layout: Pick<StudioLayoutV2, 'artDirection'>): RecipeId | undefined {
  const recipe = layout.artDirection?.recipe;
  return recipe && recipe !== 'typographic' ? recipe : undefined;
}
