import { describe, it, expect } from 'vitest';
import {
  evaluateThumbnailLayout,
  evaluateHardQa,
  minThumbnailHookPx,
  thumbnailCoveredZone,
  thumbnailPlaybookPrompt,
  thumbnailPreviewWidth,
  type StudioLayoutV2,
} from '../src/index.js';

/** The video-thumbnail playbook (ADR-127, ported from studio-v2's 1d07664b), enforced where the layout can change it. */
const YT = { width: 1280, height: 720 };
const REEL = { width: 1080, height: 1920 };

const layout = (canvas: { width: number; height: number }, over: Partial<StudioLayoutV2> = {}): StudioLayoutV2 =>
  ({
    version: 2,
    width: canvas.width,
    height: canvas.height,
    genre: 'poster',
    grid: { margin: 72, columns: 6, gutter: 24, baseline: 12 },
    background: { color: '#101820' },
    logo: { x: canvas.width - 72 - 110, y: 60, width: 110, height: 110 },
    shapes: [],
    text: [],
    ...over,
  }) as StudioLayoutV2;

const text = (o: { i: number; role: string; x: number; y: number; w: number; h: number; size: number }) => ({
  copyIndex: o.i,
  role: o.role,
  x: o.x,
  y: o.y,
  width: o.w,
  height: o.h,
  fontSize: o.size,
  lineHeight: 1.2,
  fontFamily: 'Inter',
  color: '#FFFFFF',
  align: 'left',
});

describe('thumbnail sizes', () => {
  it('reads a 16:9 thumbnail at 168px and a 9:16 cover at 180px', () => {
    expect(thumbnailPreviewWidth(YT)).toBe(168);
    expect(thumbnailPreviewWidth(REEL)).toBe(180);
  });

  it('asks for a hook that is still 9px tall at that size', () => {
    expect(minThumbnailHookPx(YT)).toBe(69);
    expect(minThumbnailHookPx(REEL)).toBe(54);
  });

  it('keeps clear where the platform draws over the thumbnail', () => {
    expect(thumbnailCoveredZone(YT)).toMatchObject({ x: 1024, y: 605, width: 256, height: 115, what: 'the video length' });
    expect(thumbnailCoveredZone(REEL)).toMatchObject({ x: 918, y: 768, width: 162, height: 768, what: 'the like, comment and share buttons' });
  });
});

describe('a thumbnail layout', () => {
  const good = layout(YT, {
    text: [text({ i: 0, role: 'title', x: 72, y: 200, w: 700, h: 200, size: 84 }), text({ i: 1, role: 'subtitle', x: 72, y: 420, w: 600, h: 60, size: 40 })] as any,
  });

  it('passes with a big hook, a small top-corner logo and the length corner free', () => {
    expect(evaluateThumbnailLayout(good, YT)).toEqual({ defectCodes: [], messages: [] });
  });

  it('fails a hook too small to read in a list', () => {
    const small = { ...good, text: [{ ...good.text[0], fontSize: 48 }, good.text[1]] };
    const check = evaluateThumbnailLayout(small, YT);
    expect(check.defectCodes).toEqual(['THUMBNAIL_HOOK_TOO_SMALL']);
    expect(check.messages[0]).toContain('needs at least 69px');
  });

  it('reads the largest block as the hook when no block is a title', () => {
    const untitled = { ...good, text: good.text.map((t) => ({ ...t, role: 'other' as const, fontSize: 40 })) };
    expect(evaluateThumbnailLayout(untitled, YT).defectCodes).toEqual(['THUMBNAIL_HOOK_TOO_SMALL']);
  });

  it('fails text or a logo under the video length', () => {
    const credit = text({ i: 2, role: 'footer', x: 1040, y: 640, w: 180, h: 40, size: 28 });
    const check = evaluateThumbnailLayout({ ...good, text: [...good.text, credit] as any, logo: { x: 1120, y: 600, width: 100, height: 100 } }, YT);
    expect(check.defectCodes).toEqual(['THUMBNAIL_COVERED_ZONE']);
    expect(check.messages[0]).toContain('block 2 (footer), the logo are under the video length');
  });

  it("fails a reel whose text runs under the platform's buttons", () => {
    const reel = layout(REEL, { text: [text({ i: 0, role: 'title', x: 80, y: 900, w: 900, h: 300, size: 90 })] as any });
    expect(evaluateThumbnailLayout(reel, REEL).defectCodes).toEqual(['THUMBNAIL_COVERED_ZONE']);
  });
});

describe('hard QA applies the thumbnail rules only to a thumbnail client', () => {
  const tooSmall = layout(YT, { text: [text({ i: 0, role: 'title', x: 72, y: 200, w: 700, h: 200, size: 48 })] as any });
  const ctx = { width: 1280, height: 720, copyScripts: ['latin' as const], latinFont: 'Inter', arabicFont: 'Noto Sans Arabic', palette: ['#101820', '#FFFFFF'], logoAspect: 1 };

  it('fails it for the thumbnail playbook', () => {
    expect(evaluateHardQa(tooSmall, { ...ctx, playbook: 'video-thumbnail' }).defectCodes).toContain('THUMBNAIL_HOOK_TOO_SMALL');
  });

  it('leaves an announcement client to the house rules alone', () => {
    const codes = evaluateHardQa(tooSmall, { ...ctx, playbook: 'institutional-announcement' }).defectCodes;
    expect(codes.filter((c) => c.startsWith('THUMBNAIL_'))).toEqual([]);
    expect(evaluateHardQa(tooSmall, ctx).defectCodes.filter((c) => c.startsWith('THUMBNAIL_'))).toEqual([]);
  });
});

describe('the playbook the design stages are told', () => {
  it('names the listing size, the hook size, the free corner and that the copy is never cut', () => {
    const prompt = thumbnailPlaybookPrompt(YT);
    expect(prompt).toContain('168px wide');
    expect(prompt).toContain('at least 69px');
    expect(prompt).toContain('x 1024-1280, y 605-720');
    expect(prompt).toContain('keep every word (the copy is exact)');
  });
});
