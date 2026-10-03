// The studio's account of a run. `studioStatusNote` is the one-line summary for the office and the
// logs (models, score, imagery, the edit's own words); `requesterDraftNotes` is what the requester
// reads with the draft, in plain words. Every figure comes from the run's own record; a figure the
// run did not record is left out.

import { coverCrop, omittedPhotoIndices, photoSelectionOrUndefined, recipePhotoMinimum } from '@hawa/creative';

const parse = (value: unknown): any => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return undefined; }
};

export interface StudioStatusNoteInput {
  run: { stages?: unknown; diagnostic?: string | null; winner_candidate_id?: string | null };
  candidates: Array<{ id: string; score?: unknown; layouts?: unknown; concept?: unknown; art_provenance?: unknown }>;
  parityNote?: string;
  /** Models that answered the run's calls, from its call ledger, most used first. */
  models?: string[];
}

export function studioStatusNote({ run, candidates, parityNote = '', models = [] }: StudioStatusNoteInput): string {
  const stages = parse(run.stages) || {};
  const v3 = Object.values(stages).some((stage: any) => stage?.pipeline === 'v3');
  const winner = candidates.find(c => c.id === run.winner_candidate_id) || candidates[0];
  const parts = [v3 ? 'Studio v3' : 'Studio v2'];
  if (models.length > 0) parts.push(`models: ${models.join(', ')}`);

  // A revision made to the design the client received says so, and what was changed.
  const directed = stages.directed && !stages.directedFailed ? stages.directed : undefined;
  if (directed) {
    const changed = (Array.isArray(directed.changes) ? directed.changes : [])
      .map((c: { after?: string; element?: string } | null) => String(c?.after || c?.element || '').trim())
      .filter(Boolean)
      .slice(0, 3);
    // What was asked and does not show on the design, said plainly: the note repeated the model's
    // own account, and could report a gold accent that had been taken off as unreadable.
    const unmade = (Array.isArray(directed.unmade) ? directed.unmade : [])
      .map((u: unknown) => String(u ?? '').trim())
      .filter(Boolean)
      .slice(0, 3);
    if (changed.length) parts.push(`your change made to the same design (${changed.join('; ')})`);
    else if (directed.unchanged !== true) parts.push('your change made to the same design');
    if (unmade.length) parts.push(`⚠️ could not be made: ${unmade.join('; ')}`);
    // The visual check is advice for the office (edit.stage visualCheck): where it disagrees with the
    // recorded outcome, the art director looks first.
    const seen = (Array.isArray(directed.asks) ? directed.asks : []).filter((a: { seen?: { made?: unknown } }) => typeof a?.seen?.made === 'boolean');
    const doubted = seen.filter((a: { status?: unknown; seen: { made: boolean } }) => a.status === 'done' && !a.seen.made);
    const agree = seen.filter((a: { status?: unknown; seen: { made: boolean } }) => a.seen.made === (a.status === 'done')).length;
    if (seen.length) parts.push(`visual check: ${agree} of ${seen.length} agree${doubted.length ? `; ⚠️ not seen made: ${doubted.map((a: { ask?: unknown }) => String(a.ask ?? '').slice(0, 60)).join('; ')}` : ''}`);
  } else if (stages.directedFailed) {
    parts.push('your change could not be made to the same design, so it was designed afresh');
  } else if (candidates.length > 0) parts.push(`${candidates.length} concept${candidates.length === 1 ? '' : 's'}`);

  const revise = stages.revise;
  const rounds = Array.isArray(revise?.rounds) ? revise.rounds.length : typeof revise?.rounds === 'number' ? revise.rounds : undefined;
  if (rounds === 0) parts.push('no revision needed');
  else if (rounds !== undefined) parts.push(`${rounds} revision round${rounds === 1 ? '' : 's'}`);

  // v3 stores the deterministic layout score (0..1) on the candidate; v2 stored the judge's 0..10 score.
  const score = typeof winner?.score === 'number' ? winner.score : Number.parseFloat(String(winner?.score ?? ''));
  if (Number.isFinite(score)) parts.push(v3 ? `layout score ${score.toFixed(2)}/1` : `judge ${Number(score.toFixed(1))}/10`);

  const artProv = parse(winner?.art_provenance);
  const concept = parse(winner?.concept);
  if (artProv?.source === 'procedural') parts.push(artProv?.artFallback ? 'imagery: procedural fallback' : `imagery: procedural (${artProv.motif || concept?.motif || 'thin-rules'})`);
  else if (artProv?.source === 'generated' || artProv?.synthId || artProv?.generator === 'imagen' || concept?.artStrategy === 'generated') parts.push('imagery: generated');
  else if (concept?.artStrategy === 'procedural') parts.push(`imagery: procedural (${concept.motif || 'thin-rules'})`);
  else if (winner) parts.push('imagery: none');

  const faces = new Set<string>();
  // The candidate keeps every layout it went through; the last one is the one transferred.
  const layouts = parse(winner?.layouts);
  const shipped = parse(Array.isArray(layouts) ? layouts[layouts.length - 1] : undefined);
  for (const t of shipped?.text || []) if (t?.fontFamily) faces.add(t.fontFamily);
  if (faces.size > 0) parts.push(`typeface: ${[...faces].join(', ')}`);
  else if (concept?.displayFont) parts.push(`typeface: ${concept.displayFont}`);

  // What became of the photographs the client sent. On 2026-09-22 two portraits sent with "a
  // graphic with these texts and two pictures" were dropped and the note said nothing about them.
  const placed = Array.isArray(shipped?.photos) ? shipped.photos.length : 0;
  const sent = typeof stages.brief?.photosSent === 'number' ? stages.brief.photosSent : undefined;
  const asReference = stages.brief?.referenceSeen === true || stages.brief?.referenceRole === 'style_reference';
  const followed = Array.isArray(stages.brief?.imageRoles) && stages.brief.imageRoles.some((r: any) => r?.role === 'style_reference');
  // ADR-157: when the requester let the design choose, the photos left out are listed for review.
  const chose = choseAmongPhotos(stages, placed, sent, shipped);
  if (chose) parts.push(`photos chosen: ${placed} of ${sent} (left out: ${omittedPhotoNumbers(stages, shipped, sent!).join(', ')})`);
  else if (sent !== undefined && sent > 0) parts.push(placed === sent ? `your ${sent} photo${sent === 1 ? '' : 's'} placed` : `⚠️ ${placed} of your ${sent} photos placed`);
  else if (placed > 0) parts.push(`${placed} photo${placed === 1 ? '' : 's'} placed`);
  const cutShipped = Array.isArray(shipped?.photos) ? (shipped.photos as Array<{ treatment?: unknown } | null>).filter((p) => p?.treatment === 'cutout').length : 0;
  if (Array.isArray(stages.cutouts)) parts.push(`cut-outs: ${cutShipped} of ${stages.cutouts.length} placed`);
  if (followed) parts.push('your reference design followed');
  else if (!(sent && sent > 0) && placed === 0 && asReference) parts.push('your image used as a style reference, not placed');

  // ADR-157: what hard QA found worth a person's look before approval: copy that may be cut short,
  // a language the instructions name and the copy lacks, a face drawn by a stand-in. Never a failure.
  const findings = (Array.isArray(stages.qa?.findings) ? stages.qa.findings : [])
    .map((f: { message?: unknown } | null) => String(f?.message ?? '').replace(/^[A-Z_]+:\s*/, '').trim())
    .filter(Boolean);
  if (findings.length) parts.push(`⚠️ check before approving: ${findings.join(' | ')}`);

  let rungNote = '';
  if (stages.ladderRung && stages.ladderRung > 1) rungNote = ` · ${stages.ladderNotes || `Rung ${stages.ladderRung} fallback`}`;
  else if (run.diagnostic?.includes('Rung')) rungNote = ` · ${run.diagnostic}`;

  return parts.join(' · ') + rungNote + parityNote;
}

/** An ask as the run recorded it (edit.stage.ts AskOutcome). */
interface RecordedAsk {
  ask?: unknown;
  status?: unknown;
  reason?: unknown;
  assumption?: unknown;
}

const plain = (value: unknown, max = 160) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** A reference design whose people are cut out of their photos, as the brief described it. */
const CUTOUT_REFERENCE = /cut-?\s?outs?\b|background(?:s)? removed|without (?:their |a |the )?backgrounds?|isolated (?:figures|portraits|people)/i;

/**
 * The lines the requester reads with a draft, in plain words: what their change did and did not
 * do, what became of their photos, and what of their reference the draft could not follow. No
 * coordinates, model names or scores: the note sent until 2026-09-23 read "your change made to the
 * same design (312 × 326.42 at (65, 672). Cutout processing remains required.)" for a change that
 * was not made.
 */
export function requesterDraftNotes({ run, candidates }: Pick<StudioStatusNoteInput, 'run' | 'candidates'>): string[] {
  const stages = parse(run.stages) || {};
  const notes: string[] = [];
  const directed = stages.directed && !stages.directedFailed ? stages.directed : undefined;
  if (directed && typeof directed.reformat === 'string') {
    // Another size of an approved design: not a change, so no list of asks.
    const size = directed.size && Number.isFinite(directed.size.width) ? ` (${directed.size.width}×${directed.size.height})` : '';
    notes.push(`📐 Your approved design as a ${plain(directed.reformat, 40)}${size}, laid out again for the format.`);
  } else if (directed) {
    const asks: RecordedAsk[] = Array.isArray(directed.asks) ? directed.asks : [];
    // A done ask that was open to reading says how it was read, so a wrong reading is caught in one look.
    const done = asks
      .filter((a) => a?.status === 'done' && plain(a.ask))
      .map((a) => `${plain(a.ask)}${plain(a.assumption, 200) ? ` (read as: ${plain(a.assumption, 200).replace(/\.$/, '')})` : ''}`);
    const notDone = asks.filter((a) => a?.status === 'not_done').map((a) => plain(a.ask)).filter(Boolean);
    const impossible = asks.filter((a) => a?.status === 'not_possible').filter((a) => plain(a.ask));
    if (asks.length) {
      for (const ask of done) notes.push(`✅ Done: ${ask}.`);
      // What moved without being asked, because it had to make room; everything else stayed put.
      const moved = (Array.isArray(directed.sideEffects) ? directed.sideEffects : []).map((m: unknown) => plain(m, 60)).filter(Boolean);
      if (moved.length) notes.push(`To make room, ${moved.length === 1 ? 'this also moved' : 'these also moved'}: ${moved.join(', ')}. Nothing else changed.`);
      for (const ask of notDone) notes.push(`⚠️ Not done: ${ask}. It could not be fitted into this design; the art director will look at it.`);
      for (const a of impossible) {
        const reason = plain(a.reason, 200).replace(/\.$/, '');
        notes.push(`❌ Not possible automatically: ${plain(a.ask)}${reason ? ` (${reason})` : ''}. The office has been told, and a designer will do it.`);
      }
    } else {
      // A run recorded before asks were: its own list of what does not show, said plainly.
      const unmade = (Array.isArray(directed.unmade) ? directed.unmade : []).map((u: unknown) => plain(u)).filter(Boolean).slice(0, 3);
      if (directed.unchanged !== true) notes.push('✅ Your change was made to the same design.');
      for (const u of unmade) notes.push(`⚠️ Not done: ${u}.`);
    }
  } else if (stages.directedFailed) {
    notes.push('Your change could not be made to the same design, so the design was made again with your change.');
  }

  const winner = candidates.find((c) => c.id === run.winner_candidate_id) || candidates[0];
  const layouts = parse(winner?.layouts);
  const shipped = parse(Array.isArray(layouts) ? layouts[layouts.length - 1] : undefined);
  const placed = Array.isArray(shipped?.photos) ? shipped.photos.length : 0;
  const sent = typeof stages.brief?.photosSent === 'number' ? stages.brief.photosSent : undefined;
  const shippedPhotos: Array<{ photoIndex?: unknown; treatment?: unknown } | null> = Array.isArray(shipped?.photos) ? shipped.photos : [];
  const cutCount = shippedPhotos.filter((p) => p?.treatment === 'cutout').length;
  // A design that chose among the photos, as the requester allowed, has not dropped any (ADR-157):
  // the office sees which were left out, and the requester is not told their photos went missing.
  if (sent !== undefined && sent > 0 && !choseAmongPhotos(stages, placed, sent, shipped)) {
    if (placed < sent) notes.push(`⚠️ Only ${placed} of your ${sent} photos ${placed === 1 ? 'is' : 'are'} on the design.`);
    else if (cutCount > 0 && cutCount === placed) notes.push(`Your ${sent === 1 ? 'photo is' : `${sent} photos are`} on the design, the people cut out of their backgrounds.`);
    else notes.push(`Your ${sent === 1 ? 'photo is' : `${sent} photos are`} on the design.`);
  }
  // ADR-280: photos from the office's own archive are said to be that, never "your photo", and the
  // notes below that speak of the requester's photos (as you sent it, send a larger one) are not given.
  const library = stages.officePhotoLibrary?.provenance === 'office_library' && stages.officePhotoLibrary.status === 'attached' && placed > 0;
  if (library) notes.push(`The ${placed === 1 ? 'photo on this draft is' : 'photos on this draft are'} from the office photo archive, not ${placed === 1 ? 'one' : 'ones'} you sent.`);
  // A cut-out that failed its checks leaves its photo framed: the requester is told which, and why.
  const cutouts: Array<{ photoIndex?: unknown; passed?: unknown; reason?: unknown } | null> = Array.isArray(stages.cutouts) && !library ? stages.cutouts : [];
  for (const o of cutouts) {
    if (!o || o.passed !== false || typeof o.photoIndex !== 'number') continue;
    if (shippedPhotos.some((p) => p?.photoIndex === o.photoIndex && p?.treatment === 'cutout')) continue;
    notes.push(`⚠️ Photo ${o.photoIndex + 1} could not be cut out cleanly (${plain(o.reason) || 'it did not pass the checks'}), so it is shown as you sent it.`);
  }
  if (!library) notes.push(...softPhotoNotes(shippedPhotos, stages.photoSizes));
  const roles: Array<{ role?: unknown; notes?: unknown } | null> = Array.isArray(stages.brief?.imageRoles) ? stages.brief.imageRoles : [];
  // ADR-171: individual reports preserve source order even when only a subset is placed.
  let contentIndex = 0;
  for (const [imageIndex, report] of roles.slice(0, 10).entries()) {
    if (!report) continue;
    const photoIndex = report.role === 'content_photo' ? contentIndex++ : undefined;
    const use = photoIndex === undefined ? 'not placed as a content photo' : shippedPhotos.some(p => p?.photoIndex === photoIndex) ? 'placed' : 'not placed';
    notes.push(`Image ${imageIndex + 1} — ${plain(report.role, 30).replace(/_/g, ' ')} (${use}): ${plain(report.notes, 240) || 'No individual analysis recorded.'}`);
  }
  const reference = roles.find((r) => r?.role === 'style_reference');
  if (reference) {
    // The design places photos whole, in boxes. A reference with its people cut out cannot be
    // followed in that, and the requester is told so rather than "your reference design followed".
    // Cut-outs tried and failed are already explained photo by photo above.
    const photosCut = CUTOUT_REFERENCE.test(String(reference.notes || '')) && placed > 0 && cutCount === 0 && cutouts.length === 0;
    // A change already reported as not possible says it; the same thing is not said twice.
    const toldAlready = Array.isArray(directed?.asks) && directed.asks.some((a: RecordedAsk) => a?.status === 'not_possible');
    if (photosCut && !toldAlready) notes.push('⚠️ Your reference shows the people cut out of their photos. This draft shows your photos as you sent them, because cut-outs cannot be made automatically yet; the art director can make them in Canva.');
    else if (!photosCut) notes.push('Styled after the reference design you sent.');
  }
  // ADR202: the requester may inspect or edit the exported draft themselves. Preserve font
  // uncertainty in plain words, without exposing QA codes or treating a warning as a refusal.
  const fontCodes = new Set(['FONT_SUBSTITUTED', 'FONT_FIDELITY_UNMEASURED', 'FONT_FIDELITY_UNCOVERED']);
  const fontFindings: Array<{ code?: unknown; message?: unknown } | null> = Array.isArray(stages.qa?.findings) ? stages.qa.findings : [];
  for (const finding of fontFindings.slice(0, 50)) {
    if (!finding || !fontCodes.has(String(finding.code))) continue;
    const message = plain(String(finding.message ?? '').replace(/^[A-Z_]+:\s*/, ''), 500);
    if (message) notes.push(`⚠️ Check before approving: ${message}`);
  }
  return notes;
}

/** True when the requester let the design choose among the photos and it placed a permitted subset. */
function choseAmongPhotos(stages: any, placed: number, sent: number | undefined, shipped?: any): boolean {
  const selection = stages?.brief?.photoSelection;
  if (selection?.mode === 'choose' && sent !== undefined && placed < sent && placed >= Math.min(sent, Number(selection.minimum) || 1)) return true;
  // ADR-180 (owner: "office house style"): an art-direction recipe chose its hero, as the office's
  // designers do, and hard QA recorded the rest for office review. Only the requester's own words
  // ("use all the photos", "pick 3") bind more photos than that.
  const recipe = shipped?.artDirection?.recipe;
  if (!recipe || recipe === 'typographic' || sent === undefined || placed < 1 || placed >= sent) return false;
  const least = recipePhotoMinimum(photoSelectionOrUndefined(selection, sent), sent);
  return placed >= least && Array.isArray(stages?.qa?.omittedPhotos) && stages.qa.omittedPhotos.length === sent - placed;
}

/** The photos a design left out, numbered from 1 as the requester counts them. */
function omittedPhotoNumbers(stages: any, shipped: any, sent: number): number[] {
  const recorded: unknown[] = Array.isArray(stages?.qa?.omittedPhotos) ? stages.qa.omittedPhotos : [];
  const omitted = recorded.length
    ? recorded.filter((i): i is number => typeof i === 'number')
    : omittedPhotoIndices(Array.isArray(shipped?.photos) ? shipped.photos : [], sent);
  return omitted.map((i) => i + 1);
}

/** A framed photo shown this many times larger than its own pixels looks soft on the design. */
export const SOFT_PHOTO_SCALE = 1.6;

/**
 * A warning per framed photo the design shows much larger than its own pixels (plan 4.4), so the
 * requester can send a larger one. No model makes the missing detail up: on a person's photo that
 * would invent their face (ADR-032). The scale is the box over the part of the photo it shows.
 */
export function softPhotoNotes(photos: Array<Record<string, unknown> | null>, sizes: unknown): string[] {
  const known: Array<{ width?: unknown; height?: unknown } | null> = Array.isArray(sizes) ? sizes : [];
  const notes: string[] = [];
  for (const p of photos) {
    if (!p || typeof p.photoIndex !== 'number' || p.treatment === 'cutout') continue;
    const size = known[p.photoIndex];
    const image = { width: Number(size?.width), height: Number(size?.height) };
    const box = { width: Number(p.width), height: Number(p.height) };
    if (!(image.width > 0 && image.height > 0 && box.width > 0 && box.height > 0)) continue;
    const focus = p.focus && typeof p.focus === 'object' ? (p.focus as { x: number; y: number }) : undefined;
    const zoom = typeof p.zoom === 'number' && p.zoom > 1 ? p.zoom : 1;
    const crop = coverCrop(box, image, focus);
    const scale = (box.width / crop.sw) * zoom;
    if (scale >= SOFT_PHOTO_SCALE) {
      notes.push(`⚠️ Photo ${p.photoIndex + 1} is small for its place on the design (${image.width}×${image.height} pixels, shown about ${scale.toFixed(1)} times larger), so it may look soft. Send a larger version if you have one.`);
    }
  }
  return notes;
}
