import { describe, expect, it } from 'vitest';
import { normalizeImageRoles } from '../src/services/design-studio/stages/brief.stage.js';
import { requesterDraftNotes } from '../src/services/design-studio/studio-status-note.js';

const reports = Array.from({ length: 6 }, (_, index) => ({ index, role: 'content_photo' as const,
  notes: `Independent observation for image ${index + 1}`, subjectFit: 4, shot: 'classroom_or_interior' as const, quietArea: 'none' as const }));
describe('ADR-171 individual source image reports', () => {
  it('preserves all six independent reports in received order', () => {
    expect(normalizeImageRoles([...reports].reverse(), 6)).toEqual(reports);
  });
  it('refuses missing, duplicated or invented image analysis without inventing an unrelated report', () => {
    for (const invalid of [reports.slice(1), [...reports, reports[0]], [...reports.slice(0, 5), { ...reports[5], index: 99 }]])
      expect(() => normalizeImageRoles(invalid, 6)).toThrow(/image validation/);
  });
  it('exposes one report per image and its actual placement separately', () => {
    const notes = requesterDraftNotes({ run: { winner_candidate_id: 'winner', stages: { brief: { imageRoles: reports, photosSent: 6 } } },
      candidates: [{ id: 'winner', layouts: [{ photos: [{ photoIndex: 0 }, { photoIndex: 2 }] }] }] });
    const individual = notes.filter(n => /^Image \d/.test(n));
    expect(individual).toHaveLength(6);
    expect(individual[0]).toContain('(placed)');
    expect(individual[1]).toContain('(not placed)');
    expect(notes).toContain('⚠️ Only 2 of your 6 photos are on the design.');
    for (const [i, note] of individual.entries()) expect(note).toContain(reports[i].notes);
  });
});
