import type { Box, PhotoElement, PhotoTreatment } from './layout-v2.js';

/**
 * A client's photograph with the person cut out of its background, for a photo placed with
 * `treatment: 'cutout'`. The matting happens elsewhere; this is what the renderer and the Canva
 * transfer receive, by photoIndex.
 *
 * Requesters' reference posters show panelists cut out and standing on the poster's own background
 * at the bottom. A framed photo cannot do that: it carries its own background into the design.
 */
export interface PhotoCutoutAsset {
  /** RGBA PNG of the person, trimmed to their bounding box. */
  png: Buffer;
  width: number;
  height: number;
  /**
   * Optional soft shadow RGBA PNG; its top-left sits at (shadowX, shadowY) in the cutout's own
   * pixel coordinates (may be negative), so it can extend beyond the cutout.
   */
  shadowPng?: Buffer;
  shadowWidth?: number;
  shadowHeight?: number;
  shadowX?: number;
  shadowY?: number;
}

/** The size fields of a cut-out, which are all the placement reads. */
export type PhotoCutoutGeometry = Pick<PhotoCutoutAsset, 'width' | 'height' | 'shadowWidth' | 'shadowHeight' | 'shadowX' | 'shadowY'>;

export interface CutoutPlacement {
  /** Where the person is drawn, in layout pixels. */
  person: Box;
  /** Where the shadow is drawn, in layout pixels, when the cut-out has one. It may leave the photo's box. */
  shadow?: Box;
  /** Layout pixels per cut-out pixel, shared by the person and the shadow. */
  scale: number;
}

/**
 * How far two cut-out people may overlap, as a share of the narrower box's width. People in a group
 * photograph stand shoulder to shoulder, so a little overlap reads as a group; more than about a
 * third hides one of them behind the other.
 */
export const CUTOUT_MAX_OVERLAP_SHARE = 0.35;

/**
 * Keeps a placement to a thousandth of a pixel, far below anything drawn. The preview writes these
 * numbers into SVG attributes, so a division's float tail (159.33333333333334) is cut there rather
 * than carried into the markup.
 */
function fine(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function positive(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * Where a cut-out person stands in a photo's box: scaled to fit inside the box with its aspect kept
 * ("contain"), centred horizontally and standing on the box's bottom edge. The shadow keeps the
 * same scale and its offset from the person's top-left.
 *
 * The one placement rule for both the preview and the Canva transfer, so the design the judge
 * scored and the design the client edits put the person in the same place.
 *
 * A box or a cut-out without a positive, finite size throws: the matting service produced
 * something that cannot be drawn, and drawing it framed instead would hide that.
 */
export function cutoutPlacement(box: Box, asset: PhotoCutoutGeometry): CutoutPlacement {
  if (![box.x, box.y].every(Number.isFinite) || !positive(box.width) || !positive(box.height)) {
    throw new RangeError(`Cut-out box has no usable size: ${JSON.stringify(box)}`);
  }
  if (!positive(asset.width) || !positive(asset.height)) {
    throw new RangeError(`Cut-out has no usable size: ${asset.width}x${asset.height}`);
  }
  const scale = Math.min(box.width / asset.width, box.height / asset.height);
  const width = fine(asset.width * scale);
  const height = fine(asset.height * scale);
  const person: Box = {
    x: fine(box.x + (box.width - width) / 2),
    // From the bottom edge, so the person's feet sit exactly on it.
    y: fine(box.y + box.height - height),
    width,
    height,
  };
  if (!positive(asset.shadowWidth) || !positive(asset.shadowHeight)) return { person, scale };
  const offsetX = asset.shadowX !== undefined && Number.isFinite(asset.shadowX) ? asset.shadowX : 0;
  const offsetY = asset.shadowY !== undefined && Number.isFinite(asset.shadowY) ? asset.shadowY : 0;
  const shadow: Box = {
    x: fine(person.x + offsetX * scale),
    y: fine(person.y + offsetY * scale),
    width: fine(asset.shadowWidth * scale),
    height: fine(asset.shadowHeight * scale),
  };
  return { person, shadow, scale };
}

/**
 * One thing the photo layer draws, bottom first. A framed photo is drawn as it always was; a cut-out
 * is a shadow and a person, each a PNG at an exact rect from `cutoutPlacement`. A cut-out with a glow
 * or an outline has that effect as a layer of its own under the person; its `png` is the person's
 * and its `rect` the person's rect, and the effect reaches beyond it (see `cutoutEffectFragment`).
 */
export type PhotoLayer =
  | { kind: 'framed'; photo: PhotoElement }
  | { kind: 'cutout-shadow' | 'cutout-glow' | 'cutout-outline' | 'cutout-person'; photo: PhotoElement; png: Buffer; rect: Box };

/**
 * The photo layer in drawing order, for both the preview and the Canva transfer, so the two stack
 * the same things the same way.
 *
 * Every cut-out's shadow goes down before any photo, then the photos in layout order. Cut-out
 * people in a group may overlap (see photosMayOverlap), and with each shadow drawn just under its
 * own person, the right-hand person's shadow would fall across the legs of the person beside them.
 *
 * A glow and an outline go just under their own person, glow lowest, unlike the shadows: they trace
 * the person's silhouette, and where two people overlap the outline of the one in front is what
 * separates them, as it does on a sticker-style group poster.
 *
 * A photo placed as a cut-out with no cut-out supplied is drawn framed, as it would have been
 * before cut-outs existed.
 */
export function photoLayers(
  photos: readonly PhotoElement[],
  cutouts: ReadonlyArray<PhotoCutoutAsset | undefined> | undefined
): PhotoLayer[] {
  const drawn = photos.map((photo) => {
    const asset = photo.treatment === 'cutout' ? cutouts?.[photo.photoIndex] : undefined;
    return { photo, asset, placed: asset ? cutoutPlacement(photo, asset) : undefined };
  });
  const layers: PhotoLayer[] = [];
  // A person fading into the background casts no contact shadow: the shadow stayed as a dark ghost of
  // the legs where the person had faded to nothing (2026-09-24 review).
  for (const { photo, asset, placed } of drawn) {
    if (asset?.shadowPng && placed?.shadow && !photo.fade) layers.push({ kind: 'cutout-shadow', photo, png: asset.shadowPng, rect: placed.shadow });
  }
  for (const { photo, asset, placed } of drawn) {
    if (asset && placed) {
      if (photo.glow) layers.push({ kind: 'cutout-glow', photo, png: asset.png, rect: placed.person });
      if (photo.outline) layers.push({ kind: 'cutout-outline', photo, png: asset.png, rect: placed.person });
      layers.push({ kind: 'cutout-person', photo, png: asset.png, rect: placed.person });
    } else layers.push({ kind: 'framed', photo });
  }
  return layers;
}

/**
 * Whether two placed photos may overlap. Two cut-out people may, by at most
 * CUTOUT_MAX_OVERLAP_SHARE of the narrower box's width, as people in a group do. A framed photo
 * never may: its rectangle would cover part of the other.
 */
export function photosMayOverlap(
  a: Box & { treatment?: PhotoTreatment },
  b: Box & { treatment?: PhotoTreatment }
): boolean {
  if (a.treatment !== 'cutout' || b.treatment !== 'cutout') return false;
  const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  return overlap <= CUTOUT_MAX_OVERLAP_SHARE * Math.min(a.width, b.width);
}
