import { describe, expect, it } from 'vitest';
import { deterministicCritiqueV3 } from '../src/services/design-studio/stages/v3.stage.js';

/**
 * P05 spent one top-tier call per design — $0.046 of $0.629, measured over 16 production runs — on
 * a written critique that reached nobody: the Desk tab that would show it reads a column the v3
 * branch never writes (0 of 60 v3 candidates carry one), and the refinement stage critiques for
 * itself on its own model role. The judgment row is still written, because it is the run's audit
 * trail, but it is filled from the hard QA and metrics the run already computed.
 */
const rankedWith = (over: Partial<any> = {}) =>
  ({
    sourceIndex: 0,
    layout: {} as any,
    metrics: {
      compositeScore: 0.742,
      passed: true,
      failingMetrics: [],
      metrics: {
        textLegibility: { score: 0.9 },
        alignment: { score: 0.8 },
        balance: { score: 0.7 },
        regularity: { score: 0.75 },
        typeScale: { score: 0.85 },
      },
    },
    ...over,
  }) as any;

describe('the critique is measured, not written', () => {
  it('costs nothing and records no model, so the ledger cannot mistake it for a call', () => {
    const critique = deterministicCritiqueV3(rankedWith());
    expect(critique.receipt.costUsd).toBe(0);
    expect(critique.receipt.inputTokens).toBe(0);
    expect(critique.receipt.outputTokens).toBe(0);
    expect(critique.receipt.model).toBe('deterministic');
  });

  it('names every hard-QA defect, with the message the QA gave, at high severity', () => {
    const critique = deterministicCritiqueV3(
      rankedWith({
        hardQa: {
          passed: false,
          defectCodes: ['COPY_ORDER', 'LOGO_CLEAR_ZONE'],
          messages: ['Block 3 sits above block 2', 'Text intrudes on the logo clear space'],
        },
      })
    );
    const issues = critique.comments.map((c) => c.issue);
    expect(issues[0]).toContain('COPY_ORDER');
    expect(issues[0]).toContain('Block 3 sits above block 2');
    expect(issues[1]).toContain('LOGO_CLEAR_ZONE');
    expect(critique.comments.every((c) => c.severity === 'high')).toBe(true);
    expect(critique.overallAssessment).toContain('hard QA failed');
  });

  it('names each failing metric with its measured score', () => {
    const critique = deterministicCritiqueV3(
      rankedWith({
        metrics: {
          compositeScore: 0.41,
          passed: false,
          failingMetrics: ['alignment', 'balance'],
          metrics: { alignment: { score: 0.312 }, balance: { score: 0.488 } },
        },
      })
    );
    const issues = critique.comments.map((c) => c.issue);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain('alignment');
    expect(issues[0]).toContain('0.312');
    expect(critique.comments[0].category).toBe('alignment');
    expect(critique.comments[1].category).toBe('whitespace');
    expect(critique.overallAssessment).toContain('0.410');
  });

  it('says so plainly when nothing is wrong, rather than inventing a criticism', () => {
    // A written critique had to say something. A measured one is allowed to find nothing, which is
    // what a design that passes hard QA with no failing metric actually deserves.
    const critique = deterministicCritiqueV3(rankedWith({ hardQa: { passed: true, defectCodes: [], messages: [] } }));
    expect(critique.comments).toEqual([]);
    expect(critique.overallAssessment).toContain('No measured defect');
    expect(critique.overallAssessment).toContain('hard QA passed');
  });

  it('keeps the record shape the run stores, including the metrics report', () => {
    const critique = deterministicCritiqueV3(rankedWith());
    expect(critique.status).toBe('success');
    expect(critique.rejectedComments).toEqual([]);
    expect(critique.deterministicMetrics.compositeScore).toBe(0.742);
  });

  it('survives a run whose hard QA never ran', () => {
    const critique = deterministicCritiqueV3(rankedWith({ hardQa: undefined }));
    expect(critique.overallAssessment).toContain('hard QA not run');
  });
});
