const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** The next moment in the fixed Erbil 09:00–20:00 window used by legacy reminders. */
export function nextOfficeMoment(atMs: number, zoneOffsetH = 3, open = 9, close = 20): number {
  if (!Number.isFinite(atMs) || !Number.isInteger(zoneOffsetH) ||
      !Number.isInteger(open) || !Number.isInteger(close) ||
      open < 0 || close > 24 || open >= close) {
    throw new RangeError('invalid office moment or hours');
  }
  const offset = zoneOffsetH * HOUR_MS;
  const local = atMs + offset;
  const dayStart = Math.floor(local / DAY_MS) * DAY_MS;
  const start = dayStart + open * HOUR_MS;
  const end = dayStart + close * HOUR_MS;
  if (local < start) return start - offset;
  if (local < end) return atMs;
  return dayStart + DAY_MS + open * HOUR_MS - offset;
}
