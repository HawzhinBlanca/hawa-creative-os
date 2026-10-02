import { readFileSync } from 'node:fs';
import { computeNegativeSpace, evaluateDesignMetrics } from '../../../src/studio/design-metrics.js';
import { computeLayoutMetrics } from '../../../src/studio/layout-metrics.js';
import { evaluateHardQa, studioReferenceFromRaw, type HardQaContext } from '../../../src/studio/hard-qa.js';
import { validateLayoutV2, type LayoutValidationContext } from '../../../src/studio/validate-layout-v2.js';
import { measureWrappedLines } from '../../../src/studio/render-layout-v2.js';
import type { StudioLayoutV2 } from '../../../src/studio/layout-v2.js';
import type { OfficePostFixture } from './office-posts.js';

/**
 * ADR-273: every gate a design passes on its way to the office, applied to one annotated office
 * post, through the exact functions production calls. No render is made: hard QA's one
 * render-dependent check (the contrast of text over a photo, measured on the rendered pixels) is
 * reported apart as `needsRender`, because without the render it fails by design.
 */

const RAW = JSON.parse(readFileSync(new URL('../../../assets/kaae-reference.json', import.meta.url), 'utf8'));
export const KAAE_PALETTE = studioReferenceFromRaw(RAW).palette;
export const KAAE_FONTS = { latin: ['Crimson Pro', 'Inter'], arabic: ['Noto Sans Arabic', 'IBM Plex Sans Arabic'] };
const ARABIC = /[؀-ۿ]/;
const RENDER_ONLY = /lies over a photograph and its contrast was not measured on the rendered pixels/;

export interface GateReport {
  /** computeNegativeSpace on the layout as carried (a photo recipe takes the quiet-region measure). */
  negativeSpace: { passed: boolean; score: number; details: Record<string, unknown> };
  /** computeNegativeSpace on the same geometry without the recipe record: a composed poster. */
  negativeSpaceComposed: { passed: boolean; score: number; fraction: number; details: Record<string, unknown> };
  /** computeLayoutMetrics().alignmentScore, hard QA's POOR_GRID_ALIGNMENT gate (>= 0.70). */
  alignment: { passed: boolean; score: number };
  /** evaluateDesignMetrics().passed (every metric and the composite), as carried and as composed. */
  designMetrics: { passed: boolean; composite: number; failing: string[]; grid: number };
  designMetricsComposed: { passed: boolean; composite: number; failing: string[]; grid: number };
  /** evaluateHardQa without a render: its defect codes and messages, the render-only check apart. */
  hardQa: { passed: boolean; codes: string[]; messages: string[]; needsRender: string[] };
  /** validateLayoutV2 (first failure only, as production reads it). */
  validation: { passed: boolean; code?: string; message?: string };
}

export function copyOf(post: Pick<OfficePostFixture, 'copy'>): Record<number, string> {
  return Object.fromEntries(post.copy.map((t, i) => [i, t]));
}

export function scriptsOf(post: Pick<OfficePostFixture, 'copy'>): Array<'latin' | 'arabic'> {
  return post.copy.map((t) => (ARABIC.test(t) ? 'arabic' : 'latin'));
}

/** The same geometry as a composed poster carries it: no recipe record. */
export function composedForm(layout: StudioLayoutV2): StudioLayoutV2 {
  const { artDirection: _recipe, ...rest } = layout;
  return structuredClone(rest);
}

export function hardQaContext(post: OfficePostFixture): HardQaContext {
  return {
    width: post.layout.width, height: post.layout.height, copyScripts: scriptsOf(post), latinFont: 'Inter', arabicFont: 'Noto Sans Arabic',
    admittedDisplayFonts: KAAE_FONTS, palette: KAAE_PALETTE, logoAspect: 1, logoMinimumWidthPx: 80, logoClearSpaceShareOfHeight: 0.15,
    copyText: copyOf(post), photoCount: post.layout.photos?.length ?? 0,
  };
}

export function validationContext(post: OfficePostFixture): LayoutValidationContext {
  return {
    expectedWidth: post.layout.width, expectedHeight: post.layout.height, copyCount: post.copy.length, copyScripts: scriptsOf(post),
    photoCount: post.layout.photos?.length ?? 0,
    reference: { rules: { fontFamily: 'Inter', palette: KAAE_PALETTE, admittedDisplayFonts: KAAE_FONTS }, logoAspect: 1, logoMinimumWidthPx: 80, logoClearSpaceShareOfHeight: 0.15 },
  };
}

export function scoreOfficePost(post: OfficePostFixture): GateReport {
  const copy = copyOf(post);
  const layout = post.layout;
  const composed = composedForm(layout);
  const lines = measureWrappedLines(layout, copy);
  const ns = computeNegativeSpace(layout, lines);
  const nsComposed = computeNegativeSpace(composed, lines);
  const dm = evaluateDesignMetrics(layout, { wrappedLines: lines });
  const dmComposed = evaluateDesignMetrics(composed, { wrappedLines: lines });
  const alignment = computeLayoutMetrics(layout).alignmentScore;
  const qa = evaluateHardQa(layout, hardQaContext(post));
  const needsRender = qa.messages.filter((m) => RENDER_ONLY.test(m));
  const otherMessages = qa.messages.filter((m) => !RENDER_ONLY.test(m));
  // CONTRAST is raised only by the render-only check when no other contrast message remains.
  const codes = qa.defectCodes.filter((c) => c !== 'CONTRAST' || otherMessages.some((m) => m.startsWith('CONTRAST')));
  const v = validateLayoutV2(layout, validationContext(post));
  const metricSummary = (r: typeof dm) => ({ passed: r.passed, composite: r.compositeScore, failing: r.failingMetrics, grid: r.metrics.gridAppropriateness.score });
  return {
    negativeSpace: { passed: ns.passed, score: ns.score, details: ns.details ?? {} },
    negativeSpaceComposed: { passed: nsComposed.passed, score: nsComposed.score, fraction: Number(nsComposed.details?.fraction), details: nsComposed.details ?? {} },
    alignment: { passed: alignment >= 0.7, score: alignment },
    designMetrics: metricSummary(dm),
    designMetricsComposed: metricSummary(dmComposed),
    hardQa: { passed: codes.length === 0, codes, messages: otherMessages, needsRender },
    validation: v.ok ? { passed: true } : { passed: false, code: v.code, message: v.message },
  };
}
