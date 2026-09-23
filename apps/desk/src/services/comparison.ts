/**
 * The blinded comparison of Hawa with the office's designer, as Core returns it
 * (apps/core/src/services/comparison-study.ts), and the small helpers the Comparison screen needs.
 */

export type StudyStatus = 'draft' | 'judging' | 'closed';
export type JudgeKind = 'requester' | 'designer';

export interface Preregistration {
  sample: string;
  judges: string;
  analysis: string;
  threshold: number;
  minDecisive: number;
  minJudgesPerPair: number;
  plannedPairs: number;
}

export interface StudySummary {
  id: string;
  name: string;
  status: StudyStatus;
  preregistration: Preregistration;
  preregistrationSha256: string;
  lockedAt: string | null;
  closedAt: string | null;
  createdBy: string;
  createdAt: string;
  pairs: number;
  judges: number;
  activeJudges: number;
  judgements: number;
}

export interface PairSummary {
  id: string;
  label: string;
  taskId: string | null;
  width: number;
  height: number;
  hawaSha256: string;
  designerSha256: string;
  judgements: number;
  createdAt: string;
}

export interface JudgeSummary {
  id: string;
  name: string;
  kind: JudgeKind;
  createdAt: string;
  revokedAt: string | null;
  judgements: number;
}

export interface StudyDetail extends StudySummary {
  pairList: PairSummary[];
  judgeList: JudgeSummary[];
}

export interface ShareSummary {
  judgements: number;
  decisive: number;
  hawa: number;
  designer: number;
  none: number;
  hawaShare: number | null;
  interval: { low: number; high: number } | null;
  tieRate: number | null;
}

export interface PairTally {
  pairId: string;
  label: string;
  judgements: number;
  hawa: number;
  designer: number;
  none: number;
  seenBefore: number;
  majority: 'hawa' | 'designer' | 'tie' | 'none';
}

export interface StudyResults {
  studyId: string;
  name: string;
  status: StudyStatus;
  preregistration: Preregistration;
  preregistrationSha256: string;
  pairs: number;
  primary: ShareSummary;
  byJudgeKind: { requester: ShareSummary; designer: ShareSummary };
  excludingSeenBefore: ShareSummary;
  seenBefore: ShareSummary;
  fromRevokedJudges: number;
  position: { shown: number; hawaShownLeft: number; decisive: number; leftChosen: number };
  perPair: PairTally[];
  claim: {
    threshold: number;
    lowerBound: number | null;
    lowerBoundAboveThreshold: boolean;
    decisive: number;
    minDecisive: number;
    pairsBelowMinJudges: number;
    sampleComplete: boolean;
    closed: boolean;
    holds: boolean;
    verdict: string;
  };
}

export interface AddedJudge {
  judge: JudgeSummary;
  token: string;
  link: { path: string; url: string | null };
}

export interface AddPairBody {
  label?: string;
  taskId?: string;
  fromTask?: boolean;
  hawaPngBase64?: string;
  designerPngBase64?: string;
}

/**
 * The protocol's text (output/plans/2026-09-23-designer-grade-revisions/PLAN.md), offered as the
 * starting pre-registration. The office edits it to the study it is actually running before locking.
 */
export const PROTOCOL_PREREGISTRATION: Preregistration = {
  sample:
    '50 real office requests from the past month, chosen before anything is made, covering what the office gets: events with speaker photos, bilingual Sorani and English copy, text-heavy notices, and requests with a reference to follow. Hawa and the office designer work from the same brief, photos, reference and requester replies; each final design is exported at the same size as a PNG.',
  judges:
    'The requesters who sent the briefs (4 to 6) and 3 designers from outside the office. Each pair is shown side by side in random order with no names, and each judge picks one or says "no preference". Every pair is judged by at least 4 judges. Pairs a judge received themselves are marked and reported separately.',
  analysis:
    'Primary outcome: the share of decisive judgements that prefer Hawa, with a Wilson 95% confidence interval, every judgement counted. "Better" is claimed only if the lower bound is above 50%, once the study is closed with at least 194 decisive judgements (a 60/40 preference at 80% power, two-sided alpha 0.05) and every pair judged at least 4 times. The tie rate is reported beside it, with the same split by judge kind and without the pairs judges had seen before.',
  threshold: 0.5,
  minDecisive: 194,
  minJudgesPerPair: 4,
  plannedPairs: 50,
};

export const percent = (share: number | null | undefined): string =>
  typeof share === 'number' && Number.isFinite(share) ? `${(share * 100).toFixed(1)}%` : '—';

export const STATUS_WORDS: Record<StudyStatus, string> = {
  draft: 'Draft: pairs and judges can be added',
  judging: 'Judging: the plan and the pairs are fixed',
  closed: 'Closed',
};

/**
 * The link to give a judge. Core names an address when the office has set one for outside judges;
 * otherwise it is this Desk's own address, which judges on another machine cannot open while Hawa
 * listens only on this computer.
 */
export function judgeLinkFor(link: { path: string; url: string | null }, origin: string): { href: string; localOnly: boolean } {
  const href = link.url || `${origin.replace(/\/+$/, '')}${link.path}`;
  let host = '';
  try {
    host = new URL(href).hostname;
  } catch {
    host = '';
  }
  return { href, localOnly: host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]' };
}

/** Core's request limit behind nginx is 25 MB; a pair's two images travel in one request as base64. */
export const MAX_PAIR_REQUEST_BYTES = 25 * 1024 * 1024;

export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || '');
      resolve(value.slice(value.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}
