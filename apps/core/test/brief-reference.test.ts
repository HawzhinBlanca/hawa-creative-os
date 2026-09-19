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
