import { PNG } from 'pngjs';
import type { Box, PhotoElement, StudioLayoutV2 } from './layout-v2.js';
import { coverCrop, imagePixelSize, photoZoomFactor, type CoverCropRect } from './photo-crop.js';
import { rgbToLuminance } from './composite-contrast.js';
import type { PhotoCutoutAsset } from './photo-cutout.js';

/**
 * ADR-123: where the regions a layout declares actually land in the pictures it draws.
 *
 * The art is drawn into its box with preserveAspectRatio="xMidYMid slice" (the renderer and the
 * deck both): scaled to cover the box, centred, and the overflow cropped. The image provider,
 * though, returns the frame it was asked for (1024x1024 by default), not the box's shape. A calm
 * region described to it in layout pixels, or in shares of the canvas, names a different area of
 * the image from the one the text finally sits over. These functions map a canvas region into the
 * provider's frame through that same cover crop, and check a finished image against the region it
 * was made for. A framed photo's declared focus is recorded with the crop the renderer applies.
 */

export interface PixelSize { width: number; height: number }
/** The frame the provider is asked for; `assumed` when the request leaves it to the provider. */
export interface ArtFrame extends PixelSize { assumed: boolean }
/** A rectangle as shares (0..1) of an image's width and height, from its top-left. */
export interface NormalizedRect { x: number; y: number; width: number; height: number }

export interface ArtRegionPlan {
  version: 1;
  frame: ArtFrame;
  artBox: Box;
  calmRegion: Box;
  /** The calm region in the frame, after the cover crop; null when no part of it is over the art. */
  prompted: NormalizedRect | null;
  /** The words the provider receives, or undefined when there is no region to describe. */
  description?: string;
  /** The frame's aspect as the provider is told it. */
  aspect: string;
}

export type ArtLandingStatus = 'landed_as_prompted' | 'moved' | 'frame_mismatch' | 'not_prompted' | 'outside_art' | 'unreadable';

export interface ArtLanding {
  version: 1;
  artBox: Box;
  calmRegion: Box;
  /** The pixel size of the image that was drawn; null when its bytes could not be read. */
  output: PixelSize | null;
  /** The part of the image the renderer shows in the art box, in its own pixels. */
  crop: CoverCropRect | null;
  /** Where the calm region lands in the image, as shares of it. */
  landed: NormalizedRect | null;
  prompted: NormalizedRect | null;
  /** The share of the landed region inside the prompted one, when the two are in the same frame. */
  containedShare: number | null;
  status: ArtLandingStatus;
  /** Luminance spread inside the landed region and over the whole visible crop (PNG art only). */
  detail?: { landedStdDev: number; visibleStdDev: number };
}

/** Held region at least this share inside the prompted one counts as landing where it was asked. */
const CONTAINED_SHARE = 0.98;
/** Relative aspect difference above which a returned frame is a different frame. */
const ASPECT_TOLERANCE = 0.005;

function round(n: number, places = 6): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function intersect(a: Box, b: Box): Box | null {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width), y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

const area = (b: Box | null) => (b ? b.width * b.height : 0);

/** The frame a provider request names: OpenAI's WxH, Google's aspect ratio; else the box, assumed. */
export function expectedArtFrame(settings: { provider: string; size: string; aspectRatio: string }, artBox: Box): ArtFrame {
  const size = /^(\d{2,5})x(\d{2,5})$/.exec(settings.size);
  if (settings.provider === 'openai' && size) return { width: Number(size[1]), height: Number(size[2]), assumed: false };
  const ratio = /^(\d{1,3}):(\d{1,3})$/.exec(settings.aspectRatio);
  if (settings.provider === 'google' && ratio) return { width: Number(ratio[1]), height: Number(ratio[2]), assumed: false };
  return { width: Math.max(1, Math.round(artBox.width)), height: Math.max(1, Math.round(artBox.height)), assumed: true };
}

/**
 * A canvas region in an image's own pixels under the cover crop, clipped to what the art box shows.
 * The same transform as canvasBoxToArtPixels, then kept to the visible crop.
 */
export function canvasRegionInImage(region: Box, artBox: Box, image: PixelSize): { crop: CoverCropRect; rect: Box | null } {
  const crop = coverCrop(artBox, image);
  const scale = Math.max(artBox.width / image.width, artBox.height / image.height);
  const originX = artBox.x + (artBox.width - image.width * scale) / 2;
  const originY = artBox.y + (artBox.height - image.height * scale) / 2;
  const mapped = { x: (region.x - originX) / scale, y: (region.y - originY) / scale, width: region.width / scale, height: region.height / scale };
  return { crop, rect: intersect(mapped, { x: crop.sx, y: crop.sy, width: crop.sw, height: crop.sh }) };
}

function normalized(rect: Box, image: PixelSize): NormalizedRect {
  return { x: round(rect.x / image.width), y: round(rect.y / image.height), width: round(rect.width / image.width), height: round(rect.height / image.height) };
}

function gcd(a: number, b: number): number { return b ? gcd(b, a % b) : a; }

function aspectWords(frame: PixelSize): string {
  const d = gcd(frame.width, frame.height);
  const w = frame.width / d, h = frame.height / d;
  return w <= 32 && h <= 32 ? `${w}:${h}` : `${(frame.width / frame.height).toFixed(2)}:1`;
}

const pct = (share: number) => Math.round(share * 100);

/** What the provider is asked to keep calm, in its own frame, for the art box's cover crop. */
export function planArtRegion(art: { box: Box; calmRegion: Box }, frame: ArtFrame): ArtRegionPlan {
  const { rect } = canvasRegionInImage(art.calmRegion, art.box, frame);
  const prompted = rect ? normalized(rect, frame) : null;
  return {
    version: 1, frame, artBox: { ...art.box }, calmRegion: { ...art.calmRegion }, prompted,
    ...(prompted ? { description: `from ${pct(prompted.x)}% to ${pct(prompted.x + prompted.width)}% across and ${pct(prompted.y)}% to ${pct(prompted.y + prompted.height)}% down the image` } : {}),
    aspect: aspectWords(frame),
  };
}

function sameAspect(a: PixelSize, b: PixelSize): boolean {
  const ra = a.width / a.height, rb = b.width / b.height;
  return Math.abs(ra - rb) / rb <= ASPECT_TOLERANCE;
}

/** Luminance spread (sampled) inside two rectangles of a PNG, or undefined for other formats. */
function pngDetail(bytes: Buffer, landed: Box | null, visible: Box): ArtLanding['detail'] {
  let png: PNG;
  try { png = PNG.sync.read(bytes); } catch { return undefined; }
  const spread = (rect: Box | null): number => {
    if (!rect) return 0;
    const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(png.width, Math.ceil(rect.x + rect.width)), y1 = Math.min(png.height, Math.ceil(rect.y + rect.height));
    const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 250_000)));
    let n = 0, mean = 0, m2 = 0;
    for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
      const i = (y * png.width + x) * 4;
      const l = rgbToLuminance(png.data[i], png.data[i + 1], png.data[i + 2]);
      n++; const d = l - mean; mean += d / n; m2 += d * (l - mean);
    }
    return n ? round(Math.sqrt(m2 / n), 5) : 0;
  };
  return { landedStdDev: spread(landed), visibleStdDev: spread(visible) };
}

/**
 * Where the art's calm region lands in the image actually drawn, checked against the region the
 * image was prompted for. `moved`: a later layout put the calm region elsewhere; `frame_mismatch`:
 * the image came back in another frame, so the prompt's words named another area.
 */
export function landArtRegion(
  art: { box: Box; calmRegion: Box },
  output: PixelSize | null,
  plan: Pick<ArtRegionPlan, 'frame' | 'prompted'> | undefined,
  bytes?: Buffer,
): ArtLanding {
  const base = { version: 1 as const, artBox: { ...art.box }, calmRegion: { ...art.calmRegion }, output: output ? { ...output } : null, prompted: plan?.prompted ?? null };
  if (!output || !(output.width > 0 && output.height > 0)) {
    return { ...base, output: null, crop: null, landed: null, containedShare: null, status: 'unreadable' };
  }
  const { crop, rect } = canvasRegionInImage(art.calmRegion, art.box, output);
  const landed = rect ? normalized(rect, output) : null;
  const detail = bytes ? pngDetail(bytes, rect, { x: crop.sx, y: crop.sy, width: crop.sw, height: crop.sh }) : undefined;
  const result = { ...base, crop, landed, ...(detail ? { detail } : {}) };
  if (!plan?.prompted) return { ...result, containedShare: null, status: 'not_prompted' };
  if (!sameAspect(plan.frame, output)) return { ...result, containedShare: null, status: 'frame_mismatch' };
  if (!landed) return { ...result, containedShare: null, status: 'outside_art' };
  const share = round(area(intersect(landed, plan.prompted)) / area(landed), 4);
  return { ...result, containedShare: share, status: share >= CONTAINED_SHARE ? 'landed_as_prompted' : 'moved' };
}

export type PhotoCropMode = 'cover' | 'centred_unknown_size' | 'cutout' | 'missing';

export interface PhotoCropPlacement {
  photoIndex: number;
  box: Box;
  declaredFocus: { x: number; y: number } | null;
  zoom: number;
  source: PixelSize | null;
  /** The part of the photograph the renderer shows, in its own pixels; null when it cannot say. */
  crop: CoverCropRect | null;
  mode: PhotoCropMode;
  /** Whether the declared focus and zoom decide what the renderer shows. */
  focusApplied: boolean;
}

/**
 * The crop the renderer applies to one placed photo. With a readable pixel size it draws exactly
 * `coverCrop` (plain and treated framed photos alike); without one it can only draw the centred
 * slice, so a declared focus or zoom is not applied, and that is recorded rather than assumed.
 */
export function photoCropPlacement(photo: PhotoElement, pixels: PixelSize | null, hasSource: boolean): PhotoCropPlacement {
  const declaredFocus = photo.focus ? { x: photo.focus.x, y: photo.focus.y } : null;
  const zoom = photoZoomFactor(photo.zoom);
  const box = { x: photo.x, y: photo.y, width: photo.width, height: photo.height };
  const base = { photoIndex: photo.photoIndex, box, declaredFocus, zoom, source: pixels ? { ...pixels } : null };
  const directed = Boolean(declaredFocus) || zoom > 1;
  if (photo.treatment === 'cutout') return { ...base, crop: null, mode: 'cutout', focusApplied: !directed };
  if (!hasSource) return { ...base, crop: null, mode: 'missing', focusApplied: false };
  if (!pixels) return { ...base, crop: null, mode: 'centred_unknown_size', focusApplied: !directed };
  return { ...base, crop: coverCrop(box, pixels, photo.focus, photo.zoom), mode: 'cover', focusApplied: true };
}

export interface LayoutPlacements {
  version: 1;
  art: ArtLanding | null;
  photos: PhotoCropPlacement[];
}

/**
 * Every placement the renderer would apply to this layout with these bytes. `artPlan` is the region
 * the art was made for; `measureDetail` also reads the art's pixels in the landed region.
 */
export function layoutPlacements(layout: StudioLayoutV2, sources: {
  art?: Buffer; artPlan?: Pick<ArtRegionPlan, 'frame' | 'prompted'>; photos?: Array<Buffer | undefined>;
  cutouts?: ReadonlyArray<PhotoCutoutAsset | undefined>; measureDetail?: boolean;
}): LayoutPlacements {
  const artBox = layout.art ? layout.art.box || { x: 0, y: 0, width: layout.width, height: layout.height } : undefined;
  const art = layout.art && artBox && sources.art
    ? landArtRegion({ box: artBox, calmRegion: layout.art.calmRegion || artBox }, imagePixelSize(sources.art), sources.artPlan,
      sources.measureDetail ? sources.art : undefined)
    : null;
  const photos = (layout.photos ?? []).map((photo) => {
    const cut = photo.treatment === 'cutout' && sources.cutouts?.[photo.photoIndex];
    const bytes = sources.photos?.[photo.photoIndex];
    const framed = cut ? photo : { ...photo, treatment: 'framed' as const };
    return photoCropPlacement(framed, bytes && bytes.length ? imagePixelSize(bytes) : null, Boolean(cut) || Boolean(bytes && bytes.length));
  });
  return { version: 1, art, photos };
}
