import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { strFromU8, unzipSync } from 'fflate';
import { reviewFindings } from '../src/studio/hard-qa.js';
import { solveRecipe, RecipeInfeasibleError, type ArtDirectionChoice } from '../src/studio/art-direction/solver.js';
import { solveConcepts, type GenerateArtDirectedOptions } from '../src/studio/art-direction/generate.js';
import { cutoutPlacement } from '../src/studio/photo-cutout.js';
import type { PhotoElement } from '../src/studio/layout-v2.js';
import { rankCandidatesV3 } from '../src/studio/pipeline-v3.js';
import { renderLayoutV2 } from '../src/studio/render-layout-v2.js';
import { encodeStudioTransferV2 } from '../src/studio/transfer-v2.js';
import { computeBoxP05Contrast } from '../src/studio/composite-contrast.js';
import { requiredContrast } from '../src/studio/house-rules.js';
import { flatPng } from './fixtures/synthetic-photos.js';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';

const choice: ArtDirectionChoice = { recipe: 'cutout_speaker', heroPhotoIndex: 0, texturePhotoIndex: null,
  cutoutPhotoIndex: 0, slots: [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'body' }],
  params: { frame: 'none', align: 'start' }, conceptNote: 'Original speaker announcement', typicality: .2 };
const options: Omit<GenerateArtDirectedOptions, 'client'> = { brief: 'Speaker announcement', canvasWidth: 800, canvasHeight: 1000,
  palette: ['#0A1628', '#FFFFFF', '#F7B500', '#1A1A1A'], logoAspect: 1,
  copyBlocks: [{ index: 0, text: 'Original title', role: 'title', script: 'latin' },
    { index: 1, text: 'Exact date 2026 Office details', role: 'body', script: 'latin' }],
  photos: [{ photoIndex: 0, width: 2400, height: 2400, subjectFit: 5, cutout: true, cutoutSize: { width: 100, height: 200 } },
    { photoIndex: 1, width: 2400, height: 2400, subjectFit: 3, cutout: true, cutoutSize: { width: 1200, height: 2400 } }],
};
const direct = (photos = options.photos) => solveRecipe({ width: 800, height: 1000, choice, photos,
  palette: options.palette, logoAspect: 1, copy: { text: Object.fromEntries(options.copyBlocks.map(b => [b.index, b.text])) } });
const framed: PhotoElement = { photoIndex: 0, role: 'hero', x: 0, y: 0, width: 400, height: 400 };
const review = (photo: PhotoElement, sources: Array<{ width: number; height: number;
  cutout?: { width: number; height: number; placement?: { width: number; height: number } } | null } | undefined>, savedScale = .2) => {
  const layout = { ...direct(), text: [], photos: [photo] };
  layout.artDirection!.heroUpscale = savedScale;
  return reviewFindings(layout, { photoSources: sources });
};

describe('current source resolution review', () => {
  it('measures the actual contained cutout and lets bounded recovery keep its sharp alternate', () => {
    const original = direct(), actual = cutoutPlacement(original.photos![0], options.photos[0].cutoutSize!).scale;
    expect(actual).toBe(3.04);
    expect(original.artDirection?.heroUpscale).toBe(actual);
    const before = structuredClone(choice), result = solveConcepts([choice], options);
    expect(result.choices[0]).toEqual({ ...choice, heroPhotoIndex: 1, cutoutPhotoIndex: 1 });
    expect(result.layouts[0].photos?.map(p => [p.photoIndex, p.treatment])).toEqual([[1, 'cutout']]);
    expect(result.layouts[0].artDirection?.heroUpscale).toBe(.25);
    expect(result.replaced[0].reason).toMatch(/HERO_UPSCALED/);
    expect(choice).toEqual(before);
    expect(solveConcepts(JSON.parse(JSON.stringify([choice])), options)).toEqual(result);
  });

  it('keeps and warns about a soft cutout when no sharp source exists', () => {
    const result = solveConcepts([choice], { ...options, photos: [{ ...options.photos[0], width: 200, height: 200 }] });
    expect(result.choices[0]).toEqual(choice);
    expect(reviewFindings(result.layouts[0], {}).map(f => f.code)).toContain('HERO_UPSCALED');
  });

  it.each([0, -10, NaN, Infinity])('refuses invalid cutout dimensions as recipe infeasibility (%s)', width => {
    expect(() => direct([{ ...options.photos[0], cutoutSize: { width, height: 200 } }])).toThrow(RecipeInfeasibleError);
  });

  it('measures edited photo geometry rather than a stale passing saved scale', () => {
    const findings = review(framed, [{ width: 100, height: 100 }]);
    expect(findings.map(f => f.code)).toEqual(['HERO_UPSCALED']);
    expect(findings[0].message).toContain('4.0x');
  });

  it('does not retain a stale high saved warning after a sharp source replaces it', () => {
    expect(review(framed, [{ width: 2000, height: 2000 }], 9)).toEqual([]);
  });

  it('applies current zoom for framed photos', () => {
    const findings = review({ ...framed, width: 800, height: 800, zoom: 3 }, [{ width: 1200, height: 1200 }]);
    expect(findings.map(f => f.code)).toEqual(['HERO_UPSCALED']);
    expect(findings[0].message).toContain('2.0x');
  });

  it('uses contain for an actual cutout, without a cover-based false warning', () => {
    const portrait = { ...framed, role: 'portrait' as const, treatment: 'cutout' as const, width: 100, height: 600 };
    expect(review(portrait, [{ width: 2400, height: 2400, cutout: { width: 1000, height: 100 } }], 9)).toEqual([]);
  });

  it('measures actual cutout pixels instead of the high-resolution original or saved size', () => {
    const portrait = { ...framed, role: 'portrait' as const, treatment: 'cutout' as const, width: 304, height: 640 };
    const findings = review(portrait, [{ width: 6000, height: 6000,
      cutout: { width: 100, height: 200, placement: { width: 1200, height: 2400 } } }]);
    expect(findings.map(f => f.code)).toEqual(['HERO_UPSCALED']);
    expect(findings[0].message).toContain('3.0x');
  });

  it('reports a soft supporting portrait as well as checking the primary photo', () => {
    const layout = { ...direct(), text: [], photos: [{ ...framed, width: 200, height: 200 },
      { ...framed, photoIndex: 1, role: 'portrait' as const, treatment: 'cutout' as const, width: 400, height: 800 }] };
    const findings = reviewFindings(layout, { photoSources: [{ width: 2400, height: 2400 },
      { width: 2400, height: 2400, cutout: { width: 100, height: 200 } }] });
    expect(findings.map(f => f.code)).toEqual(['PHOTO_UPSCALED']);
    expect(findings[0].message).toContain('Photo 2');
  });

  it.each([undefined, { width: 0, height: 200 }, { width: 2400, height: 2400, cutout: null }])('shows unavailable current dimensions instead of trusting saved metadata (%j)', source => {
    const portrait = { ...framed, role: 'portrait' as const, treatment: 'cutout' as const };
    const findings = review(portrait, [source]);
    expect(findings.map(f => f.code)).toEqual(['PHOTO_RESOLUTION_UNMEASURED']);
  });

  it('matches actual framed fallback when no cutout asset is present', () => {
    expect(review({ ...framed, treatment: 'cutout', role: 'portrait' }, [{ width: 100, height: 100 }])[0].message).toContain('4.0x');
  });

  it('keeps the unchanged 1.5x boundary and does not mutate current evidence or layout', () => {
    const layout = { ...direct(), text: [], photos: [{ ...framed, width: 150, height: 150 }] };
    const sources = [{ width: 100, height: 100 }], before = structuredClone(layout);
    expect(reviewFindings(layout, { photoSources: sources })).toEqual([]);
    expect(layout).toEqual(before);
    expect(sources).toEqual([{ width: 100, height: 100 }]);
    expect(review({ ...framed, width: 151, height: 151 }, sources).map(f => f.code)).toEqual(['HERO_UPSCALED']);
  });

  it('ranks current sharp pixels before a soft source despite contrary stale saved scales', () => {
    const soft = direct(), sharp = structuredClone(soft);
    soft.artDirection!.heroUpscale = .25;
    sharp.photos![0].photoIndex = 1;
    sharp.artDirection!.heroUpscale = 9;
    const ranked = rankCandidatesV3([{ sourceIndex: 0, layout: soft }, { sourceIndex: 1, layout: sharp }], {
      text: Object.fromEntries(options.copyBlocks.map(b => [b.index, b.text])),
    }, { width: 800, height: 1000, copyScripts: ['latin', 'latin'], latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic',
      palette: options.palette, logoAspect: 1, photoCount: 2, photoSelection: { mode: 'choose', minimum: 1 },
      photoSources: options.photos.map(p => ({ width: p.width, height: p.height, cutout: p.cutoutSize })) });
    expect(ranked.every(r => r.hardQa?.passed)).toBe(true);
    expect(ranked.map(r => r.sourceIndex)).toEqual([1, 0]);
  });

  it('renders and transfers the retained original cutout pixels with live exact copy', async () => {
    const layout = direct();
    const png = flatPng(100, 200, [220, 40, 60]);
    const photoCutouts = [{ png, width: 100, height: 200 }];
    const render = renderLayoutV2(layout, { copyText: Object.fromEntries(options.copyBlocks.map(b => [b.index, b.text])),
      logoDataUri: KAAE_TEST_LOGO, photoCutouts });
    const composite = PNG.sync.read(render.noTextPng);
    for (const t of layout.text) expect(computeBoxP05Contrast(composite, t, t.color)).toBeGreaterThanOrEqual(requiredContrast(t.fontSize, !!t.bold));
    const actual = cutoutPlacement(layout.photos![0], photoCutouts[0]);
    expect(actual.scale).toBe(3.04);
    expect(render.svg).toContain('width="304" height="608"');
    const logoBytes = Buffer.from(KAAE_TEST_LOGO.split(',')[1], 'base64');
    const deck = await encodeStudioTransferV2(layout, options.copyBlocks.map(b => b.text), {
      bytes: logoBytes, sha256: createHash('sha256').update(logoBytes).digest('hex'), mimeType: 'image/png',
    }, { photoCutouts });
    const files = unzipSync(deck.bytes), xml = strFromU8(files['ppt/slides/slide1.xml']);
    expect(xml).toContain('<a:t>Original title</a:t>');
    expect(xml).toContain('Exact date 2026 Office details');
    const media = Object.entries(files).filter(([name]) => name.startsWith('ppt/media/')).map(([, bytes]) => Buffer.from(bytes));
    expect(media.some(bytes => bytes.equals(png))).toBe(true);
    expect(media.some(bytes => bytes.equals(logoBytes))).toBe(true);
  });
});
