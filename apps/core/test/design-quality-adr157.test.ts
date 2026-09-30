import { describe, it, expect, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { OpenAiStudioClient, renderMotifPng, type StudioLayoutV2 } from '@hawa/creative';
import type { StageContext, CandidateState } from '../src/services/design-studio/types.js';
import { runQAStage } from '../src/services/design-studio/stages/qa.stage.js';
import { hardQaContextFor } from '../src/services/design-studio/stages/v3.stage.js';
import { photosBrief } from '../src/services/design-studio/stages/layouts.stage.js';
import { studioStatusNote, requesterDraftNotes } from '../src/services/design-studio/studio-status-note.js';
import { recordedPhotoSelection, studioCopyBlocks } from '../src/services/design-studio/design-quality.js';

/**
 * ADR-157, the studio side of the design-quality fixes: the KAAE report cover of 2026-09-30 (six
 * photos, a subtitle ending "toward") and what the office and the requester are told about it.
 */
const FONT = 'Inter';
const palette = ['#0A1628', '#1E3A5F', '#4770A3', '#F7B500', '#FDF8F3', '#FFFFFF', '#1A1A1A'];
const copy = ['KAAE K-12 Pilot Study', 'Field Visit Report', 'Insights from KAAE school field visits and next steps toward'];
const photo = (i: number) => ({ dataUrl: '', bytes: renderMotifPng('gradient-wash', { width: 320, height: 240, palette: ['#4770A3', '#1E3A5F'], seed: i }), mimeType: 'image/png' as const, width: 320, height: 240 });

function kaae(): StudioLayoutV2 {
  return {
    version: 2, width: 1080, height: 1350,
    grid: { margin: 65, columns: 6, gutter: 20, baseline: 8 },
    background: { color: '#0A1628' },
    shapes: [{ kind: 'rect', role: 'panel', x: 65, y: 863, width: 950, height: 393, color: '#1E3A5F' }] as StudioLayoutV2['shapes'],
    logo: { x: 490, y: 135, width: 100, height: 80 },
    photos: [
      { photoIndex: 0, role: 'grid', x: 65, y: 297, width: 302, height: 257 },
      { photoIndex: 1, role: 'grid', x: 383, y: 297, width: 324, height: 257 },
      { photoIndex: 2, role: 'grid', x: 724, y: 297, width: 292, height: 257 },
      { photoIndex: 3, role: 'grid', x: 65, y: 574, width: 324, height: 257 },
    ] as unknown as StudioLayoutV2['photos'],
    text: [
      { copyIndex: 0, role: 'title', x: 110, y: 900, width: 860, height: 72, fontSize: 44, lineHeight: 1.2, fontFamily: FONT, color: '#FFFFFF', align: 'center', bold: true },
      { copyIndex: 1, role: 'subtitle', x: 110, y: 1020, width: 860, height: 44, fontSize: 28, lineHeight: 1.3, fontFamily: FONT, color: '#F7B500', align: 'center', bold: true },
      { copyIndex: 2, role: 'body', x: 110, y: 1130, width: 860, height: 40, fontSize: 19, lineHeight: 1.4, fontFamily: FONT, color: '#FFFFFF', align: 'center' },
    ] as StudioLayoutV2['text'],
  };
}

function context(overrides: Partial<StageContext> = {}): StageContext {
  const logo = renderMotifPng('thin-rules', { width: 125, height: 100, palette: ['#F7B500', '#FFFFFF'] });
  return {
    runId: randomUUID(), tenantId: randomUUID(), taskId: randomUUID(), clientId: randomUUID(), actorId: 'test',
    width: 1080, height: 1350, tier: 'premium',
    instructions: 'A report cover with these photos. You do not have to use all the photos, choose the best ones.',
    copyBlocks: copy.map((text) => ({ text, script: 'latin' as const })),
    referencePack: { id: 'kaae', palette, fonts: [FONT], rules: {} } as any,
    client: new OpenAiStudioClient({ apiKey: 'k', fetcher: vi.fn() as any }),
    latinFont: FONT, arabicFont: 'Noto Sans Arabic', logoAspect: 1.25, promotedRules: '',
    logo: { bytes: logo, sha256: createHash('sha256').update(logo).digest('hex'), mimeType: 'image/png' },
    photos: [0, 1, 2, 3, 4, 5].map(photo),
    ...overrides,
  };
}

const winner = (layout: StudioLayoutV2, extra: Partial<CandidateState> = {}): CandidateState => ({
  id: 'w', ordinal: 0, concept: {} as any, layouts: [layout], currentLayout: layout, critiques: [], status: 'winner', ...extra,
});

describe('final QA on the KAAE draft (ADR-157)', () => {
  it('passes a chosen four of six photos, lists the two left out, flags the cut-short copy and measures contrast on the render', async () => {
    const qa = await runQAStage(context(), winner(kaae()));
    expect(qa.defectCodes).toEqual([]);
    expect(qa.passed).toBe(true);
    expect(qa.omittedPhotos).toEqual([4, 5]);
    expect(qa.findings?.map((f) => f.code)).toContain('COPY_DANGLING_END');
    expect(Object.keys(qa.measuredContrast ?? {})).toEqual(['0', '1', '2']);
    expect(qa.measuredContrast![0]).toBeGreaterThan(4.5);
  });

  it('refuses the same four photos when the requester did not let it choose', async () => {
    const qa = await runQAStage(context({ instructions: 'A report cover with these photos.' }), winner(kaae()));
    expect(qa.defectCodes).toContain('PHOTOS');
  });

  it('fails copy set over pale art that the declared colours call readable', async () => {
    const layout = kaae();
    layout.shapes = [];
    layout.art = { source: 'procedural', motif: 'gradient-wash', box: { x: 0, y: 0, width: 1080, height: 1350 }, opacity: 1, calmRegion: { x: 65, y: 850, width: 950, height: 420 } };
    const artPng = renderMotifPng('gradient-wash', { width: 1080, height: 1350, palette: ['#F4F4F4', '#EEEEEE'] });
    const qa = await runQAStage(context(), winner(layout, { artPng }));
    expect(qa.defectCodes).toContain('CONTRAST');
    expect(qa.messages.join(' ')).toMatch(/rendered pixels under its lines/);
  });

  it('says contrast went unmeasured when the design cannot be rendered, rather than passing in silence', async () => {
    const qa = await runQAStage(context({ logo: undefined }), winner(kaae()));
    expect(qa.findings?.map((f) => f.code)).toContain('CONTRAST_UNMEASURED');
  });
});

describe('photo choice from the brief (ADR-157)', () => {
  it('derives the choice from the instructions, and a recorded choice wins', () => {
    expect(hardQaContextFor(context()).photoSelection).toMatchObject({ mode: 'choose', minimum: 3 });
    expect(hardQaContextFor(context({ instructions: 'with these photos' })).photoSelection).toEqual({ mode: 'all', minimum: 6 });
    const recorded = recordedPhotoSelection({ photoSelection: { mode: 'choose', minimum: 4 } }, 6);
    expect(hardQaContextFor(context({ instructions: 'make the title bigger', photoSelection: recorded })).photoSelection).toEqual({ mode: 'choose', minimum: 4 });
  });

  it('tells the layout model it may choose, and otherwise that every photo is placed', () => {
    const photos = context().photos;
    expect(photosBrief(photos, 1080, 1350, undefined, { mode: 'choose', minimum: 3 })).toContain('place at least 3 of the 6');
    expect(photosBrief(photos, 1080, 1350)).toContain('Each appears exactly once in photos[]');
  });
});

describe('what the office and the requester are told (ADR-157)', () => {
  const run = (selection: unknown) => ({
    winner_candidate_id: 'w',
    stages: {
      brief: { pipeline: 'v3', photosSent: 6, ...(selection ? { photoSelection: selection } : {}) },
      qa: { findings: [{ code: 'COPY_DANGLING_END', severity: 'warning', copyIndex: 2, message: 'COPY_DANGLING_END: block 2 ends on "toward", which does not end a phrase; the copy may be cut short. Check the wording with the requester.' }], omittedPhotos: [4, 5] },
    },
  });
  const candidates = [{ id: 'w', layouts: [kaae()] }];

  it('lists the photos left out and the findings for review in the office note', () => {
    const note = studioStatusNote({ run: run({ mode: 'choose', minimum: 3 }), candidates });
    expect(note).toContain('photos chosen: 4 of 6 (left out: 5, 6)');
    expect(note).toContain('⚠️ check before approving: block 2 ends on "toward"');
    expect(note).not.toContain('⚠️ 4 of your 6 photos placed');
  });

  it('does not tell the requester their photos went missing when they let the design choose', () => {
    expect(requesterDraftNotes({ run: run({ mode: 'choose', minimum: 3 }), candidates }).join(' ')).not.toMatch(/Only 4 of your 6/);
    expect(requesterDraftNotes({ run: run(undefined), candidates }).join(' ')).toMatch(/Only 4 of your 6 photos are on the design/);
    expect(studioStatusNote({ run: run(undefined), candidates })).toContain('⚠️ 4 of your 6 photos placed');
  });
});

describe('mixed-script copy blocks (ADR-157)', () => {
  it('splits a Sorani block with an English line into blocks of one script, keeping single-script blocks whole', () => {
    const blocks = studioCopyBlocks(['کۆنفرانسی پەروەردە\nKAAE Education Conference', 'Field Visit Report'], ['arabic', 'latin'], ['ckb', 'en']);
    expect(blocks).toEqual([
      { text: 'کۆنفرانسی پەروەردە', script: 'arabic', locale: 'und' },
      { text: 'KAAE Education Conference', script: 'latin', locale: 'und' },
      { text: 'Field Visit Report', script: 'latin', locale: 'en', localeCopySha256: createHash('sha256').update('Field Visit Report').digest('hex') },
    ]);
  });
});
