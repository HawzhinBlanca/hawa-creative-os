import { coverCrop } from './photo-crop.js';
import type { Box, PhotoElement } from './layout-v2.js';

/** ADR-172: normalized regions in the original upright source, never canvas coordinates. */
export interface SourceRegion extends Box { kind: 'face' | 'subject' | 'product' }
export type RegionStatus = 'measured' | 'invalid';
export interface PhotoRegionEvidence {
  width: number;
  height: number;
  regions?: SourceRegion[];
  regionStatus?: RegionStatus;
}

/** Parse untrusted pixel boxes. Invalid evidence must not become a measured empty detection. */
export function sourceRegionsFromPixels(value: unknown, width: unknown, height: unknown):
  { regionStatus: RegionStatus; regions?: SourceRegion[] } | undefined {
  if (value === undefined) return undefined; // legacy service did not provide region evidence
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!Array.isArray(value) || value.length > 128 || !finite(width) || !finite(height) || width <= 0 || height <= 0)
    return { regionStatus: 'invalid' };
  const regions: SourceRegion[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return { regionStatus: 'invalid' };
    const { x, y, width: w, height: h } = raw as Record<string, unknown>;
    if (!finite(x) || !finite(y) || !finite(w) || !finite(h) || w <= 0 || h <= 0)
      return { regionStatus: 'invalid' };
    const left = Math.max(0, x), top = Math.max(0, y);
    const right = Math.min(width, x + w), bottom = Math.min(height, y + h);
    if (right <= left || bottom <= top) return { regionStatus: 'invalid' };
    regions.push({ kind: 'face', x: left / width, y: top / height, width: (right - left) / width, height: (bottom - top) / height });
  }
  return { regionStatus: 'measured', regions };
}

function valid(r: SourceRegion): boolean {
  return ['face', 'subject', 'product'].includes(r.kind) && [r.x, r.y, r.width, r.height].every(Number.isFinite)
    && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= 1 + 1e-9 && r.y + r.height <= 1 + 1e-9;
}

/** Keep headroom where source pixels exist; never infer pixels outside the photograph. */
function expanded(r: SourceRegion): Box {
  if (!valid(r)) throw new RangeError('PHOTO_REGION_INVALID: malformed source region');
  const px = r.kind === 'face' ? 0.15 * r.width : 0;
  const py = r.kind === 'face' ? 0.2 * r.height : 0;
  const x = Math.max(0, r.x - px), y = Math.max(0, r.y - py);
  return { x, y, width: Math.min(1, r.x + r.width + px) - x, height: Math.min(1, r.y + r.height + py) - y };
}

/** A cover crop that retains every region, closest to the proposed focus; null if impossible. */
export function protectedCropFocus(box: Pick<Box, 'width' | 'height'>, image: PhotoRegionEvidence,
  fallback?: { x: number; y: number }, zoom?: number): { x: number; y: number } | null {
  if (image.regionStatus === 'invalid') throw new RangeError('PHOTO_REGION_INVALID: invalid detector evidence');
  const crop = coverCrop(box, image, fallback, zoom);
  const regions = image.regions ?? [];
  if (!regions.length) return fallback ?? { x: 0.5, y: 0.5 };
  if (regions.length > 128) throw new RangeError('PHOTO_REGION_INVALID: too many regions');
  const boxes = regions.map(expanded);
  const place = (axis: 'x' | 'y', size: 'width' | 'height', kept: number, proposed: number) => {
    const start = Math.min(...boxes.map(r => r[axis] * image[size]));
    const end = Math.max(...boxes.map(r => (r[axis] + r[size]) * image[size]));
    const low = Math.max(0, end - kept), high = Math.min(image[size] - kept, start);
    return low > high + 1e-6 ? null : Math.min(high, Math.max(low, proposed));
  };
  const x = place('x', 'width', crop.sw, crop.sx), y = place('y', 'height', crop.sh, crop.sy);
  if (x === null || y === null) return null;
  return { x: (x + crop.sw / 2) / image.width, y: (y + crop.sh / 2) / image.height };
}

/** Map each source region through the exact crop used by SVG and native transfer. */
export function protectedRegionsOnCanvas(photo: PhotoElement, image: PhotoRegionEvidence): Box[] {
  if (image.regionStatus === 'invalid') throw new RangeError('PHOTO_REGION_INVALID: invalid detector evidence');
  const crop = coverCrop(photo, image, photo.focus, photo.zoom);
  const regions = image.regions ?? [];
  if (regions.length > 128) throw new RangeError('PHOTO_REGION_INVALID: too many regions');
  return regions.map(r => {
    const b = expanded(r);
    return { x: photo.x + (b.x * image.width - crop.sx) * photo.width / crop.sw,
      y: photo.y + (b.y * image.height - crop.sy) * photo.height / crop.sh,
      width: b.width * image.width * photo.width / crop.sw, height: b.height * image.height * photo.height / crop.sh };
  });
}

/** Independent final-layout audit: catches edits/refinement that bypassed the original solver. */
export function photoRegionViolations(layout: { photos?: PhotoElement[]; text: Box[]; logo: Box;
  shapes: Array<Box & { role?: string; fill?: string; layer?: string }> }, evidence: Array<PhotoRegionEvidence | undefined>): string[] {
  const errors: string[] = [];
  const hit = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  for (const photo of layout.photos ?? []) {
    const source = evidence[photo.photoIndex];
    if (!source || photo.treatment === 'cutout') continue; // cutouts have their separate alpha/face gates
    let boxes: Box[];
    try { boxes = protectedRegionsOnCanvas(photo, source); }
    catch { errors.push(`PHOTO_REGION_INVALID: photo ${photo.photoIndex} has invalid region evidence`); continue; }
    for (const [i, b] of boxes.entries()) {
      const slack = 1;
      if (b.x < photo.x - slack || b.y < photo.y - slack || b.x + b.width > photo.x + photo.width + slack || b.y + b.height > photo.y + photo.height + slack)
        errors.push(`PHOTO_SUBJECT_CROPPED: photo ${photo.photoIndex} region ${i} leaves its visible crop`);
      const covers = [...layout.text, layout.logo, ...layout.shapes.filter(s => s.role === 'panel' && s.fill !== 'none' && s.layer === 'overlay')];
      if (covers.some(c => hit(c, b))) errors.push(`PHOTO_SUBJECT_COVERED: photo ${photo.photoIndex} region ${i} is covered by copy, logo or panel`);
    }
  }
  return errors;
}
