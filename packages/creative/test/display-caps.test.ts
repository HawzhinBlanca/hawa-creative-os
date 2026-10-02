import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { displayedCopy, textElementSchema, textFontWeight, uppercaseApplies, type StudioLayoutV2, type TextElement } from '../src/studio/layout-v2.js';
import { HOUSE_RULES, capsTrackingRange, isDisplayText, lineHeightRange } from '../src/studio/house-rules.js';
import {
  elementFontFace, fontCoversText, fontFidelityKey, fontFileFor, measureLineInkClearance, measureTextGeometry, renderLayoutV2ToSvg, weightedFontFidelity,
} from '../src/studio/render-layout-v2.js';
import { validateLayoutV2, type LayoutValidationContext } from '../src/studio/validate-layout-v2.js';
import { pageGrammarFromRaw, type PageGrammar } from '../src/studio/page-grammar.js';
import { admitPageGrammarFromReference, PageGrammarInvalidError } from '../src/studio/page-grammar-admission.js';
import { posterDisplayStyle, posterLabelStyle, PosterDisplayFaceError, withPosterDisplayStyle } from '../src/studio/poster-display.js';
import { capsTextObjectName, deckFontFace, encodeStudioTransferV2 } from '../src/studio/transfer-v2.js';
import { conformToHouseRules } from '../src/studio/pipeline-v3.js';
import { applyStyleSpec, NEUTRAL_STYLE_SPEC } from '../src/studio/style-spec.js';
import { checkCanvaPptx } from '../../qa/src/canva-pptx-check.js';

/**
 * ADR-275 (owner's decision, 2026-10-02): KAAE poster display titles are heavy sans capitals, as the
 * office's own published posts set them. Engine layer: a weight and a capitals transform on a text
 * block, measured and drawn with the same weighted file; the copy stored and sent exactly as typed;
 * role- and size-aware display leading guarded by the measured ink of the lines; caps tracking; a
 * poster display policy in the client reference.
 */

const RAW = JSON.parse(readFileSync(new URL('../assets/kaae-reference.json', import.meta.url), 'utf8'));
const G = pageGrammarFromRaw(RAW)!;
const FONTS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../assets/fonts');
const LOGO = readFileSync(new URL('../assets/logos/kaae-official-logo.png', import.meta.url));
const W = 1080;
const H = 1350;
const SORANI_TITLE = 'بانگەواز بۆ هەڵسەنگێنەرانی هاوتا';
const SORANI_LETTERS = ['ڕ', 'ڵ', 'ۆ', 'ێ', 'ە'];

function available(tool: string): boolean {
  try {
    execFileSync(tool, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const el = (over: Partial<TextElement> = {}): TextElement => ({
  copyIndex: 0, role: 'title', x: 65, y: 400, width: 950, height: 700, fontSize: 200, lineHeight: 0.98,
  fontFamily: 'Inter', color: '#1E3A5F', align: 'left', ...over,
});
const layoutOf = (text: TextElement[]): StudioLayoutV2 => ({
  version: 2, width: W, height: H, grid: { margin: 65, columns: 12, gutter: 24, baseline: 8 },
  background: { color: '#FDF8F3' }, shapes: [], text, logo: { x: 65, y: 65, width: 173, height: 173 },
});
const context = (scripts: Array<'latin' | 'arabic'>, extra: Partial<LayoutValidationContext> = {}): LayoutValidationContext => ({
  expectedWidth: W, expectedHeight: H, copyCount: scripts.length, copyScripts: scripts,
  reference: { rules: { fontFamily: 'Inter', palette: RAW.rules.palette, scriptFonts: { arabic: 'Noto Sans Arabic' },
    admittedDisplayFonts: { latin: ['Crimson Pro', 'Inter'], arabic: ['Noto Sans Arabic', 'IBM Plex Sans Arabic'] } },
  logoAspect: 1, logoMinimumWidthPx: 80, logoClearSpaceShareOfHeight: 0.15 },
  ...extra,
});
const latinCaps = () => withPosterDisplayStyle(el(), posterDisplayStyle(G, 'latin'));
const soraniTitle = (over: Partial<TextElement> = {}) => ({ ...withPosterDisplayStyle(el({ align: 'right', fontSize: 112, height: 400 }), posterDisplayStyle(G, 'arabic')), ...over });

describe('the text block: weight and capitals', () => {
  it('admits a weight 100..900 and the capitals transform, and nothing else', () => {
    expect(textElementSchema.safeParse({ ...el(), fontWeight: 800, textTransform: 'uppercase' }).success).toBe(true);
    expect(textElementSchema.safeParse({ ...el(), fontWeight: 850 }).success).toBe(false);
    expect(textElementSchema.safeParse({ ...el(), fontWeight: 1000 }).success).toBe(false);
    expect(textElementSchema.safeParse({ ...el(), textTransform: 'lowercase' }).success).toBe(false);
  });

  it('reads bold as 700 and its absence as 400; a named weight wins', () => {
    expect(textFontWeight({})).toBe(400);
    expect(textFontWeight({ bold: true })).toBe(700);
    expect(textFontWeight({ bold: true, fontWeight: 800 })).toBe(800);
    expect(textFontWeight({ bold: false, fontWeight: 600 })).toBe(600);
  });

  it('draws Latin copy in capitals and ignores the transform on Arabic script', () => {
    expect(displayedCopy({ textTransform: 'uppercase' }, 'Peer Review Week')).toBe('PEER REVIEW WEEK');
    expect(displayedCopy({}, 'Peer Review Week')).toBe('Peer Review Week');
    expect(uppercaseApplies({ textTransform: 'uppercase' }, SORANI_TITLE)).toBe(false);
    expect(uppercaseApplies({ textTransform: 'uppercase', rtl: true }, 'Erbil')).toBe(false);
    expect(displayedCopy({ textTransform: 'uppercase' }, `KAAE ${SORANI_TITLE}`)).toBe(`KAAE ${SORANI_TITLE}`);
  });
});

describe('measuring and drawing the weighted face', () => {
  it('resolves each weight to the file the family ships, and an older block to the file it always had', () => {
    const file = (family: string, weight?: number, bold?: boolean) => path.basename(fontFileFor(family, bold, false, FONTS, weight));
    expect(file('Inter', 800)).toBe('Inter-ExtraBold.ttf');
    expect(file('Inter', 900)).toBe('Inter-Black.ttf');
    expect(file('Inter', 700)).toBe('Inter-Bold.ttf');
    expect(file('Inter', 600)).toBe('Inter-SemiBold.ttf');
    expect(file('Inter', 500)).toBe('Inter-SemiBold.ttf');
    expect(file('Inter', 400)).toBe('Inter-Regular.ttf');
    expect(file('Inter', undefined, true)).toBe('Inter-Bold.ttf');
    expect(file('Inter')).toBe('Inter-Regular.ttf');
    // A family without the weight draws its nearest real face; nothing is synthesised.
    expect(file('IBM Plex Sans Arabic', 800)).toBe('IBMPlexSansArabic-Bold.ttf');
    expect(file('Noto Sans Arabic', 900)).toBe('NotoSansArabic-Bold.ttf');
    expect(file('Cairo', 700)).toBe('Cairo-Regular.ttf');
  });

  it('names the face by the weight its file declares and by the file\'s own family name', () => {
    expect(elementFontFace({ fontFamily: 'Inter', fontWeight: 800 }, { fontsDir: FONTS })).toMatchObject({ weight: 800, legacyFamilyName: 'Inter ExtraBold' });
    expect(elementFontFace({ fontFamily: 'Inter', fontWeight: 900 }, { fontsDir: FONTS })).toMatchObject({ weight: 900, legacyFamilyName: 'Inter Black' });
    expect(elementFontFace({ fontFamily: 'Inter', fontWeight: 700 }, { fontsDir: FONTS })).toMatchObject({ weight: 700, legacyFamilyName: 'Inter' });
    expect(fontFidelityKey({ fontFamily: 'Inter', fontWeight: 800 }, { fontsDir: FONTS })).toBe('Inter 800');
    expect(fontFidelityKey({ fontFamily: 'Inter', fontWeight: 400 }, { fontsDir: FONTS })).toBe('Inter');
    expect(fontFidelityKey({ fontFamily: 'Inter', bold: true })).toBe('Inter');
  });

  it('measures the capitals in the weighted face, and hashes the copy as typed', () => {
    const copy = 'Peer Review Week';
    const [caps] = measureTextGeometry(layoutOf([latinCaps()]), { 0: copy }, { fontsDir: FONTS });
    const [plain] = measureTextGeometry(layoutOf([el({ fontSize: 200 })]), { 0: copy }, { fontsDir: FONTS });
    expect(caps.status).toBe('measured');
    expect(plain.status).toBe('measured');
    if (caps.status !== 'measured' || plain.status !== 'measured') return;
    expect(caps.copySha256).toBe(createHash('sha256').update(copy).digest('hex'));
    expect(caps.maxLineWidthPx).toBeGreaterThan(plain.maxLineWidthPx);
    expect(caps.fontSha256).toBe(createHash('sha256').update(readFileSync(path.join(FONTS, 'Inter-ExtraBold.ttf'))).digest('hex'));
    expect(caps.inputSha256).not.toBe(plain.inputSha256);
  });

  it('keeps the measurement of a block without the new fields byte-identical', () => {
    const t = el({ bold: true, lineHeight: 1.2 });
    const [a] = measureTextGeometry(layoutOf([t]), { 0: 'Quality Assurance' }, { fontsDir: FONTS });
    const [b] = measureTextGeometry(layoutOf([{ ...t, fontWeight: undefined, textTransform: undefined }]), { 0: 'Quality Assurance' }, { fontsDir: FONTS });
    expect(a).toEqual(b);
  });

  it('draws the capitals at the file\'s weight, never the typed lower case', () => {
    const { svg } = renderLayoutV2ToSvg(layoutOf([latinCaps()]), { copyText: { 0: 'Peer Review Week' }, fontsDir: FONTS, logoDataUri: `data:image/png;base64,${LOGO.toString('base64')}` });
    expect(svg).toContain('font-weight="800"');
    expect(svg).toContain('>PEER<');
    expect(svg).not.toMatch(/Peer|Review/);
  });

  it.skipIf(!available('rsvg-convert'))('draws Inter ExtraBold and IBM Plex Sans Arabic Bold from the files it measures (no substitution)', () => {
    expect(weightedFontFidelity({ fontFamily: 'Inter', fontWeight: 800 }, { fontsDir: FONTS })).toBe('exact');
    expect(weightedFontFidelity({ fontFamily: 'Inter', fontWeight: 900 }, { fontsDir: FONTS })).toBe('exact');
    expect(weightedFontFidelity({ fontFamily: 'IBM Plex Sans Arabic', fontWeight: 700 }, { fontsDir: FONTS })).toBe('exact');
  });
});

describe('display leading (house rules and validator)', () => {
  it('is role- and size-aware; body copy is unchanged', () => {
    expect(isDisplayText({ role: 'title', fontSize: 0.06 * W }, W)).toBe(true);
    expect(isDisplayText({ role: 'title', fontSize: 0.05 * W }, W)).toBe(false);
    expect(isDisplayText({ role: 'body', fontSize: 200 }, W)).toBe(false);
    expect(lineHeightRange('latin', { role: 'title', fontSize: 200 }, W)).toMatchObject({ min: 0.95, max: 1.5, inkCheckedBelow: 1.2, display: true });
    expect(lineHeightRange('arabic', { role: 'title', fontSize: 112 }, W)).toMatchObject({ min: 1.3, max: 1.9, inkCheckedBelow: 1.6, display: true });
    expect(lineHeightRange('latin', { role: 'body', fontSize: 40 }, W)).toMatchObject(HOUSE_RULES.lineHeight.latin);
    expect(lineHeightRange('arabic', { role: 'subtitle', fontSize: 112 }, W)).toMatchObject(HOUSE_RULES.lineHeight.arabic);
  });

  it('admits a Latin display title at 0.98 and refuses tight body copy and a small title', () => {
    expect(validateLayoutV2(layoutOf([latinCaps()]), context(['latin'])).ok).toBe(true);
    const body = validateLayoutV2(layoutOf([el({ role: 'body', fontSize: 40, lineHeight: 1.0 })]), context(['latin']));
    expect(body).toMatchObject({ ok: false, code: 'LINE_HEIGHT' });
    const small = validateLayoutV2(layoutOf([el({ fontSize: 50, lineHeight: 1.0 })]), context(['latin']));
    expect(small).toMatchObject({ ok: false, code: 'LINE_HEIGHT' });
    expect(validateLayoutV2(layoutOf([el({ lineHeight: 0.9 })]), context(['latin'])).ok).toBe(false);
  });

  it('admits Sorani display at 1.35 only on the measured ink of its lines', () => {
    const t = soraniTitle();
    expect(t).toMatchObject({ fontFamily: 'IBM Plex Sans Arabic', fontWeight: 700, lineHeight: 1.35, letterSpacing: 0, rtl: true });
    expect(validateLayoutV2(layoutOf([t]), context(['arabic'], { copyText: { 0: SORANI_TITLE } })).ok).toBe(true);
    // Without the copy the clearance of its marks is unproven.
    const unproven = validateLayoutV2(layoutOf([t]), context(['arabic']));
    expect(unproven).toMatchObject({ ok: false, code: 'LINE_HEIGHT' });
    expect((unproven as { message: string }).message).toMatch(/not measured/);
    // A measured collision is refused whatever the ratio.
    const collides = validateLayoutV2(layoutOf([t]), context(['arabic'], {
      lineInkClearance: () => ({ method: 'fontkit-glyph-ink-v1', lineCount: 2, fontSizePx: 112, lineHeight: 1.35, minGapPx: -3, minGapEm: -0.027, tightestPair: 0 }),
    }));
    expect(collides).toMatchObject({ ok: false, code: 'LINE_HEIGHT' });
    expect((collides as { message: string }).message).toMatch(/collide/);
    // Under the Sorani display minimum, and Sorani body copy, keep their ranges.
    expect(validateLayoutV2(layoutOf([soraniTitle({ lineHeight: 1.25 })]), context(['arabic'], { copyText: { 0: SORANI_TITLE } })).ok).toBe(false);
    expect(validateLayoutV2(layoutOf([soraniTitle({ role: 'body', fontSize: 40, lineHeight: 1.4 })]), context(['arabic'], { copyText: { 0: SORANI_TITLE } })).ok).toBe(false);
  });

  it('holds a tight Latin title to its ink when the copy is at hand', () => {
    const mixed = el({ fontSize: 200, lineHeight: 0.95, fontWeight: 800 });
    const tight = measureLineInkClearance(mixed, 'gypsy gypsy gypsy\nLight Light', { fontsDir: FONTS });
    expect(tight).toBeDefined();
    expect(tight!.minGapEm).toBeLessThan(HOUSE_RULES.displayLineHeight.inkClearanceEm);
    const r = validateLayoutV2(layoutOf([mixed]), context(['latin'], { copyText: { 0: 'gypsy gypsy gypsy\nLight Light' } }));
    expect(r).toMatchObject({ ok: false, code: 'LINE_HEIGHT' });
  });

  it('measures how close the marks of adjacent Sorani lines come, as drawn', () => {
    const at = (lineHeight: number) => measureLineInkClearance(soraniTitle({ lineHeight }), SORANI_TITLE, { fontsDir: FONTS })!;
    expect(at(1.35).lineCount).toBe(2);
    expect(at(1.35).minGapEm).toBeGreaterThan(HOUSE_RULES.displayLineHeight.inkClearanceEm);
    expect(at(1.0).minGapPx).toBeLessThan(0); // the marks collide
    expect(at(1.35).minGapPx - at(1.0).minGapPx).toBeCloseTo(0.35 * 112, 3);
    expect(measureLineInkClearance(soraniTitle({ width: 4000 }), SORANI_TITLE, { fontsDir: FONTS })!.minGapPx).toBe(Infinity);
  });
});

describe('caps tracking', () => {
  it('sets capitals solid to slightly tight at display size and opens small labels', () => {
    expect(capsTrackingRange({ role: 'title', fontSize: 200 }, W)).toMatchObject({ min: -0.03, max: 0, kind: 'display' });
    expect(capsTrackingRange({ role: 'eyebrow', fontSize: 30 }, W)).toMatchObject({ min: 0.05, max: 0.1, kind: 'label' });
    const ok = (t: TextElement) => validateLayoutV2(layoutOf([t]), context(['latin'])).ok;
    expect(ok(latinCaps())).toBe(true);
    expect(ok({ ...latinCaps(), letterSpacing: 0.04 })).toBe(false);
    const eyebrow = el({ role: 'eyebrow', fontSize: 30, height: 40, lineHeight: 1.3, textTransform: 'uppercase' });
    expect(ok({ ...eyebrow, letterSpacing: 0 })).toBe(false);
    expect(ok({ ...eyebrow, ...posterLabelStyle(G) })).toBe(true);
  });

  it('never tracks Arabic script, and drops a capitals transform from it', () => {
    const r = validateLayoutV2(layoutOf([soraniTitle({ textTransform: 'uppercase' })]), context(['arabic'], { copyText: { 0: SORANI_TITLE } }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.layout.text[0].textTransform).toBeUndefined();
    expect(validateLayoutV2(layoutOf([soraniTitle({ letterSpacing: 0.02 })]), context(['arabic'], { copyText: { 0: SORANI_TITLE } })).ok).toBe(false);
  });
});

describe('the poster display policy (kaae-reference.json)', () => {
  it('is admitted with the grammar, and the guideline serif stays for document pages', () => {
    const admitted = admitPageGrammarFromReference(RAW)!;
    expect(admitted.poster?.display).toMatchObject({
      latin: { fontFamily: 'Inter', fontWeight: 800, textTransform: 'uppercase', lineHeight: 0.98 },
      arabic: { fontFamily: 'IBM Plex Sans Arabic', fontWeight: 700, lineHeight: 1.35 },
    });
    expect(admitted.title.fontFamily).toBe('Crimson Pro');
    expect(G.title.fontFamily).toBe('Crimson Pro');
  });

  it('refuses a policy that cases or tracks Arabic script, or leads outside the display ranges', () => {
    const withDisplay = (display: unknown) => {
      const raw = structuredClone(RAW);
      raw.rules.pageGrammar.poster.display = display;
      return () => admitPageGrammarFromReference(raw);
    };
    const policy = RAW.rules.pageGrammar.poster.display;
    expect(withDisplay({ ...policy, arabic: { ...policy.arabic, textTransform: 'uppercase' } })).toThrow(PageGrammarInvalidError);
    expect(withDisplay({ ...policy, arabic: { ...policy.arabic, letterSpacing: 0.02 } })).toThrow(PageGrammarInvalidError);
    expect(withDisplay({ ...policy, arabic: { ...policy.arabic, lineHeight: 1.2 } })).toThrow(PageGrammarInvalidError);
    expect(withDisplay({ ...policy, latin: { ...policy.latin, lineHeight: 0.9 } })).toThrow(PageGrammarInvalidError);
    expect(withDisplay({ ...policy, latin: { ...policy.latin, fontWeight: 850 } })).toThrow(PageGrammarInvalidError);
  });

  it('gives the composer the display style per script', () => {
    expect(posterDisplayStyle(G, 'latin')).toEqual({ fontFamily: 'Inter', fontWeight: 800, bold: true, lineHeight: 0.98, letterSpacing: -0.01, textTransform: 'uppercase' });
    expect(posterDisplayStyle(G, 'arabic')).toEqual({ fontFamily: 'IBM Plex Sans Arabic', fontWeight: 700, bold: true, lineHeight: 1.35, letterSpacing: 0, rtl: true });
    expect(posterLabelStyle(G)).toEqual({ textTransform: 'uppercase', letterSpacing: 0.08 });
    const { display: _display, ...posterWithout } = G.poster!;
    expect(posterDisplayStyle({ poster: posterWithout }, 'latin')).toBeUndefined();
  });

  it('excludes Cairo for Sorani: Cairo-Regular has no glyph for the five Sorani letters', () => {
    const cairo = fontCoversText('Cairo', SORANI_LETTERS.join(''), { fontsDir: FONTS });
    expect(cairo.covers).toBe(false);
    expect(cairo.missing.sort()).toEqual([...SORANI_LETTERS].sort());
    expect(fontCoversText('IBM Plex Sans Arabic', SORANI_LETTERS.join(''), { fontsDir: FONTS, fontWeight: 700 }).covers).toBe(true);
    const grammar: Pick<PageGrammar, 'poster'> = { poster: { ...G.poster!, display: { ...G.poster!.display!, arabic: { fontFamily: 'Cairo', fontWeight: 700, lineHeight: 1.35 } } } };
    expect(() => posterDisplayStyle(grammar, 'arabic')).toThrow(PosterDisplayFaceError);
    try {
      posterDisplayStyle(grammar, 'arabic');
    } catch (err) {
      expect((err as PosterDisplayFaceError).missing).toEqual(expect.arrayContaining(SORANI_LETTERS));
    }
  });
});

describe('preparation and requester edits', () => {
  it('keeps a styled display title\'s leading and still holds a model\'s title to the body range', () => {
    const copy = { text: { 0: 'Peer Review Week' } };
    const styled = conformToHouseRules(layoutOf([latinCaps()]), copy);
    expect(styled.text[0].lineHeight).toBe(0.98);
    const model = conformToHouseRules(layoutOf([el({ lineHeight: 0.98 })]), copy);
    expect(model.text[0].lineHeight).toBe(1.2);
  });

  it('drops a weight a lighter title style contradicts', () => {
    const light = applyStyleSpec(layoutOf([latinCaps()]), { text: { 0: 'Peer Review Week' } }, { ...NEUTRAL_STYLE_SPEC, titleWeight: 'regular' }, RAW.rules.palette);
    expect(light.text[0].fontWeight).toBeUndefined();
    expect(light.text[0].bold).toBe(false);
  });
});

describe('the Canva deck: live copy as typed, cap="all", the weighted face', () => {
  it('sends the typed copy under cap="all" in Inter ExtraBold and passes the exact-copy check', async () => {
    const copy = ['Peer Review Week', 'Join KAAE’s network of peer evaluators.'];
    const layout = layoutOf([latinCaps(), el({ copyIndex: 1, role: 'body', y: 1150, height: 120, fontSize: 40, lineHeight: 1.4 })]);
    expect(deckFontFace(layout.text[0])).toEqual({ face: 'Inter ExtraBold', bold: false });
    expect(deckFontFace({ fontFamily: 'Inter', fontWeight: 700 })).toEqual({ face: 'Inter', bold: true });
    expect(deckFontFace({ fontFamily: 'Inter', bold: true })).toEqual({ face: 'Inter', bold: true });
    const deck = await encodeStudioTransferV2(structuredClone(layout), copy, { bytes: LOGO, sha256: RAW.logoSha256, mimeType: 'image/png' });
    const slide = strFromU8(unzipSync(new Uint8Array(deck.bytes))['ppt/slides/slide1.xml']);
    const caps = slide.match(/<p:sp>(?:(?!<\/p:sp>)[\s\S])*?name="Caps text 0"[\s\S]*?<\/p:sp>/)?.[0] ?? '';
    expect(caps).toContain('cap="all"');
    expect(caps).toContain('<a:latin typeface="Inter ExtraBold"');
    expect(caps).toContain('>Peer Review Week<');
    expect(caps).not.toContain('b="1"');
    expect((slide.match(/cap="all"/g) || []).length).toBe((caps.match(/cap="all"/g) || []).length);
    expect(capsTextObjectName(0)).toBe('Caps text 0');
    expect(deck.plan.text[0]).toMatchObject({ fontWeight: 800, fontFace: 'Inter ExtraBold', textTransform: 'uppercase' });
    expect(deck.plan.text[1].textTransform).toBeUndefined();
    expect(deck.manifest.copy).toEqual(copy);
    const fonts = layout.text.map((t) => t.fontFamily);
    expect(checkCanvaPptx(deck.bytes, copy, { fontsByIndex: fonts, uppercaseByIndex: [true, false] })).toMatchObject({ copyPass: true, fontPass: true });
  });

  it('never sets a Sorani block in capitals in the deck', async () => {
    const copy = [SORANI_TITLE];
    const layout = layoutOf([soraniTitle({ textTransform: 'uppercase' })]);
    const deck = await encodeStudioTransferV2(structuredClone(layout), copy, { bytes: LOGO, sha256: RAW.logoSha256, mimeType: 'image/png' },
      { extraFonts: ['IBM Plex Sans Arabic'] });
    const slide = strFromU8(unzipSync(new Uint8Array(deck.bytes))['ppt/slides/slide1.xml']);
    expect(slide).not.toContain('cap="all"');
    expect(deck.plan.text[0].textTransform).toBeUndefined();
  });
});
