import { describe, it, expect } from 'vitest';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';
import { readFileSync } from 'node:fs';
import { generateLayoutCandidatesV3, evaluatePairOrder, type StudioLayoutV2 } from '../src/index.js';

// The owner asked (2026-09-19) that an image sent with a request be followed robustly. It was saved
// with every Telegram task, but the v3 studio never read it.
const reference = { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', notes: 'centred crest, gold rules framing the title, deep navy' };
const capture = () => {
  const seen: any[] = [];
  const client: any = {
    primaryModel: 'gpt-4.1-mini',
    createStructuredCompletion: async (params: any) => {
      seen.push(params);
      throw new Error('captured');
    },
    completeJson: async (params: any) => {
      seen.push(params);
      throw new Error('captured');
    },
  };
  return { client, seen };
};
const imageUrls = (params: any) =>
  params.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((p: any) => p.type === 'image_url').map((p: any) => p.image_url.url);
const text = (params: any) =>
  params.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content.filter((p: any) => p.type === 'text').map((p: any) => p.text) : [m.content])).join('\n');

describe("the client's reference image", () => {
  it('reaches the layout generator with the instruction to follow it', async () => {
    const { client, seen } = capture();
    const base = { client, brief: 'Invitation', copyBlocks: [{ index: 0, text: 'Title', role: 'title' as const, script: 'latin' as const }], palette: ['#0A1628', '#F7B500'] };
    await expect(generateLayoutCandidatesV3({ ...base, reference })).rejects.toThrow('captured');
    expect(imageUrls(seen[0])).toEqual([reference.dataUrl]);
    expect(text(seen[0])).toContain('CLIENT REFERENCE IMAGE');
    expect(text(seen[0])).toContain('gold rules framing the title');
    await expect(generateLayoutCandidatesV3(base)).rejects.toThrow('captured');
    expect(imageUrls(seen[1])).toEqual([]);
  });

  it('is shown to the judge as a third image, after the two candidates', async () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/cheap-tier-overflow-1f392e16.json', import.meta.url), 'utf8')) as { copy: string[]; layout: StudioLayoutV2 };
    const copyText = Object.fromEntries(fixture.copy.map((b, i) => [i, b]));
    const { client, seen } = capture();
    const cand = (id: string) => ({ id, layout: fixture.layout });
    await expect(evaluatePairOrder(cand('a') as any, cand('b') as any, 'AB', { client, reference, renderOptions: { copyText, logoDataUri: KAAE_TEST_LOGO } } as any)).rejects.toThrow('captured');
    const urls = imageUrls(seen[0]);
    expect(urls).toHaveLength(3);
    expect(urls[2]).toBe(reference.dataUrl);
    expect(text(seen[0])).toContain('Image 3 is that reference');
  });
});
