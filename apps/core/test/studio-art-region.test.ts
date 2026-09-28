import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { runArtStage } from '../src/services/design-studio/stages/art.stage.js';
import { runQAStage } from '../src/services/design-studio/stages/qa.stage.js';
import type { CandidateState, StageContext } from '../src/services/design-studio/types.js';

// ADR-123: the region a layout reserves for text is described to the image provider in the frame the
// provider is asked for, retained with the art, and checked at final QA against where it landed.
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** A real uniform grey PNG, encoded here: Core has no image-encoding dependency of its own. */
function solid(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.alloc(1 + width * 3, 200); row[0] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
const box = { x: 0, y: 0, width: 1080, height: 1350 };
const bottom = { x: 0, y: 945, width: 1080, height: 405 };

function fixture(calmRegion = bottom) {
  const ctx = {
    pipelineV3: true, width: 1080, height: 1350, copyBlocks: [{ text: 'Approved workshop', script: 'latin' }],
    referencePack: { palette: ['#0A1628', '#FFFFFF'] }, latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic',
  } as unknown as StageContext;
  const candidate: CandidateState = {
    id: 'candidate-region', ordinal: 0, layouts: [], critiques: [], status: 'draft', concept: { artStrategy: 'generated' } as CandidateState['concept'],
    currentLayout: {
      version: 2, width: 1080, height: 1350, grid: { margin: 76, columns: 6, gutter: 26, baseline: 8 },
      background: { color: '#0A1628' }, shapes: [], logo: { x: 480, y: 80, width: 120, height: 120 },
      text: [{ copyIndex: 0, role: 'body', x: 76, y: 1000, width: 928, height: 70, fontSize: 24, fontFamily: 'Verdana', lineHeight: 1.3, color: '#FFFFFF', align: 'center' }],
      art: { source: 'generated', prompt: 'Abstract texture', box, calmRegion, opacity: 0.4 },
    },
  };
  return { ctx, candidate };
}
function provider(ctx: StageContext, output: Buffer) {
  const generateArt = vi.fn().mockResolvedValue({ imageBuffer: output, receipt: { sha256: sha(output), provider: 'openai', model: 'synthetic' } });
  ctx.artProvider = { generateArt } as unknown as StageContext['artProvider'];
  return generateArt;
}

describe('provider frame region mapping at the art stage', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('describes the reserved region in the requested provider frame and retains the plan with its check', async () => {
    const f = fixture(); const output = solid(1024, 1024); const generateArt = provider(f.ctx, output);
    await runArtStage(f.ctx, [f.candidate]);
    expect(generateArt).toHaveBeenCalledTimes(1);
    const params = generateArt.mock.calls[0][0];
    expect(params.calmRegionDescription).toBe('from 10% to 90% across and 70% to 100% down the image');
    expect(params.aspect).toBe('1:1');
    expect(params.settings).toMatchObject({ provider: 'openai', size: '1024x1024' });
    const region = (f.candidate.artProvenance as { region: Record<string, any> }).region;
    expect(region.plan).toMatchObject({ version: 1, frame: { width: 1024, height: 1024, assumed: false }, description: params.calmRegionDescription });
    expect(region.generated).toMatchObject({ status: 'landed_as_prompted', output: { width: 1024, height: 1024 }, containedShare: 1 });
    expect(JSON.parse(JSON.stringify(f.candidate.artProvenance))).toEqual(f.candidate.artProvenance);
  });

  it('uses the configured frame and records an output that came back in another frame', async () => {
    vi.stubEnv('HAWA_IMAGE_SIZE', '1024x1536');
    const f = fixture(); const generateArt = provider(f.ctx, solid(1536, 1024));
    await runArtStage(f.ctx, [f.candidate]);
    const params = generateArt.mock.calls[0][0];
    expect(params.calmRegionDescription).toBe('from 0% to 100% across and 67% to 92% down the image');
    expect(params.aspect).toBe('2:3');
    expect((f.candidate.artProvenance as { region: Record<string, any> }).region.generated).toMatchObject({ status: 'frame_mismatch', output: { width: 1536, height: 1024 } });
  });

  it('keeps unreadable provider bytes explicit instead of inventing a landing', async () => {
    const f = fixture(); provider(f.ctx, Buffer.from('synthetic-not-an-image'));
    await runArtStage(f.ctx, [f.candidate]);
    expect((f.candidate.artProvenance as { region: Record<string, any> }).region.generated).toMatchObject({ status: 'unreadable', landed: null });
  });
});

describe('final QA checks art against where it landed', () => {
  async function made() {
    const f = fixture(); const output = solid(1024, 1024); provider(f.ctx, output);
    await runArtStage(f.ctx, [f.candidate]);
    return f;
  }
  it('confirms the final layout still puts the calm region where the art was made for it', async () => {
    const f = await made();
    const qa = await runQAStage(f.ctx, { ...f.candidate, status: 'winner' });
    expect(qa.placement).toMatchObject({ version: 1, art: { status: 'landed_as_prompted', containedShare: 1 }, photos: [] });
    expect(qa.placement!.art!.detail).toMatchObject({ landedStdDev: 0, visibleStdDev: 0 });
  });

  it('reports a calm region that a later layout moved away from the prompted area', async () => {
    const f = await made();
    const moved = structuredClone(f.candidate.currentLayout);
    moved.art!.calmRegion = { x: 0, y: 0, width: 1080, height: 405 };
    moved.text[0].y = 100;
    const qa = await runQAStage(f.ctx, { ...f.candidate, currentLayout: moved, status: 'winner' });
    expect(qa.placement!.art).toMatchObject({ status: 'moved', containedShare: 0 });
  });

  it('says when a declared photo focus cannot be applied by the renderer', async () => {
    const f = fixture();
    f.ctx.photos = [{ bytes: Buffer.from('synthetic-unreadable-photo'), dataUrl: 'data:image/png;base64,AA==', mimeType: 'image/png' }];
    f.candidate.currentLayout.photos = [{ photoIndex: 0, role: 'portrait', x: 100, y: 200, width: 300, height: 300, focus: { x: 0.5, y: 0.1 } }];
    delete f.candidate.currentLayout.art;
    const qa = await runQAStage(f.ctx, { ...f.candidate, status: 'winner' });
    expect(qa.placement).toMatchObject({ art: null, photos: [{ photoIndex: 0, mode: 'centred_unknown_size', focusApplied: false }] });
  });
});
