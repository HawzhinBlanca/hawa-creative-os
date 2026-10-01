import { describe, expect, it } from 'vitest';
import { refineCandidate } from '../src/studio/refinement-engine-v3.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';
import type { OpenAiStudioClient } from '../src/studio/openai-studio-client.js';
import { SIX_CONFIRMED_EXEMPLARS } from './fixtures/design-metrics-fixtures.js';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';
import { encodeStudioTransferV2 } from '../src/studio/transfer-v2.js';
import { strFromU8, unzipSync } from 'fflate';
import { createHash } from 'node:crypto';

const clone = <T>(v: T): T => structuredClone(v);
function rich(): StudioLayoutV2 {
  const l = clone(SIX_CONFIRMED_EXEMPLARS[0]);
  l.background.field = { kind: 'linear', direction: 'to-bottom', stops: [{ at: 0, color: '#0C2340' }, { at: 1, color: '#1B365D' }] };
  l.background.decision = { policy: 'content-background-v1', basis: 'requester', intent: 'editorial', mode: 'gradient', textAreaShare: .3 };
  l.text[0].accentColor = '#FFFFFF'; l.text[0].accentText = 'Accreditation';
  l.text[0].opacity = .95;
  l.shapes[1].radius = 12; l.shapes[1].surface = 'card';
  l.overlays = [{ kind: 'gradient', color: '#0C2340', direction: 'to-bottom', purpose: 'fade', x: 0, y: 0, width: 1080, height: 1080, stops: [{ at: 0, opacity: 0 }, { at: 1, opacity: .1 }] }];
  l.photos = [{ photoIndex: 0, role: 'inset', x: 10, y: 1040, width: 20, height: 20, radius: 4 }];
  return l;
}
/** What the existing strict repair schema can actually return: optional rich fields are absent. */
function reduced(l: StudioLayoutV2): StudioLayoutV2 {
  return { version: 2, width: l.width, height: l.height, grid: clone(l.grid), background: { color: l.background.color },
    logo: clone(l.logo), typeScale: clone(l.typeScale),
    shapes: l.shapes.map(s => ({ x: s.x, y: s.y, width: s.width, height: s.height, kind: s.kind, role: s.role, color: s.color })),
    text: l.text.map(t => ({ copyIndex: t.copyIndex, role: t.role, x: t.x, y: t.y, width: t.width, height: t.height,
      fontSize: t.fontSize, lineHeight: t.lineHeight, fontFamily: t.fontFamily, color: t.color, align: t.align,
      bold: !!t.bold, italic: !!t.italic, rtl: !!t.rtl, letterSpacing: t.letterSpacing ?? 0 })) };
}
function clientFor(proposal: unknown) {
  const calls: string[] = [];
  const client = { async createStructuredCompletion(p: { jsonSchema: { name: string } }) {
    const name = p.jsonSchema.name; calls.push(name);
    const data = name === 'DesignCritiqueReport' ? { overallAssessment: 'Local position adjustment.', comments: [
      { boxId: 'B1', category: 'alignment', severity: 'medium', issue: 'Title position.', suggestedFix: 'Move eight pixels.' },
    ] } : { repairSummary: 'Geometry adjusted.', layout: proposal };
    return { data, rawText: JSON.stringify(data), receipt: { model: 'gpt-6.1-sol', responseId: `call${calls.length}`,
      xRequestId: `request${calls.length}`, inputTokens: 101, cachedTokens: 11, cacheReadTokens: 11, outputTokens: 21, costUsd: .001, latencyMs: 2 } };
  } } as unknown as OpenAiStudioClient;
  return { client, calls };
}
const renderOptions = { logoDataUri: KAAE_TEST_LOGO, photoDataUris: [KAAE_TEST_LOGO] };

describe('ADR190 controlled refinement boundary', { timeout: 30000 }, () => {
  it('retains rich editable layers and accents when applying a reduced-schema geometry response', async () => {
    const l = rich(), before = clone(l), p = reduced(l); p.text[0].x += 8;
    const { client, calls } = clientFor(p);
    const copy = l.text.map((t, i) => i === 0 ? 'Accreditation report' : `Requested block ${t.copyIndex}`);
    const copyText = Object.fromEntries(copy.map((t, i) => [i, t]));
    const result = await refineCandidate('rich', l, { client, force: true, maxRounds: 1, copyText, renderOptions });
    expect(calls).toHaveLength(2);
    expect(l).toEqual(before);
    expect(result.finalLayout.background).toEqual(before.background);
    expect(result.finalLayout.overlays).toEqual(before.overlays);
    expect(result.finalLayout.photos).toEqual(before.photos);
    expect(result.finalLayout.text[0]).toMatchObject({ accentColor: '#FFFFFF', accentText: 'Accreditation', opacity: .95, x: p.text[0].x });
    expect(result.finalLayout.shapes[1]).toMatchObject({ radius: 12, surface: 'card' });
    const bytes = Buffer.from(KAAE_TEST_LOGO.split(',')[1], 'base64');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const transfer = await encodeStudioTransferV2(result.finalLayout, copy, { bytes, sha256, mimeType: 'image/png' },
      { photos: [{ bytes, mimeType: 'image/png' }] });
    const files = unzipSync(transfer.bytes), xml = strFromU8(files['ppt/slides/slide1.xml']);
    expect(xml).toContain('name="Hawa background field"');
    expect(xml).toContain('<a:gradFill');
    expect(xml).toContain('<a:t>Accreditation</a:t>');
    expect(transfer.manifest.copy).toEqual(copy);
    expect(transfer.manifest.plan.backgroundField).toEqual(before.background.field);
    expect(Object.entries(files).some(([name, data]) => name.startsWith('ppt/media/') && createHash('sha256').update(data).digest('hex') === sha256)).toBe(true);
  });

  it.each([
    ['canvas', (p: StudioLayoutV2) => { p.width += 1; }],
    ['color', (p: StudioLayoutV2) => { p.text[0].color = '#00FF00'; }],
    ['font', (p: StudioLayoutV2) => { p.text[0].fontFamily = 'Arial'; }],
    ['direction', (p: StudioLayoutV2) => { p.text[0].rtl = true; }],
    ['missing-copy', (p: StudioLayoutV2) => { p.text.pop(); }],
    ['duplicate-copy', (p: StudioLayoutV2) => { p.text[1].copyIndex = p.text[0].copyIndex; }],
    ['missing-shape', (p: StudioLayoutV2) => { p.shapes.pop(); }],
    ['invalid-geometry', (p: StudioLayoutV2) => { p.text[0].height = NaN; }],
    ['outside-canvas', (p: StudioLayoutV2) => { p.text[0].x = 1e100; }],
    ['unbounded-type', (p: StudioLayoutV2) => { p.text[0].fontSize = 1e100; }],
    ['unbounded-scale', (p: StudioLayoutV2) => { p.typeScale = { base: 10, ratio: Infinity }; }],
    ['photo-cover', (p: StudioLayoutV2) => { p.logo = { x: 10, y: 1040, width: 20, height: 20 }; }],
  ] as const)('rejects %s changes while retaining both actual attempt receipts', async (_name, mutate) => {
    const l = rich(), p = reduced(l); mutate(p);
    const { client, calls } = clientFor(p);
    const result = await refineCandidate('reject', l, { client, force: true, renderOptions });
    expect(result.finalLayout).toEqual(l);
    expect(calls).toHaveLength(2);
    expect(result.roundsRun).toBe(1);
    expect(result.rounds[0].rejection?.code).toBeTruthy();
    expect(result.rounds[0].calls.map(c => c.responseId)).toEqual(['call1', 'call2']);
    expect(result.rounds[0].calls.reduce((s, c) => s + c.costUsd, 0)).toBe(.002);
  });

  it('preserves evidence for an absent repair layout', async () => {
    const l = rich(), { client } = clientFor(null);
    const result = await refineCandidate('missing', l, { client, force: true, renderOptions });
    expect(result.finalLayout).toEqual(l);
    expect(result.rounds[0].rejection?.code).toBe('repair_returned_unusable_layout');
    expect(result.rounds[0].calls).toHaveLength(2);
  });

  it('restores only missing authoritative live-copy blocks, preserving the original layers', async () => {
    const complete = rich(), l = clone(complete); l.text = l.text.filter(t => t.copyIndex !== 1);
    const { client } = clientFor(reduced(complete));
    const copyText = Object.fromEntries(complete.text.map(t => [t.copyIndex, `Requested block ${t.copyIndex}`]));
    const result = await refineCandidate('restore', l, { client, force: true, maxRounds: 1, copyText, renderOptions });
    expect(result.finalLayout.text.map(t => t.copyIndex)).toEqual(complete.text.map(t => t.copyIndex));
    expect(result.finalLayout.background).toEqual(l.background);
    expect(result.finalLayout.overlays).toEqual(l.overlays);
    expect(result.rounds[0].rejection).toBeUndefined();
    expect(result.rounds[0].calls).toHaveLength(2);
  });

  it('rejects invented copy even when the proposal also restores a genuine missing block', async () => {
    const complete = rich(), l = clone(complete); l.text.pop();
    const p = reduced(complete); p.text.push({ ...p.text[0], copyIndex: 99 });
    const { client } = clientFor(p);
    const copyText = Object.fromEntries(complete.text.map(t => [t.copyIndex, `Requested block ${t.copyIndex}`]));
    const result = await refineCandidate('invented', l, { client, force: true, copyText, renderOptions });
    expect(result.finalLayout).toEqual(l);
    expect(result.rounds[0].rejection?.code).toBe('repair_changed_protected_input');
  });

  it.each([-1, 3, 1.5, NaN, Infinity])('refuses unbounded round option %s before any call', async maxRounds => {
    const { client, calls } = clientFor(null);
    await expect(refineCandidate('bounds', rich(), { client, force: true, maxRounds, renderOptions })).rejects.toThrow('REFINEMENT_OPTIONS');
    expect(calls).toHaveLength(0);
  });

  it.each([-1, NaN, Infinity])('refuses invalid plateau option %s before any call', async minDelta => {
    const { client, calls } = clientFor(null);
    await expect(refineCandidate('bounds', rich(), { client, force: true, minDelta, renderOptions })).rejects.toThrow('REFINEMENT_OPTIONS');
    expect(calls).toHaveLength(0);
  });

  it('allows an explicit zero-round budget without making calls', async () => {
    const l = rich(), { client, calls } = clientFor(null);
    const result = await refineCandidate('zero', l, { client, force: true, maxRounds: 0, renderOptions });
    expect(calls).toHaveLength(0);
    expect(result.finalLayout).toEqual(l);
    expect(result.roundsRun).toBe(0);
    expect(result.stopReason).toBe('refinement_disabled');
  });
});
