/**
 * ADR-124: Core records `humanChoiceRecommended` on the judge stage when automated preference is
 * uncertain, untested or unavailable. The higher-ranked candidate is only a default then, and the
 * reviewer is asked to choose.
 */
export interface StudioTournamentStage {
  decidedBy?: string;
  judgeProtocol?: string;
  humanChoiceRecommended?: boolean;
  prior?: { basis?: string; instead?: string };
}

const REASONS: Record<string, string> = {
  art_direction_prior: 'The judge tied or failed its reliability check. The client style policy supplied the default design.',
  composite_after_tie: 'The judge could not distinguish the designs consistently across both display orders.',
  composite_judge_uncertain: 'The judge could not decide between the top two designs, or its pick could not be tested.',
  composite_judge_unreliable: 'The judge did not prefer its own pick over a degraded copy of it, so its pick is not trusted.',
  composite_judge_unavailable: 'The judge was unavailable for this run.',
};

export function StudioJudgeNotice({ tournament }: { tournament?: StudioTournamentStage | null }) {
  const guideline = tournament?.decidedBy === 'art_direction_prior' && tournament.prior?.basis === 'guideline';
  if (tournament?.humanChoiceRecommended !== true) {
    if (!guideline) return null;
    return <div role="status" style={{ margin: '8px 0', padding: '8px 10px', border: '1px solid currentColor', borderRadius: 4 }}>
      <strong>The client guideline selected this design.</strong>
      {tournament?.prior?.instead === 'judge_without_clear_margin' && <span> The judge preferred another design without a clear margin.</span>}
    </div>;
  }
  const reason = guideline ? 'The client guideline supplied the default design.' :
    REASONS[tournament.decidedBy ?? ''] ?? 'Automated preference is uncertain for this run.';
  return <div role="status" style={{ margin: '8px 0', padding: '8px 10px', border: '1px solid currentColor', borderRadius: 4 }}>
    <strong>Choose the design yourself.</strong> {reason} The higher-ranked candidate is shown by default, not as the judge's choice.
    {tournament.judgeProtocol === 'brief_bound_v1' && <span> (Judge: brief-bound challenger.)</span>}
  </div>;
}
