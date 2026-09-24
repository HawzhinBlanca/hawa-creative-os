import { describe, expect, it } from 'vitest';
import { nextOfficeMoment } from '../src/office-hours.js';

/**
 * Reminders are delayed self-sends of the RequestLifecycle object (PHASE2_DESIGN.md 2.7): they fire
 * at the next moment inside office hours, 09:00 to 20:00 in Erbil (UTC+3), the window Core's reminder
 * pass keeps today (inOfficeHours, apps/core/src/services/draft-reminders.ts). That window has no
 * weekend, so neither has this.
 */
const erbil = (iso: string) => Date.parse(`${iso}+03:00`);

describe('nextOfficeMoment', () => {
  it('a minute before opening waits for 09:00 the same day', () => {
    expect(nextOfficeMoment(erbil('2026-09-24T08:59:00'))).toBe(erbil('2026-09-24T09:00:00'));
  });

  it('09:00 itself is inside', () => {
    expect(nextOfficeMoment(erbil('2026-09-24T09:00:00'))).toBe(erbil('2026-09-24T09:00:00'));
  });

  it('19:59 is inside, to the millisecond', () => {
    const at = erbil('2026-09-24T19:59:59') + 999;
    expect(nextOfficeMoment(at)).toBe(at);
  });

  it('20:00 is closed: the next morning at 09:00', () => {
    expect(nextOfficeMoment(erbil('2026-09-24T20:00:00'))).toBe(erbil('2026-09-25T09:00:00'));
  });

  it('midnight in Erbil waits for 09:00 that day, not the next', () => {
    expect(nextOfficeMoment(erbil('2026-09-25T00:00:00'))).toBe(erbil('2026-09-25T09:00:00'));
    // 21:30 UTC is 00:30 in Erbil the next calendar day.
    expect(nextOfficeMoment(Date.parse('2026-09-24T21:30:00Z'))).toBe(erbil('2026-09-25T09:00:00'));
  });

  it('Friday is a working day like any other (the office window has no weekend today)', () => {
    // 2026-09-25 is a Friday.
    expect(new Date(erbil('2026-09-25T12:00:00')).getUTCDay()).toBe(5);
    expect(nextOfficeMoment(erbil('2026-09-25T12:00:00'))).toBe(erbil('2026-09-25T12:00:00'));
    expect(nextOfficeMoment(erbil('2026-09-25T21:00:00'))).toBe(erbil('2026-09-26T09:00:00'));
  });

  it('crosses a month and a year end', () => {
    expect(nextOfficeMoment(erbil('2026-09-30T23:10:00'))).toBe(erbil('2026-10-01T09:00:00'));
    expect(nextOfficeMoment(erbil('2026-12-31T20:00:00'))).toBe(erbil('2027-01-01T09:00:00'));
  });

  it('agrees with the office window at every quarter hour of a week, and never goes back in time', () => {
    const start = erbil('2026-09-21T00:00:00');
    for (let t = start; t < start + 7 * 24 * 3600_000; t += 15 * 60_000) {
      const hour = (new Date(t).getUTCHours() + 3) % 24;
      const inside = hour >= 9 && hour < 20;
      const next = nextOfficeMoment(t);
      expect(next === t, new Date(t).toISOString()).toBe(inside);
      expect(next).toBeGreaterThanOrEqual(t);
      expect(next - t).toBeLessThanOrEqual(13 * 3600_000);
      const nextHour = (new Date(next).getUTCHours() + 3) % 24;
      expect(nextHour >= 9 && nextHour < 20).toBe(true);
    }
  });

  it('takes another zone and window', () => {
    // UTC, 08:00 to 17:00.
    expect(nextOfficeMoment(Date.parse('2026-09-24T17:00:00Z'), 0, 8, 17)).toBe(Date.parse('2026-09-25T08:00:00Z'));
    expect(nextOfficeMoment(Date.parse('2026-09-24T07:59:00Z'), 0, 8, 17)).toBe(Date.parse('2026-09-24T08:00:00Z'));
  });

  it('refuses a window that is not one', () => {
    expect(() => nextOfficeMoment(0, 3, 20, 9)).toThrow(/office hours/);
    expect(() => nextOfficeMoment(Number.NaN)).toThrow(/time/);
  });
});
