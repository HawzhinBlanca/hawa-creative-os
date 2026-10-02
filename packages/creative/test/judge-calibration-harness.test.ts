import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  calibrationPlan,
  JUDGE_CALL_USD,
  panelLabel,
  summarizeCalibration,
  verdictOf,
  type FrozenSet,
  type JudgedPair,
} from '../../../scripts/experiments/judge-calibration.js';
import { JUDGE_DIMENSIONS } from '../src/studio/pairwise-judge-v3.js';

/**
 * ADR-274 item 6: the judge-calibration harness is prepared, not run (a run needs the owner's
 * approval of the spend). Its plan, its labels and its agreement arithmetic are checked here, free.
 */
const SET = JSON.parse(readFileSync(new URL('../../../plans/judge-calibration-2026-10-02/frozen-set.json', import.meta.url), 'utf8')) as FrozenSet;

describe('the frozen calibration set', () => {
  it('holds the blind panel\'s 33 designs and 47 pairs, each of our designs against two office posts', () => {
    expect(SET.images).toHaveLength(33);
    expect(SET.images.filter((i) => i.group === 'office')).toHaveLength(12);
    expect(SET.pairs).toHaveLength(47);
    const ids = new Set(SET.images.map((i) => i.id));
    for (const p of SET.pairs) expect(ids.has(p.a) && ids.has(p.b)).toBe(true);
    const group = (id: string) => SET.images.find((i) => i.id === id)!.group;
    for (const p of SET.pairs.filter((x) => x.kind === 'ours_vs_office')) {
      expect(group(p.a)).not.toBe('office');
      expect(group(p.b)).toBe('office');
    }
    expect(SET.pairs.filter((p) => p.kind === 'document_page_vs_poster').every((p) => group(p.a) === 'ours_shipped' && group(p.b) === 'ours_new')).toBe(true);
  });

  it('labels a pair by the panel\'s mean overall, a tie inside the margin', () => {
    const set: FrozenSet = { version: 1, tieMargin: 0.5, pairs: [], images: [
      { id: 'x', group: 'ours_new', file: 'x.png', panelOverall: 6.0 },
      { id: 'y', group: 'office', file: 'y.jpg', panelOverall: 5.6 },
      { id: 'z', group: 'ours_shipped', file: 'z.png', panelOverall: 3.3 },
    ] };
    expect(panelLabel(set, { a: 'x', b: 'y', kind: 'k' })).toBe('tie');
    expect(panelLabel(set, { a: 'z', b: 'x', kind: 'k' })).toBe('b');
    expect(panelLabel(set, { a: 'x', b: 'z', kind: 'k' })).toBe('a');
    // Every shipped document page lost to the poster for its brief on the panel.
    for (const p of SET.pairs.filter((x) => x.kind === 'document_page_vs_poster')) expect(panelLabel(SET, p)).toBe('b');
  });
});

describe('the plan and its cost, before anything is sent', () => {
  it('is two calls a pair at the production judge\'s measured rate', () => {
    const plan = calibrationPlan(SET);
    expect(plan.calls).toBe(94);
    expect(plan.usd.low).toBeCloseTo(94 * JUDGE_CALL_USD.low, 4);
    expect(plan.usd.high).toBeCloseTo(94 * JUDGE_CALL_USD.high, 4);
    expect(plan.usd.high).toBeLessThan(2);
    expect(plan.labelCounts.a + plan.labelCounts.b + plan.labelCounts.tie).toBe(47);
    expect(calibrationPlan(SET, { limit: 10 }).calls).toBe(20);
    expect(calibrationPlan(SET, { officeReference: true }).usd.high).toBeGreaterThan(plan.usd.high);
  });
});

describe('agreement with the panel', () => {
  const votes = Object.fromEntries(JUDGE_DIMENSIONS.map((d) => [d, 'A'])) as JudgedPair['votes']['aFirst'];
  const judged = (label: JudgedPair['label'], aFirst: 'a' | 'b', bFirst: 'a' | 'b', kind = 'ours_vs_office'): JudgedPair => ({
    pair: { a: 'p', b: 'q', kind }, label, winnerAFirst: aFirst, winnerBFirst: bFirst, verdict: verdictOf(aFirst, bFirst),
    votes: { aFirst: votes, bFirst: votes }, costUsd: 0.03,
  });

  it('an order flip is a tie, as in production', () => {
    expect(verdictOf('a', 'a')).toBe('a');
    expect(verdictOf('a', 'b')).toBe('tie');
  });

  it('reports decided agreement, three-way agreement, position consistency, kappa and cost', () => {
    const s = summarizeCalibration([
      judged('b', 'b', 'b'), judged('b', 'b', 'b'), judged('a', 'b', 'b'), judged('tie', 'a', 'b'), judged('b', 'a', 'b', 'document_page_vs_poster'),
    ]);
    expect(s.pairs).toBe(5);
    expect(s.decided).toEqual({ pairs: 3, agree: 2, rate: 0.6667 });
    expect(s.threeWay).toEqual({ agree: 3, rate: 0.6 });
    expect(s.positionConsistency).toBe(0.6);
    expect(s.byKind.document_page_vs_poster).toEqual({ pairs: 1, agreeDecided: 0, decided: 0 });
    expect(s.costUsd).toBeCloseTo(0.15, 6);
    expect(s.kappa).not.toBeNull();
    expect(summarizeCalibration([]).decided.rate).toBeNull();
  });
});
