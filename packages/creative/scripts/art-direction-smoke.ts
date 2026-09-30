/**
 * ADR-170 smoke render: solves a recipe for the KAAE K-12 copy and a folder of photos, and writes
 * the PNG. Not part of the pipeline; for looking at the solver's output by eye.
 *
 *   npx tsx packages/creative/scripts/art-direction-smoke.ts <photo-dir> <out-dir> [recipe] [WxH] [ltr|rtl]
 */
import fs from 'node:fs';
import path from 'node:path';
import { solveRecipe, type ArtDirectionChoice } from '../src/studio/art-direction/solver.js';
import { renderLayoutV2 } from '../src/studio/render-layout-v2.js';
import { imagePixelSize } from '../src/studio/photo-crop.js';
import { getKaaeOfficialLogoDataUri } from '../src/operations-to-svg.js';
import { analysePhotoAsync } from '../src/studio/art-direction/photo-analysis.js';
import type { RecipeId } from '../src/studio/layout-v2.js';

const [photoDir, outDir, recipeArg = 'hero_fade_report', sizeArg = '1080x1350', dirArg = 'ltr'] = process.argv.slice(2);
const [W, H] = sizeArg.split('x').map(Number);
const palette = ['#0A1628', '#1E3A5F', '#4770A3', '#F7B500', '#FDF8F3', '#FFFFFF', '#1A1A1A'];
const latin = { 0: 'KAAE K-12 Pilot Study', 1: 'Field Visit Report', 2: 'Insights from KAAE school field visits and next steps toward', 3: 'kaae.org' };
const sorani = { 0: 'توێژینەوەی پیلۆتی K-12ی کەی ئەی', 1: 'ڕاپۆرتی سەردانی مەیدانی', 2: 'تێڕوانینەکان لە سەردانە مەیدانییەکانی کەی ئەی بۆ قوتابخانەکان و هەنگاوەکانی داهاتوو', 3: 'kaae.org' };

async function main() {
  const files = fs.readdirSync(photoDir).filter((f) => /\.jpe?g$/i.test(f)).sort();
  const bytes = files.map((f) => fs.readFileSync(path.join(photoDir, f)));
  const photos = await Promise.all(bytes.map(async (b, i) => {
    const size = imagePixelSize(b)!;
    const a = await analysePhotoAsync(b);
    return { photoIndex: i, width: size.width, height: size.height, salient: a.salient, quiet: a.quiet, quietLuminance: a.quietLuminance };
  }));
  const rtl = dirArg === 'rtl';
  const text = rtl ? sorani : latin;
  const choice: ArtDirectionChoice = {
    recipe: recipeArg as RecipeId,
    heroPhotoIndex: 0,
    texturePhotoIndex: 4,
    cutoutPhotoIndex: null,
    slots: [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'accent' }, { copyIndex: 2, slot: 'body' }, { copyIndex: 3, slot: 'cta' }],
    params: { fadeShare: 0.48, frame: 'inset', align: 'start' },
  };
  const layout = solveRecipe({
    width: W, height: H, choice, copy: { text }, photos, palette, logoAspect: 1,
  });
  const out = renderLayoutV2(layout, {
    copyText: text,
    logoDataUri: getKaaeOfficialLogoDataUri()!,
    photoFiles: bytes.map((b) => ({ bytes: b, mediaType: 'image/jpeg' })),
  });
  fs.mkdirSync(outDir, { recursive: true });
  const name = `${recipeArg}_${sizeArg}_${dirArg}`;
  fs.writeFileSync(path.join(outDir, `${name}.png`), out.png);
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(layout, null, 2));
  console.log(path.join(outDir, `${name}.png`));
}

main().catch((e) => { console.error(e); process.exit(1); });
