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
  role: 'hero' | 'portrait' | 'inset';
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
  role: z.enum(['hero', 'portrait', 'inset']),
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
}).strict();
