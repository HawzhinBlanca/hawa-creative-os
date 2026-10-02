import type { FontWeight, TextElement } from './layout-v2.js';
import type { PageGrammar, PosterDisplayFace } from './page-grammar.js';
import { fontCoversText, loadRenderFontRegistry, type RenderLayoutOptions } from './render-layout-v2.js';
import { HOUSE_RULES } from './house-rules.js';

/**
 * ADR-275: how a poster's display title is set, read from the client's poster display policy
 * (`rules.pageGrammar.poster.display`; KAAE: Inter ExtraBold in capitals, Sorani in IBM Plex Sans
 * Arabic Bold). The composer spreads the result over the title element it builds, before it measures
 * the title, so the size search fits the capitals in the weighted face the renderer will draw.
 *
 * Shared code names no client: every face, weight and leading comes from the reference. A grammar
 * without a display policy gets undefined, and its posters keep the grammar's `title` face.
 */
export interface PosterDisplayStyle {
  fontFamily: string;
  fontWeight: FontWeight;
  /** Kept true for every heavier-than-regular face, so contrast and older readers see a bold title. */
  bold: boolean;
  lineHeight: number;
  letterSpacing: number;
  textTransform?: 'uppercase';
  rtl?: boolean;
}

export class PosterDisplayFaceError extends Error {
  readonly code = 'POSTER_DISPLAY_FACE_UNCOVERED';
  constructor(readonly fontFamily: string, readonly script: 'latin' | 'arabic', readonly missing: string[]) {
    super(`POSTER_DISPLAY_FACE_UNCOVERED: the poster display face '${fontFamily}' cannot draw ${missing.length} of the ${script} characters the client's copy uses (${missing.join(' ')}).`);
    this.name = 'PosterDisplayFaceError';
  }
}

const coverageMemo = new Map<string, string[]>();

/**
 * The characters a face must draw to set a script (render-fonts.json `scripts.<script>.requiredCharacters`,
 * derived from the client copy), checked on the file of the weight the policy names. Cairo-Regular
 * has no glyph for five Sorani letters, so a policy naming it for Sorani is refused here rather than
 * drawn half in another face.
 */
function missingCharacters(face: PosterDisplayFace, script: 'latin' | 'arabic', options: Pick<RenderLayoutOptions, 'fontsDir'>): string[] {
  const required = String(loadRenderFontRegistry().scripts?.[script]?.requiredCharacters ?? '');
  const key = JSON.stringify([face.fontFamily, face.fontWeight, script, required, options.fontsDir ?? '']);
  const memo = coverageMemo.get(key);
  if (memo) return memo;
  const result = fontCoversText(face.fontFamily, required, { fontWeight: face.fontWeight, ...(options.fontsDir ? { fontsDir: options.fontsDir } : {}) });
  const missing = result.covers ? [] : result.missing.length ? result.missing : ['(the face could not be opened)'];
  coverageMemo.set(key, missing);
  return missing;
}

/**
 * The display style for a poster title in `script`, or undefined when the grammar has no display
 * policy. Arabic script takes no case transform and no tracking, whatever the policy says. Throws
 * PosterDisplayFaceError when the named face cannot draw the script.
 */
export function posterDisplayStyle(
  grammar: Pick<PageGrammar, 'poster'>,
  script: 'latin' | 'arabic',
  options: Pick<RenderLayoutOptions, 'fontsDir'> = {}
): PosterDisplayStyle | undefined {
  const face = grammar.poster?.display?.[script];
  if (!face) return undefined;
  const missing = missingCharacters(face, script, options);
  if (missing.length) throw new PosterDisplayFaceError(face.fontFamily, script, missing);
  const range = HOUSE_RULES.displayLineHeight[script];
  const lineHeight = Math.min(range.max, Math.max(range.min, face.lineHeight));
  if (script === 'arabic') {
    return { fontFamily: face.fontFamily, fontWeight: face.fontWeight, bold: face.fontWeight >= 600, lineHeight, letterSpacing: 0, rtl: true };
  }
  const caps = HOUSE_RULES.capsTracking.displayEm;
  const tracking = face.letterSpacing ?? 0;
  return {
    fontFamily: face.fontFamily,
    fontWeight: face.fontWeight,
    bold: face.fontWeight >= 600,
    lineHeight,
    // Capitals at display size: solid to slightly tight (house-rules.ts capsTracking).
    letterSpacing: face.textTransform === 'uppercase' ? Math.min(caps.max, Math.max(caps.min, tracking)) : tracking,
    ...(face.textTransform === 'uppercase' ? { textTransform: 'uppercase' as const } : {}),
  };
}

/**
 * ADR-275: a small Latin capitals label (an eyebrow, a title tab) beside a display title: capitals,
 * opened up within the house's label range. Undefined without a display policy or a label tracking.
 */
export function posterLabelStyle(grammar: Pick<PageGrammar, 'poster'>): { textTransform: 'uppercase'; letterSpacing: number } | undefined {
  const tracking = grammar.poster?.display?.labelLetterSpacing;
  if (tracking === undefined) return undefined;
  const label = HOUSE_RULES.capsTracking.labelEm;
  return { textTransform: 'uppercase', letterSpacing: Math.min(label.max, Math.max(label.min, tracking)) };
}

/**
 * ADR-275: a title element with the display style applied. Only the type fields change; the box,
 * the size and the colour are the composer's.
 */
export function withPosterDisplayStyle<T extends TextElement>(element: T, style: PosterDisplayStyle | undefined): T {
  if (!style) return element;
  const out: T = { ...element, fontFamily: style.fontFamily, fontWeight: style.fontWeight, bold: style.bold,
    lineHeight: style.lineHeight, letterSpacing: style.letterSpacing };
  if (style.textTransform) out.textTransform = style.textTransform;
  else delete out.textTransform;
  if (style.rtl) out.rtl = true;
  return out;
}
