import type { StudioLayoutV2, Box } from './layout-v2.js';

/**
 * The video-thumbnail playbook (ADR-127, ported from studio-v2): the rules a thumbnail client's designs follow on top of the
 * house rules. A thumbnail is judged small, in a list, next to other thumbnails, with the platform's
 * own badges drawn over it. Only what the layout can change is enforced here: the requester's copy
 * is exact, so its length is guidance for the design stages, never a defect.
 */
export const THUMBNAIL_RULES = {
  /**
   * The width the thumbnail is seen at in the smallest common listing: YouTube's search and
   * "up next" rows show a 16:9 thumbnail about 168 px wide; a Shorts or Reels grid a 9:16 cover
   * about 180 px wide.
   */
  previewWidthPx: { landscape: 168, portrait: 180 },
  /** The hook (the title block) is at least this tall, in pixels, at preview width. */
  minHookPreviewPx: 9,
  /** Words the hook reads best in. Guidance only: the requester's copy is never shortened. */
  hookWords: 5,
  /** YouTube draws the video length over the bottom-right corner of a 16:9 thumbnail. */
  lengthBadge: { widthShare: 0.2, heightShare: 0.16 },
  /** Shorts and Reels draw like, comment and share buttons down the right side of a 9:16 cover. */
  actionRail: { widthShare: 0.15, topShare: 0.4, bottomShare: 0.8 },
} as const;

type Canvas = { width: number; height: number };

const isPortrait = ({ width, height }: Canvas) => height > width;

/** The width the thumbnail is seen at, for this canvas. */
export function thumbnailPreviewWidth(canvas: Canvas): number {
  return isPortrait(canvas) ? THUMBNAIL_RULES.previewWidthPx.portrait : THUMBNAIL_RULES.previewWidthPx.landscape;
}

/** The smallest title size, in canvas pixels, that stays legible at preview width. */
export function minThumbnailHookPx(canvas: Canvas): number {
  return Math.ceil((THUMBNAIL_RULES.minHookPreviewPx * canvas.width) / thumbnailPreviewWidth(canvas));
}

/** The part of the canvas the platform draws its own badges or buttons over. */
export function thumbnailCoveredZone(canvas: Canvas): Box & { what: string } {
  const { width, height } = canvas;
  if (isPortrait(canvas)) {
    const rail = THUMBNAIL_RULES.actionRail;
    const w = Math.round(width * rail.widthShare);
    return { x: width - w, y: Math.round(height * rail.topShare), width: w, height: Math.round(height * (rail.bottomShare - rail.topShare)), what: 'the like, comment and share buttons' };
  }
  const badge = THUMBNAIL_RULES.lengthBadge;
  const w = Math.round(width * badge.widthShare);
  const h = Math.round(height * badge.heightShare);
  return { x: width - w, y: height - h, width: w, height: h, what: 'the video length' };
}

const intersects = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

export interface ThumbnailCheck {
  defectCodes: string[];
  messages: string[];
}

/**
 * The thumbnail rules a layout can break:
 *  - THUMBNAIL_COVERED_ZONE: text or the logo where the platform draws its badge or buttons;
 *  - THUMBNAIL_HOOK_TOO_SMALL: the title set too small to read at listing size.
 */
export function evaluateThumbnailLayout(layout: StudioLayoutV2, canvas: Canvas): ThumbnailCheck {
  const defectCodes: string[] = [];
  const messages: string[] = [];
  const zone = thumbnailCoveredZone(canvas);
  const covered = [
    ...layout.text.filter((t) => intersects(t, zone)).map((t) => `block ${t.copyIndex} (${t.role})`),
    ...(layout.logo && layout.logo.width > 0 && intersects(layout.logo, zone) ? ['the logo'] : []),
  ];
  if (covered.length) {
    defectCodes.push('THUMBNAIL_COVERED_ZONE');
    messages.push(
      `THUMBNAIL_COVERED_ZONE: ${covered.join(', ')} ${covered.length === 1 ? 'is' : 'are'} under ${zone.what} ` +
        `(x ${zone.x}-${zone.x + zone.width}, y ${zone.y}-${zone.y + zone.height}); keep that area free`
    );
  }
  const minPx = minThumbnailHookPx(canvas);
  const hooks = layout.text.filter((t) => t.role === 'title');
  const largest = Math.max(0, ...layout.text.map((t) => t.fontSize));
  // A layout that names no title reads its largest block as the hook.
  const hookBlocks = hooks.length ? hooks : layout.text.filter((t) => t.fontSize === largest);
  for (const t of hookBlocks) {
    if (t.fontSize < minPx) {
      if (!defectCodes.includes('THUMBNAIL_HOOK_TOO_SMALL')) defectCodes.push('THUMBNAIL_HOOK_TOO_SMALL');
      messages.push(
        `THUMBNAIL_HOOK_TOO_SMALL: block ${t.copyIndex} (${t.role}) is ${t.fontSize}px; at ${thumbnailPreviewWidth(canvas)}px wide ` +
          `it reads ${((t.fontSize * thumbnailPreviewWidth(canvas)) / canvas.width).toFixed(1)}px. The hook needs at least ${minPx}px on this canvas`
      );
    }
  }
  return { defectCodes, messages };
}

/**
 * The playbook as the design stages are told it. Appended to the client's rules for every stage, so
 * the brief, the layouts, the critique and the judge work to the same thumbnail.
 */
export function thumbnailPlaybookPrompt(canvas: Canvas): string {
  const zone = thumbnailCoveredZone(canvas);
  return [
    `VIDEO THUMBNAIL PLAYBOOK (this client's designs are video thumbnails, ${canvas.width}x${canvas.height}):`,
    `- It is seen about ${thumbnailPreviewWidth(canvas)}px wide in a list of other thumbnails. Design for that size: one focal point, no small print.`,
    `- The person in the request's photo is the focal point: cut out, large (face at least a third of the height), looking into the frame, not at its edge.`,
    `- The title is the hook and the largest text, at least ${minThumbnailHookPx(canvas)}px, in at most two lines, with the strongest contrast on the canvas.`,
    `- If the title is longer than ${THUMBNAIL_RULES.hookWords} words, keep every word (the copy is exact) and let the layout carry it: size and line breaks, never cutting.`,
    `- Other copy stays short and large, or small and out of the way; never a paragraph.`,
    `- Keep x ${zone.x}-${zone.x + zone.width}, y ${zone.y}-${zone.y + zone.height} free of text and logo: the platform draws ${zone.what} there.`,
    `- The logo is small, in a top corner, clear of the face and the hook.`,
  ].join('\n');
}
