import type { StudioLayoutV2, TextElement, ShapeElement } from './layout-v2.js';
import { measureWrappedLines } from './render-layout-v2.js';
import { calculateLuminanceContrastRatio, declaredBackgroundColour, hexToLuminance } from './composite-contrast.js';
import { logoClearZone, requiredContrast } from './house-rules.js';
import type { OrnamentSettings } from './pipeline-v3.js';

/**
 * The visual decisions a client's reference image and instructions make, as values code can
 * enforce. A style reference used to reach the models only as prose ("prominent light title,
 * restrained gold"), and nothing checked the result against it: for task 89c242f2 (2026-09-19) the
 * reference had a heavy sans title filling the width, a gold last line, a gold button and the logo
 * bottom-right, and the delivered design had a small serif title, a navy box and the logo top-centre.
 *
 * The brief reads these from the image and the client's words (the words win); preparation applies
 * them to every candidate. 'as_generated' leaves the generator's choice.
 */
export interface StyleSpec {
  /** 'dominant': the title spans the text column at display size; 'large': a step below. */
  titleScale: 'as_generated' | 'large' | 'dominant';
  titleWeight: 'as_generated' | 'regular' | 'heavy';
  typeface: 'as_generated' | 'serif' | 'sans';
  /** Reading-direction relative: 'start' is left for English and right for Kurdish. */
  alignment: 'as_generated' | 'start' | 'center' | 'end';
  /**
   * The colour of the title as a whole: 'light' for a white or cream title, 'gold', 'dark'. Read
   * off the reference image, because the title's colour is a decision of the design and not a
   * standing rule. See `applyStyleSpec` for the incident behind it.
   */
  titleColor: 'as_generated' | 'light' | 'gold' | 'dark';
  /** The title's last line (after its last line break) set in the brand gold. */
  accentLastTitleLine: boolean;
  cta: 'as_generated' | 'plain' | 'gold_button';
  logoCorner: 'as_generated' | 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
  texture: 'as_generated' | 'none' | 'diagonal-lines' | 'sun-rays' | 'guilloche' | 'thin-rules' | 'gradient-wash';
  dividers: 'as_generated' | 'yes' | 'no';
  /** 'none': no boxes or cards behind the copy (a button behind the call to action excepted). */
  panels: 'as_generated' | 'none';
  /** 'spread': title high, call to action on the bottom margin, the rest between; 'centered': one centred stack. */
  composition: 'as_generated' | 'centered' | 'spread';
}

export const NEUTRAL_STYLE_SPEC: StyleSpec = {
  titleScale: 'as_generated',
  titleWeight: 'as_generated',
  typeface: 'as_generated',
  alignment: 'as_generated',
  titleColor: 'as_generated',
  accentLastTitleLine: false,
  cta: 'as_generated',
  logoCorner: 'as_generated',
  texture: 'as_generated',
  dividers: 'as_generated',
  panels: 'as_generated',
  composition: 'as_generated',
};

/** JSON schema for the brief's structured output. */
export const STYLE_SPEC_SCHEMA = {
  type: 'object',
  description:
    "Concrete visual decisions to enforce. Read each value off the attached style reference; a value comes from the client's instructions only where they name it explicitly (a font, a gold button, where the logo goes), and then the instructions win. General words such as 'clean' or 'minimal' decide nothing here. Use 'as_generated' (or false) for anything neither shows or asks for.",
  properties: {
    titleScale: {
      type: 'string',
      enum: ['as_generated', 'large', 'dominant'],
      description: "'dominant' when the title spans most of the width at poster size; 'large' when big but clearly smaller.",
    },
    titleWeight: { type: 'string', enum: ['as_generated', 'regular', 'heavy'] },
    typeface: {
      type: 'string',
      enum: ['as_generated', 'serif', 'sans'],
      description: "The reference's type style, or the client's font request ('only Verdana' is sans).",
    },
    alignment: {
      type: 'string',
      enum: ['as_generated', 'start', 'center', 'end'],
      description:
        "Read it off the reference's lines of text: a ragged right edge with every line starting at the left margin is 'start' (mirrored for Kurdish); lines centred on the canvas are 'center'. Take it from the instructions only when they name an alignment.",
    },
    titleColor: {
      type: 'string',
      enum: ['as_generated', 'light', 'gold', 'dark'],
      description:
        "The colour of the title as a whole in the reference: 'light' for a white or cream title, 'gold' when the whole title is gold, 'dark' for a dark title on a light ground. A gold line inside an otherwise light title is 'light' plus accentLastTitleLine, not 'gold'.",
    },
    accentLastTitleLine: {
      type: 'boolean',
      description: 'True when the last line of the title is set in gold (for example an edition line).',
    },
    cta: {
      type: 'string',
      enum: ['as_generated', 'plain', 'gold_button'],
      description: "'gold_button' when the call to action sits on a gold filled box, or the client asks for one.",
    },
    logoCorner: {
      type: 'string',
      enum: ['as_generated', 'top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'],
    },
    texture: {
      type: 'string',
      enum: ['as_generated', 'none', 'diagonal-lines', 'sun-rays', 'guilloche', 'thin-rules', 'gradient-wash'],
      description: "The background texture: fine diagonal lines, rays, guilloche, thin rules, a gradient, or 'none' for a flat field.",
    },
    dividers: {
      type: 'string',
      enum: ['as_generated', 'yes', 'no'],
      description: "Whether gold divider rules separate the blocks; 'no' when the reference has none.",
    },
    panels: {
      type: 'string',
      enum: ['as_generated', 'none'],
      description: "'none' when the reference sets its copy straight on the background, with no cards or boxes behind it.",
    },
    composition: {
      type: 'string',
      enum: ['as_generated', 'centered', 'spread'],
      description: "'spread' when the title sits high, the call to action on the bottom margin and the rest between; 'centered' for one centred stack.",
    },
  },
  required: ['titleScale', 'titleWeight', 'typeface', 'alignment', 'titleColor', 'accentLastTitleLine', 'cta', 'logoCorner', 'texture', 'dividers', 'panels', 'composition'],
  additionalProperties: false,
} as const;

type Rect = { x: number; y: number; width: number; height: number };
const intersects = (a: Rect, b: Rect) =>
  !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);

const ARABIC = /[؀-ۿݐ-ݿ]/;
const nearest = (want: string, palette: string[]) => {
  const rgb = (h: string) => {
    const c = h.replace('#', '');
    const f = c.length === 3 ? c.split('').map((x) => x + x).join('') : c;
    return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
  };
  const [r, g, b] = rgb(want);
  return [...palette].sort((p, q) => {
    const d = (h: string) => {
      const [x, y, z] = rgb(h);
      return (x - r) ** 2 + (y - g) ** 2 + (z - b) ** 2;
    };
    return d(p) - d(q);
  })[0] || want;
};

/** The ornament the spec implies: its texture and dividers override the owner's defaults. */
export function ornamentForStyle(ornament: OrnamentSettings | undefined, spec: StyleSpec | undefined): OrnamentSettings | undefined {
  if (!ornament || !spec) return ornament;
  return {
    ...ornament,
    ...(spec.texture !== 'as_generated' ? { texture: spec.texture } : {}),
    ...(spec.dividers !== 'as_generated' ? { dividers: spec.dividers === 'yes' } : {}),
  };
}

/**
 * Applies a style spec to a normalised layout, before house-rule conformance settles collisions
 * and sizes boxes. Mutates and returns the layout.
 */
export function applyStyleSpec(
  layout: StudioLayoutV2,
  copy: { text: Record<number, string> },
  spec: StyleSpec,
  palette: string[]
): StudioLayoutV2 {
  const W = layout.width;
  const H = layout.height;
  const m = layout.grid.margin;
  const rtl = (t: TextElement) => t.rtl === true || ARABIC.test(copy.text[t.copyIndex] || '');
  const title = layout.text.find((t) => t.role === 'title');
  const cta = layout.text.find((t) => t.role === 'cta');
  const gold = palette.length ? nearest('#F7B500', palette) : '#F7B500';
  const ctaBefore = cta ? { x: cta.x, y: cta.y, width: cta.width, height: cta.height } : undefined;
  const fullBleed = (s: ShapeElement) => s.width >= 0.98 * W && s.height >= 0.98 * H;
  // What the reference does not have goes: dividers and accent strokes, cards behind the copy.
  if (spec.dividers === 'no') layout.shapes = (layout.shapes || []).filter((s) => s.role !== 'rule' && s.role !== 'accent');
  if (spec.panels === 'none') layout.shapes = (layout.shapes || []).filter((s) => fullBleed(s) || (s.role !== 'panel' && s.role !== 'frame'));
  const darkest = palette.length
    ? [...palette].sort((a, b) => hexToLuminance(a) - hexToLuminance(b))[0]
    : '#0A1628';

  // Typeface: the admitted sans for each script (Verdana has no Kurdish letters; Noto Sans Arabic
  // is the brand's Kurdish sans), or the serif display faces.
  if (spec.typeface === 'sans') {
    for (const t of layout.text) t.fontFamily = rtl(t) ? 'Noto Sans Arabic' : 'Verdana';
  } else if (spec.typeface === 'serif' && title) {
    title.fontFamily = rtl(title) ? 'Amiri' : 'Playfair Display';
  }
  if (title && spec.titleWeight !== 'as_generated') title.bold = spec.titleWeight === 'heavy';

  // Alignment: each block reads from the same column edge. Its own measure is kept, because
  // stretching every box to the full column made all three candidates of a request identical
  // (pairwise distance 0px on task 89c242f2) and pushed 52 of the 200 stored designs into QA
  // failure: a widened box reaches the logo and whatever else shares its band.
  const alignFor = (t: TextElement): TextElement['align'] =>
    spec.alignment === 'center' ? 'center' : (spec.alignment === 'start') !== rtl(t) ? 'left' : 'right';
  if (spec.alignment !== 'as_generated') {
    // Each measure is snapped to the design's own columns, so blocks that keep different widths
    // still share edges. Without it, ragged edges cost the alignment gate: a Kurdish candidate came
    // out at 0.60 against the 0.70 QA needs, while its type and composition were what the client
    // asked for.
    const columns = Math.max(1, Math.round(layout.grid?.columns || 12));
    const columnWidth = (W - 2 * m) / columns;
    for (const t of layout.text) {
      t.align = alignFor(t);
      if (t === cta && spec.cta === 'gold_button') continue;
      const snapped = Math.round(Math.min(t.width, W - 2 * m) / columnWidth) * columnWidth;
      const width = Math.round(Math.min(W - 2 * m, Math.max(columnWidth, snapped)));
      t.width = width;
      t.x = t.align === 'left' ? m : t.align === 'right' ? W - m - width : Math.round((W - width) / 2);
    }
  }

  // Title at display size: the largest size, up to the cap, whose lines stay within one more
  // than the lines the client broke it into. Never smaller than the generator made it.
  if (title && spec.titleScale !== 'as_generated') {
    if (spec.alignment === 'as_generated' && title.width < 0.5 * (W - 2 * m)) {
      // A title set in a narrow column cannot carry display type; give it the column, but only
      // when the spec says nothing about alignment (which sets the measure itself).
      title.x = m;
      title.width = W - 2 * m;
    }
    const cap = Math.round((spec.titleScale === 'dominant' ? 0.095 : 0.072) * W);
    const paragraphs = (copy.text[title.copyIndex] || '').split('\n').filter((p) => p.trim()).length || 1;
    const maxLines = Math.min(4, paragraphs + 1);
    const probe = { ...layout, text: [title] } as StudioLayoutV2;
    for (let size = cap; size > title.fontSize; size -= 2) {
      const lines = measureWrappedLines({ ...probe, text: [{ ...title, fontSize: size }] }, copy.text)[title.copyIndex];
      if (lines !== undefined && lines <= maxLines) {
        title.fontSize = size;
        title.height = Math.ceil(lines * size * title.lineHeight);
        break;
      }
    }
  }

  // Supporting copy in proportion to a display title (the reference sets its body near 4% of the
  // width), within the house ladder: the title stays at least 2.2x the body.
  if (title && spec.titleScale === 'dominant') {
    const bodyMax = Math.floor(title.fontSize / 2.2);
    for (const t of layout.text) {
      if (t === title) continue;
      const want = Math.round((t.role === 'cta' ? 0.03 : t.role === 'body' ? 0.034 : 0.03) * W);
      if (t.fontSize < want) t.fontSize = Math.min(want, t.role === 'body' || t.role === 'footer' ? bodyMax : want);
      const lines = measureWrappedLines({ ...layout, text: [t] } as StudioLayoutV2, copy.text)[t.copyIndex] ?? 1;
      t.height = Math.max(t.height, Math.ceil(lines * t.fontSize * t.lineHeight));
    }
  }

  // The title's colour is a decision of the design, not a standing rule. The client's brand DNA
  // read "Title and dates must be Kurdistan Sun Gold (#F7B500)"; those rules only began reaching the
  // brief on 2026-09-20 (the asset path fix, 125ea66), and the two designs delivered that morning
  // (Canva DAHVuK0Oclo and DAHVuLZG8gM) came back with the entire title gold, while the owner's own
  // reference image shows a white title with only its last line ("EDITION 2.0") in gold. The
  // reference has to beat the rule, so the colour is read off the image and enforced here.
  //
  // Placed after titleScale and titleWeight, because the contrast a block needs depends on the size
  // and weight it ends up with.
  // The key is read defensively because specs stored before it existed (the gate's reference
  // fixtures, replayed runs) carry no titleColor at all, and those must behave as 'as_generated'.
  if (title && spec.titleColor && spec.titleColor !== 'as_generated') {
    const light = palette.length ? nearest('#FFFFFF', palette) : '#FFFFFF';
    const want = spec.titleColor === 'gold' ? gold : spec.titleColor === 'dark' ? darkest : light;
    // Never below the contrast the house rules ask against the surface the layout declares behind
    // the title: 'dark' over the navy background this client asks for is 1.0:1. A choice that
    // cannot be read is left as the generator drew it, and conformToHouseRules then repairs it from
    // the palette, which is the same path an unreadable generated colour already takes.
    const surface = declaredBackgroundColour(layout, title);
    const ratio = calculateLuminanceContrastRatio(hexToLuminance(want), hexToLuminance(surface));
    if (ratio >= requiredContrast(title.fontSize, Boolean(title.bold))) title.color = want;
  }

  // The gold accent line sits on top of that colour, which is the owner's own treatment: a light
  // title whose edition line alone is gold. The renderer and the deck draw the last paragraph in
  // accentColor and the rest in title.color, so the two decisions compose.
  if (title && spec.accentLastTitleLine && (copy.text[title.copyIndex] || '').trim().includes('\n')) {
    title.accentColor = gold;
  }

  // Call to action on a gold button: the text sized to its line, the button its padding around it,
  // on the column edge; any panel the generator set behind it goes.
  if (cta && spec.cta === 'gold_button') {
    cta.bold = true;
    cta.color = darkest;
    const lineWidth = (() => {
      const one = (w: number) =>
        (measureWrappedLines({ ...layout, text: [{ ...cta, width: w }] } as StudioLayoutV2, copy.text)[cta.copyIndex] ?? 1) <= 1;
      let lo = 20;
      let hi = W - 2 * m;
      if (!one(hi)) return hi;
      while (hi - lo > 2) {
        const mid = Math.floor((lo + hi) / 2);
        if (one(mid)) hi = mid;
        else lo = mid;
      }
      return hi + 2;
    })();
    const padX = Math.round(0.9 * cta.fontSize);
    const padY = Math.round(0.45 * cta.fontSize);
    let align = spec.alignment === 'as_generated' ? cta.align : alignFor(cta);
    cta.align = 'center';
    cta.width = Math.min(W - 2 * m - 2 * padX, lineWidth);
    cta.height = Math.ceil(cta.fontSize * cta.lineHeight);
    const buttonWidth = cta.width + 2 * padX;
    // The button keeps away from the logo's corner. In the owner's reference the button sits
    // bottom-left with the logo bottom-right; mirrored for Kurdish, both wanted the same corner, and
    // the design had to give up either its display title or the logo's place to fit them.
    const logoBottom = layout.logo && spec.logoCorner.startsWith('bottom') ? spec.logoCorner.split('-')[1] : undefined;
    if (logoBottom === 'right' && align === 'right') align = 'left';
    else if (logoBottom === 'left' && align === 'left') align = 'right';
    const bx = align === 'left' ? m : align === 'right' ? W - m - buttonWidth : Math.round((W - buttonWidth) / 2);
    cta.x = bx + padX;
    const button: ShapeElement = {
      kind: 'roundRect',
      role: 'panel',
      x: bx,
      y: cta.y - padY,
      width: buttonWidth,
      height: cta.height + 2 * padY,
      color: gold,
      radius: Math.round(Math.min(18, 0.28 * (cta.height + 2 * padY))),
    };
    const small = (s: ShapeElement) => s.width * s.height < 0.25 * W * H;
    layout.shapes = (layout.shapes || []).filter(
      (s) => !(s.role === 'panel' && small(s) && (intersects(s, cta) || (ctaBefore && intersects(s, ctaBefore))))
    );
    layout.shapes.push(button);
    // Contrast is checked on the button; navy on gold passes by a wide margin, but say so if not.
    const on = calculateLuminanceContrastRatio(hexToLuminance(cta.color), hexToLuminance(gold));
    if (on < 4.5) cta.color = hexToLuminance(gold) > 0.4 ? '#0A1628' : '#FFFFFF';
  }

  // Logo in the corner the client or the reference puts it.
  if (layout.logo && spec.logoCorner !== 'as_generated') {
    const l = layout.logo;
    const [v, h] = spec.logoCorner.split('-');
    const x = h === 'left' ? m : h === 'right' ? W - m - l.width : Math.round((W - l.width) / 2);
    const y = v === 'top' ? m : H - m - l.height;
    layout.logo = { ...l, x, y };
  }
  return layout;
}

/**
 * The reference's composition, applied last (after settling and balance): a one-column design
 * with the title high, the call to action (with its button) on the bottom margin — above the
 * logo's clear space when the two share a corner — and the blocks between them set a little above
 * the middle of the space left. Returns the layout unchanged when it is not one column or when the
 * arrangement does not fit.
 */
export function composeStyleSpec(layout: StudioLayoutV2, spec: StyleSpec, logoClear: (l: Rect) => Rect): StudioLayoutV2 {
  if (spec.composition !== 'spread') return layout;
  const W = layout.width;
  const H = layout.height;
  const m = layout.grid.margin;
  const texts = [...layout.text].sort((a, b) => a.y - b.y);
  if (texts.length < 2) return layout;
  for (let i = 1; i < texts.length; i++) if (texts[i].y < texts[i - 1].y + texts[i - 1].height) return layout;
  const fullBleed = (s: Rect) => s.width >= 0.98 * W && s.height >= 0.98 * H;
  const shapes = (layout.shapes || []).filter((s) => !fullBleed(s));
  const holds = (s: Rect, t: Rect) => t.x >= s.x - 1 && t.x + t.width <= s.x + s.width + 1 && t.y >= s.y - 1 && t.y + t.height <= s.y + s.height + 1;
  // Each block moves with the shapes that hold it; a shape holding nothing (a divider) is dropped
  // from the arithmetic and re-centred in its gap afterwards by the caller's rules.
  const groups = texts.map((t) => {
    const own = shapes.filter((s) => holds(s, t));
    const top = Math.min(t.y, ...own.map((s) => s.y));
    const bottom = Math.max(t.y + t.height, ...own.map((s) => s.y + s.height));
    return { t, own, top, bottom };
  });
  const first = groups[0];
  const last = groups[groups.length - 1];
  const snapshot = JSON.stringify(layout);
  const move = (g: (typeof groups)[number], dy: number) => {
    g.t.y += dy;
    for (const s of g.own) s.y += dy;
    g.top += dy;
    g.bottom += dy;
  };

  let floor = H - m;
  if (layout.logo) {
    const zone = logoClear(layout.logo);
    const lastBox = { x: Math.min(last.t.x, ...last.own.map((s) => s.x)), y: 0, width: 0, height: H };
    lastBox.width = Math.max(last.t.x + last.t.width, ...last.own.map((s) => s.x + s.width)) - lastBox.x;
    if (intersects(lastBox, zone) && zone.y < floor) floor = Math.floor(zone.y);
  }
  move(first, Math.round(m + 0.07 * H) - first.top);
  move(last, floor - last.bottom);
  const middle = groups.slice(1, -1);
  if (middle.length) {
    const gaps = middle.slice(1).map((g, i) => Math.max(0, g.top - middle[i].bottom));
    const height = middle.reduce((sum, g) => sum + (g.bottom - g.top), 0) + gaps.reduce((a, b) => a + b, 0);
    const free = last.top - first.bottom - height;
    if (free < 48) {
      Object.assign(layout, JSON.parse(snapshot));
      return layout;
    }
    let y = first.bottom + Math.round(0.42 * free);
    middle.forEach((g, i) => {
      if (i > 0) y += gaps[i - 1];
      move(g, y - g.top);
      y = g.bottom;
    });
  } else if (last.top - first.bottom < 48) {
    Object.assign(layout, JSON.parse(snapshot));
    return layout;
  }
  if (layout.art?.calmRegion) {
    const y0 = Math.min(...layout.text.map((t) => t.y));
    const y1 = Math.max(...layout.text.map((t) => t.y + t.height));
    layout.art.calmRegion = { ...layout.art.calmRegion, y: y0, height: y1 - y0 };
  }
  return layout;
}

/**
 * What a prepared layout gets wrong, by the measures preparation can take on its own: blocks that
 * overlap, copy that reads out of order down the page, a box whose copy no longer fits, text outside
 * the safe area, and the logo's clear space breached. These mirror the hard-QA codes OVERLAP,
 * COPY_ORDER, COPY_OVERFLOW, MARGIN and LOGO closely enough to choose between two arrangements of
 * the same design without the QA context (fonts and palette rules) that only the caller holds.
 */
export function layoutDefectCount(layout: StudioLayoutV2, copy: { text: Record<number, string> }): number {
  const W = layout.width;
  const H = layout.height;
  const m = layout.grid?.margin ?? 0;
  const texts = layout.text || [];
  let defects = 0;
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) if (intersects(texts[i], texts[j])) defects++;
  }
  const ordered = [...texts].sort((a, b) => a.y - b.y || a.x - b.x).map((t) => t.copyIndex);
  for (let i = 1; i < ordered.length; i++) if (ordered[i] < ordered[i - 1]) defects++;
  const lines = measureWrappedLines(layout, copy.text);
  for (const t of texts) {
    if (Math.ceil((lines[t.copyIndex] ?? 1) * t.fontSize * t.lineHeight) > t.height + 1) defects++;
    if (t.x < m - 1 || t.y < m - 1 || t.x + t.width > W - m + 1 || t.y + t.height > H - m + 1) defects++;
  }
  if (layout.logo) {
    const zone = logoClearZone(layout.logo);
    for (const t of texts) if (intersects(t, zone)) defects++;
    for (const sh of layout.shapes || []) if (sh.role === 'rule' && intersects(sh, zone)) defects++;
  }
  return defects;
}

/**
 * The decisions that move or resize something, and so can put two parts of a design into each
 * other. Ordered by what costs the client's look least when it has to go: where the logo sits, then
 * the title's size, then the arrangement down the page, then the button's treatment, then whether
 * cards are stripped, then the alignment everything reads from.
 */
export const MOVEMENT_DECISIONS = ['logoCorner', 'titleScale', 'composition', 'cta', 'panels', 'alignment'] as const;

/** The same spec with one decision left to the generator. */
export function withoutDecision(spec: StyleSpec, key: (typeof MOVEMENT_DECISIONS)[number]): StyleSpec {
  return { ...spec, [key]: 'as_generated' };
}

/**
 * The spec's colour decisions alone. `titleColor` and `accentLastTitleLine` only recolour text:
 * they move and resize nothing, so they cannot add one of the defects the relaxation ladder counts
 * (overlaps, reading order, copy that no longer fits, the safe area, the logo's clear space), which
 * is why they are not in MOVEMENT_DECISIONS. Giving them up would buy the ladder nothing. It would
 * also cost something: a design cramped enough to lose every movement decision would then deliver
 * the gold title the client's old rule produced, which is what the owner corrected on 2026-09-20.
 * So they are kept even on the arrangement the generator drew.
 */
export function colourDecisionsOnly(spec: StyleSpec): StyleSpec {
  return { ...NEUTRAL_STYLE_SPEC, titleColor: spec.titleColor, accentLastTitleLine: spec.accentLastTitleLine };
}
