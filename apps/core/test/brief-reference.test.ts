import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { imagePixelSize, reserveStudioText } from '@hawa/creative';
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
    const completeJson = vi.fn(async () => reply({ referenceRole: 'style_reference', referenceNotes: 'gold frame', imageRoles: [{ index: 0, role: 'style_reference', notes: 'gold frame' }] }));
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
  it.each([
    {usage:{mode:'all'},expected:'The requester requires all 6 supplied content photos'},
    {usage:{mode:'count',count:3},expected:'The requester requires exactly 3 photos'},
    {usage:{mode:'auto'},expected:'The client lets you choose among the photographs'},
  ])('carries the admitted website photo policy into the actual brief call: $usage.mode', async ({usage,expected}) => {
    const completeJson=vi.fn(async()=>reply({referenceRole:'none',imageRoles:Array.from({length:6},(_,index)=>({index,role:'content_photo',notes:'source'}))}));
    const context={...ctx(undefined,completeJson),instructions:'Compose for this content.',
      requestImages:Array.from({length:6},()=> 'data:image/jpeg;base64,/9j/AAAA'),webPhotoPolicy:{photoCount:6,usage}};
    await runBriefStage(context);
    const sent=(completeJson.mock.calls[0] as unknown as [{prompt:string}])[0];
    expect(sent.prompt).toContain('Admitted website source photos');
    expect(sent.prompt).toContain(expected);
  });
  it('sends all of them in arrival order and keeps one role per image', async () => {
    const completeJson = vi.fn(async () =>
      reply({
        referenceRole: 'style_reference',
        referenceNotes: 'portraits bottom-left, gold title with side bar',
        imageRoles: [
          { index: 0, role: 'content_photo', notes: 'panelist in white' },
          { index: 1, role: 'content_photo', notes: 'panelist in black' },
          { index: 2, role: 'style_reference', notes: 'finished poster mock-up' },
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

  it('an image the model did not classify fails visibly instead of becoming unrelated', async () => {
    const completeJson = vi.fn(async () => reply({ referenceRole: 'none', referenceNotes: '', imageRoles: [{ index: 0, role: 'content_photo', notes: '' }] }));
    const c = { ...ctx(undefined, completeJson), requestImages: ['data:image/jpeg;base64,/9j/A', 'data:image/jpeg;base64,/9j/B'] };
    await expect(runBriefStage(c)).rejects.toThrow('missing report for image 2');
  });
});

describe('the brief reads photos at most 1280 pixels on their long side (ADR-142)', () => {
  it('sends a full-size phone photo downscaled, a Telegram-sized one unchanged, and reserves accordingly', async () => {
    const phone = readFileSync(new URL('../../../packages/creative/test/fixtures/phone-12mp-plasma.jpg', import.meta.url));
    const telegram = readFileSync(new URL('./fixtures/telegram-photo-1280.jpg', import.meta.url));
    const completeJson = vi.fn(async () => reply({ imageRoles: [
      { index: 0, role: 'content_photo', notes: 'full-size' }, { index: 1, role: 'content_photo', notes: 'telegram' }] }));
    const c = { ...ctx(undefined, completeJson), requestImages: [
      `data:image/jpeg;base64,${phone.toString('base64')}`, `data:image/jpeg;base64,${telegram.toString('base64')}`] };
    await runBriefStage(c);
    const sent = (completeJson.mock.calls[0] as any)[0].images as Array<{ mediaType: string; data: string }>;
    expect(imagePixelSize(Buffer.from(phone))).toEqual({ width: 4032, height: 3024 });
    expect(imagePixelSize(Buffer.from(sent[0].data, 'base64'))).toEqual({ width: 1280, height: 960 });
    expect(sent[1]).toEqual({ mediaType: 'image/jpeg', data: telegram.toString('base64') });
    // Six full-size photos in one brief reserve about $1.94 of vision input at production prices.
    const sixUsd = (data: string, mediaType: string) => reserveStudioText(JSON.stringify({ model: 'gpt-6-astra', service_tier: 'default',
      max_completion_tokens: 1, response_format: { type: 'json_schema', json_schema: { name: 'x', schema: { type: 'object' } } },
      messages: [{ role: 'user', content: Array.from({ length: 6 }, () => ({ type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } })) }] })).usd;
    expect(sixUsd(phone.toString('base64'), 'image/jpeg')).toBeGreaterThan(1.9);
    expect(sixUsd(sent[0].data, sent[0].mediaType)).toBeLessThan(0.25);
  });
});
