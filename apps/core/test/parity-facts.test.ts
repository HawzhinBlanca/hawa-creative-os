import { describe, expect, it } from 'vitest';
import { parityFactsFrom } from '../src/services/design-studio/stages/parity.stage.js';

/**
 * Parity asked a vision model five questions about two pictures. Three of them were already
 * answered exactly, elsewhere and earlier: checkCanvaPptx parses the exported slide XML and
 * establishes whether every copy string survived word for word, whether each text object kept the
 * typeface it was sent in, and whether right-to-left runs stayed right-to-left. That same check
 * already gates delivery — apps/worker/src/canva-draft-workflow.ts refuses the design on copyPass
 * or fontPass — so the model was being paid top-tier rates to squint at a render and re-derive,
 * less reliably, facts the pipeline was holding in its hand.
 *
 * They are now stated to it, leaving it only the question the document cannot answer: whether the
 * arrangement survived the round trip.
 */
describe('parity states what the export check already established', () => {
  const passingCheck = {
    copyPass: true,
    fontPass: true,
    rtlPass: true,
    textObjectCount: 6,
    expectedTextObjectCount: 6,
    observedFonts: ['Cinzel', 'Verdana'],
    offendingObjects: [],
  };

  it('tells the model the copy and typefaces survived, and which booleans that makes', () => {
    const facts = parityFactsFrom(passingCheck);
    expect(facts).toContain('survived the round trip word for word');
    expect(facts).toContain('kept the typeface it was sent in');
    expect(facts).toMatch(/copyVisibleIdentical to true/);
    expect(facts).toMatch(/fontSubstituted to false/);
    expect(facts).toContain('Cinzel');
  });

  it('reverses both booleans when the export check failed, instead of leaving it to the picture', () => {
    const facts = parityFactsFrom({
      ...passingCheck,
      copyPass: false,
      fontPass: false,
      offendingObjects: [{ index: 2 }, { index: 3 }],
      observedFonts: ['Arial'],
    });
    expect(facts).toContain('did NOT survive intact');
    expect(facts).toContain('2 offending text object(s)');
    expect(facts).toContain('did NOT keep the typeface it was sent in');
    expect(facts).toMatch(/copyVisibleIdentical to false/);
    expect(facts).toMatch(/fontSubstituted to true/);
  });

  it('points the model at the one question the document cannot answer', () => {
    // The whole point of stating the rest: the model's attention goes to geometry, which is the
    // only part of a Canva round trip that the slide XML does not settle on its own.
    expect(parityFactsFrom(passingCheck)).toMatch(/ARRANGEMENT survived/);
  });

  it('reports the right-to-left finding only when the check made one', () => {
    expect(parityFactsFrom(passingCheck)).toContain('Right-to-left runs: preserved');
    const { rtlPass, ...withoutRtl } = passingCheck;
    expect(parityFactsFrom(withoutRtl)).not.toContain('Right-to-left runs');
  });

  it('falls back to judging all five from the images when no export check exists', () => {
    // A design whose PPTX was never checked (an older task, a PNG-only export) must not be told
    // that facts exist which do not, so the stage degrades to what it did before.
    const facts = parityFactsFrom(undefined);
    expect(facts).toContain('judge all five answers from the two images alone');
    expect(facts).not.toMatch(/copyVisibleIdentical to/);
  });
});
