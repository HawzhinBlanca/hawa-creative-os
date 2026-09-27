/**
 * Present the measurement the Canva QC actually made (ADR-077). Older immutable reports named
 * family membership "fontCoverage". Read their explicit check without rewriting the report/hash;
 * the legacy flag alone establishes neither family membership nor rendered glyph coverage.
 */
export function canvaFontEvidence(report: unknown): { fontFamilyPass: boolean | null; fontCoverage: null } {
  let fontFamilyPass: boolean | null = null;
  if (report && typeof report === 'object') {
    const value = report as Record<string, unknown>;
    if (Object.hasOwn(value, 'fontFamilyPass')) {
      fontFamilyPass = typeof value.fontFamilyPass === 'boolean' ? value.fontFamilyPass : null;
    } else if (Array.isArray(value.checks)) {
      const check = value.checks.find((item: unknown) => item && typeof item === 'object'
        && (item as Record<string, unknown>).name === 'fontPass');
      fontFamilyPass = typeof check?.passed === 'boolean' ? check.passed : null;
    }
  }
  return { fontFamilyPass, fontCoverage: null };
}
