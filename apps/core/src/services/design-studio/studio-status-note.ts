// The one-line studio summary sent to the requester with the Canva result.
// Every figure comes from the run's own record; a figure the run did not record is left out.

const parse = (value: unknown): any => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return undefined; }
};

export interface StudioStatusNoteInput {
  run: { stages?: unknown; diagnostic?: string | null; winner_candidate_id?: string | null };
  candidates: Array<{ id: string; score?: unknown; layouts?: unknown; concept?: unknown; art_provenance?: unknown }>;
  parityNote?: string;
}

export function studioStatusNote({ run, candidates, parityNote = '' }: StudioStatusNoteInput): string {
  const stages = parse(run.stages) || {};
  const v3 = Object.values(stages).some((stage: any) => stage?.pipeline === 'v3');
  const winner = candidates.find(c => c.id === run.winner_candidate_id) || candidates[0];
  const parts = [v3 ? 'Studio v3' : 'Studio v2'];

  if (candidates.length > 0) parts.push(`${candidates.length} concept${candidates.length === 1 ? '' : 's'}`);

  const revise = stages.revise;
  const rounds = Array.isArray(revise?.rounds) ? revise.rounds.length : typeof revise?.rounds === 'number' ? revise.rounds : undefined;
  if (rounds === 0) parts.push('no revision needed');
  else if (rounds !== undefined) parts.push(`${rounds} revision round${rounds === 1 ? '' : 's'}`);

  // v3 stores the deterministic layout score (0..1) on the candidate; v2 stored the judge's 0..10 score.
  const score = typeof winner?.score === 'number' ? winner.score : Number.parseFloat(String(winner?.score ?? ''));
  if (Number.isFinite(score)) parts.push(v3 ? `layout score ${score.toFixed(2)}/1` : `judge ${Number(score.toFixed(1))}/10`);

  const artProv = parse(winner?.art_provenance);
  const concept = parse(winner?.concept);
  if (artProv?.synthId || artProv?.generator === 'imagen' || concept?.artStrategy === 'generated') parts.push('imagery: generated');
  else if (concept?.artStrategy === 'procedural') parts.push(`imagery: procedural (${concept.motif || 'thin-rules'})`);
  else if (winner) parts.push('imagery: none');

  const faces = new Set<string>();
  // The candidate keeps every layout it went through; the last one is the one transferred.
  const layouts = parse(winner?.layouts);
  const shipped = parse(Array.isArray(layouts) ? layouts[layouts.length - 1] : undefined);
  for (const t of shipped?.text || []) if (t?.fontFamily) faces.add(t.fontFamily);
  if (faces.size > 0) parts.push(`typeface: ${[...faces].join(', ')}`);
  else if (concept?.displayFont) parts.push(`typeface: ${concept.displayFont}`);

  let rungNote = '';
  if (stages.ladderRung && stages.ladderRung > 1) rungNote = ` · ${stages.ladderNotes || `Rung ${stages.ladderRung} fallback`}`;
  else if (run.diagnostic?.includes('Rung')) rungNote = ` · ${run.diagnostic}`;

  return parts.join(' · ') + rungNote + parityNote;
}
