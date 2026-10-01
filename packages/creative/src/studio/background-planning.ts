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
  const field = (() => {
    if (!wantsGradient || fullScene) return undefined;
    const lab = rgbToLab(hexToRgb(surface));
    // Keep the field restrained; every stop is approved. No extra color or recoloring of photos.
    const neighbors = allowed.filter(c => c !== surface && ciede2000(lab, rgbToLab(hexToRgb(c))) <= 25)
      .sort((a, b) => ciede2000(lab, rgbToLab(hexToRgb(a))) - ciede2000(lab, rgbToLab(hexToRgb(b))));
    const second = neighbors[0];
    if (!second) return undefined;
    return backgroundFieldSchema.parse({ kind: 'linear', direction: layout.width > layout.height ? 'to-right' : 'to-bottom',
      stops: [{ at: 0, color: surface }, ...(requested ? [{ at: .8, color: surface }] : []), { at: 1, color: second }] });
  })();
  layout.background = { color: surface, ...(field ? { field } : {}), decision: {
    policy: 'content-background-v1', basis, intent, mode: field ? 'gradient' : fullScene ? 'scene' : 'solid',
    textAreaShare: Math.round(textAreaShare * 1000) / 1000,
  } };
  // Copy carriers matching the old ground belong to the background decision. A contrasting card,
  // logo carrier, accent or CTA keeps its distinct role. Never recolor an original photograph.
  for (const shape of layout.shapes) {
    if (shape.role === 'panel' && shape.surface !== 'tab' && shape.surface !== 'pill' && shape.fill !== 'none' && canon(shape.color) === old) shape.color = surface;
  }
  for (const overlay of layout.overlays ?? []) if (canon(overlay.color) === old) overlay.color = surface;
  if (input.style?.texture === 'none' && layout.art?.source === 'procedural') delete layout.art;
  // Preserve role colors where readable; repair against the actual chosen surface/envelope.
  for (const text of layout.text) {
    const threshold = requiredContrast(text.fontSize, !!text.bold);
    const on = declaredColorContrastEvaluator(layout, text);
    if (on(text.color) < threshold) {
      const candidate = [...allowed].sort((a, b) => on(b) - on(a))[0];
      if (on(candidate) < threshold) throw new Error(`BACKGROUND: no approved readable ink for block ${text.copyIndex}`);
      text.color = candidate;
    }
    if (text.accentColor && on(text.accentColor) < threshold) {
      delete text.accentColor; delete text.accentText; delete text.accentParagraph;
    }
  }
  // A gradient can consume the palette's usable contrast; refuse instead of adding another plaque.
  return layout;
}
