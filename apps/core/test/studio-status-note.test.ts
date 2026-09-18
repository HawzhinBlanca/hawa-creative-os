import { describe, it, expect } from 'vitest';
import { studioStatusNote } from '../src/services/design-studio/studio-status-note.js';

// Shaped like production run 1cf63524 (task a57a5fdd, 2026-09-18): v3, three concepts,
// no revision needed, layout score 0.979, no imagery, Cinzel over Verdana.
const v3Run = {
  winner_candidate_id: 'w',
  diagnostic: null,
  stages: {
    brief: { completed: true, pipeline: 'v3' },
    revise: { completed: true, pipeline: 'v3', rounds: [], adopted: false, stopReason: 'candidate_already_passes_all_checks' },
  },
};
const layout = { text: [{ fontFamily: 'Cinzel' }, { fontFamily: 'Verdana' }, { fontFamily: 'Cinzel' }] };
const v3Candidates = [
  { id: 'r1', score: '0.84', layouts: [layout], concept: { artStrategy: 'none' } },
  { id: 'w', score: '0.979', layouts: [{ text: [{ fontFamily: 'Georgia' }] }, layout], concept: { artStrategy: 'none' } },
  { id: 'r2', score: '0.95', layouts: [layout], concept: { artStrategy: 'none' } },
];

describe('studio summary line sent with the Canva result', () => {
  it('reports only what the v3 run recorded', () => {
    expect(studioStatusNote({ run: v3Run, candidates: v3Candidates })).toBe(
      'Studio v3 · 3 concepts · no revision needed · layout score 0.98/1 · imagery: none · typeface: Cinzel, Verdana'
    );
  });

  it('never invents a count, a revision round or a judge score the run did not record', () => {
    const note = studioStatusNote({ run: { stages: {} }, candidates: [] });
    expect(note).toBe('Studio v2');
    expect(note).not.toMatch(/8\.7|5 concepts|2 revision|Verdana/);
  });

  it('counts real revision rounds and keeps the v2 judge scale', () => {
    const note = studioStatusNote({
      run: { winner_candidate_id: 'a', stages: JSON.stringify({ revise: { completed: true, rounds: [{}, {}] } }) },
      candidates: [{ id: 'a', score: 7.4, layouts: [JSON.stringify(layout)], concept: JSON.stringify({ artStrategy: 'procedural', motif: 'arcs' }) }],
    });
    expect(note).toBe('Studio v2 · 1 concept · 2 revision rounds · judge 7.4/10 · imagery: procedural (arcs) · typeface: Cinzel, Verdana');
  });

  it('keeps the ladder and parity notes', () => {
    const note = studioStatusNote({ run: { stages: { ladderRung: 3 } }, candidates: [], parityNote: ' · parity: unavailable (timeout)' });
    expect(note).toBe('Studio v2 · Rung 3 fallback · parity: unavailable (timeout)');
  });
});
