import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildLayoutV3SystemPrompt,
  buildLayoutV3UserPrompt,
  paletteRepairColours,
  composeArtPrompt,
  deriveConditionedArtPrompt,
  studioReferenceFromRaw,
  findClientPack,
  type StudioLayoutV2,
} from '../src/index.js';

/**
 * ADR-038: shared design code names no client. Who a client is lives in its pack's profile; its
 * colours come from its own reference pack. These fail if KAAE's identity or palette returns to code
 * every client's designs pass through.
 */
const KAAE_IDENTITY = /KAAE|Kurdistan Accredit|academic gravitas|statutory authority/i;
const KAAE_COLOURS = /#0A1628|#1E3A5F|#4770A3|#F7B500|#FDF8F3|#C5A059|#162B48/i;
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/studio');

/** A source file's code with its comments removed, so a comment explaining the change is allowed. */
const codeOf = (file: string) =>
  readFileSync(path.join(SRC, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

describe('the prompts every client shares', () => {
  it('name no client and no client colour in the layout system prompt', () => {
    const prompt = buildLayoutV3SystemPrompt();
    expect(prompt).not.toMatch(KAAE_IDENTITY);
    expect(prompt).not.toMatch(KAAE_COLOURS);
    expect(prompt).toContain('never borrow another client');
  });

  it('carry the client in the request, from its pack', () => {
    const zar = findClientPack('zar-podcast')!;
    const common = { brief: 'Episode 14', copyBlocks: [{ index: 0, text: 'Why cities flood', role: 'title' as const, script: 'latin' as const }], palette: ['#E10600', '#111111', '#FFFFFF'], canvasWidth: 1280, canvasHeight: 720 };
    expect(buildLayoutV3UserPrompt({ ...common, clientProfile: zar.profile })).toContain(`CLIENT:\n${zar.profile}`);
    expect(buildLayoutV3UserPrompt(common)).toContain('invent no brand identity');
    expect(buildLayoutV3UserPrompt(common)).not.toMatch(KAAE_IDENTITY);
  });

  it('keep KAAE itself in its own pack', () => {
    expect(findClientPack('kaae')!.profile).toMatch(/Kurdistan Accrediting Agency for Education/);
    for (const code of ['zar-podcast', 'halwest-news', 'kawa-ba-hawlery', 'erbil-edition']) {
      expect(findClientPack(code)!.profile).toContain('not set yet');
    }
  });

  it('have no KAAE identity or palette in the judge, critique, layout or art code', () => {
    for (const file of ['pairwise-judge-v3.ts', 'box-critique-v3.ts', 'layout-generator-v3.ts', 'art-generator-v3.ts', 'gemini-image-provider.ts', 'motifs.ts', 'hard-qa.ts']) {
      const code = codeOf(file);
      expect(code, file).not.toMatch(KAAE_IDENTITY);
    }
    // KAAE's colours may appear only as points to find the nearest client colour to, never drawn.
    for (const file of ['layout-generator-v3.ts', 'art-generator-v3.ts', 'gemini-image-provider.ts', 'hard-qa.ts']) {
      expect(codeOf(file), file).not.toMatch(KAAE_COLOURS);
    }
    expect(codeOf('pairwise-judge-v3.ts')).toContain('${options.clientProfile');
  });
});

describe('colours come from the client', () => {
  it('repairs contrast with the palette it is given', () => {
    const repair = paletteRepairColours(['#E10600', '#111111', '#FFFFFF']);
    expect(repair.darkest).toBe('#111111');
    expect(repair.lightest).toBe('#FFFFFF');
    expect(repair.accentOnDark(0.005, 3)).toBe('#E10600');
  });

  it('falls back to neutral greys, not KAAE, with no palette', () => {
    const repair = paletteRepairColours([]);
    expect([repair.darkest, repair.lightest, repair.deepAlternative, repair.accentOnDark(0.005, 3)].join(' ')).not.toMatch(KAAE_COLOURS);
  });

  it('asks for art in the layout\'s colours, and in neutral tones with none', () => {
    expect(composeArtPrompt('abstract', { palette: [] })).not.toMatch(KAAE_COLOURS);
    const layout = { width: 1280, height: 720, background: { color: '#111111' }, shapes: [{ color: '#E10600' }], text: [], art: { source: 'generated', box: { x: 0, y: 0, width: 1280, height: 720 }, calmRegion: { x: 100, y: 100, width: 400, height: 200 } } } as unknown as StudioLayoutV2;
    const prompt = deriveConditionedArtPrompt(layout);
    expect(prompt).toContain('#111111, #E10600');
    expect(prompt).not.toMatch(/navy|academic/i);
  });

  it('refuses a reference pack that names no palette instead of lending one', () => {
    expect(() => studioReferenceFromRaw({ rules: {} })).toThrow(/names no palette/);
    expect(studioReferenceFromRaw({ rules: { palette: ['#E10600', '#111111'] } }).palette).toEqual(['#E10600', '#111111']);
  });
});
