import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { ComparisonResultsView, JudgeLinkNotice, PreregistrationView, StudyDetailView } from '../src/screens/ComparisonScreen.js';
import { PROTOCOL_PREREGISTRATION, judgeLinkFor, type ShareSummary, type StudyDetail, type StudyResults } from '../src/services/comparison.js';

const share = (hawa: number, designer: number, none: number, low: number | null, high: number | null): ShareSummary => ({
  judgements: hawa + designer + none,
  decisive: hawa + designer,
  hawa,
  designer,
  none,
  hawaShare: hawa + designer ? hawa / (hawa + designer) : null,
  interval: low === null || high === null ? null : { low, high },
  tieRate: hawa + designer + none ? none / (hawa + designer + none) : null,
});

const study: StudyDetail = {
  id: 's1',
  name: 'Hawa and the office designer, October',
  status: 'judging',
  preregistration: PROTOCOL_PREREGISTRATION,
  preregistrationSha256: 'a'.repeat(64),
  lockedAt: '2026-10-01T09:30:00.000Z',
  closedAt: null,
  createdBy: 'art_director_1',
  createdAt: '2026-09-30T09:00:00.000Z',
  pairs: 2,
  judges: 2,
  activeJudges: 1,
  judgements: 3,
  pairList: [
    { id: 'p1', label: 'P01', taskId: '00000000-0000-4000-c000-000000000001', width: 1080, height: 1350, hawaSha256: 'b'.repeat(64), designerSha256: 'c'.repeat(64), judgements: 2, createdAt: '' },
    { id: 'p2', label: 'P02', taskId: null, width: 1080, height: 1350, hawaSha256: 'd'.repeat(64), designerSha256: 'e'.repeat(64), judgements: 1, createdAt: '' },
  ],
  judgeList: [
    { id: 'j1', name: 'Requester A', kind: 'requester', createdAt: '', revokedAt: null, judgements: 2 },
    { id: 'j2', name: 'Outside designer C', kind: 'designer', createdAt: '', revokedAt: '2026-10-02T10:00:00.000Z', judgements: 1 },
  ],
};

const results: StudyResults = {
  studyId: 's1',
  name: study.name,
  status: 'judging',
  preregistration: PROTOCOL_PREREGISTRATION,
  preregistrationSha256: 'a'.repeat(64),
  pairs: 50,
  primary: share(117, 77, 6, 0.532887, 0.669296),
  byJudgeKind: { requester: share(60, 40, 4, 0.5020, 0.6906), designer: share(57, 37, 2, 0.5057, 0.6997) },
  excludingSeenBefore: share(110, 74, 6, 0.5256, 0.6660),
  seenBefore: share(7, 3, 0, 0.3968, 0.8922),
  fromRevokedJudges: 12,
  position: { shown: 200, hawaShownLeft: 101, decisive: 194, leftChosen: 99 },
  perPair: [
    { pairId: 'p1', label: 'P01', judgements: 4, hawa: 3, designer: 1, none: 0, seenBefore: 1, majority: 'hawa' },
    { pairId: 'p2', label: 'P02', judgements: 4, hawa: 0, designer: 0, none: 4, seenBefore: 0, majority: 'none' },
  ],
  claim: {
    threshold: 0.5,
    lowerBound: 0.532887,
    lowerBoundAboveThreshold: true,
    decisive: 194,
    minDecisive: 194,
    pairsBelowMinJudges: 0,
    sampleComplete: true,
    closed: false,
    holds: false,
    verdict: 'Not decided yet: the lower bound (53.3%) is above 50.0% so far, but the claim is decided only on the complete pre-registered sample (the study is not closed).',
  },
};

describe('the Comparison screen', () => {
  it('shows the share, its interval, the tie rate, every split, and whether the claim holds', () => {
    const html = renderToStaticMarkup(React.createElement(ComparisonResultsView, { results }));
    expect(html).toContain('Hawa preferred');
    expect(html).toContain('60.3%');
    expect(html).toContain('of 194 decisive judgements');
    expect(html).toContain('53.3% to 66.9%');
    expect(html).toContain('3.0%');
    expect(html).toContain('Claim holds');
    expect(html).toContain('<b>No</b>');
    expect(html).toContain('lower bound must be above 50.0%');
    expect(html).toContain('Not decided yet');
    for (const row of ['All (primary outcome)', 'Requesters', 'Outside designers', 'Without designs the judge had received', 'Only designs the judge had received']) expect(html).toContain(row);
    expect(html).toContain('Hawa was on the left in 101 of 200 judgements; the left design was picked in 99 of 194 decisive ones.');
    expect(html).toContain('12 judgements came through links revoked since; they are counted, as pre-registered.');
    expect(html).toContain('No decisive judgement');

    const holds = renderToStaticMarkup(
      React.createElement(ComparisonResultsView, { results: { ...results, status: 'closed', claim: { ...results.claim, closed: true, holds: true, verdict: 'Hawa is preferred.' } } })
    );
    expect(holds).toContain('<b>Yes</b>');
  });

  it('shows the plan with its fingerprint, and the study’s pairs and judges without anything a judge could use', () => {
    const plan = renderToStaticMarkup(React.createElement(PreregistrationView, { study }));
    expect(plan).toContain('Pre-registration (fixed)');
    expect(plan).toContain('at least 194 decisive judgements');
    expect(plan).toContain('a'.repeat(64));
    expect(plan).toContain('locked 2026-10-01 09:30 UTC');

    const html = renderToStaticMarkup(React.createElement(StudyDetailView, { study, onChanged: () => {}, onJudgeAdded: () => {} }));
    expect(html).toContain('Judging: the plan and the pairs are fixed');
    expect(html).toContain('The pairs are fixed: judging has started.');
    expect(html).not.toContain('Add a pair');
    expect(html).toContain('P01');
    expect(html).toContain('1080×1350');
    expect(html).toContain('Requester A');
    expect(html).toContain('Revoked');
    expect(html).toContain('Close judging');
    expect(html).not.toContain('Lock and start judging');

    const draft = renderToStaticMarkup(React.createElement(StudyDetailView, { study: { ...study, status: 'draft', lockedAt: null }, onChanged: () => {}, onJudgeAdded: () => {} }));
    expect(draft).toContain('Add a pair');
    expect(draft).toContain('Lock and start judging');
    expect(draft).toContain('(can still change until the study is locked)');
  });

  it('gives the judge’s link once, and says when it only works on this computer', () => {
    const local = judgeLinkFor({ path: '/api/judge/TOKEN', url: null }, 'http://127.0.0.1:8080');
    expect(local).toEqual({ href: 'http://127.0.0.1:8080/api/judge/TOKEN', localOnly: true });
    const outside = judgeLinkFor({ path: '/api/judge/TOKEN', url: 'https://judge.example.org/api/judge/TOKEN' }, 'http://127.0.0.1:8080');
    expect(outside).toEqual({ href: 'https://judge.example.org/api/judge/TOKEN', localOnly: false });

    const html = renderToStaticMarkup(React.createElement(JudgeLinkNotice, { name: 'Requester A', ...local }));
    expect(html).toContain('It is shown only this once');
    expect(html).toContain('value="http://127.0.0.1:8080/api/judge/TOKEN"');
    expect(html).toContain('A judge on another device cannot open it');
    expect(renderToStaticMarkup(React.createElement(JudgeLinkNotice, { name: 'B', ...outside }))).not.toContain('another device');
  });
});
