import { describe, expect, it } from 'vitest';
import { sourceRegionsFromPixels, protectedCropFocus, protectedRegionsOnCanvas, photoRegionViolations, type SourceRegion } from '../src/studio/protected-regions.js';
import { coverCrop } from '../src/studio/photo-crop.js';
import type { PhotoElement } from '../src/studio/layout-v2.js';

const face = (x: number, y = .2): SourceRegion => ({ kind: 'face', x, y, width: .1, height: .1 });
const image = (regions = [face(.08), face(.8)]) => ({ width: 1000, height: 500, regions, regionStatus: 'measured' as const });
const photo: PhotoElement = { photoIndex: 0, role: 'hero', x: 0, y: 0, width: 1000, height: 500 };
const empty = { photos: [photo], text: [], shapes: [], logo: { x: 1100, y: 0, width: 40, height: 40 } };

describe('individual source-region protection', () => {
  it('refuses a tall crop that cannot show both sides of a group photograph', () => {
    expect(protectedCropFocus({ width: 250, height: 500 }, image(), { x: .5, y: .25 })).toBeNull();
  });
  it('moves a feasible crop to retain an off-center subject and headroom', () => {
    const source = image([face(.05)]);
    const focus = protectedCropFocus({ width: 500, height: 500 }, source, { x: .8, y: .5 })!;
    const crop = coverCrop({ width: 500, height: 500 }, source, focus);
    expect(crop.sx).toBeLessThanOrEqual(35 + 1e-6);
    const boxes = protectedRegionsOnCanvas({ ...photo, width: 500, focus }, source);
    expect(boxes[0].x).toBeGreaterThanOrEqual(-1e-6);
    expect(boxes[0].x + boxes[0].width).toBeLessThanOrEqual(500 + 1e-6);
  });
  it('does not fabricate detections when the old service omitted region evidence', () => {
    expect(sourceRegionsFromPixels(undefined, 1000, 500)).toBeUndefined();
    expect(sourceRegionsFromPixels([], 1000, 500)).toEqual({ regionStatus: 'measured', regions: [] });
  });
  it.each([null, [{ x: '0', y: 0, width: 10, height: 10 }], [{ x: 0, y: 0, width: -1, height: 1 }],
    [{ x: 1001, y: 0, width: 10, height: 10 }], Array.from({ length: 129 }, () => ({ x: 0, y: 0, width: 1, height: 1 }))])
  ('rejects malformed or unbounded region data (%#)', value => {
    expect(sourceRegionsFromPixels(value, 1000, 500)).toEqual({ regionStatus: 'invalid' });
  });
  it('clips a real edge detection to available source pixels without deleting interior white/logo pixels', () => {
    expect(sourceRegionsFromPixels([{ x: -10, y: 0, width: 100, height: 50 }], 1000, 500))
      .toEqual({ regionStatus: 'measured', regions: [{ kind: 'face', x: 0, y: 0, width: .09, height: .1 }] });
  });
  it('checks every individual subject rather than an imaginary face in the gap', () => {
    expect(photoRegionViolations({ ...empty, text: [{ x: 400, y: 100, width: 100, height: 100 }] }, [image()])).toEqual([]);
    expect(photoRegionViolations({ ...empty, text: [{ x: 790, y: 90, width: 100, height: 80 }] }, [image()]))
      .toEqual(['PHOTO_SUBJECT_COVERED: photo 0 region 1 is covered by copy, logo or panel']);
  });
  it('detects a cropped supporting image even if its hero is untouched', () => {
    const support = { ...photo, photoIndex: 1, role: 'inset' as const, x: 1100, width: 250, focus: { x: .5, y: .5 } };
    const errors = photoRegionViolations({ ...empty, photos: [photo, support], logo: { x: 0, y: 700, width: 40, height: 40 } }, [image([]), image()]);
    expect(errors.filter(e => e.startsWith('PHOTO_SUBJECT_CROPPED'))).toHaveLength(2);
  });
  it('refuses invalid saved detector evidence even when coordinates otherwise fit', () => {
    expect(photoRegionViolations(empty, [{ ...image(), regionStatus: 'invalid' }])).toEqual(['PHOTO_REGION_INVALID: photo 0 has invalid region evidence']);
  });
  it('maps cover zoom exactly and exposes cropped subjects after an edit', () => {
    expect(photoRegionViolations({ ...empty, photos: [{ ...photo, zoom: 2 }] }, [image()]).some(e => e.startsWith('PHOTO_SUBJECT_CROPPED'))).toBe(true);
  });
});
