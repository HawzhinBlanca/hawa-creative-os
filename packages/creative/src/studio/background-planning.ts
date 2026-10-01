import type { BackgroundDecision, StudioLayoutV2 } from './layout-v2.js';
import { backgroundFieldSchema } from './background-field.js';
import { declaredColorContrastEvaluator, hexToLuminance } from './composite-contrast.js';
import { hexToRgb, rgbToLab, ciede2000 } from './color-science.js';
import { requiredContrast } from './house-rules.js';
import type { StyleSpec } from './style-spec.js';

export interface BackgroundPlanningInput {
  requestedColor?: string;
  style?: Pick<StyleSpec, 'texture' | 'titleColor'>;
  /** Bounded semantic proposal; requester and approved palette still govern it. */
  intent?: BackgroundDecision['intent'];
  mode?: 'auto' | 'solid' | 'gradient';
  colorIndex?: number | null;
  photos?: Array<{ photoIndex: number; shot?: string; quietLuminance?: number }>;
}
const canon = (c: string) => {
  const s = c.toUpperCase();
  if (/^#[0-9A-F]{3}$/.test(s)) return '#' + [...s.slice(1)].map(v => v + v).join('');
  if (!/^#[0-9A-F]{6}$/.test(s)) throw new Error('BACKGROUND: invalid palette color');
  return s;
};

/** Plan on the solved boxes, before acceptance. No provider, storage or invented scene pixels. */
export function applyContentBackground(layout: StudioLayoutV2, palette: string[], input: BackgroundPlanningInput): StudioLayoutV2 {
  if (!palette.length) throw new Error('BACKGROUND: no approved palette');
  if (palette.length > 32 || layout.text.length > 40 || layout.shapes.length > 40 || (layout.overlays?.length ?? 0) > 6) {
    throw new Error('BACKGROUND: local search bounds exceeded');
  }
  const allowed = [...new Set(palette.map(canon))];
  const old = canon(layout.background.color);
  const requested = input.requestedColor ? canon(input.requestedColor) : undefined;
  if (requested && !allowed.includes(requested)) throw new Error('BACKGROUND: requested color is outside the approved palette');
  const area = layout.width * layout.height;
  const textAreaShare = Math.min(1, layout.text.reduce((n, t) => n + t.width * t.height, 0) / area);
  const cutout = layout.photos?.some(p => p.treatment === 'cutout');
  const hero = input.photos?.find(p => p.photoIndex === layout.artDirection?.heroPhotoIndex);
  const dense = textAreaShare >= .32;
  // The factual photo remains the background; a product/speaker stage can use restrained depth.
  const intent = input.intent ?? layout.background.decision?.intent ?? (dense || layout.artDirection?.recipe === 'fade_to_paper' ? 'editorial' : cutout || hero?.shot === 'product' ? 'showcase' : 'documentary');
  const reference = input.style?.titleColor && input.style.titleColor !== 'as_generated' || input.style?.texture && input.style.texture !== 'as_generated';
  const basis: BackgroundDecision['basis'] = requested ? 'requester' : reference ? 'reference' : input.intent || input.mode && input.mode !== 'auto' || input.colorIndex != null ? 'concept' : 'content';
  const preferLight = input.style?.titleColor === 'dark' || input.style?.titleColor !== 'light' && intent === 'editorial';
  const proposed = Number.isInteger(input.colorIndex) && input.colorIndex! >= 0 && input.colorIndex! < palette.length ? canon(palette[input.colorIndex!]) : undefined;
  const surface = requested ?? proposed ?? (preferLight ? [...allowed].sort((a, b) => hexToLuminance(b) - hexToLuminance(a))[0] : old);
  const fullScene = !cutout && layout.photos?.some(p => p.x === 0 && p.y === 0 && p.width >= layout.width && p.height >= layout.height);
  const mode = input.mode ?? (layout.background.field ? 'gradient' : 'auto');
  const wantsGradient = input.style?.texture !== 'none' && !dense && (mode === 'gradient' || input.style?.texture === 'gradient-wash' || mode !== 'solid' && intent === 'showcase');
  const neighbors = (() => {
    if (!wantsGradient || fullScene) return [];
    const lab = rgbToLab(hexToRgb(surface));
    // Keep the field restrained; every stop is approved. No extra color or recoloring of photos.
    return allowed.filter(c => c !== surface).map(color => ({ color, distance: ciede2000(lab, rgbToLab(hexToRgb(color))) }))
      .filter(n => n.distance <= 25).sort((a, b) => a.distance - b.distance).map(n => n.color);
  })();
  // Copy carriers matching the old ground belong to the background decision. A contrasting card,
  // logo carrier, accent or CTA keeps its distinct role. Never recolor an original photograph.
  const planned: StudioLayoutV2 = { ...layout,
    shapes: layout.shapes.map(shape => shape.role === 'panel' && shape.surface !== 'tab' && shape.surface !== 'pill' &&
      shape.fill !== 'none' && canon(shape.color) === old ? { ...shape, color: surface } : shape),
    ...(layout.overlays ? { overlays: layout.overlays.map(overlay =>
      canon(overlay.color) === old ? { ...overlay, color: surface } : overlay) } : {}),
  };
  let failedBlock: number | undefined;
  // ADR206: contrast is a joint decision. Do not mutate even an early passing block before
  // every block admits the same field. Reuse one enclosure per block and trial for all inks.
  for (const second of neighbors.length ? neighbors : [undefined]) {
    const field = second ? backgroundFieldSchema.parse({ kind: 'linear',
      direction: layout.width > layout.height ? 'to-right' : 'to-bottom',
      stops: [{ at: 0, color: surface }, ...(requested ? [{ at: .8, color: surface }] : []), { at: 1, color: second }] }) : undefined;
    planned.background = { color: surface, ...(field ? { field } : {}), decision: {
      policy: 'content-background-v1', basis, intent, mode: field ? 'gradient' : fullScene ? 'scene' : 'solid',
      textAreaShare: Math.round(textAreaShare * 1000) / 1000,
    } };
    const edits: Array<{ color: string; removeAccent: boolean }> = [];
    for (const text of layout.text) {
      const threshold = requiredContrast(text.fontSize, !!text.bold);
      const on = declaredColorContrastEvaluator(planned, text);
      let color = text.color;
      if (!(on(color) >= threshold)) {
        let best = -Infinity;
        for (const ink of allowed) {
          const contrast = on(ink);
          if (contrast > best) { best = contrast; color = ink; }
        }
        if (!(best >= threshold)) { failedBlock ??= text.copyIndex; break; }
      }
      edits.push({ color, removeAccent: !!text.accentColor && !(on(text.accentColor) >= threshold) });
    }
    if (edits.length !== layout.text.length) continue;
    // All computations and possible refusals precede this commit. Keep existing node identities.
    layout.background = planned.background;
    layout.shapes.forEach((shape, i) => { shape.color = planned.shapes[i].color; });
    layout.overlays?.forEach((overlay, i) => { overlay.color = planned.overlays![i].color; });
    layout.text.forEach((text, i) => {
      text.color = edits[i].color;
      if (edits[i].removeAccent) { delete text.accentColor; delete text.accentText; delete text.accentParagraph; }
    });
    if (input.style?.texture === 'none' && layout.art?.source === 'procedural') delete layout.art;
    return layout;
  }
  // Do not flatten an infeasible field, invent a color or add another plaque to mask the failure.
  throw new Error(`BACKGROUND: no approved readable ink for block ${failedBlock}`);
}
