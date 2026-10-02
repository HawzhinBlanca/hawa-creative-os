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
  pageGrammarFromRaw,
  guidelineFidelityRule,
  JUDGE_DIMENSIONS,
  PNG,
  logoClearZone,
  negativeSpaceOf,
  POSTER_IMPACT_CRITERIA,
  type StudioLayoutV2,
} from '@hawa/creative';
import { kaaeClientDNA } from '@hawa/domain';
import type { CandidateState, CreativeBrief, StageContext } from '../src/services/design-studio/types.js';
import { runLayoutsStage, runRenderStage, rankStudioCandidatesV3, layoutBriefV3, runJudgeStageV3, houseRulesFor } from '../src/services/design-studio/stages/index.js';
import { requestedBackgroundFor } from '../src/services/design-studio/stages/brief.stage.js';
import { paletteFallbacksOf } from '../src/services/client-design-reference.js';
import { packagedAdmittedDisplayFonts } from '../src/services/design-studio/design-studio-service.js';

/**
 * ADR-238 (owner, 2026-10-01): KAAE's designs follow the 2025 guideline, "Brand Guidelines —
 * Excellence Edition" (KAAE_Guidelines4.pdf; printed page numbers cited). Primary KAAE Blue #4770A3
 * and KAAE Gold #F7B500 (p.7), the extended palette (p.8), white pages; the guideline's page grammar
 * (header, serif title and gold bar, italic lead, cards, foot rule) and its navy-gradient cover. The
 * earlier guideline ADR-236 applied is withdrawn; ADR-236's light-first logic stays.
 *
 * These run the real layout stage, preparation, render and hard QA, with the layout model mocked:
 * the live Quality Assurance Workshop copy as a text-only poster (the grammar's pages first), an
 * announcement cover, an evening invitation that stays dark, and a one-photo report whose light
 * concepts include the guideline page. HAWA_KAAE_2025_PROOF_OUT writes every candidate's PNG there;
 * HAWA_ART_DIRECTION_ALBUM points at a folder of real photo0.jpg.. for the photo proof.
 */

const REFERENCE = JSON.parse(readFileSync(creativeAssetPath('kaae-reference.json'), 'utf8'));
const PALETTE: string[] = REFERENCE.rules.palette;
const OUT = process.env.HAWA_KAAE_2025_PROOF_OUT;
const RECEIPT = { responseId: 'resp_light', xRequestId: null, model: 'mock', inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0, latencyMs: 0 };

const GRAMMAR = pageGrammarFromRaw(REFERENCE)!;
const MIDNIGHT = '#0A1628';
const ROYAL = '#1E3A5F';
const BLUE = '#4770A3';
const GOLD = '#F7B500';
const CREAM = '#FDF8F3';
const WHITE = '#FFFFFF';
const SUN = '#FFD700';
const INK = MIDNIGHT;

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
    referencePack: { palette: PALETTE, referenceFonts: { latin: 'Inter', arabic: 'Noto Sans Arabic' }, clientId: REFERENCE.clientId,
      admittedDisplayFonts: packagedAdmittedDisplayFonts(REFERENCE), logoConstraints: REFERENCE.rules.logoConstraints },
    promotedRules: studioReferenceFromRaw(REFERENCE).promotedRules, latinFont: 'Inter', arabicFont: 'Noto Sans Arabic', logoAspect: 1,
    pageGrammar: GRAMMAR,
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
  letterSpacing: 0, fontFamily: role === 'title' || role === 'subtitle' ? 'Crimson Pro' : 'Inter', color, align: 'left',
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
      shape('panel', [0, 0, 1, 0.4], ROYAL),
      shape('rule', [0.08, 0.345, 0.11, 0.003], GOLD),
      shape('rule', [0.08, 0.705, 0.84, 0.0015], GOLD),
      shape('panel', [0, 0.965, 1, 0.035], ROYAL),
    ], [
      text(0, 'title', [0.08, 0.2, 0.84, 0.125], 66, WHITE),
      text(1, 'subtitle', [0.08, 0.455, 0.84, 0.04], 34, BLUE, { italic: true }),
      text(2, 'date', [0.08, 0.545, 0.84, 0.035], 30, INK),
      text(3, 'venue', [0.08, 0.6, 0.84, 0.035], 28, BLUE),
      text(4, 'body', [0.08, 0.735, 0.84, 0.035], 24, INK),
    ]),
    candidate('cream-monolith', 'monolith_centered', CREAM, [0.44, 0.07], [
      shape('rule', [0.45, 0.415, 0.1, 0.003], GOLD),
      shape('panel', [0.15, 0.55, 0.7, 0.17], WHITE),
      shape('rule', [0.45, 0.86, 0.1, 0.003], GOLD),
    ], [
      text(0, 'title', [0.1, 0.25, 0.8, 0.14], 70, BLUE, { align: 'center' }),
      text(1, 'subtitle', [0.1, 0.44, 0.8, 0.045], 34, BLUE, { align: 'center', italic: true }),
      text(2, 'date', [0.18, 0.585, 0.64, 0.04], 30, INK, { align: 'center' }),
      text(3, 'venue', [0.18, 0.645, 0.64, 0.035], 28, BLUE, { align: 'center' }),
      text(4, 'body', [0.1, 0.785, 0.8, 0.035], 24, INK, { align: 'center' }),
    ]),
    candidate('white-editorial', 'asymmetric_editorial', WHITE, [0.08, 0.06], [
      shape('accent', [0.08, 0.235, 0.008, 0.27], BLUE),
      shape('panel', [0, 0.69, 1, 0.31], ROYAL),
      shape('rule', [0.08, 0.86, 0.1, 0.003], GOLD),
    ], [
      text(0, 'title', [0.115, 0.235, 0.8, 0.2], 78, BLUE),
      text(1, 'subtitle', [0.115, 0.455, 0.8, 0.045], 34, BLUE, { italic: true }),
      text(2, 'date', [0.08, 0.74, 0.84, 0.04], 34, WHITE),
      text(3, 'venue', [0.08, 0.795, 0.84, 0.035], 28, CREAM),
      text(4, 'body', [0.08, 0.885, 0.84, 0.035], 24, WHITE),
    ]),
  ],
};

/** An evening invitation, and what the model proposes for it once told its ground is navy. */
const GALA_COPY = ['An Evening of Accreditation', 'KAAE Annual Gala Dinner', 'Thursday 12 November 2026 · 7:00 PM', 'Rotana Hotel, Erbil', 'By invitation only'];
const GALA_ROLES = ['subtitle', 'title', 'date', 'venue', 'footer'] as const;
const GALA_ANSWER = {
  layouts: [
    candidate('gala-centred', 'commencement_diploma_frame', MIDNIGHT, [0.44, 0.08], [
      shape('rule', [0.45, 0.47, 0.1, 0.003], GOLD),
      shape('rule', [0.45, 0.76, 0.1, 0.003], GOLD),
    ], [
      text(0, 'subtitle', [0.1, 0.26, 0.8, 0.045], 32, GOLD, { align: 'center', italic: true }),
      text(1, 'title', [0.1, 0.32, 0.8, 0.13], 70, WHITE, { align: 'center' }),
      text(2, 'date', [0.1, 0.52, 0.8, 0.04], 30, CREAM, { align: 'center' }),
      text(3, 'venue', [0.1, 0.575, 0.8, 0.035], 28, CREAM, { align: 'center' }),
      text(4, 'footer', [0.1, 0.8, 0.8, 0.03], 22, GOLD, { align: 'center' }),
    ]),
    candidate('gala-royal-band', 'crest_banner_split', MIDNIGHT, [0.08, 0.06], [
      shape('panel', [0, 0.5, 1, 0.26], ROYAL),
      shape('rule', [0.08, 0.455, 0.1, 0.003], GOLD),
    ], [
      text(0, 'subtitle', [0.08, 0.24, 0.84, 0.045], 32, GOLD, { italic: true }),
      text(1, 'title', [0.08, 0.3, 0.84, 0.13], 70, WHITE),
      text(2, 'date', [0.08, 0.56, 0.84, 0.04], 32, WHITE),
      text(3, 'venue', [0.08, 0.615, 0.84, 0.035], 28, CREAM),
      text(4, 'footer', [0.08, 0.85, 0.84, 0.03], 22, GOLD),
    ]),
    candidate('gala-editorial', 'asymmetric_editorial', MIDNIGHT, [0.8, 0.06], [
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

describe('ADR-238: the KAAE palette is the 2025 guideline\'s, light first', () => {
  it('carries exactly the guideline\'s colours, the white page first, and none of the withdrawn book\'s', () => {
    expect(PALETTE).toEqual([WHITE, CREAM, BLUE, GOLD, MIDNIGHT, ROYAL, '#2C5282', '#4A90E2', SUN]);
    for (const old of ['#17087A', '#3833A3', '#0F73DE', '#E8B85C', '#FFF2DB', '#000000']) expect(PALETTE).not.toContain(old);
    expect(REFERENCE.rules.paletteFallbacks).toEqual({ background: WHITE, text: MIDNIGHT, accent: BLUE });
    expect(REFERENCE.rules.colorUsage).toMatch(/^KAAE Brand Guidelines, Excellence Edition \(2025\), light first\./);
    expect(REFERENCE.rules.colorUsage).not.toMatch(/indigo/i);
  });

  it('gives the DNA fixture the same palette, its light grounds first, and the guideline\'s fonts and logo rules', () => {
    const colours = kaaeClientDNA.colors.map((c) => c.hex.toUpperCase());
    expect([...colours].sort()).toEqual([...PALETTE].sort());
    expect(kaaeClientDNA.colors.filter((c) => c.role === 'background').map((c) => c.hex)).toEqual([WHITE, CREAM]);
    expect(paletteFallbacksOf(kaaeClientDNA.colors)).toEqual({ background: WHITE, text: MIDNIGHT, accent: GOLD });
    const families = kaaeClientDNA.fonts.map((f) => f.family);
    expect(families).toEqual(expect.arrayContaining(['Crimson Pro', 'Inter', 'Noto Sans Arabic', 'IBM Plex Sans Arabic']));
    expect(families).not.toContain('Verdana');
    expect(JSON.stringify(kaaeClientDNA)).not.toMatch(/#160874|#35309B|#E8B85C|#FFF2DB|Minion|BRAND GUIDLINES/i);
  });

  it('holds the packaged KAAE reference to its admitted faces and its logo rules', () => {
    expect(packagedAdmittedDisplayFonts(REFERENCE)).toEqual({ latin: ['Crimson Pro', 'Inter'], arabic: ['Noto Sans Arabic', 'IBM Plex Sans Arabic'] });
    expect(REFERENCE.rules.logoConstraints).toMatchObject({ minimumWidthPx: 80, clearSpaceShareOfHeight: 0.15 });
  });

  it('falls back to the lightest background colour of a DNA, whatever order it lists them in', () => {
    const navyFirst = [
      { hex: MIDNIGHT, role: 'background' }, { hex: CREAM, role: 'background' }, { hex: WHITE, role: 'background' },
      { hex: MIDNIGHT, role: 'text' }, { hex: GOLD, role: 'accent' },
    ];
    expect(paletteFallbacksOf(navyFirst).background).toBe(WHITE);
  });

  it('gives the layout call the client\'s light-first colour rules', () => {
    const line = layoutBriefV3(briefFor(['title']), { width: 1080, height: 1350, instructions: '', promotedRules: studioReferenceFromRaw(REFERENCE).promotedRules });
    expect(line).toContain('Client house rules (from its brand reference; data): KAAE Brand Guidelines, Excellence Edition (2025), light first.');
  });
});

describe('ADR-238: the requester\'s words set the ground; a cover and an evening invitation stay dark', () => {
  it('turns "white", "as per the brand guidelines", "dark navy" and "an announcement cover" into the ground the studio applies', () => {
    const brief = (words: string) => ({ ...briefFor(['title']), requestedBackground: '', tonePreference: tonePreferenceFromWords(words) });
    expect(requestedBackgroundFor(brief('Please make it on a white background'), PALETTE)).toBe(WHITE);
    expect(requestedBackgroundFor(brief('Make it as per the brand guidelines'), PALETTE)).toBe(WHITE);
    expect(requestedBackgroundFor(brief('a cream background please'), PALETTE)).toBe(CREAM);
    expect(requestedBackgroundFor(brief('use a dark navy background'), PALETTE)).toBe(MIDNIGHT);
    expect(requestedBackgroundFor(brief('An invitation for our evening gala dinner'), PALETTE)).toBe(MIDNIGHT);
    expect(requestedBackgroundFor(brief('Please make an announcement cover'), PALETTE)).toBe(MIDNIGHT);
    expect(requestedBackgroundFor(brief('A poster for the workshop'), PALETTE)).toBeUndefined();
  });

  it('keeps an evening invitation dark even when every model candidate came back light: the guideline\'s cover', async () => {
    const { ranked } = await typographicRun(GALA_COPY, GALA_ROLES, 'Please design an invitation for our evening gala dinner.', LIGHT_POSTER_ANSWER);
    expect(ranked.length).toBe(3);
    for (const r of ranked) {
      expect(r.layout.background.color).toBe(MIDNIGHT);
      for (const t of r.layout.text) {
        const ratio = calculateLuminanceContrastRatio(hexToLuminance(t.color), hexToLuminance(declaredBackgroundColour(r.layout, t)));
        expect(ratio, `${t.role} ${t.color}`).toBeGreaterThanOrEqual(requiredContrast(t.fontSize, Boolean(t.bold)));
      }
    }
    expect(ranked.filter((r) => r.layout.composition?.grammar === 'cover')).toHaveLength(2);
    expect(ranked.some((r) => r.hardQa?.passed)).toBe(true);
  }, 120000);
});

describe('ADR-238 proofs: the guideline\'s pages through the real stage, render and hard QA (model mocked)', () => {
  it('ADR-271: the Quality Assurance Workshop is three different office poster compositions, bold, with no layout call, all passing hard QA', async () => {
    const { ranked, requests } = await typographicRun(QA_COPY, QA_ROLES, 'Design a poster for our Quality Assurance Workshop.', LIGHT_POSTER_ANSWER);
    // Three compositions were set from the grammar, so the layout model was not called.
    expect(requests).toHaveLength(0);
    expect(ranked).toHaveLength(3);
    expect(ranked.map((r) => r.layout.composition?.grammar)).toEqual(['poster', 'poster', 'poster']);
    expect(ranked.map((r) => r.layout.composition!.variant).sort()).toEqual(['band', 'cream', 'navy']);
    const grounds = new Set<string>();
    for (const r of ranked) {
      const W = r.layout.width;
      const title = r.layout.text.find((t) => t.role === 'title')!;
      // ADR-275 (owner, 2026-10-02): the office's heavy sans capitals; the copy is stored as typed.
      expect(title).toMatchObject({ fontFamily: 'Inter', fontWeight: 800, textTransform: 'uppercase', bold: true });
      // One dominant display moment: the title at 10-20% of the width, the logo at 16%.
      expect(title.fontSize / W).toBeGreaterThanOrEqual(0.1);
      expect(title.fontSize / W).toBeLessThanOrEqual(0.2);
      expect(r.layout.logo.width / W).toBeGreaterThanOrEqual(0.16);
      expect(r.layout.shapes.map((x) => x.primitive)).toContain('title_bar');
      // No more of the canvas empty than the poster ceiling allows.
      expect(negativeSpaceOf(r.layout, { copy: { text: Object.fromEntries(QA_COPY.map((c, i) => [i, c])) } })).toBeLessThanOrEqual(0.65);
      expect(r.hardQa?.passed, `${r.candidate.concept.name}: ${r.hardQa?.messages.join(' | ')}`).toBe(true);
      grounds.add(r.layout.background.color.toUpperCase());
      save(`qa-workshop_${r.layout.composition!.variant}`, r.layout, QA_COPY);
    }
    // White (the band), cream and the navy cover: light first, and one dark option.
    expect([...grounds].sort()).toEqual([CREAM, MIDNIGHT, WHITE].sort());
  }, 120000);

  it('ADR-271: a requester who names white gets the banded white poster and the guideline\'s own two pages', async () => {
    const { ranked } = await typographicRun(QA_COPY, QA_ROLES, 'Design a poster for our Quality Assurance Workshop, on a white background.', LIGHT_POSTER_ANSWER);
    expect(ranked.map((r) => `${r.layout.composition?.grammar}/${r.layout.composition?.variant}`).sort()).toEqual(['page/brand_card', 'page/cards', 'poster/band']);
    for (const r of ranked) {
      expect(r.layout.background.color.toUpperCase()).toBe(WHITE);
      expect(r.hardQa?.passed, r.hardQa?.messages.join(' | ')).toBe(true);
    }
    const page = ranked.find((r) => r.layout.composition?.variant === 'brand_card')!;
    expect(page.layout.shapes.map((x) => x.primitive)).toEqual(expect.arrayContaining(['header_rule', 'header_accent', 'card', 'title_bar', 'foot_rule']));
    expect(page.layout.text.find((t) => t.role === 'title')!.fontSize / page.layout.width).toBeGreaterThanOrEqual(0.1);
  }, 120000);

  it('an announcement cover: the guideline\'s navy-gradient covers, passing hard QA', async () => {
    const copy = ['Accreditation Cycle 2027', 'Applications now open', 'From 1 November 2026', 'kaae.org'];
    const { ranked } = await typographicRun(copy, ['title', 'subtitle', 'date', 'footer'], 'Please make an announcement cover.', GALA_ANSWER);
    const covers = ranked.filter((r) => r.layout.composition?.grammar === 'cover');
    expect(covers).toHaveLength(2);
    for (const r of covers) {
      expect(r.layout.shapes[0]).toMatchObject({ primitive: 'cover_ground', gradient: { angle: 45 } });
      expect(r.hardQa?.passed, r.hardQa?.messages.join(' | ')).toBe(true);
      save(`cover_${r.layout.composition!.variant}`, r.layout, copy);
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
      { id: 'paper', conceptNote: 'The guideline page: the photo in a rounded card under the header and title.', recipe: 'fade_to_paper', typicality: 0.4, heroPhotoIndex: 0, texturePhotoIndex: null, cutoutPhotoIndex: null,
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

  it('the one-photo report: with no tone asked, every recipe sits on the white page, none is replaced by the guideline page (ADR-274), all pass hard QA', async () => {
    // The model still asks for navy out of habit: the photo is bright and nothing in the brief calls for dark.
    const ranked = await photoRun('Design a report post for KAAE using this photo and the text.', 'navy');
    expect(ranked.length).toBeGreaterThanOrEqual(2);
    // ADR-274: KAAE's grammar carries poster rules, so no photo concept becomes the guideline's
    // document page (ADR-238 did that, and the page then won every split judge by default).
    expect(ranked.some((r) => r.layout.composition), ranked.map((r) => r.layout.artDirection?.recipe).join(',')).toBe(false);
    expect(ranked.every((r) => r.layout.artDirection?.recipe)).toBe(true);
    for (const r of ranked) {
      const recipe = r.layout.artDirection?.recipe;
      expect(r.layout.background.color, `${recipe} ground`).toBe(WHITE);
      for (const o of r.layout.overlays ?? []) {
        if (hexToLuminance(o.color) > 0.7) continue;
        // A measured local logo scrim may use a dark approved colour; it cannot tint the page.
        const clear = logoClearZone(r.layout.logo);
        expect(o.direction).toBe('radial');
        expect(o.x).toBeGreaterThanOrEqual(clear.x - 1);
        expect(o.y).toBeGreaterThanOrEqual(clear.y - 1);
        expect(o.x + o.width).toBeLessThanOrEqual(clear.x + clear.width + 1);
        expect(o.y + o.height).toBeLessThanOrEqual(clear.y + clear.height + 1);
      }
      // The serif title, in KAAE Blue on the page or white on a navy plate.
      const title = r.layout.text.find((t) => t.role === 'title')!;
      expect(title.fontFamily).toBe('Crimson Pro');
      expect([BLUE, WHITE]).toContain(title.color.toUpperCase());
      expect(r.hardQa?.passed, `${recipe}: ${r.hardQa?.messages.join(' | ')}`).toBe(true);
      save(`photo-report_${recipe}`, r.layout, REPORT_COPY, [{ bytes: reportPhoto.bytes, mediaType: reportPhoto.mimeType }]);
    }
  }, 240000);

  it('a requester who asks for a dark navy overlay still gets navy (the owner\'s K-12 brief)', async () => {
    const ranked = await photoRun('Use KAAE’s navy blue with a dark navy overlay toward the lower section.', 'auto');
    const fade = ranked.find((r) => r.layout.artDirection?.recipe === 'hero_fade_report')!;
    expect(fade.layout.background.color).toBe(MIDNIGHT);
    expect(fade.layout.overlays?.[0].color).toBe(MIDNIGHT);
    expect(fade.layout.text.find((t) => t.copyIndex === 0)!.color.toUpperCase()).toBe(WHITE);
    expect(fade.hardQa?.passed, fade.hardQa?.messages.join(' | ')).toBe(true);
    save('photo-report-dark_hero_fade_report', fade.layout, REPORT_COPY, [{ bytes: reportPhoto.bytes, mediaType: reportPhoto.mimeType }]);
  }, 240000);
});

describe('ADR-271: the judge decides between the compositions; the guideline prior only breaks a tie', () => {
  /** Five votes, `votesA` of them to the design shown as A. */
  const verdict = (votesA: number) => ({
    dimensions: Object.fromEntries(JUDGE_DIMENSIONS.map((d, i) => [d, { winner: i < votesA ? 'A' : 'B', rationale: 'r' }])),
    majorityWinner: votesA >= 3 ? 'A' : 'B', summary: 's',
  });

  it('gives the judge, the visual review and the refinement judge the guideline-fidelity rule after the house rules', () => {
    const rules = artDirectionRulesFromRaw(REFERENCE);
    expect(houseRulesFor({ artDirectionRules: rules, pageGrammar: GRAMMAR }).houseRules).toEqual([...rules, guidelineFidelityRule(GRAMMAR)]);
    expect(houseRulesFor({ artDirectionRules: rules })).toEqual({ houseRules: rules });
    expect(houseRulesFor({})).toEqual({});
  });

  it('ADR-274: the judge sees all three compositions in a round robin; the third by composite can win; it reads the poster criteria', async () => {
    const { ctx, ranked } = await typographicRun(GALA_COPY, GALA_ROLES, 'An evening invitation for the gala dinner, dark navy.', GALA_ANSWER);
    const eligible = ranked.filter((r) => r.hardQa?.passed);
    expect(eligible).toHaveLength(3);
    expect(eligible.every((r) => r.layout.composition)).toBe(true);
    // Pairs (1st,2nd) split; the 3rd wins both of its pairs 3-2 in both orders; then the canary.
    const plan = [verdict(3), verdict(3), verdict(2), verdict(3), verdict(2), verdict(3), verdict(5), verdict(0)];
    const requests: any[] = [];
    const judge = { createStructuredCompletion: async (req: any) => {
      requests.push(req);
      const data = plan[requests.length - 1];
      return { data, rawText: JSON.stringify(data), receipt: { ...RECEIPT, model: 'gpt-4.1-mini' } };
    } };
    const { selection } = await runJudgeStageV3({ ...ctx, client: judge as any }, ranked.map((r) => r.candidate));
    expect(requests).toHaveLength(8);
    const system = requests[0].messages[0].content as string;
    expect(system).toContain(JSON.stringify(guidelineFidelityRule(GRAMMAR)));
    expect(system).toContain(POSTER_IMPACT_CRITERIA.hierarchy.trim());
    expect(system).toContain(POSTER_IMPACT_CRITERIA.composition.trim());
    expect(system).not.toMatch(/You must take them into account/);
    // The office reference is off by default: two images a call.
    expect(requests.every((r) => r.messages[1].content.filter((p: any) => p.type === 'image_url').length === 2)).toBe(true);
    expect(selection.matches).toHaveLength(3);
    expect(selection.winner.sourceIndex).toBe(eligible[2].sourceIndex);
    expect(selection.roundRobin!.pickSourceIndex).toBe(eligible[2].sourceIndex);
    expect(selection.decidedBy).toBe('judge');
    expect(selection.prior).toBeUndefined();
    expect(selection.humanChoiceRecommended).toBe(false);
  }, 120000);
});
