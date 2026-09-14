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
  motif?: 'guilloche' | 'sun-rays' | 'thin-rules' | 'gradient-wash';
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
}

export interface StudioLayoutV2 {
  version: 2;
  width: number;
  height: number;
  grid: GridConfig;
  background: { color: Hex };
  art?: ArtConfig;
  shapes: ShapeElement[];
  text: TextElement[];
  logo: Box;
}

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
  motif: z.enum(['guilloche', 'sun-rays', 'thin-rules', 'gradient-wash']).optional(),
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
}).strict();

export const studioLayoutV2Schema = z.object({
  version: z.literal(2),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  grid: gridSchema,
  background: z.object({ color: hexSchema }).strict(),
  art: artSchema.optional(),
  shapes: z.array(shapeElementSchema).max(40),
  text: z.array(textElementSchema).min(1).max(40),
  logo: boxSchema,
}).strict();
