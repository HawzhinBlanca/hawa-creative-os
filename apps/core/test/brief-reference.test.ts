import { describe, it, expect, vi } from 'vitest';
import { runBriefStage } from '../src/services/design-studio/stages/brief.stage.js';

const reply = (extra: Record<string, unknown>) => ({
  data: {
    occasion: 'Launch', audience: 'Officials', formality: 5, toneWords: ['Formal', 'National', 'Clear'], readingOrder: [0],
    roles: [{ copyIndex: 0, role: 'title', importance: 5 }], must: [], mustNot: [], imageryStrategy: 'none', imageryRationale: '',
    kurdishLeads: false, riskFlags: [], requestedBackground: '', ...extra,
  },
});
const ctx = (attachedImage?: string, completeJson = vi.fn()) => ({
  client: { completeJson },
  referencePack: { palette: ['#0A1628'] },
  copyBlocks: [{ text: 'Title', script: 'latin' }],
  instructions: 'Make it like the attached design',
  width: 1080, height: 1350, tier: 'premium', attachedImage,
}) as any;

describe('the brief reads an attached image', () => {
  it('sends the image and keeps what the model read in it', async () => {
    const completeJson = vi.fn(async () => reply({ referenceRole: 'style_reference', referenceNotes: 'gold frame' }));
    const brief = await runBriefStage(ctx('data:image/jpeg;base64,/9j/AAAA', completeJson));
    const params = (completeJson.mock.calls[0] as any)[0];
    expect(params.images).toEqual([{ mediaType: 'image/jpeg', data: '/9j/AAAA' }]);
    expect(params.prompt).toContain('The client attached the image shown');
    expect(brief).toMatchObject({ referenceRole: 'style_reference', referenceNotes: 'gold frame' });
  });

  it('never claims a reference when no image was attached', async () => {
    const completeJson = vi.fn(async () => reply({ referenceRole: 'style_reference', referenceNotes: 'imagined' }));
    const brief = await runBriefStage(ctx(undefined, completeJson));
    expect((completeJson.mock.calls[0] as any)[0].images).toBeUndefined();
    expect(brief).toMatchObject({ referenceRole: 'none', referenceNotes: '' });
  });
});

describe('the brief says what each of several images is', () => {
  it('sends all of them in arrival order and keeps one role per image', async () => {
    const completeJson = vi.fn(async () =>
      reply({
        referenceRole: 'style_reference',
        referenceNotes: 'portraits bottom-left, gold title with side bar',
        imageRoles: [
          { index: 0, role: 'content_photo', notes: 'panelist in white' },
          { index: 1, role: 'content_photo', notes: 'panelist in black' },
          { index: 2, role: 'style_reference', notes: 'finished poster mock-up' },
          { index: 7, role: 'logo', notes: 'out of range' },
        ],
      })
    );
    const c = { ...ctx(undefined, completeJson), requestImages: ['data:image/jpeg;base64,/9j/AAA1', 'data:image/jpeg;base64,/9j/AAA2', 'data:image/png;base64,iVBOR3'] };
    c.instructions = 'I need a graphic with these texts and two pictures in it\nI attached the panelists pictures and a reference for the graphic';
    const brief = await runBriefStage(c);
    const params = (completeJson.mock.calls[0] as any)[0];
    expect(params.images).toEqual([
      { mediaType: 'image/jpeg', data: '/9j/AAA1' },
      { mediaType: 'image/jpeg', data: '/9j/AAA2' },
      { mediaType: 'image/png', data: 'iVBOR3' },
    ]);
    expect(params.prompt).toMatch(/sent the 3 images shown, in this order/);
    expect(brief.imageRoles).toEqual([
      { index: 0, role: 'content_photo', notes: 'panelist in white' },
      { index: 1, role: 'content_photo', notes: 'panelist in black' },
      { index: 2, role: 'style_reference', notes: 'finished poster mock-up' },
    ]);
    expect(brief.referenceSeen).toBe(true);
  });

  it('an image the model did not classify is unrelated, never guessed', async () => {
    const completeJson = vi.fn(async () => reply({ referenceRole: 'none', referenceNotes: '', imageRoles: [{ index: 0, role: 'content_photo', notes: '' }] }));
    const c = { ...ctx(undefined, completeJson), requestImages: ['data:image/jpeg;base64,/9j/A', 'data:image/jpeg;base64,/9j/B'] };
    const brief = await runBriefStage(c);
    expect(brief.imageRoles).toEqual([
      { index: 0, role: 'content_photo', notes: '' },
      { index: 1, role: 'unrelated', notes: '' },
    ]);
  });
});
