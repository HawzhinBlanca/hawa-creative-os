import { analysePhotoAsync, imagePixelSize, type PhotoFacts, type SolverPhoto } from '@hawa/creative';
import type { CreativeBrief, StageContext } from './types.js';
import { log } from '../../logging.js';

/**
 * ADR-170: what the studio knows about each content photo when it art-directs a design: the brief's
 * review (subject fit, shot, quiet area), the face detector's focus, whether a cut-out passed its
 * checks, and the local pixel analysis (sharpness, calm thirds, centre of detail). All of it was
 * already paid for or is computed locally: no model call is added.
 */

/** The facts the recorded brief alone gives, for exemplar retrieval before the photos are loaded. */
export function briefPhotoFacts(brief: Partial<CreativeBrief> | undefined, cutoutsWanted: boolean): PhotoFacts[] {
  const roles = (brief?.imageRoles ?? []).filter((r) => r?.role === 'content_photo');
  return roles.map((r, photoIndex) => ({
    photoIndex,
    ...(r.subjectFit ? { subjectFit: r.subjectFit } : {}),
    ...(r.shot ? { shot: r.shot } : {}),
    ...(r.quietArea ? { quietArea: r.quietArea } : {}),
    // Whether a cut-out will pass is known only at the layout stage; one asked for may be offered.
    ...(cutoutsWanted ? { cutout: true } : {}),
  }));
}

/** Every content photo's facts for the art director and the solver, by photoIndex. */
export async function photoFactsFor(
  ctx: Pick<StageContext, 'photos' | 'photoFaces' | 'photoCutouts'>
): Promise<Array<PhotoFacts & SolverPhoto>> {
  const out: Array<PhotoFacts & SolverPhoto> = [];
  for (const [photoIndex, photo] of (ctx.photos ?? []).entries()) {
    const size = (photo.width && photo.height ? { width: photo.width, height: photo.height } : imagePixelSize(photo.bytes)) ?? { width: 1, height: 1 };
    // The detector answers every photo it reads; with no face it answers the centre and no face
    // height. That centre is not a face: counted as one, it told the art director "faces found" for a
    // photo of a woman in profile and cropped on the middle instead of the photo's measured detail
    // (live trial, 2026-09-30). Only a point with a face height is a face.
    const detected = ctx.photoFaces?.[photoIndex] ?? undefined;
    const face = detected && typeof detected.faceShare === 'number' && detected.faceShare > 0 ? detected : undefined;
    const cut = ctx.photoCutouts?.[photoIndex];
    let analysis: Awaited<ReturnType<typeof analysePhotoAsync>> | undefined;
    try {
      analysis = await analysePhotoAsync(photo.bytes);
    } catch (err) {
      // Said, never silent: the photo is still eligible, ranked on the brief's review alone.
      log.warn(`[art-direction] photo ${photoIndex} could not be analysed (${err instanceof Error ? err.message : String(err)})`);
    }
    out.push({
      photoIndex,
      width: size.width,
      height: size.height,
      ...(detected?.regionStatus ? { regionStatus: detected.regionStatus, ...(detected.regions ? { regions: detected.regions } : {}) } : {}),
      ...(photo.review?.subjectFit ? { subjectFit: photo.review.subjectFit } : {}),
      ...(photo.review?.shot ? { shot: photo.review.shot } : {}),
      ...(photo.review?.quietArea ? { quietArea: photo.review.quietArea } : {}),
      ...(face ? { focus: { x: face.x, y: face.y }, faces: true, ...(face.faceShare ? { faceShare: face.faceShare } : {}) } : {}),
      ...(cut ? { cutout: true, cutoutSize: { width: cut.width, height: cut.height } } : {}),
      ...(analysis
        ? {
            sharpness: analysis.sharpness,
            localQuiet: analysis.quiet,
            salient: analysis.salient,
            quiet: photo.review?.quietArea && photo.review.quietArea !== 'none' ? photo.review.quietArea : analysis.quiet,
            quietLuminance: analysis.quietLuminance,
          }
        : photo.review?.quietArea ? { quiet: photo.review.quietArea } : {}),
    } as PhotoFacts & SolverPhoto);
  }
  return out;
}
