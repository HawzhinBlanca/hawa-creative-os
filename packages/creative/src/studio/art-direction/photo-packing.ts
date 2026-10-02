import type { Box } from '../layout-v2.js';
import { protectedCropFocus, type SourceRegion, type RegionStatus } from '../protected-regions.js';

export interface PackingPhoto {
  photoIndex: number;
  width: number;
  height: number;
  regions?: SourceRegion[];
  regionStatus?: RegionStatus;
  focus?: { x: number; y: number };
}
export interface PackedPhoto extends Box { photoIndex: number; }

/** Ordered justified rows. Enumerate <=130 contiguous partitions for ten sources/four rows.
 * Source aspect determines each cell width; crop feasibility and readable cell sizes are hard
 * constraints. The score measures crop distortion, not professional taste. No photo is flipped.
 */
export function packPhotoSequence(photos: PackingPhoto[], area: Box, gap: number, shortEdge: number, rtl = false): PackedPhoto[] | null {
  if (photos.length < 2 || photos.length > 10 || photos.some(p => !Number.isFinite(p.width) || !Number.isFinite(p.height) || p.width <= 0 || p.height <= 0)
      || ![area.x, area.y, area.width, area.height, gap, shortEdge].every(Number.isFinite) || area.width <= 0 || area.height <= 0 || gap < 0 || shortEdge <= 0) return null;
  let best: { score: number; boxes: PackedPhoto[] } | undefined;
  const evaluate = (ends: number[]) => {
    const rows: PackingPhoto[][] = []; let start = 0;
    for (const end of ends) { rows.push(photos.slice(start, end)); start = end; }
    const natural = rows.map(row => (area.width - (row.length - 1) * gap) / row.reduce((sum, p) => sum + p.width / p.height, 0));
    if (natural.some(h => h <= 0)) return;
    const usableH = area.height - (rows.length - 1) * gap;
    if (usableH <= 0) return;
    const scale = usableH / natural.reduce((a, b) => a + b, 0);
    const boxes: PackedPhoto[] = []; let y = Math.round(area.y), score = 0;
    for (let r = 0, at = 0; r < rows.length; r++) {
      const row = rows[r], bottom = r === rows.length - 1 ? Math.round(area.y + area.height) : Math.round(y + natural[r] * scale);
      const h = bottom - y;
      const totalAspect = row.reduce((sum, p) => sum + p.width / p.height, 0);
      const usableW = area.width - (row.length - 1) * gap;
      let cursor = Math.round(area.x);
      for (let c = 0; c < row.length; c++, at++) {
        const p = row[c];
        const end = c === row.length - 1 ? Math.round(area.x + area.width) : Math.round(cursor + usableW * (p.width / p.height) / totalAspect);
        const w = end - cursor;
        if (Math.min(w, h) < Math.round(shortEdge * (at === 0 ? .22 : .12))) return;
        const x = rtl ? Math.round(area.x + area.width) - (end - Math.round(area.x)) : cursor;
        const box = { photoIndex: p.photoIndex, x, y, width: w, height: h };
        try { if (!protectedCropFocus(box, p, p.focus ?? { x: .5, y: .5 })) return; } catch { return; }
        const distortion = Math.log((w / h) / (p.width / p.height));
        // Equal per-source crop loss: small supporting photos must not lose their meaning
        // merely because a dominant hero contributes most of the area.
        score += distortion * distortion / photos.length;
        boxes.push(box); cursor = end + gap;
      }
      y = bottom + gap;
    }
    // Small penalty for fragmented rows; feasibility/crop distortion is dominant.
    score += .002 * (rows.length - 1);
    if (!best || score < best.score - 1e-9) best = { score, boxes };
  };
  const enumerate = (start: number, ends: number[]) => {
    evaluate([...ends, photos.length]);
    if (ends.length >= 3) return;
    for (let end = start + 1; end < photos.length; end++) enumerate(end, [...ends, end]);
  };
  enumerate(0, []);
  return best?.boxes ?? null;
}
