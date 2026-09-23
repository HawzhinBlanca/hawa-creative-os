import type { Box, Hex, PhotoElement, PhotoFade, PhotoFilter, PhotoGlow, PhotoMask, PhotoOutline } from './layout-v2.js';
import {
  hexSchema,
  PHOTO_FADE_EDGES,
  PHOTO_FADE_LENGTH_MAX,
  PHOTO_FADE_LENGTH_MIN,
  PHOTO_GLOW_RADIUS_MAX,
  PHOTO_GLOW_RADIUS_MIN,
  PHOTO_MASKS,
  PHOTO_OUTLINE_WIDTH_MAX,
  PHOTO_OUTLINE_WIDTH_MIN,
  PHOTO_ZOOM_MAX,
  PHOTO_ZOOM_MIN,
} from './layout-v2.js';
import { coverCrop, pngPixelSize, type CoverCropRect } from './photo-crop.js';
import { hexToRgb } from './color-science.js';

/**
 * Designer treatments of a client's photo: a circle or arch mask, a fade into the background, a
 * black-and-white, duotone or tint filter, and an outline or glow around a cut-out person. Every one
 * is deterministic: it crops, masks, recolours or draws around the photograph's own pixels, and none
 * of them regenerates a person (ADR-032).
 *
 * This module is the one source of the treated pixels. It builds the SVG fragment for a treated
 * photo; the preview inlines that fragment, and the Canva transfer rasterises the same fragment,
 * alone, through the same rsvg-convert the preview uses, and places the PNG at the fragment's rect
 * with no further crop. Canva keeps a PNG's alpha on PPTX import, so the mask and the fade survive,
 * and the design the judge scored and the design the client edits show the same pixels.
 *
 * A photo with none of these treatments is not drawn from here at all: the preview and the deck
 * draw it exactly as before (the deck natively cropped, so the client can re-crop it in Canva).
 *
 * The fragments carry their own defs and ids made from the photo's index, so two photos with the
 * same filter still have distinct ids, and a fragment wrapped alone still resolves every reference.
 */

/** Rec. 709 luma weights, applied to the sRGB values as a designer's greyscale is. */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/**
 * An outline's region reaches this many layout pixels past its width, so the anti-aliased rim of the
 * grown silhouette is not cut by the filter's edge.
 */
const OUTLINE_REGION_MARGIN_PX = 1;

/**
 * The largest single feMorphology step, in layout pixels. librsvg (2.62, measured 2026-09-23) rounds
 * a morphology radius to whole device pixels and caps it at 10: an outline 12px wide drew 10px wide
 * in the preview and 5px wide in a deck baked at 2x. Dilations by squares add up, so a wider outline
 * is several steps, each at most 10 device pixels at PHOTO_BAKE_SCALE_MAX.
 */
const OUTLINE_MORPHOLOGY_STEP_PX = 5;

/**
 * A glow is the silhouette blurred by a Gaussian whose standard deviation is half the glow's radius,
 * so the halo is still clearly there at the radius and has faded out by one and a half radii.
 */
const GLOW_SIGMA_PER_RADIUS = 0.5;
/** Three standard deviations hold all but a fraction of a percent of the blur, so nothing is cut. */
const GLOW_REGION_SIGMAS = 3;

/**
 * The person's opaque core, which an outline or a glow leaves out, is where their alpha is above
 * 98%: alpha * CORE_SLOPE + CORE_INTERCEPT, held to 0..1, is 1 at full opacity and 0 below 98%.
 * Under the soft edge of the matte (hair) the effect is whole, so person and outline meet with no
 * gap; under the opaque person it is absent, so a faded person fades into the background.
 */
const CORE_SLOPE = 50;
const CORE_INTERCEPT = 1 - CORE_SLOPE;

/**
 * The deck bakes a treated photo at twice the layout's pixels at most, as a retina screen shows it.
 * The scale is always a whole number: librsvg rounds a morphology radius to whole device pixels, so
 * only at a whole multiple of the preview's pixels is the baked outline exactly as wide as the one
 * the judge scored.
 */
export const PHOTO_BAKE_SCALE_MAX = 2;
/**
 * And at the layout's own pixels at least, even when the photograph has fewer: a mask's edge or an
 * outline drawn at the source's lower resolution would look softer in Canva than in the preview.
 */
export const PHOTO_BAKE_SCALE_MIN = 1;
/**
 * A baked layer's pixel budget. A full-page hero on a 1080x1920 story at 2x is 8.3 million pixels,
 * a PNG of tens of megabytes in the deck; above this the scale comes down, never under
 * PHOTO_BAKE_SCALE_MIN.
 */
export const PHOTO_BAKE_MAX_PIXELS = 6_000_000;

/** A treated photo's SVG, and the part of the layout it draws into. */
export interface PhotoFragment {
  /**
   * Definitions the markup uses and does not draw: a cut-out's picture, which the person, their
   * outline and their glow all `<use>`. The preview puts each one in its defs once, however many
   * fragments use it; the deck's document for a fragment carries the ones it uses. Empty for a
   * framed photo.
   *
   * librsvg 2.62's parser gives up ("Premature end of data") once somewhere between 10 and 24 MB
   * of large data URIs have gone through it, depending on their sizes (measured 2026-09-23), and a
   * matted person is a PNG of several megabytes: three copies of each of two people pass that.
   */
  defs: string;
  /**
   * SVG markup in the layout's coordinates, with its own filters, masks and clips: the preview
   * inlines it, and the deck wraps it with `defs` alone in a document whose viewBox is `rect`.
   */
  svg: string;
  /** The layout rect the fragment draws into, and where the deck places the baked picture. */
  rect: Box;
  /**
   * Source pixels per layout pixel of the picture drawn, when known. The deck never bakes finer than
   * this, since pixels past the photograph's own would be upsampling, not detail.
   */
  sourceScale?: number;
}

/** The two things drawn around a cut-out person, under them. */
export type CutoutEffectKind = 'outline' | 'glow';

/** Kept to a thousandth of a pixel, so a division's float tail is not written into the markup. */
function n(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Matrix coefficients to a millionth, well below one step of an 8-bit channel. */
function coefficient(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function clampTo(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * Slack for a placement's thousandth-of-a-pixel rounding, so an edge written as 1840.0004 is not
 * grown by a whole pixel.
 */
const PLACEMENT_SLACK_PX = 0.001;

/**
 * The smallest rect of whole layout pixels that holds `r`. A cut-out person is placed at fractional
 * pixels; baked at such a rect, the deck's PNG would be resampled onto the page's pixel grid and its
 * hard edges (an outline's rim) smeared by a pixel against the preview. Baked at whole pixels, the
 * PNG's pixels are the preview's.
 */
function wholePixelRect(r: Box): Box {
  const left = Math.floor(r.x + PLACEMENT_SLACK_PX);
  const top = Math.floor(r.y + PLACEMENT_SLACK_PX);
  const right = Math.ceil(r.x + r.width - PLACEMENT_SLACK_PX);
  const bottom = Math.ceil(r.y + r.height - PLACEMENT_SLACK_PX);
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/** A colour as three shares of full intensity, for a colour matrix. */
function unitRgb(hex: Hex): [number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  return [r / 255, g / 255, b / 255];
}

/**
 * Whether a framed photo's pixels change: a mask, a fade or a filter. Such a photo is drawn from its
 * fragment in the preview and baked into a PNG for the deck. Zoom is not among them: it only moves
 * the crop, which the deck can make natively, so the client can still re-crop the photo in Canva.
 */
export function framedPhotoTreated(photo: PhotoElement): boolean {
  return Boolean(photo.mask || photo.fade || photo.filter);
}

/**
 * Whether a cut-out person's own pixels change: a fade or a filter. An outline or a glow does not
 * change the person; each is its own layer under them, so the person stays the untouched cut-out
 * and the client can delete the effect in Canva.
 */
export function cutoutPersonTreated(photo: PhotoElement): boolean {
  return Boolean(photo.fade || photo.filter);
}

/** The clip shape of a framed photo: its mask, or its box with the corner radius it always had. */
function framedClipShape(box: Box, radius: number | undefined, mask: PhotoMask | undefined): string {
  if (mask === 'circle') {
    return `<ellipse cx="${n(box.x + box.width / 2)}" cy="${n(box.y + box.height / 2)}" rx="${n(box.width / 2)}" ry="${n(box.height / 2)}"/>`;
  }
  if (mask === 'arch') {
    // A half-ellipse as wide as the box on a rectangle: a semicircle when the box is at least half
    // as tall as it is wide, and a flatter arch that still reaches the bottom corners when it is not.
    const rx = box.width / 2;
    const ry = Math.min(box.width / 2, box.height);
    const shoulder = n(box.y + ry);
    const right = n(box.x + box.width);
    const bottom = n(box.y + box.height);
    return `<path d="M ${box.x} ${shoulder} A ${n(rx)} ${n(ry)} 0 0 1 ${right} ${shoulder} L ${right} ${bottom} L ${box.x} ${bottom} Z"/>`;
  }
  const rx = Math.max(0, Math.min(radius ?? 0, Math.min(box.width, box.height) / 2));
  return `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="${rx}" ry="${rx}"/>`;
}

/**
 * A fade as a mask: a white ramp whose opacity runs from 1 to 0 over the last `length` of `over`
 * toward the edge. White's luminance is 1 however a renderer computes it, so the mask's value is the
 * ramp's opacity, which a gradient interpolates linearly. Before the ramp the gradient pads opaque;
 * past the edge it pads clear, which is what an outline reaching beyond the person needs.
 *
 * `region` is the area the mask covers: the drawn rect, or an effect's larger one.
 */
function fadeMaskDefs(id: string, fade: PhotoFade, over: Box, region: Box): string {
  const length = clampTo(fade.length, PHOTO_FADE_LENGTH_MIN, PHOTO_FADE_LENGTH_MAX);
  const { x, y, width, height } = over;
  const [x1, y1, x2, y2] =
    fade.edge === 'bottom'
      ? [x, y + height * (1 - length), x, y + height]
      : fade.edge === 'top'
        ? [x, y + height * length, x, y]
        : fade.edge === 'right'
          ? [x + width * (1 - length), y, x + width, y]
          : [x + width * length, y, x, y];
  const ramp = `${id}-ramp`;
  return (
    `<linearGradient id="${ramp}" gradientUnits="userSpaceOnUse" x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}">` +
    `<stop offset="0" stop-color="#FFFFFF" stop-opacity="1"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>` +
    `</linearGradient>` +
    `<mask id="${id}" maskUnits="userSpaceOnUse" x="${n(region.x)}" y="${n(region.y)}" width="${n(region.width)}" height="${n(region.height)}">` +
    `<rect x="${n(region.x)}" y="${n(region.y)}" width="${n(region.width)}" height="${n(region.height)}" fill="url(#${ramp})"/>` +
    `</mask>`
  );
}

/**
 * The colour matrix of a filter, as the 20 values of an feColorMatrix. All three are one matrix
 * each, so the photo is quantised once:
 *   bw       each channel = Y, the Rec. 709 luminance;
 *   duotone  each channel = dark + (light - dark) * Y, so black is `dark` and white is `light`;
 *   tint     each channel = (1 - strength) * itself + strength * colour.
 * Alpha is untouched, so a cut-out keeps its edge.
 */
export function photoFilterMatrix(filter: PhotoFilter): number[] {
  const alphaRow = [0, 0, 0, 1, 0];
  if (filter.kind === 'bw') {
    const grey = [LUMA_R, LUMA_G, LUMA_B, 0, 0];
    return [...grey, ...grey, ...grey, ...alphaRow];
  }
  if (filter.kind === 'duotone') {
    const dark = unitRgb(filter.dark);
    const light = unitRgb(filter.light);
    const row = (c: number) => {
      const span = light[c] - dark[c];
      return [span * LUMA_R, span * LUMA_G, span * LUMA_B, 0, dark[c]];
    };
    return [...row(0), ...row(1), ...row(2), ...alphaRow].map(coefficient);
  }
  const strength = clampTo(filter.strength, 0, 1);
  const colour = unitRgb(filter.color);
  const keep = 1 - strength;
  return [
    keep, 0, 0, 0, strength * colour[0],
    0, keep, 0, 0, strength * colour[1],
    0, 0, keep, 0, strength * colour[2],
    ...alphaRow,
  ].map(coefficient);
}

/**
 * A filter over `region`, in sRGB: the colours a designer names, and the luminance they mean, are
 * sRGB values, and SVG's default of linear RGB would draw a Rec. 709 grey of #C81E1E as #666666
 * instead of #424242.
 */
function colourFilterDef(id: string, filter: PhotoFilter, region: Box): string {
  return (
    `<filter id="${id}" filterUnits="userSpaceOnUse" x="${n(region.x)}" y="${n(region.y)}" width="${n(region.width)}" height="${n(region.height)}" color-interpolation-filters="sRGB">` +
    `<feColorMatrix type="matrix" values="${photoFilterMatrix(filter).join(' ')}"/>` +
    `</filter>`
  );
}

/**
 * The picture of a framed photo cropped to exactly `crop`, the part of it `coverCrop` keeps. A nested
 * viewport at the photo's box has that rectangle, in the photo's own pixels, as its viewBox and holds
 * the whole picture at its natural size, so only the crop shows and it fills the box. It carries the
 * id `photo-<index>` a framed photo has, with the box's geometry.
 */
export function croppedPhotoSvg(
  id: string,
  href: string,
  box: Box,
  pixels: { width: number; height: number },
  crop: CoverCropRect
): string {
  return (
    `<svg id="${id}" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" viewBox="${n(crop.sx)} ${n(crop.sy)} ${n(crop.sw)} ${n(crop.sh)}" preserveAspectRatio="none">` +
    `<image xlink:href="${href}" x="0" y="0" width="${pixels.width}" height="${pixels.height}" preserveAspectRatio="none"/>` +
    `</svg>`
  );
}

/**
 * A framed photo with its treatments: cropped by `coverCrop` around its focus and zoom, recoloured by
 * its filter, cut to its mask (or its rounded box) and faded toward its edge.
 *
 * `pixels` is the photo's own size. When it cannot be read (WebP), the picture is the centred cover
 * crop SVG's `xMidYMid slice` draws, focus and zoom are ignored as they are for an untreated photo,
 * and the deck bakes it at PHOTO_BAKE_SCALE_MAX, having no source resolution to cap it by.
 */
export function framedPhotoFragment(
  photo: PhotoElement,
  href: string,
  pixels: { width: number; height: number } | null
): PhotoFragment {
  const box: Box = { x: photo.x, y: photo.y, width: photo.width, height: photo.height };
  const index = photo.photoIndex;
  const clipId = `photo-clip-${index}`;
  const fadeId = `photo-fade-${index}`;
  const filterId = `photo-filter-${index}`;
  const crop = pixels ? coverCrop(box, pixels, photo.focus, photo.zoom) : undefined;
  const picture =
    pixels && crop
      ? croppedPhotoSvg(`photo-${index}`, href, box, pixels, crop)
      : `<image id="photo-${index}" xlink:href="${href}" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" preserveAspectRatio="xMidYMid slice"/>`;
  const defs =
    `<clipPath id="${clipId}">${framedClipShape(box, photo.radius, photo.mask)}</clipPath>` +
    (photo.fade ? fadeMaskDefs(fadeId, photo.fade, box, box) : '') +
    (photo.filter ? colourFilterDef(filterId, photo.filter, box) : '');
  // The filter recolours the picture inside the box; the clip and the fade then shape what shows.
  const filtered = photo.filter ? `<g filter="url(#${filterId})">${picture}</g>` : picture;
  const svg =
    `<g><defs>${defs}</defs>` +
    `<g clip-path="url(#${clipId})"${photo.fade ? ` mask="url(#${fadeId})"` : ''}>${filtered}</g>` +
    `</g>`;
  return { defs: '', svg, rect: box, ...(crop ? { sourceScale: crop.sw / box.width } : {}) };
}

/**
 * The cut-out's picture at the person's rect, as a definition the person, their outline and their
 * glow each `<use>` (id `photo-source-<index>`), and its source pixels per layout pixel.
 */
function cutoutSource(index: number, png: Buffer, rect: Box): { id: string; defs: string; sourceScale?: number } {
  const id = `photo-source-${index}`;
  const pixels = pngPixelSize(png);
  return {
    id,
    defs: `<image id="${id}" xlink:href="data:image/png;base64,${png.toString('base64')}" x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" preserveAspectRatio="none"/>`,
    ...(pixels && rect.width > 0 ? { sourceScale: pixels.width / rect.width } : {}),
  };
}

/**
 * Whether the preview draws a cut-out person from `cutoutPersonFragment`, which it does whenever the
 * photo has a treatment of its own or around it. With an outline or a glow the person uses the same
 * picture definition as the effects, so the preview carries the PNG once; with none, the person is
 * drawn exactly as before.
 */
export function cutoutPhotoTreated(photo: PhotoElement): boolean {
  return cutoutPersonTreated(photo) || Boolean(photo.outline || photo.glow);
}

/**
 * A cut-out person at the exact rect `cutoutPlacement` gave, with their fade and filter, if any. It
 * carries the id `photo-<index>` the untreated person has. The fragment's rect is the whole-pixel
 * rect around the person, which the deck bakes and places.
 *
 * The fade runs over the person's own rect, not the photo's box: a cut-out stands on the box's
 * bottom edge and is often narrower or shorter than the box, and "the bottom third of the person
 * fades out" is what a designer means. The filter recolours the person and leaves their edge alone.
 */
export function cutoutPersonFragment(photo: PhotoElement, png: Buffer, rect: Box): PhotoFragment {
  const index = photo.photoIndex;
  const fadeId = `photo-fade-${index}`;
  const filterId = `photo-filter-${index}`;
  const region = wholePixelRect(rect);
  const source = cutoutSource(index, png, rect);
  const defs =
    (photo.fade ? fadeMaskDefs(fadeId, photo.fade, rect, region) : '') +
    (photo.filter ? colourFilterDef(filterId, photo.filter, region) : '');
  const person = `<use id="photo-${index}" xlink:href="#${source.id}"${photo.filter ? ` filter="url(#${filterId})"` : ''}/>`;
  const svg = `<g>${defs ? `<defs>${defs}</defs>` : ''}${photo.fade ? `<g mask="url(#${fadeId})">${person}</g>` : person}</g>`;
  return { defs: source.defs, svg, rect: region, ...(source.sourceScale !== undefined ? { sourceScale: source.sourceScale } : {}) };
}

/**
 * An outline's width as drawn: held to its range and rounded to a whole layout pixel, which
 * librsvg's whole-device-pixel morphology draws exactly at any whole bake scale. A fraction of a
 * pixel of outline is below what anyone sees.
 */
function outlineWidthPx(outline: PhotoOutline | undefined): number {
  return Math.round(clampTo(outline?.width ?? 0, PHOTO_OUTLINE_WIDTH_MIN, PHOTO_OUTLINE_WIDTH_MAX));
}

/**
 * The feMorphology steps that dilate by `width` whole pixels: as few as OUTLINE_MORPHOLOGY_STEP_PX
 * allows, whole pixels each, the larger ones first.
 */
export function outlineMorphologySteps(width: number): number[] {
  const count = Math.max(1, Math.ceil(width / OUTLINE_MORPHOLOGY_STEP_PX));
  const small = Math.floor(width / count);
  const larger = width - small * count;
  return Array.from({ length: count }, (_, i) => (i < larger ? small + 1 : small));
}

/** How far an effect reaches beyond the person's rect, in layout pixels. A glow around an outline starts at its outer edge. */
function effectReach(kind: CutoutEffectKind, outline: PhotoOutline | undefined, glow: PhotoGlow | undefined): number {
  if (kind === 'outline') return outlineWidthPx(outline) + OUTLINE_REGION_MARGIN_PX;
  const radius = clampTo(glow?.radius ?? 0, PHOTO_GLOW_RADIUS_MIN, PHOTO_GLOW_RADIUS_MAX);
  return (outline ? outlineWidthPx(outline) : 0) + Math.ceil(radius * GLOW_SIGMA_PER_RADIUS * GLOW_REGION_SIGMAS);
}

/**
 * Filter primitives that dilate SourceAlpha by `width` whole pixels into `result`. A square dilation
 * is a row pass then a column pass: the same pixels (checked on librsvg 2.54 and 2.62, 2026-09-24) at
 * a fraction of the cost. As one square pass per step, a 24 px outline baked at 2x took 23 s and the
 * Canva deck timed out at 20 s.
 */
function dilateAlpha(width: number, result: string): string {
  return outlineMorphologySteps(width)
    .map((step, i, steps) => {
      const input = i === 0 ? 'SourceAlpha' : `${result}-${i - 1}`;
      const out = i === steps.length - 1 ? result : `${result}-${i}`;
      return (
        `<feMorphology in="${input}" operator="dilate" radius="${step} 0" result="${out}-rows"/>` +
        `<feMorphology in="${out}-rows" operator="dilate" radius="0 ${step}" result="${out}"/>`
      );
    })
    .join('');
}

/**
 * The layout rect an outline or glow draws into: the person's rect grown by the effect's reach to
 * the left, the right and above, and kept to the canvas, where the preview is cut too. Undefined when
 * nothing of it is on the canvas.
 *
 * It does not reach below the person. A cut-out stands on its box's bottom edge, and the person's
 * bottom is either where the photograph cut them off (a bust) or their feet on the floor: an outline
 * there underlines the cut like a sticker's border, and a glow lights the floor. The first proof
 * sheet (2026-09-23) showed both.
 */
export function cutoutEffectRect(
  kind: CutoutEffectKind,
  photo: PhotoElement,
  personRect: Box,
  canvas: { width: number; height: number }
): Box | undefined {
  const reach = effectReach(kind, photo.outline, photo.glow);
  const grown = wholePixelRect({ x: personRect.x - reach, y: personRect.y - reach, width: personRect.width + 2 * reach, height: personRect.height + reach });
  const left = Math.max(0, grown.x);
  const top = Math.max(0, grown.y);
  const right = Math.min(canvas.width, grown.x + grown.width);
  const bottom = Math.min(canvas.height, grown.y + grown.height);
  if (right <= left || bottom <= top) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * An outline or a glow around a cut-out person, as its own layer drawn under them.
 *
 *   outline  the person's alpha dilated by the outline's width (feMorphology), filled with its colour;
 *   glow     the person's alpha blurred (feGaussianBlur, sigma half the radius), filled with its colour;
 *            with an outline too, the alpha is first grown by the outline's width, so the glow lights
 *            the outline's outer edge (drawn from the person alone, a 24 px outline covered a 30 px
 *            glow entirely: proof render in Core, 2026-09-24);
 *
 * each less the person's opaque core (feComposite "out"; see CORE_SLOPE), so none of it lies under
 * the opaque person. The first proof sheet (2026-09-23) drew the whole grown silhouette, and a person
 * with a fade faded into the outline's gold instead of the design's background. Leaving out the
 * person's whole alpha instead would let the background through the soft edge of the matte, a dark
 * fringe between person and outline; under that edge the effect stays whole.
 *
 * A person with a fade has it on the effect too, over the person's rect, so the outline fades out
 * with them instead of standing alone where they have faded.
 *
 * Undefined when the photo has no such effect or none of it falls on the canvas.
 */
export function cutoutEffectFragment(
  kind: CutoutEffectKind,
  photo: PhotoElement,
  png: Buffer,
  personRect: Box,
  canvas: { width: number; height: number }
): PhotoFragment | undefined {
  const outline = kind === 'outline' ? photo.outline : undefined;
  const glow = kind === 'glow' ? photo.glow : undefined;
  if (!outline && !glow) return undefined;
  const glowAround = glow && photo.outline ? outlineWidthPx(photo.outline) : 0;
  const region = cutoutEffectRect(kind, photo, personRect, canvas);
  if (!region) return undefined;
  const index = photo.photoIndex;
  const layerId = `photo-${kind}-${index}`;
  const filterId = `photo-${kind}-filter-${index}`;
  const fadeId = `photo-${kind}-fade-${index}`;
  const colour = outline?.color ?? glow?.color;
  const spread = outline
    ? dilateAlpha(outlineWidthPx(outline), 'silhouette')
    : (glowAround ? dilateAlpha(glowAround, 'outlined') : '') +
      `<feGaussianBlur in="${glowAround ? 'outlined' : 'SourceAlpha'}" stdDeviation="${n(clampTo(glow?.radius ?? 0, PHOTO_GLOW_RADIUS_MIN, PHOTO_GLOW_RADIUS_MAX) * GLOW_SIGMA_PER_RADIUS)}" result="silhouette"/>`;
  const filter =
    `<filter id="${filterId}" filterUnits="userSpaceOnUse" x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}" color-interpolation-filters="sRGB">` +
    spread +
    `<feFlood flood-color="${colour}" flood-opacity="1" result="colour"/>` +
    `<feComposite in="colour" in2="silhouette" operator="in" result="filled"/>` +
    `<feComponentTransfer in="SourceAlpha" result="core"><feFuncA type="linear" slope="${CORE_SLOPE}" intercept="${CORE_INTERCEPT}"/></feComponentTransfer>` +
    `<feComposite in="filled" in2="core" operator="out"/>` +
    `</filter>`;
  const source = cutoutSource(index, png, personRect);
  const defs = filter + (photo.fade ? fadeMaskDefs(fadeId, photo.fade, personRect, region) : '');
  const silhouette = `<use xlink:href="#${source.id}" filter="url(#${filterId})"/>`;
  const svg = `<g id="${layerId}"${photo.fade ? ` mask="url(#${fadeId})"` : ''}><defs>${defs}</defs>${silhouette}</g>`;
  return { defs: source.defs, svg, rect: region, ...(source.sourceScale !== undefined ? { sourceScale: source.sourceScale } : {}) };
}

/**
 * The whole-number scale the deck bakes a fragment at: PHOTO_BAKE_SCALE_MAX, unless the photograph
 * has fewer pixels than that there or the layer would pass PHOTO_BAKE_MAX_PIXELS, and never under
 * PHOTO_BAKE_SCALE_MIN.
 */
export function photoBakeScale(fragment: PhotoFragment): number {
  const { width, height } = fragment.rect;
  let scale = PHOTO_BAKE_SCALE_MAX;
  if (fragment.sourceScale !== undefined && Number.isFinite(fragment.sourceScale)) scale = Math.min(scale, fragment.sourceScale);
  scale = Math.min(scale, Math.sqrt(PHOTO_BAKE_MAX_PIXELS / Math.max(1, width * height)));
  return Math.max(PHOTO_BAKE_SCALE_MIN, Math.floor(scale));
}

/** The pixel size the deck bakes a fragment at: its rect at `photoBakeScale`. */
export function photoBakePixelSize(fragment: PhotoFragment): { width: number; height: number } {
  const scale = photoBakeScale(fragment);
  return { width: Math.max(1, Math.round(fragment.rect.width * scale)), height: Math.max(1, Math.round(fragment.rect.height * scale)) };
}

/**
 * A fragment alone as an SVG document for the deck's bake: `size` pixels showing exactly the
 * fragment's rect, on a transparent ground, with the definitions it uses. preserveAspectRatio="none"
 * absorbs the rounding of the pixel size, so the PNG covers the rect exactly when Canva places it
 * there.
 */
export function photoFragmentDocument(fragment: PhotoFragment, size: { width: number; height: number }): string {
  const r = fragment.rect;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg width="${size.width}" height="${size.height}" viewBox="${r.x} ${r.y} ${r.width} ${r.height}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">` +
    (fragment.defs ? `<defs>${fragment.defs}</defs>` : '') +
    fragment.svg +
    `</svg>`
  );
}

/**
 * The treatment fields a caller or a model supplied, made ones the layout schema accepts: each
 * number held to its range, and anything malformed dropped. One bad field then costs that
 * treatment, not the whole design, as with `photoFocusOrUndefined`. Whether a treatment suits the
 * photo's placement (a mask on a cut-out, an outline on a framed photo) is validation's to refuse.
 */
export function photoTreatmentFields(value: unknown): Pick<PhotoElement, 'zoom' | 'mask' | 'fade' | 'filter' | 'outline' | 'glow'> {
  if (!value || typeof value !== 'object') return {};
  const v = value as Record<string, unknown>;
  const zoom = finite(v.zoom);
  const mask = PHOTO_MASKS.find((m) => m === v.mask);
  const fade = photoFadeOrUndefined(v.fade);
  const filter = photoFilterOrUndefined(v.filter);
  const outline = photoOutlineOrUndefined(v.outline);
  const glow = photoGlowOrUndefined(v.glow);
  return {
    ...(zoom !== undefined ? { zoom: clampTo(zoom, PHOTO_ZOOM_MIN, PHOTO_ZOOM_MAX) } : {}),
    ...(mask ? { mask } : {}),
    ...(fade ? { fade } : {}),
    ...(filter ? { filter } : {}),
    ...(outline ? { outline } : {}),
    ...(glow ? { glow } : {}),
  };
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function hexOrUndefined(value: unknown): Hex | undefined {
  return typeof value === 'string' && hexSchema.safeParse(value).success ? value : undefined;
}

function fields(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

export function photoFadeOrUndefined(value: unknown): PhotoFade | undefined {
  const v = fields(value);
  const edge = PHOTO_FADE_EDGES.find((e) => e === v?.edge);
  const length = finite(v?.length);
  if (!edge || length === undefined) return undefined;
  return { edge, length: clampTo(length, PHOTO_FADE_LENGTH_MIN, PHOTO_FADE_LENGTH_MAX) };
}

export function photoFilterOrUndefined(value: unknown): PhotoFilter | undefined {
  const v = fields(value);
  if (v?.kind === 'bw') return { kind: 'bw' };
  if (v?.kind === 'duotone') {
    const dark = hexOrUndefined(v.dark);
    const light = hexOrUndefined(v.light);
    return dark && light ? { kind: 'duotone', dark, light } : undefined;
  }
  if (v?.kind === 'tint') {
    const color = hexOrUndefined(v.color);
    const strength = finite(v.strength);
    return color && strength !== undefined ? { kind: 'tint', color, strength: clampTo(strength, 0, 1) } : undefined;
  }
  return undefined;
}

export function photoOutlineOrUndefined(value: unknown): PhotoOutline | undefined {
  const v = fields(value);
  const color = hexOrUndefined(v?.color);
  const width = finite(v?.width);
  if (!color || width === undefined) return undefined;
  return { color, width: clampTo(width, PHOTO_OUTLINE_WIDTH_MIN, PHOTO_OUTLINE_WIDTH_MAX) };
}

export function photoGlowOrUndefined(value: unknown): PhotoGlow | undefined {
  const v = fields(value);
  const color = hexOrUndefined(v?.color);
  const radius = finite(v?.radius);
  if (!color || radius === undefined) return undefined;
  return { color, radius: clampTo(radius, PHOTO_GLOW_RADIUS_MIN, PHOTO_GLOW_RADIUS_MAX) };
}
