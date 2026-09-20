import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  admittedFontFaces,
  admittedFontFor,
  buildLayoutV3SystemPrompt,
  buildLayoutV3UserPrompt,
  fontCoversText,
  fontFaceSupports,
  loadRenderFontRegistry,
  sanitizeFontsV3,
  type StudioLayoutV2,
} from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures');

const ARABIC_RANGE = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
const LATIN_RANGE = /[A-Za-zÀ-ɏ]/;

/**
 * The client's own copy, as committed. Each fixture under test/fixtures carries the copy of a real
 * KAAE task under `copy`, either as the blocks of one design or keyed by language. Nothing here
 * lists letters: the alphabet a face has to draw is whatever the client has actually written, so a
 * new line with a letter no admitted face covers fails this file instead of rendering .notdef.
 */
function clientCopyBlocks(): string[] {
  const blocks: string[] = [];
  for (const file of fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))) {
    const copy = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8')).copy;
    if (Array.isArray(copy)) blocks.push(...copy.filter((c) => typeof c === 'string'));
    else if (copy && typeof copy === 'object') {
      for (const value of Object.values(copy)) {
        if (Array.isArray(value)) blocks.push(...value.filter((c) => typeof c === 'string'));
        else if (typeof value === 'string') blocks.push(value);
      }
    }
  }
  return blocks;
}

function charactersInRange(range: RegExp): Set<string> {
  const found = new Set<string>();
  for (const block of clientCopyBlocks()) {
    for (const ch of Array.from(block)) if (range.test(ch)) found.add(ch);
  }
  return found;
}

const chars = (s: string) => new Set(Array.from(s));

describe('render-fonts.json — the characters a face has to draw', () => {
  it('requires exactly the characters the client has written in each script', () => {
    const registry = loadRenderFontRegistry();
    const sorani = charactersInRange(ARABIC_RANGE);
    const latin = charactersInRange(LATIN_RANGE);
    // Guards against a fixture read that silently returns nothing.
    expect(sorani.size).toBeGreaterThan(25);
    expect(latin.size).toBeGreaterThan(25);
    expect(chars(registry.scripts.arabic.requiredCharacters)).toEqual(sorani);
    expect(chars(registry.scripts.latin.requiredCharacters)).toEqual(latin);
    expect(registry.scripts.arabic.requiredCharacters.length).toBe(sorani.size);
    expect(registry.scripts.latin.requiredCharacters.length).toBe(latin.size);
  });
});

describe('admitted faces — measured against the real font files', () => {
  it('offers no Sorani display face that cannot draw every Sorani letter in the client copy', () => {
    const required = [...charactersInRange(ARABIC_RANGE)].join('');
    const faces = admittedFontFaces({ script: 'arabic', role: 'display' });
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      const coverage = fontCoversText(face.name, required);
      expect({ face: face.name, missing: coverage.missing }).toEqual({ face: face.name, missing: [] });
    }
  });

  it('drops Cairo, because its file has no glyph for five of those letters', () => {
    const required = [...charactersInRange(ARABIC_RANGE)].join('');
    // The reason, measured rather than asserted: Cairo is still declared in render-fonts.json and
    // is refused by the coverage check alone. ە is among the most common characters in Sorani.
    expect(new Set(fontCoversText('Cairo', required).missing)).toEqual(chars('ڕڵۆێە'));
    expect(loadRenderFontRegistry().families['Cairo'].admitted).toBe(true);
    expect(admittedFontFaces({ script: 'arabic', role: 'display' }).map((f) => f.name)).not.toContain('Cairo');
    expect(admittedFontFor('Cairo', 'arabic', 'title')).not.toBe('Cairo');
  });

  it('offers no face for a weight it has no file for, so the preview and Canva agree', () => {
    const regular = admittedFontFaces({ script: 'arabic', role: 'display' }).map((f) => f.name);
    const bold = admittedFontFaces({ script: 'arabic', role: 'display', bold: true }).map((f) => f.name);
    // Amiri used to fail this: the registry declared Amiri-Regular.ttf alone, so it was not an
    // answer to "which face carries this bold block" — the preview drew such a title regular while
    // the deck set a real bold in Canva. Amiri-Bold.ttf was added on 2026-09-20, so it is now
    // offered for both weights, and the divergence it caused is gone.
    expect(regular).toContain('Amiri');
    expect(bold).toContain('Amiri');
    expect(bold).toContain('Noto Sans Arabic');
    expect(admittedFontFor('Montserrat', 'arabic', 'title', { bold: true })).toBe('Amiri');
    expect(admittedFontFor('Montserrat', 'arabic', 'title', { bold: false })).toBe('Amiri');

    // The rule the Amiri case was an instance of, asserted directly rather than through one
    // family, so it keeps holding when the registry changes again: nothing is offered for bold
    // unless the registry declares a file for that weight.
    const registry = JSON.parse(
      fs.readFileSync(path.join(here, '../src/studio/render-fonts.json'), 'utf8')
    );
    for (const face of bold) {
      expect({ face, hasBoldFile: Boolean(registry.families[face]?.files?.bold) }).toEqual({
        face,
        hasBoldFile: true,
      });
    }
  });

  it('can draw every weight it offers with the file the renderer would load', () => {
    // The direction that matters: a face offered for bold must be one fontFaceSupports will let the
    // renderer emit a bold axis for. The reverse is allowed — a file may sit in assets/fonts
    // without being declared, and then it is simply not used.
    for (const script of ['latin', 'arabic'] as const) {
      for (const role of ['display', 'body'] as const) {
        for (const face of admittedFontFaces({ script, role, bold: true })) {
          expect({ face: face.name, bold: fontFaceSupports(face.name, true).bold }).toEqual({
            face: face.name,
            bold: true,
          });
        }
      }
    }
  });

  it('declares no font file it does not have', () => {
    const registry = loadRenderFontRegistry();
    for (const [script, role] of [
      ['latin', 'display'],
      ['latin', 'body'],
      ['arabic', 'display'],
      ['arabic', 'body'],
    ] as const) {
      for (const face of admittedFontFaces({ script, role })) {
        expect({ face: face.name, weights: [...face.weights].sort() }).toEqual({
          face: face.name,
          weights: Object.keys(registry.families[face.name].files).sort(),
        });
      }
    }
  });
});

describe('admitted faces — the Latin choices are unchanged', () => {
  it('maps every Latin block exactly as it did before the registry', () => {
    expect(admittedFontFor('Montserrat', 'latin', 'title')).toBe('Cinzel');
    expect(admittedFontFor('Lora', 'latin', 'title')).toBe('Playfair Display');
    expect(admittedFontFor('Cinzel', 'latin', 'title')).toBe('Cinzel');
    expect(admittedFontFor('Playfair Display', 'latin', 'subtitle')).toBe('Playfair Display');
    expect(admittedFontFor('Verdana', 'latin', 'title')).toBe('Verdana');
    expect(admittedFontFor('Cinzel', 'latin', 'body')).toBe('Verdana');
    expect(admittedFontFor('Cinzel', 'latin', 'footer')).toBe('Verdana');
    expect(admittedFontFor('Amiri', 'latin', 'title')).toBe('Cinzel');
  });

  it('keeps a Latin face bold, because all three have a bold file', () => {
    for (const font of ['Cinzel', 'Playfair Display', 'Verdana']) {
      expect(admittedFontFor(font, 'latin', 'title', { bold: true })).toBe(font);
    }
    expect(admittedFontFor('Montserrat', 'latin', 'title', { bold: true })).toBe('Cinzel');
  });

  it('leaves a Latin design untouched through sanitizeFontsV3', () => {
    const layout = latinLayout();
    const before = layout.text.map((t) => ({ font: t.fontFamily, rtl: t.rtl }));
    sanitizeFontsV3(layout, {
      text: {
        0: 'Mandatory Quality Standards 2026',
        1: 'All universities must publish audited accreditation reports.',
      },
    });
    expect(layout.text.map((t) => ({ font: t.fontFamily, rtl: t.rtl }))).toEqual(before);
  });
});

describe('admitted faces — the registry is the source', () => {
  it('stops offering a family the moment render-fonts.json stops declaring it', () => {
    const registryPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-fonts-')), 'render-fonts.json');
    const registry = JSON.parse(
      fs.readFileSync(path.join(here, '../src/studio/render-fonts.json'), 'utf8')
    );
    expect(admittedFontFaces({ script: 'arabic', role: 'display', registryPath: undefined }).map((f) => f.name)).toContain(
      'Amiri'
    );
    delete registry.families['Amiri'];
    fs.writeFileSync(registryPath, JSON.stringify(registry));
    const faces = admittedFontFaces({ script: 'arabic', role: 'display', registryPath }).map((f) => f.name);
    expect(faces).not.toContain('Amiri');
    // What is left, in the registry's own rank order. IBM Plex Sans Arabic was added on 2026-09-20
    // at a rank below the incumbents, so it is offered as a choice without displacing the face an
    // unchosen block falls back to.
    expect(faces).toEqual(['Noto Sans Arabic', 'IBM Plex Sans Arabic']);
    expect(admittedFontFor('Amiri', 'arabic', 'title', { registryPath })).toBe('Noto Sans Arabic');
  });
});

describe('the layout model is told the faces the pipeline will accept', () => {
  const prompts = () => {
    const system = buildLayoutV3SystemPrompt();
    const user = buildLayoutV3UserPrompt({
      brief: 'A Kurdish announcement',
      copyBlocks: [{ index: 0, text: 'ڕاپۆرتی ساڵانە', role: 'title', script: 'arabic' }],
      palette: ['#0A1628', '#C5A059', '#FDF8F3'],
      canvasWidth: 1080,
      canvasHeight: 1350,
      logoAspect: 1,
      exemplars: [],
      isRtl: true,
    } as any);
    return `${system}\n${user}`;
  };

  it('names every admitted display face for each script', () => {
    const text = prompts();
    for (const script of ['latin', 'arabic'] as const) {
      for (const face of admittedFontFaces({ script, role: 'display' })) {
        expect(text).toContain(face.name);
      }
    }
  });

  it('never names a face the pipeline would overwrite', () => {
    // Cairo was named in three prompt strings while sanitizeFontsV3 replaced it, so the model was
    // asked to choose a family that could not reach a design.
    expect(prompts()).not.toContain('Cairo');
  });
});

describe('sanitizeFontsV3 — enforcement stays here', () => {
  it('keeps each script on its own admitted face and swaps a face that cannot draw the copy', () => {
    const layout = bilingualLayout();
    sanitizeFontsV3(layout, { text: { 0: 'Annual Report', 1: 'ڕاپۆرتی ساڵانە', 2: 'ڕاپۆرتی ساڵانە' } });
    expect(layout.text[0].fontFamily).toBe('Cinzel');
    // Cairo is refused for the script, not corrected after the fact.
    expect(layout.text[1].fontFamily).toBe('Amiri');
    expect(layout.text[1].rtl).toBe(true);
    // The typeface a design chose is kept. The weight used to go with it here, because Amiri had
    // no Bold file; it now has one, so a bold Kurdish title survives and the deck and the preview
    // set the same weight. The weight-stripping path itself is covered by the test below, against
    // a face that genuinely has no file for the weight.
    expect(layout.text[2].fontFamily).toBe('Amiri');
    expect(layout.text[2].bold).toBe(true);
  });

  it('leaves the weight alone on a face that has a bold file', () => {
    const layout = bilingualLayout();
    layout.text[2].fontFamily = 'Noto Sans Arabic';
    sanitizeFontsV3(layout, { text: { 0: 'Annual Report', 1: 'ڕاپۆرتی ساڵانە', 2: 'ڕاپۆرتی ساڵانە' } });
    expect(layout.text[2].fontFamily).toBe('Noto Sans Arabic');
    expect(layout.text[2].bold).toBe(true);
  });

  it('lets a design keep a second admitted Sorani face rather than forcing one family', () => {
    const layout = bilingualLayout();
    layout.text[1].fontFamily = 'Noto Sans Arabic';
    sanitizeFontsV3(layout, { text: { 0: 'Annual Report', 1: 'ڕاپۆرتی ساڵانە', 2: 'ڕاپۆرتی ساڵانە' } });
    expect(layout.text[1].fontFamily).toBe('Noto Sans Arabic');
  });
});

const W = 1080;
const H = 1350;

const text = (over: Record<string, unknown>) =>
  ({
    copyIndex: 0,
    role: 'title',
    x: 76,
    y: 300,
    width: 928,
    height: 120,
    fontSize: 48,
    lineHeight: 1.3,
    letterSpacing: 0,
    fontFamily: 'Cinzel',
    color: '#FDF8F3',
    align: 'center',
    bold: false,
    italic: false,
    rtl: false,
    ...over,
  }) as any;

const shell = (blocks: unknown[]): StudioLayoutV2 =>
  ({
    width: W,
    height: H,
    background: { color: '#0A1628' },
    grid: { columns: 6, margin: 76, gutter: 26 },
    typeScale: { base: 18, ratio: 1.333 },
    text: blocks,
    shapes: [],
  }) as unknown as StudioLayoutV2;

const latinLayout = () =>
  shell([
    text({ copyIndex: 0, role: 'title', fontFamily: 'Cinzel', bold: true }),
    text({ copyIndex: 1, role: 'body', y: 500, fontSize: 20, fontFamily: 'Verdana' }),
  ]);

const bilingualLayout = () =>
  shell([
    text({ copyIndex: 0, role: 'title', fontFamily: 'Montserrat' }),
    // Cairo is declared in render-fonts.json and has no glyph for ڕ or ێ.
    text({ copyIndex: 1, role: 'title', y: 500, fontFamily: 'Cairo', rtl: true }),
    text({ copyIndex: 2, role: 'title', y: 700, fontFamily: 'Amiri', rtl: true, bold: true }),
  ]);
