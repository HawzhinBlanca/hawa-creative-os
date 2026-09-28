import { describe, expect, it } from 'vitest';
import { nextOfficeMoment } from '../src/office-hours.js';

describe('nextOfficeMoment', () => {
  it.each([
    ['08:59', '2026-09-25T05:59:00Z', '2026-09-25T06:00:00Z'],
    ['09:00', '2026-09-25T06:00:00Z', '2026-09-25T06:00:00Z'],
    ['19:59', '2026-09-25T16:59:00Z', '2026-09-25T16:59:00Z'],
    ['20:00', '2026-09-25T17:00:00Z', '2026-09-26T06:00:00Z'],
    ['midnight', '2026-09-25T21:00:00Z', '2026-09-26T06:00:00Z'],
  ])('%s Erbil time', (_label, at, expected) => {
    expect(nextOfficeMoment(Date.parse(at))).toBe(Date.parse(expected));
  });

  it('uses the same window on Friday as the existing reminder policy', () => {
    expect(new Date(nextOfficeMoment(Date.parse('2026-09-25T10:00:00Z'))).toISOString())
      .toBe('2026-09-25T10:00:00.000Z');
  });
});
