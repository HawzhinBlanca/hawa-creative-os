/**
 * When a reminder may reach a requester (architecture programme Phase 2, PHASE2_DESIGN.md 2.7).
 *
 * The office answers from 09:00 to 20:00 in Erbil (UTC+3, no daylight saving), every day: the same
 * window Core's reminder pass keeps today (inOfficeHours, apps/core/src/services/draft-reminders.ts).
 * The RequestLifecycle object schedules a reminder as a delayed send to the moment this returns, so
 * nobody is reminded at night. Pure: time comes in as a number (the handler's journaled clock).
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * `atMs` when it falls inside office hours, otherwise the next opening (09:00 local). `open` is
 * inside the window and `close` is not.
 */
export function nextOfficeMoment(atMs: number, zoneOffsetH = 3, open = 9, close = 20): number {
  if (!Number.isFinite(atMs)) throw new Error(`nextOfficeMoment needs a time in milliseconds, not ${atMs}`);
  if (!(open >= 0 && open < close && close <= 24)) throw new Error(`office hours ${open}:00 to ${close}:00 are not a window within one day`);
  const offset = zoneOffsetH * HOUR_MS;
  const local = atMs + offset;
  const dayStart = Math.floor(local / DAY_MS) * DAY_MS;
  const sinceMidnight = local - dayStart;
  if (sinceMidnight >= open * HOUR_MS && sinceMidnight < close * HOUR_MS) return atMs;
  const opening = sinceMidnight < open * HOUR_MS ? dayStart + open * HOUR_MS : dayStart + DAY_MS + open * HOUR_MS;
  return opening - offset;
}
