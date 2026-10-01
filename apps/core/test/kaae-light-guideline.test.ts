import { KAAE_TEST_CLIENT_LOGO } from './fixtures/kaae-logo.js';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  artDirectionRulesFromRaw,
  calculateLuminanceContrastRatio,
  creativeAssetPath,
  declaredBackgroundColour,
  hexToLuminance,
  imagePixelSize,
  photoSelectionFromInstructions,
  renderLayoutV2,
  requiredContrast,
  resolveOrnamentSettings,
  studioReferenceFromRaw,
  tonePreferenceFromWords,
  PNG,
  type StudioLayoutV2,
} from '@hawa/creative';
import { kaaeClientDNA } from '@hawa/domain';
import type { CandidateState, CreativeBrief, StageContext } from '../src/services/design-studio/types.js';
import { runLayoutsStage, runRenderStage, rankStudioCandidatesV3, layoutBriefV3 } from '../src/services/design-studio/stages/index.js';
import { requestedBackgroundFor } from '../src/services/design-studio/stages/brief.stage.js';
import { paletteFallbacksOf } from '../src/services/client-design-reference.js';

/**
 * ADR-236 (owner, 2026-10-01: the "Brand guideline PDF" palette): KAAE's designs follow the brand
 * guideline, light first. Its pages are white (and its cover cream) under an indigo band; its palette
 * page lists #E8B85C, #4770A3, #FFF2DB, #17087A, #3833A3, #0F73DE; its body text is black. Before,
 * the reference carried a navy set written for one dark invitation, and 46 of 46 recent drafts were
 * navy.
 *
 * These run the real layout stage, preparation, render and hard QA, with the layout model mocked:
 * the live Quality Assurance Workshop copy as a text-only poster, a one-photo report, and an evening
 * invitation that stays dark. HAWA_LIGHT_PROOF_OUT writes every candidate's PNG there;
 * HAWA_ART_DIRECTION_ALBUM points at a folder of real photo0.jpg.. for the photo proof.
 */

const REFERENCE = JSON.parse(readFileSync(creativeAssetPath('kaae-reference.json'), 'utf8'));
const PALETTE: string[] = REFERENCE.rules.palette;
const OUT = process.env.HAWA_LIGHT_PROOF_OUT;
const RECEIPT = { responseId: 'resp_light', xRequestId: null, model: 'mock', inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0, latencyMs: 0 };

const INDIGO = '#17087A';
const ROYAL = '#3833A3';
const BLUE = '#4770A3';
const GOLD = '#E8B85C';
const CREAM = '#FFF2DB';
const WHITE = '#FFFFFF';
const INK = '#000000';

function mockClient(answer: unknown, requests: any[] = []) {
  return {
    requests,
    createStructuredCompletion: async (req: any) => {
      requests.push(req);
      return { data: answer, rawText: JSON.stringify(answer), receipt: RECEIPT };
    },
  };
}

function baseContext(over: Partial<StageContext>): StageContext {
  return {
    runId: randomUUID(), tenantId: randomUUID(), taskId: randomUUID(), clientId: REFERENCE.clientId, actorId: 'light-proof',
    width: 1080, height: 1350, tier: 'standard', instructions: '',
    copyBlocks: [],
    referencePack: { palette: PALETTE, referenceFonts: { latin: 'Verdana', arabic: 'Noto Sans Arabic' }, clientId: REFERENCE.clientId },
    promotedRules: studioReferenceFromRaw(REFERENCE).promotedRules, latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', logoAspect: 1,
    logo: KAAE_TEST_CLIENT_LOGO, pipelineV3: true, imageryStrategy: 'none',
    ornament: resolveOrnamentSettings({}),
    artDirectionRules: artDirectionRulesFromRaw(REFERENCE),
    ...over,
  } as StageContext;
}

function briefFor(roles: Array<CreativeBrief['roles'][number]['role']>, over: Partial<CreativeBrief> = {}): CreativeBrief {
  return {
    occasion: 'KAAE announcement', audience: 'school leaders', formality: 4, toneWords: ['formal', 'institutional', 'calm'],
    readingOrder: roles.map((_, i) => i), roles: roles.map((role, copyIndex) => ({ copyIndex, role, importance: copyIndex === 0 ? 5 : 3 })),
    must: [], mustNot: [], imageryStrategy: 'none', imageryRationale: '', kurdishLeads: false, riskFlags: [],
    ...over,
  } as CreativeBrief;
}

const text = (copyIndex: number, role: string, box: [number, number, number, number], px: number, color: string, opts: Partial<Record<string, unknown>> = {}) => ({
  copyIndex, role, x: box[0], y: box[1], width: box[2], height: box[3], fontSize: px / 1350, lineHeight: role === 'title' ? 1.2 : 1.45,
  letterSpacing: 0, fontFamily: role === 'title' || role === 'subtitle' ? 'Playfair Display' : 'Verdana', color, align: 'left',
  bold: role === 'title' || role === 'date', italic: false, rtl: false, ...opts,
});
const shape = (role: 'panel' | 'rule' | 'accent', box: [number, number, number, number], color: string) => ({
  x: box[0], y: box[1], width: box[2], height: box[3], kind: 'rect', color, opacity: 1, radius: 0, strokeWidth: null, strokeColor: null, role,
});
const candidate = (id: string, archetype: string, background: string, logo: [number, number], shapes: unknown[], texts: unknown[]) => ({
  id, conceptTitle: id, compositionArchetype: archetype, typeScale: { base: 22, ratio: 1.333 },
  grid: { margin: 0.07, columns: 12, gutter: 0.02, baseline: 0.006 }, background: { color: background },
  logo: { x: logo[0], y: logo[1], width: 0.12, height: 0.096 }, art: null, photos: [], shapes, text: texts,
});

/** The live text-only poster (task of 2026-10-01): a title and four short lines. */
const QA_COPY = ['Quality Assurance Workshop', 'For school principals', '22 October 2026 · 10:00 AM', 'Divan Hotel, Erbil', 'Seats are limited, please register early'];
const QA_ROLES = ['title', 'subtitle', 'date', 'venue', 'body'] as const;

/** What a layout model following the guideline's rules proposes: three light pages. */
const LIGHT_POSTER_ANSWER = {
  layouts: [
    candidate('guideline-band', 'split_statutory_banner', WHITE, [0.08, 0.055], [
      shape('panel', [0, 0, 1, 0.4], INDIGO),
      shape('rule', [0.08, 0.345, 0.11, 0.003], GOLD),
      shape('rule', [0.08, 0.705, 0.84, 0.0015], GOLD),
      shape('panel', [0, 0.965, 1, 0.035], INDIGO),
    ], [
      text(0, 'title', [0.08, 0.2, 0.84, 0.125], 66, WHITE),
      text(1, 'subtitle', [0.08, 0.455, 0.84, 0.04], 34, ROYAL, { italic: true }),
      text(2, 'date', [0.08, 0.545, 0.84, 0.035], 30, INK),
      text(3, 'venue', [0.08, 0.6, 0.84, 0.035], 28, BLUE),
      text(4, 'body', [0.08, 0.735, 0.84, 0.035], 24, INK),
    ]),
    candidate('cream-monolith', 'monolith_centered', CREAM, [0.44, 0.07], [
      shape('rule', [0.45, 0.415, 0.1, 0.003], GOLD),
      shape('panel', [0.15, 0.55, 0.7, 0.17], WHITE),
      shape('rule', [0.45, 0.86, 0.1, 0.003], GOLD),
    ], [
      text(0, 'title', [0.1, 0.25, 0.8, 0.14], 70, INDIGO, { align: 'center' }),
      text(1, 'subtitle', [0.1, 0.44, 0.8, 0.045], 34, ROYAL, { align: 'center', italic: true }),
      text(2, 'date', [0.18, 0.585, 0.64, 0.04], 30, INK, { align: 'center' }),
      text(3, 'venue', [0.18, 0.645, 0.64, 0.035], 28, BLUE, { align: 'center' }),
      text(4, 'body', [0.1, 0.785, 0.8, 0.035], 24, INK, { align: 'center' }),
    ]),
    candidate('white-editorial', 'asymmetric_editorial', WHITE, [0.08, 0.06], [
      shape('accent', [0.08, 0.235, 0.008, 0.27], INDIGO),
      shape('panel', [0, 0.69, 1, 0.31], INDIGO),
      shape('rule', [0.08, 0.86, 0.1, 0.003], GOLD),
    ], [
      text(0, 'title', [0.115, 0.235, 0.8, 0.2], 78, INDIGO),
      text(1, 'subtitle', [0.115, 0.455, 0.8, 0.045], 34, ROYAL, { italic: true }),
      text(2, 'date', [0.08, 0.74, 0.84, 0.04], 34, WHITE),
      text(3, 'venue', [0.08, 0.795, 0.84, 0.035], 28, CREAM),
      text(4, 'body', [0.08, 0.885, 0.84, 0.035], 24, WHITE),
    ]),
  ],
};

/** An evening invitation, and what the model proposes for it once told its ground is indigo. */
const GALA_COPY = ['An Evening of Accreditation', 'KAAE Annual Gala Dinner', 'Thursday 12 November 2026 · 7:00 PM', 'Rotana Hotel, Erbil', 'By invitation only'];
const GALA_ROLES = ['subtitle', 'title', 'date', 'venue', 'footer'] as const;
const GALA_ANSWER = {
  layouts: [
    candidate('gala-centred', 'commencement_diploma_frame', INDIGO, [0.44, 0.08], [
      shape('rule', [0.45, 0.47, 0.1, 0.003], GOLD),
      shape('rule', [0.45, 0.76, 0.1, 0.003], GOLD),
    ], [
      text(0, 'subtitle', [0.1, 0.26, 0.8, 0.045], 32, GOLD, { align: 'center', italic: true }),
      text(1, 'title', [0.1, 0.32, 0.8, 0.13], 70, WHITE, { align: 'center' }),
      text(2, 'date', [0.1, 0.52, 0.8, 0.04], 30, CREAM, { align: 'center' }),
      text(3, 'venue', [0.1, 0.575, 0.8, 0.035], 28, CREAM, { align: 'center' }),
      text(4, 'footer', [0.1, 0.8, 0.8, 0.03], 22, GOLD, { align: 'center' }),
    ]),
    candidate('gala-royal-band', 'crest_banner_split', INDIGO, [0.08, 0.06], [
      shape('panel', [0, 0.5, 1, 0.26], ROYAL),
      shape('rule', [0.08, 0.455, 0.1, 0.003], GOLD),
    ], [
      text(0, 'subtitle', [0.08, 0.24, 0.84, 0.045], 32, GOLD, { italic: true }),
      text(1, 'title', [0.08, 0.3, 0.84, 0.13], 70, WHITE),
      text(2, 'date', [0.08, 0.56, 0.84, 0.04], 32, WHITE),
      text(3, 'venue', [0.08, 0.615, 0.84, 0.035], 28, CREAM),
      text(4, 'footer', [0.08, 0.85, 0.84, 0.03], 22, GOLD),
    ]),
    candidate('gala-editorial', 'asymmetric_editorial', INDIGO, [0.8, 0.06], [
      shape('accent', [0.08, 0.3, 0.006, 0.3], GOLD),
    ], [
      text(0, 'subtitle', [0.11, 0.3, 0.8, 0.045], 32, GOLD, { italic: true }),
      text(1, 'title', [0.11, 0.36, 0.8, 0.2], 78, WHITE),
      text(2, 'date', [0.11, 0.7, 0.8, 0.04], 30, CREAM),
      text(3, 'venue', [0.11, 0.75, 0.8, 0.035], 28, CREAM),
      text(4, 'footer', [0.11, 0.86, 0.8, 0.03], 22, GOLD),
    ]),
  ],
};

async function typographicRun(copy: readonly string[], roles: readonly CreativeBrief['roles'][number]['role'][], instructions: string, answer: unknown) {
  const requests: any[] = [];
  const client = mockClient(answer, requests);
  const brief = briefFor([...roles], { tonePreference: tonePreferenceFromWords(instructions) });
  const ctx = baseContext({
    instructions, client: client as any, copyBlocks: copy.map((t) => ({ text: t, script: 'latin' as const })),
    requestedBackground: requestedBackgroundFor(brief, PALETTE),
  });
  const candidates = await runLayoutsStage(ctx, brief, [], [0, 1, 2].map((ordinal) => ({ id: randomUUID(), ordinal })));
  const rendered = await runRenderStage(ctx, candidates);
  const ranked = rankStudioCandidatesV3(ctx, rendered);
  return { ctx, ranked, requests };
}

function save(name: string, layout: StudioLayoutV2, copy: readonly string[], photos?: Array<{ bytes: Buffer; mediaType: string }>) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  const png = renderLayoutV2(layout, {
    copyText: Object.fromEntries(copy.map((c, i) => [i, c])),
    logoDataUri: `data:image/png;base64,${KAAE_TEST_CLIENT_LOGO.bytes.toString('base64')}`,
    ...(photos ? { photoFiles: photos } : {}),
  }).png;
  writeFileSync(join(OUT, `${name}.png`), png);
}

describe('ADR-236: the KAAE palette is the brand guideline\'s, light first', () => {
  it('carries exactly the guideline\'s colours, white and cream first, and no midnight navy', () => {
    expect(PALETTE).toEqual([WHITE, CREAM, INDIGO, ROYAL, BLUE, '#0F73DE', GOLD, INK]);
    expect(PALETTE).not.toContain('#0A1628');
    expect(REFERENCE.rules.paletteFallbacks.background).toBe(WHITE);
    expect(hexToLuminance(REFERENCE.rules.paletteFallbacks.background)).toBeGreaterThan(0.85);
    expect(REFERENCE.rules.colorUsage).not.toMatch(/never use[^.]*indigo/i);
    expect(REFERENCE.rules.colorUsage).toMatch(/default page is White \(#FFFFFF\) or Cream \(#FFF2DB\)/);
    expect((REFERENCE.rules.artDirection as string[]).join(' ')).not.toMatch(/navy for fades, plates and scrims/);
  });

  it('gives the DNA fixture the same palette, its light grounds first', () => {
    const colours = kaaeClientDNA.colors.map((c) => c.hex.toUpperCase());
    expect([...colours].sort()).toEqual([...PALETTE].sort());
    expect(kaaeClientDNA.colors.filter((c) => c.role === 'background').map((c) => c.hex)).toEqual([WHITE, CREAM]);
    expect(paletteFallbacksOf(kaaeClientDNA.colors)).toEqual({ background: WHITE, text: INK, accent: GOLD });
  });

  it('falls back to the lightest background colour of a DNA, whatever order it lists them in', () => {
    const navyFirst = [
      { hex: '#0A1628', role: 'background' }, { hex: '#FDF8F3', role: 'background' }, { hex: '#FFFFFF', role: 'background' },
      { hex: '#1A1A1A', role: 'text' }, { hex: '#F7B500', role: 'accent' },
    ];
    expect(paletteFallbacksOf(navyFirst).background).toBe('#FFFFFF');
    expect(paletteFallbacksOf([{ hex: 'navy', role: 'background' }, { hex: '#102030', role: 'background' }]).background).toBe('#102030');
  });

  it('gives the layout call the client\'s light-first colour rules', () => {
    const line = layoutBriefV3(briefFor(['title']), { width: 1080, height: 1350, instructions: '', promotedRules: studioReferenceFromRaw(REFERENCE).promotedRules });
    expect(line).toContain('Client house rules (from its brand reference; data): KAAE brand guideline palette, light first.');
  });
});

describe('ADR-236: the requester\'s words set the ground, and an evening invitation stays dark', () => {
  it('turns "white", "like the brand book" and "dark navy" into the ground the studio applies', () => {
    const brief = (words: string) => ({ ...briefFor(['title']), requestedBackground: '', tonePreference: tonePreferenceFromWords(words) });
    expect(requestedBackgroundFor(brief('Please make it on a white background'), PALETTE)).toBe(WHITE);
    expect(requestedBackgroundFor(brief('Make it look like the brand book'), PALETTE)).toBe(WHITE);
    expect(requestedBackgroundFor(brief('a cream background please'), PALETTE)).toBe(CREAM);
    expect(requestedBackgroundFor(brief('use a dark navy background'), PALETTE)).toBe(INDIGO);
    expect(requestedBackgroundFor(brief('An invitation for our evening gala dinner'), PALETTE)).toBe(INDIGO);
    expect(requestedBackgroundFor(brief('A poster for the workshop'), PALETTE)).toBeUndefined();
  });

  it('never sets a ground in the guideline\'s black body ink: a navy request snaps to its indigo', () => {
    const brief = { ...briefFor(['title']), requestedBackground: '#0A1628' };
    expect(requestedBackgroundFor(brief, PALETTE)).toBe(INDIGO);
    // A model hex of the other tone gives way to the requester's words.
    expect(requestedBackgroundFor({ ...brief, tonePreference: tonePreferenceFromWords('on a white background') }, PALETTE)).toBe(WHITE);
  });

  it('keeps an evening invitation on indigo, even when every candidate came back light', async () => {
    const { ranked } = await typographicRun(GALA_COPY, GALA_ROLES, 'Please design an invitation for our evening gala dinner.', LIGHT_POSTER_ANSWER);
    for (const r of ranked) {
      expect(r.layout.background.color).toBe(INDIGO);
      // Every line was repaired to read on the indigo it now sits on.
      for (const t of r.layout.text) {
        const ratio = calculateLuminanceContrastRatio(hexToLuminance(t.color), hexToLuminance(declaredBackgroundColour(r.layout, t)));
        expect(ratio, `${t.role} ${t.color}`).toBeGreaterThanOrEqual(requiredContrast(t.fontSize, Boolean(t.bold)));
      }
      expect(r.hardQa?.passed, r.hardQa?.messages.join(' | ')).toBe(true);
    }
  }, 120000);
});

describe('ADR-236 proofs: light pages through the real stage, render and hard QA (model mocked)', () => {
  it('the Quality Assurance Workshop poster: three light candidates that pass hard QA', async () => {
    const { ranked, requests } = await typographicRun(QA_COPY, QA_ROLES, 'Design a poster for our Quality Assurance Workshop.', LIGHT_POSTER_ANSWER);
    // The layout call saw the guideline's rules.
    expect(JSON.stringify(requests[0].messages)).toContain('light first');
    expect(ranked).toHaveLength(3);
    for (const r of ranked) {
      expect([WHITE, CREAM]).toContain(r.layout.background.color.toUpperCase());
      expect(r.hardQa?.passed, `${r.layout.background.color}: ${r.hardQa?.messages.join(' | ')}`).toBe(true);
      save(`qa-workshop_${r.candidate.ordinal}`, r.layout, QA_COPY);
    }
  }, 120000);

  it('the evening gala invitation stays dark and passes hard QA', async () => {
    const { ranked } = await typographicRun(GALA_COPY, GALA_ROLES, 'Please design an invitation for our evening gala dinner.', GALA_ANSWER);
    for (const r of ranked) {
      expect(r.layout.background.color).toBe(INDIGO);
      expect(r.hardQa?.passed, r.hardQa?.messages.join(' | ')).toBe(true);
      save(`evening-gala_${r.candidate.ordinal}`, r.layout, GALA_COPY);
    }
  }, 120000);

  const REPORT_COPY = ['KAAE K-12 Pilot Study', 'Field Visit Report', 'Insights from KAAE school field visits and next steps toward stronger schools'];
  /** A bright, calm upper part and a busier lower part, seeded: a daylight interior. */
  function syntheticPhoto(): Buffer {
    const width = 1280, height = 853;
    const png = new PNG({ width, height });
    let s = 7919 + 17;
    const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4, calm = y < height * 0.35, n = calm ? 0 : Math.floor(rnd() * 90) - 45;
      png.data[i] = calm ? 232 : 150 + n + ((x >> 4) % 3) * 20; png.data[i + 1] = calm ? 236 : 120 + n; png.data[i + 2] = calm ? 240 : 90 + n; png.data[i + 3] = 255;
    }
    return PNG.sync.write(png);
  }
  const album = process.env.HAWA_ART_DIRECTION_ALBUM;
  const reportPhoto = album && existsSync(join(album, 'photo0.jpg'))
    ? { bytes: readFileSync(join(album, 'photo0.jpg')), mimeType: 'image/jpeg' as const }
    : { bytes: syntheticPhoto(), mimeType: 'image/png' as const };

  const concepts = (tone: 'navy' | 'cream' | 'auto') => ({
    concepts: [
      { id: 'fade', conceptNote: 'The library is the report; the scene fades into the page.', recipe: 'hero_fade_report', typicality: 0.8, heroPhotoIndex: 0, texturePhotoIndex: null, cutoutPhotoIndex: null,
        slots: [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'accent' }, { copyIndex: 2, slot: 'body' }], titleAccentWords: null, fadeShare: 0.48, surfaceTone: tone, frame: 'inset', align: 'start' },
      { id: 'card', conceptNote: 'The office carousel post: the photo above a card on the page.', recipe: 'hero_card', typicality: 0.6, heroPhotoIndex: 0, texturePhotoIndex: null, cutoutPhotoIndex: null,
        slots: [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'accent' }, { copyIndex: 2, slot: 'body' }], titleAccentWords: null, fadeShare: null, surfaceTone: tone, frame: 'outer', align: 'center' },
      { id: 'paper', conceptNote: 'The guideline page: an indigo band, the photo fading into the paper.', recipe: 'fade_to_paper', typicality: 0.4, heroPhotoIndex: 0, texturePhotoIndex: null, cutoutPhotoIndex: null,
        slots: [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'accent' }, { copyIndex: 2, slot: 'body' }], titleAccentWords: null, fadeShare: null, surfaceTone: tone, frame: 'none', align: 'start' },
    ],
  });

  async function photoRun(instructions: string, tone: 'navy' | 'cream' | 'auto') {
    const size = imagePixelSize(reportPhoto.bytes)!;
    const brief = briefFor(['title', 'subtitle', 'body'], { imageryStrategy: 'photographic', tonePreference: tonePreferenceFromWords(instructions), subjectTags: ['report_release', 'field_visit'] });
    const ctx = baseContext({
      instructions, client: mockClient(concepts(tone)) as any, imageryStrategy: 'photographic',
      copyBlocks: REPORT_COPY.map((t) => ({ text: t, script: 'latin' as const })),
      photoSelection: photoSelectionFromInstructions(instructions, 1),
      photos: [{ ...reportPhoto, dataUrl: `data:${reportPhoto.mimeType};base64,${reportPhoto.bytes.toString('base64')}`, width: size.width, height: size.height,
        review: { subjectFit: 5, shot: 'classroom_or_interior', quietArea: 'none' } }] as StageContext['photos'],
      requestedBackground: requestedBackgroundFor(brief, PALETTE),
    });
    const candidates = await runLayoutsStage(ctx, brief, [], [0, 1, 2].map((ordinal) => ({ id: randomUUID(), ordinal })));
    const ranked = rankStudioCandidatesV3(ctx, await runRenderStage(ctx, candidates));
    return ranked as Array<(typeof ranked)[number] & { candidate: CandidateState }>;
  }

  it('the one-photo report: with no tone asked, every recipe sits on the light page and passes hard QA', async () => {
    // The model still asks for navy out of habit: the photo is bright and nothing in the brief calls for dark.
    const ranked = await photoRun('Design a report post for KAAE using this photo and the text.', 'navy');
    expect(ranked.length).toBeGreaterThanOrEqual(2);
    for (const r of ranked) {
      const recipe = r.layout.artDirection?.recipe;
      expect(hexToLuminance(r.layout.background.color), `${recipe} ground`).toBeGreaterThan(0.7);
      for (const o of r.layout.overlays ?? []) expect(hexToLuminance(o.color)).toBeGreaterThan(0.7);
      expect(r.hardQa?.passed, `${recipe}: ${r.hardQa?.messages.join(' | ')}`).toBe(true);
      save(`photo-report_${recipe}`, r.layout, REPORT_COPY, [{ bytes: reportPhoto.bytes, mediaType: reportPhoto.mimeType }]);
    }
  }, 240000);

  it('"like the brand book" puts the photo report on white under the guideline\'s indigo band', async () => {
    const ranked = await photoRun('Design a report post for KAAE like the brand book, using this photo.', 'auto');
    const paper = ranked.find((r) => r.layout.artDirection?.recipe === 'fade_to_paper');
    expect(paper, ranked.map((r) => r.layout.artDirection?.recipe).join(',')).toBeDefined();
    expect(paper!.layout.background.color).toBe(WHITE);
    const band = paper!.layout.shapes.find((s) => s.surface === 'plate')!;
    expect(band).toMatchObject({ x: 0, y: 0, width: 1080, color: INDIGO });
    expect(paper!.hardQa?.passed, paper!.hardQa?.messages.join(' | ')).toBe(true);
    for (const r of ranked) save(`photo-brandbook_${r.layout.artDirection?.recipe}`, r.layout, REPORT_COPY, [{ bytes: reportPhoto.bytes, mediaType: reportPhoto.mimeType }]);
  }, 240000);

  it('a requester who asks for a dark navy overlay still gets navy (the owner\'s K-12 brief)', async () => {
    const ranked = await photoRun('Use KAAE’s navy blue with a dark navy overlay toward the lower section.', 'auto');
    const fade = ranked.find((r) => r.layout.artDirection?.recipe === 'hero_fade_report')!;
    expect(fade.layout.background.color).toBe(INDIGO);
    expect(fade.layout.overlays?.[0].color).toBe(INDIGO);
    expect(fade.layout.text.find((t) => t.copyIndex === 1)!.color.toUpperCase()).toBe(GOLD);
    expect(fade.hardQa?.passed, fade.hardQa?.messages.join(' | ')).toBe(true);
    save('photo-report-dark_hero_fade_report', fade.layout, REPORT_COPY, [{ bytes: reportPhoto.bytes, mediaType: reportPhoto.mimeType }]);
  }, 240000);
});
