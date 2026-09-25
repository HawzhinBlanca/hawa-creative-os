import { describe, it, expect } from 'vitest';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';
import {
  checkRefinementGate,
  refineCandidate,
  identifyAttributedChanges,
} from '../src/studio/refinement-engine-v3.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';
import { SIX_CONFIRMED_EXEMPLARS } from './fixtures/design-metrics-fixtures.js';

describe('P06 — Gated Refinement with Plateau Stop', () => {
  const passingLayout: StudioLayoutV2 = {
    ...SIX_CONFIRMED_EXEMPLARS[0],
  };

  it('skips refinement entirely for an already-passing candidate (0 calls)', async () => {
    const gate = checkRefinementGate(passingLayout);
    expect(gate.shouldRefine).toBe(false);
    expect(gate.reason).toBe('candidate_already_passes_all_checks');

    let fetchCalled = false;
    const mockFetcher = (async () => {
      fetchCalled = true;
      throw new Error('Should not make any network calls for passing candidate');
    }) as any;

    const result = await refineCandidate('candidate-passing', passingLayout, {
      openaiApiKey: 'test-key',
      fetchFn: mockFetcher,
    });

    expect(fetchCalled).toBe(false);
    expect(result.roundsRun).toBe(0);
    expect(result.gateDecision).toBe('skip');
    expect(result.stopReason).toBe('candidate_already_passes_all_checks');
    expect(result.initialScore).toBe(result.finalScore);
  });

  it('repairs a failing candidate and attributes fixes to critique comments', async () => {
    // Deliberately misaligned layout from P05: title at x: 20, width: 700, body at y: 1020
    const fs = await import('node:fs');
    const path = await import('node:path');
    const rootDir = fs.existsSync(path.resolve(process.cwd(), 'packages'))
      ? process.cwd()
      : path.resolve(process.cwd(), '../..');
    const layout4Path = path.resolve(
      rootDir,
      'output/proofs/2026-09-17-research-grade-pipeline/P03_LAYOUTS/layout_04.json'
    );
    const base = JSON.parse(fs.readFileSync(layout4Path, 'utf8'));
    if (base.text[1]) base.text[1].fontFamily = 'Playfair Display';

    const failingLayout: StudioLayoutV2 = {
      ...base,
      logo: { x: 490, y: 50, width: 100, height: 100 },
      text: base.text.map((t: any) => {
        if (t.role === 'title') return { ...t, x: 20, width: 700 };
        if (t.role === 'body') return { ...t, y: 1020, height: 200 };
        return t;
      }),
    };

    const gate = checkRefinementGate(failingLayout);
    expect(gate.shouldRefine).toBe(true);

    // Mock fetcher that provides:
    // Call 1: critique from gpt-6-astra citing B1
    // Call 2: repair from gpt-6-astra fixing B1 (x: 20 -> x: 80)
    let callIndex = 0;
    const mockFetcher = (async (_url: string, init: any) => {
      callIndex++;
      const payload = JSON.parse(init.body);

      if (callIndex === 1) {
        // Critique call
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'critique-1',
            model: 'gpt-6-astra',
            usage: { prompt_tokens: 500, completion_tokens: 150 },
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    overallAssessment: 'Title is displaced outside margin.',
                    comments: [
                      {
                        boxId: 'B1',
                        category: 'alignment',
                        issue: 'Title at x:20 violates grid margin',
                        severity: 'high',
                        suggestedFix: 'Shift x from 20 to 108 and restore width to 864',
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          headers: new Headers({ 'x-request-id': 'req-critique-1' }),
        } as any;
      } else {
        // Repair call: returns fixed layout
        const repairedLayout = {
          ...base,
          logo: { x: 490, y: 50, width: 100, height: 100 },
        };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'repair-1',
            model: 'gpt-6-astra',
            usage: { prompt_tokens: 600, completion_tokens: 250 },
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    repairSummary: 'Shifted title from x:20 to x:108 and restored body placement.',
                    layout: repairedLayout,
                  }),
                },
              },
            ],
          }),
          headers: new Headers({ 'x-request-id': 'req-repair-1' }),
        } as any;
      }
    }) as any;

    const result = await refineCandidate('candidate-repair', failingLayout, {
      openaiApiKey: 'test-key',
      fetchFn: mockFetcher,
      renderOptions: { logoDataUri: KAAE_TEST_LOGO },
      maxRounds: 2,
    });
    expect(result.gateDecision).toBe('refine');
    expect(result.roundsRun).toBe(1);
    expect(result.stopReason).toBe('repaired_and_passed');
    expect(result.finalScore).toBeGreaterThan(result.initialScore);
    expect(result.scoreDelta).toBeGreaterThanOrEqual(0.02);

    const round1 = result.rounds[0];
    expect(round1.changesAttributed.length).toBeGreaterThan(0);
    expect(round1.changesAttributed[0].boxId).toBe('B1');
    expect(round1.changesAttributed[0].description).toContain('x: 20->108');
  });

  it('stops early when improvement plateaus (score delta < 0.02)', async () => {
    // Failing layout from P05
    const fs = await import('node:fs');
    const path = await import('node:path');
    const rootDir = fs.existsSync(path.resolve(process.cwd(), 'packages'))
      ? process.cwd()
      : path.resolve(process.cwd(), '../..');
    const layout4Path = path.resolve(
      rootDir,
      'output/proofs/2026-09-17-research-grade-pipeline/P03_LAYOUTS/layout_04.json'
    );
    const base = JSON.parse(fs.readFileSync(layout4Path, 'utf8'));
    if (base.text[1]) base.text[1].fontFamily = 'Playfair Display';

    const failingLayout: StudioLayoutV2 = {
      ...base,
      logo: { x: 490, y: 50, width: 100, height: 100 },
      text: base.text.map((t: any) => {
        if (t.role === 'title') return { ...t, x: 20, width: 700 };
        if (t.role === 'body') return { ...t, y: 1020, height: 200 };
        return t;
      }),
    };

    let callIndex = 0;
    const mockFetcher = (async (_url: string, _init: any) => {
      callIndex++;
      if (callIndex % 2 === 1) {
        // Critique call
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: `critique-${callIndex}`,
            model: 'gpt-6-astra',
            usage: { prompt_tokens: 400, completion_tokens: 100 },
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    overallAssessment: 'Minor whitespace issue.',
                    comments: [
                      {
                        boxId: 'B1',
                        category: 'whitespace',
                        issue: 'Title needs tiny 1px breathing room',
                        severity: 'low',
                        suggestedFix: 'Shift x from 20 to 21',
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          headers: new Headers({ 'x-request-id': `req-critique-${callIndex}` }),
        } as any;
      } else {
        // Repair call that makes an insignificant change (x: 20 -> 21), improving score by almost nothing (< 0.02)
        const minimalChangeLayout = {
          ...failingLayout,
          text: failingLayout.text.map((t) =>
            t.role === 'title' ? { ...t, x: 21 } : t
          ),
        };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: `repair-${callIndex}`,
            model: 'gpt-6-astra',
            usage: { prompt_tokens: 500, completion_tokens: 200 },
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    repairSummary: 'Tiny nudge of title to x:21',
                    layout: minimalChangeLayout,
                  }),
                },
              },
            ],
          }),
          headers: new Headers({ 'x-request-id': `req-repair-${callIndex}` }),
        } as any;
      }
    }) as any;

    const result = await refineCandidate('candidate-plateau', failingLayout, {
      openaiApiKey: 'test-key',
      fetchFn: mockFetcher,
      renderOptions: { logoDataUri: KAAE_TEST_LOGO },
      maxRounds: 2,
      minDelta: 0.02,
    });

    expect(result.roundsRun).toBe(1); // Stopped after round 1 instead of continuing to round 2!
    expect(result.stopReason).toContain('plateau_detected');
    expect(result.rounds[0].scoreDelta).toBeLessThan(0.02);
  });
});
