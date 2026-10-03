import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { analysePhotoAsync } from '../src/studio/art-direction/photo-analysis.js';
import { defaultChoice } from '../src/studio/art-direction/generate.js';
import { solveRecipe, type SolverPhoto } from '../src/studio/art-direction/solver.js';
import type { PhotoFacts } from '../src/studio/art-direction/recipes.js';
import { evaluateHardQa } from '../src/studio/hard-qa.js';
import { renderLayoutV2 } from '../src/studio/render-layout-v2.js';
import { selectOfficeLibraryPhotos } from '../src/studio/office-photo-library.js';
import { ingestOfficePhotoFolder, loadOfficeLibraryPhoto, officePhotoClientDir, parseOfficePhotoTagSheet, readOfficePhotoLibrary } from '../src/studio/office-photo-library-store.js';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';
import { syntheticPhoto } from './fixtures/synthetic-photos.js';

/**
 * ADR-280 end to end, deterministic and local: a text-only KAAE brief, a synthetic photo ingested
 * into a library and tagged, retrieved for the brief, set through the house photo recipes by the
 * solver, rendered, and held to hard QA with contrast measured on the rendered pixels. With
 * HAWA_PROOF_DIR set, the renders are written there to be looked at.
 */

const PALETTE = ['#0A1628', '#1E3A5F', '#4770A3', '#F7B500', '#FDF8F3', '#FFFFFF', '#1A1A1A'];
const COPY = { 0: 'KAAE K-12 Pilot Study', 1: 'Field Visit Report', 2: 'Insights from KAAE school field visits and next steps', 3: 'kaae.org' };
const ROLES = ['title', 'subtitle', 'body', 'cta'] as const;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('a text-only KAAE brief designed with a library photo (ADR-280)', () => {
  it.each(['hero_fade_report', 'scrim_caption'] as const)('%s: retrieved, solved, rendered and passing hard QA', async (recipe) => {
    const source = mkdtempSync(path.join(tmpdir(), 'olp-e2e-src-'));
    const root = mkdtempSync(path.join(tmpdir(), 'olp-e2e-lib-'));
    dirs.push(source, root);
    writeFileSync(path.join(source, 'school-visit.png'), syntheticPhoto(1200, 1500, 21));
    writeFileSync(path.join(source, 'signing.png'), syntheticPhoto(1500, 1000, 22, [120, 90, 70]));
    const tags = parseOfficePhotoTagSheet([
      'source,description,subjects,events,keywords,shot,people,consent,usable',
      'school-visit.png,KAAE evaluators with pupils in a school classroom,school; k12,field visit,pilot; students,classroom_or_interior,yes,granted,yes',
      'signing.png,Partnership signing at the ministry,ministry,signing,agreement,event_or_stage,yes,granted,yes',
    ].join('\n'), 'csv');
    await ingestOfficePhotoFolder({ sourceDir: source, libraryRoot: root, clientId: 'kaae', tagRows: tags, now: () => new Date('2026-10-03T00:00:00.000Z') });
    const dir = officePhotoClientDir(root, 'kaae');
    const lib = (await readOfficePhotoLibrary(dir))!.library;

    const selection = selectOfficeLibraryPhotos(lib, { copy: Object.values(COPY), width: 1080, height: 1350 });
    expect(selection.picks.map((p) => lib.photos.find((e) => e.id === p.id)!.sourceName)).toEqual(['school-visit.png']);
    const entry = lib.photos.find((e) => e.id === selection.picks[0].id)!;
    const { bytes } = await loadOfficeLibraryPhoto(dir, entry);

    // What Core's photoFactsFor gives the solver for this photo (no face detector here).
    const analysis = await analysePhotoAsync(bytes);
    const facts: Array<PhotoFacts & SolverPhoto> = [{ photoIndex: 0, width: entry.width, height: entry.height, shot: entry.tags.shot,
      quietArea: entry.features.quietArea, sharpness: analysis.sharpness, localQuiet: analysis.quiet, salient: analysis.salient, quiet: analysis.quiet, quietLuminance: analysis.quietLuminance }];
    const choice = defaultChoice(recipe, facts, ROLES.map((role, index) => ({ index, text: COPY[index as 0], role, script: 'latin' as const })));
    const layout = solveRecipe({ width: 1080, height: 1350, copy: { text: COPY }, photos: facts, palette: PALETTE, logoAspect: 1, choice,
      photoSelection: { mode: 'choose', minimum: 1 } });
    expect(layout.artDirection?.recipe).toBe(recipe);
    expect((layout.photos ?? []).map((p) => p.photoIndex)).toContain(0);

    const render = renderLayoutV2(layout, { copyText: COPY, logoDataUri: KAAE_TEST_LOGO, photoFiles: [{ bytes }] });
    const qa = evaluateHardQa(layout, {
      width: 1080, height: 1350, copyScripts: ['latin', 'latin', 'latin', 'latin'], latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic',
      palette: PALETTE, logoAspect: 1, copyText: COPY, photoCount: 1, photoSelection: { mode: 'choose', minimum: 1 },
      renderedComposite: render.noTextPng,
    });
    expect(qa.messages).toEqual([]);
    expect(qa.passed).toBe(true);
    for (const t of layout.text) expect(qa.measuredContrast![t.copyIndex]).toBeGreaterThanOrEqual(3);
    // Every copy block is set exactly as given: the photo adds no words.
    expect(layout.text.map((t) => t.copyIndex).sort()).toEqual([0, 1, 2, 3]);

    const proofDir = process.env.HAWA_PROOF_DIR;
    if (proofDir) {
      mkdirSync(proofDir, { recursive: true });
      writeFileSync(path.join(proofDir, `office_library_${recipe}.png`), render.png);
      writeFileSync(path.join(proofDir, `office_library_${recipe}.json`), `${JSON.stringify({ recipe, pick: selection.picks[0], qa: { passed: qa.passed, messages: qa.messages, measuredContrast: qa.measuredContrast } }, null, 2)}\n`);
    }
  }, 60_000);
});
