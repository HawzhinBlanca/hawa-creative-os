import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { screenCopyFeasibility, COPY_FEASIBILITY_VERSION } from '../src/studio/copy-feasibility.js';
import { admittedFamiliesForQa, validateLayoutV2, type LayoutValidationContext } from '../src/studio/validate-layout-v2.js';
import { getSafeZoneBox, HOUSE_RULES } from '../src/studio/house-rules.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';

/**
 * ADR-125. A conflict the contract reports must be one hard QA would reject for every layout: an
 * unbreakable run of approved copy wider than the widest box QA admits (the safe area), at the
 * smallest size QA admits, in every face QA admits, at the tightest tracking QA admits.
 */
const fonts = { latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic' };
const unbroken = 'W'.repeat(150);

describe('copy feasibility screen (ADR-125)', () => {
  it('names the exact face set the validator admits', () => {
    const families = admittedFamiliesForQa(fonts);
    expect(families.latin).toContain('Verdana');
    expect(families.arabic).toContain('Noto Sans Arabic');
    const context: LayoutValidationContext = {
      expectedWidth: 1080, expectedHeight: 1350, copyCount: 2, copyScripts: ['latin', 'arabic'], photoCount: 0,
      reference: { rules: { fontFamily: fonts.latinFont, palette: ['#FFFFFF', '#000000'], scriptFonts: { arabic: fonts.arabicFont } }, logoAspect: 1 },
      draftFont: fonts.latinFont,
    };
    const layout = (latin: string, arabic: string): StudioLayoutV2 => ({
      version: 2, width: 1080, height: 1350, background: { color: '#FFFFFF' }, grid: { margin: 81, columns: 6, gutter: 20, baseline: 8 }, shapes: [],
      logo: { x: 490, y: 90, width: 100, height: 100 },
      text: [
        { copyIndex: 0, role: 'title', x: 100, y: 300, width: 800, height: 120, fontSize: 60, lineHeight: 1.3, fontFamily: latin, color: '#000000', align: 'left' },
        { copyIndex: 1, role: 'body', x: 100, y: 600, width: 800, height: 120, fontSize: 30, lineHeight: 1.7, fontFamily: arabic, color: '#000000', align: 'right', rtl: true },
      ],
    });
    const fontFailure = (latin: string, arabic: string) => {
      const result = validateLayoutV2(layout(latin, arabic), context);
      return !result.ok && result.code === 'FONT_NOT_ADMITTED';
    };
    for (const family of families.latin) expect(fontFailure(family, fonts.arabicFont), family).toBe(false);
    expect(fontFailure('Comic Sans MS', fonts.arabicFont)).toBe(true);
  });

  it('reports an unbreakable run no admitted face can set inside the safe width', () => {
    const screen = screenCopyFeasibility({ width: 1080, height: 1350, copy: { text: { 0: 'Approved workshop title', 1: unbroken }, scripts: { 0: 'latin', 1: 'latin' } }, ...fonts });
    const safeWidth = getSafeZoneBox(1080, 1350).width;
    expect(screen).toMatchObject({ version: COPY_FEASIBILITY_VERSION, minimumFontPx: HOUSE_RULES.minFontPx, safeWidthPx: safeWidth });
    expect(screen.blocks[0]).toMatchObject({ copyIndex: 0, status: 'fits' });
    expect(screen.blocks[1]).toMatchObject({ copyIndex: 1, status: 'exceeds_safe_width', unmeasured: [] });
    expect(screen.blocks[1].narrowestPx).toBeGreaterThan(safeWidth + 4);
    expect(screen.blocks[1].measuredFaces).toBe(admittedFamiliesForQa(fonts).latin.length * 2);
  });

  it('does not report copy that has a break opportunity or a format wide enough for it', () => {
    const spaced = unbroken.replace(/(.{20})/g, '$1 ');
    const wrapped = screenCopyFeasibility({ width: 1080, height: 1350, copy: { text: { 0: spaced }, scripts: { 0: 'latin' } }, ...fonts });
    expect(wrapped.blocks[0].status).toBe('fits');
    const wide = screenCopyFeasibility({ width: 4000, height: 4000, copy: { text: { 0: unbroken }, scripts: { 0: 'latin' } }, ...fonts });
    expect(wide.blocks[0].status).toBe('fits');
  });

  it('measures Sorani copy in the admitted Arabic-script faces without flagging ordinary words', () => {
    const screen = screenCopyFeasibility({ width: 1080, height: 1350, copy: { text: { 0: 'ڕاگەیاندنی کۆبوونەوەی زانکۆ' }, scripts: { 0: 'arabic' } }, ...fonts });
    expect(screen.blocks[0]).toMatchObject({ status: 'fits' });
  });

  it('never turns an unmeasurable face into a conflict', () => {
    const empty = mkdtempSync(join(tmpdir(), 'hawa-no-fonts-'));
    const screen = screenCopyFeasibility({ width: 1080, height: 1350, copy: { text: { 0: unbroken }, scripts: { 0: 'latin' } }, ...fonts, fontsDir: empty });
    expect(screen.blocks[0].status).toBe('unknown');
    expect(screen.blocks[0].unmeasured.length).toBeGreaterThan(0);
  });
});
