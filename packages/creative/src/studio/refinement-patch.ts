import { z } from 'zod';
import { boxSchema, gridSchema, hexSchema, textElementSchema, typeScaleSchema, type StudioLayoutV2, type TextElement } from './layout-v2.js';

export const REFINEMENT_PATCH_POLICY = 'geometry-only-v1' as const;
export interface RepairRejection {
  code: 'repair_returned_unusable_layout' | 'repair_changed_protected_input' | 'repair_covered_a_photo';
  findings: string[];
}
export interface RepairPatchContext {
  /** Authoritative requested live-copy identities; permits restoration of an omitted block. */
  copyIndices?: readonly number[];
  /** Trusted current-client policy, used only for a newly restored block. */
  allowedFonts?: readonly string[];
  palette?: readonly string[];
}
const textPatch = boxSchema.extend({ copyIndex: z.number().int().nonnegative(), role: textElementSchema.shape.role,
  fontSize: z.number().finite().positive(), lineHeight: z.number().finite().positive(),
  letterSpacing: z.number().finite().optional(), fontFamily: z.string(), color: hexSchema,
  align: z.enum(['left', 'center', 'right']), bold: z.boolean().optional(), italic: z.boolean().optional(), rtl: z.boolean().optional() }).passthrough();
const shapePatch = boxSchema.extend({ kind: z.string(), role: z.string().optional(), color: hexSchema }).passthrough();
const patchSchema = z.object({ version: z.literal(2), width: z.number().finite().positive(), height: z.number().finite().positive(),
  grid: gridSchema, background: z.object({ color: hexSchema }).passthrough(), logo: boxSchema,
  text: z.array(textPatch).min(1).max(40), shapes: z.array(shapePatch).max(40), typeScale: typeScaleSchema.optional() }).passthrough();
const color = (s: string) => { const h = s.toUpperCase(); return h.length === 4 ? '#' + [...h.slice(1)].map(c => c + c).join('') : h; };
const box = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x, y: b.y, width: b.width, height: b.height });

/** A model proposes geometry; the original design owns its editable assets and style. */
export function applyRefinementPatch(original: StudioLayoutV2, proposal: unknown, context: RepairPatchContext = {}):
  { ok: true; layout: StudioLayoutV2 } | { ok: false; rejection: RepairRejection } {
  const parsed = patchSchema.safeParse(proposal);
  if (!parsed.success) return { ok: false, rejection: { code: 'repair_returned_unusable_layout',
    findings: parsed.error.issues.slice(0, 8).map(i => `${i.path.join('.')}: ${i.code}`) } };
  const p = parsed.data;
  const geometryFindings: string[] = [];
  [...p.text, p.logo, ...p.shapes].forEach((b, i) => {
    if (b.x + b.width > original.width || b.y + b.height > original.height) geometryFindings.push(`box ${i}: outside canvas`);
  });
  p.text.forEach(t => {
    if (t.fontSize * t.lineHeight > original.height || Math.abs(t.letterSpacing ?? 0) > original.width) geometryFindings.push(`text ${t.copyIndex}: type geometry exceeds canvas`);
  });
  if (p.typeScale && (!Number.isFinite(p.typeScale.base) || !Number.isFinite(p.typeScale.ratio)
    || p.typeScale.base > original.height || p.typeScale.ratio > Math.max(original.width, original.height))) geometryFindings.push('type scale exceeds bounded canvas');
  if (geometryFindings.length) return { ok: false, rejection: { code: 'repair_returned_unusable_layout', findings: geometryFindings.slice(0, 8) } };
  const findings: string[] = [];
  if (p.width !== original.width || p.height !== original.height) findings.push('canvas dimensions changed');
  if (Object.keys(original.grid).some(k => p.grid[k as keyof typeof p.grid] !== original.grid[k as keyof typeof original.grid])) findings.push('grid changed');
  if (color(p.background.color) !== color(original.background.color)) findings.push('background color changed');
  const byCopy = new Map(p.text.map(t => [t.copyIndex, t]));
  const expected = context.copyIndices ?? original.text.map(t => t.copyIndex);
  const expectedSet = new Set(expected);
  if (expectedSet.size !== expected.length || expected.some(id => !Number.isSafeInteger(id) || id < 0)
    || p.text.length !== expected.length || byCopy.size !== p.text.length || expected.some(id => !byCopy.has(id))) findings.push('copy identities changed, duplicated or removed');
  const originalByCopy = new Map(original.text.map(t => [t.copyIndex, t]));
  const allowedFonts = new Set([...original.text.map(t => t.fontFamily), ...(context.allowedFonts ?? [])]);
  const allowedInk = new Set([...original.text.flatMap(t => [t.color, ...(t.accentColor ? [t.accentColor] : [])]),
    original.background.color, ...original.shapes.map(s => s.color), ...(context.palette ?? [])].map(color));
  for (const v of p.text) {
    if (!originalByCopy.has(v.copyIndex) && (!allowedFonts.has(v.fontFamily) || !allowedInk.has(color(v.color)))) findings.push(`text ${v.copyIndex}: restored block outside trusted font/color policy`);
  }
  for (const t of original.text) {
    const v = byCopy.get(t.copyIndex); if (!v) continue;
    if (t.role !== v.role || t.fontFamily !== v.fontFamily || color(t.color) !== color(v.color) || t.align !== v.align
      || !!t.bold !== !!v.bold || !!t.italic !== !!v.italic || !!t.rtl !== !!v.rtl) findings.push(`text ${t.copyIndex}: protected style changed`);
  }
  if (p.shapes.length !== original.shapes.length) findings.push('shape identities changed or removed');
  original.shapes.forEach((s, i) => {
    const v = p.shapes[i]; if (v && (s.kind !== v.kind || s.role !== v.role || color(s.color) !== color(v.color))) findings.push(`shape ${i}: protected identity/style changed`);
  });
  if (findings.length) return { ok: false, rejection: { code: 'repair_changed_protected_input', findings: findings.slice(0, 8) } };
  const layout = structuredClone(original);
  layout.logo = { ...layout.logo, ...box(p.logo) };
  const order = context.copyIndices ? [...expected].sort((a, b) => a - b) : original.text.map(t => t.copyIndex);
  layout.text = order.map(id => {
    const v = byCopy.get(id)!;
    const t = originalByCopy.get(id);
    const restored: TextElement = { ...box(v), copyIndex: id, role: v.role, fontFamily: v.fontFamily, color: v.color,
      align: v.align, bold: v.bold, italic: v.italic, rtl: v.rtl, fontSize: v.fontSize, lineHeight: v.lineHeight };
    return { ...(t ?? restored), ...box(v), fontSize: v.fontSize, lineHeight: v.lineHeight,
      ...(v.letterSpacing !== undefined ? { letterSpacing: v.letterSpacing } : {}) };
  });
  layout.shapes = layout.shapes.map((s, i) => ({ ...s, ...box(p.shapes[i]) }));
  if (p.typeScale) layout.typeScale = { ...p.typeScale };
  return { ok: true, layout };
}
