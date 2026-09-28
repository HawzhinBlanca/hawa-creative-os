import type { StudioLayoutV2, TextElement } from './layout-v2.js';
import { measureTextGeometry, type RenderLayoutOptions } from './render-layout-v2.js';
import { admittedFamiliesForQa } from './validate-layout-v2.js';
import { COPY_WIDTH_TOLERANCE_PX, HOUSE_RULES, getSafeZoneBox } from './house-rules.js';
import { copyScriptV3, type PipelineV3Copy } from './pipeline-v3.js';

/**
 * A free, deterministic screen for approved copy that no layout can set (ADR-125).
 *
 * Hard QA rejects a block whose widest measured line exceeds its box by more than the width
 * tolerance, and every text box must sit inside the safe area. Lines break only between words.
 * So a block containing a run that is wider than the whole safe width, at the smallest size QA
 * admits, in every face QA admits for its script, at the tightest tracking QA admits, fails QA in
 * every layout. Such a block is reported; the copy is never shrunk, broken, shortened or reworded
 * to make it pass. When any admitted face cannot be measured the result is 'unknown', never a
 * conflict. Aggregate area capacity is not screened here.
 */
export const COPY_FEASIBILITY_VERSION = 'copy-feasibility.v1';

export interface CopyFeasibilityBlock {
  copyIndex: number;
  status: 'fits' | 'exceeds_safe_width' | 'unknown';
  /** Widest line of the narrowest measured face variant, in px, at the minimum size. */
  narrowestPx?: number;
  family?: string;
  measuredFaces: number;
  /** `family[:italic]:reason` for each face variant that could not be measured. */
  unmeasured: string[];
}

export interface CopyFeasibilityScreen {
  version: typeof COPY_FEASIBILITY_VERSION;
  safeWidthPx: number;
  minimumFontPx: number;
  tolerancePx: number;
  blocks: CopyFeasibilityBlock[];
}

export function screenCopyFeasibility(input: {
  width: number;
  height: number;
  copy: PipelineV3Copy;
  latinFont?: string;
  arabicFont?: string;
  admittedDisplayFonts?: { latin: string[]; arabic: string[] };
  fontsDir?: RenderLayoutOptions['fontsDir'];
}): CopyFeasibilityScreen {
  const safeWidthPx = getSafeZoneBox(input.width, input.height).width;
  const minimumFontPx = HOUSE_RULES.minFontPx;
  const families = admittedFamiliesForQa({ latinFont: input.latinFont, arabicFont: input.arabicFont, draftFont: input.latinFont,
    admittedDisplayFonts: input.admittedDisplayFonts });
  const indexes = Object.keys(input.copy.text).map(Number).filter(Number.isInteger).sort((a, b) => a - b);

  const blocks = indexes.map((copyIndex): CopyFeasibilityBlock => {
    const arabic = copyScriptV3(input.copy, copyIndex) === 'arabic';
    // Latin display tracking may be negative down to the house limit; Arabic script takes none.
    const variants = (arabic ? families.arabic : families.latin).flatMap((family) =>
      (arabic ? [false] : [false, true]).map((italic) => ({ family, italic })));
    const text: TextElement[] = variants.map((v, i) => ({
      copyIndex, role: 'title', x: 0, y: i, width: safeWidthPx, height: 1_000_000, fontSize: minimumFontPx,
      lineHeight: arabic ? HOUSE_RULES.lineHeight.arabic.min : HOUSE_RULES.lineHeight.latin.min,
      letterSpacing: arabic ? 0 : -HOUSE_RULES.letterSpacingMaxEm, fontFamily: v.family, color: '#000000',
      align: arabic ? 'right' : 'left', rtl: arabic, italic: v.italic, bold: false,
    }));
    const layout = { version: 2, width: input.width, height: input.height, text } as unknown as StudioLayoutV2;
    const measurements = measureTextGeometry(layout, { [copyIndex]: input.copy.text[copyIndex] }, input.fontsDir ? { fontsDir: input.fontsDir } : {});
    const unmeasured: string[] = [];
    let narrowest: { px: number; family: string } | undefined;
    measurements.forEach((m, i) => {
      const v = variants[i];
      if (m.status !== 'measured') { unmeasured.push(`${v.family}${v.italic ? ':italic' : ''}:${m.reason}`); return; }
      if (!narrowest || m.maxLineWidthPx < narrowest.px) narrowest = { px: m.maxLineWidthPx, family: v.family };
    });
    const measuredFaces = variants.length - unmeasured.length;
    const base = { copyIndex, measuredFaces, unmeasured, ...(narrowest ? { narrowestPx: narrowest.px, family: narrowest.family } : {}) };
    if (narrowest && narrowest.px <= safeWidthPx + COPY_WIDTH_TOLERANCE_PX) return { ...base, status: 'fits' };
    if (narrowest && unmeasured.length === 0) return { ...base, status: 'exceeds_safe_width' };
    return { ...base, status: 'unknown' };
  });

  return { version: COPY_FEASIBILITY_VERSION, safeWidthPx, minimumFontPx, tolerancePx: COPY_WIDTH_TOLERANCE_PX, blocks };
}
