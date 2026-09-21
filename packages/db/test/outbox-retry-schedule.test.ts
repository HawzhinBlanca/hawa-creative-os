import { describe, it, expect } from 'vitest';
import {
  outboxRetryDelaySeconds,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_BACKOFF_BASE_SECONDS,
  OUTBOX_BACKOFF_CAP_SECONDS,
} from '../src/repositories/outbox.repository.js';

/** Waits before attempts 2..max, with jitter pinned by `random`. */
const schedule = (random: () => number) =>
  Array.from({ length: OUTBOX_MAX_ATTEMPTS - 1 }, (_, i) => outboxRetryDelaySeconds(i + 1, undefined, undefined, random));
const total = (random: () => number) => schedule(random).reduce((a, b) => a + b, 0);

describe('outbox retry schedule', () => {
  it('outlasts a two-hour outage even with the least jitter, where the old one gave up after 75 seconds', () => {
    // Old schedule: 5 attempts from a 5 s base = 5 + 10 + 20 + 40.
    expect(5 + 10 + 20 + 40).toBe(75);
    expect(total(() => 0)).toBeGreaterThan(2 * 3600);
    expect(total(() => 1)).toBeLessThan(6 * 3600);
  });

  it('doubles from the base and stops at the cap', () => {
    const nominal = schedule(() => 1);
    expect(nominal[0]).toBe(OUTBOX_BACKOFF_BASE_SECONDS);
    expect(nominal[1]).toBe(2 * OUTBOX_BACKOFF_BASE_SECONDS);
    expect(nominal[2]).toBe(4 * OUTBOX_BACKOFF_BASE_SECONDS);
    expect(Math.max(...nominal)).toBe(OUTBOX_BACKOFF_CAP_SECONDS);
    for (let i = 1; i < nominal.length; i++) expect(nominal[i]).toBeGreaterThanOrEqual(nominal[i - 1]);
  });

  it('keeps every delay between half the nominal wait and all of it, so no retry is immediate', () => {
    for (let attempt = 1; attempt <= 40; attempt++) {
      const nominal = outboxRetryDelaySeconds(attempt, undefined, undefined, () => 1);
      for (const r of [0, 0.25, 0.5, 0.999]) {
        const d = outboxRetryDelaySeconds(attempt, undefined, undefined, () => r);
        expect(d).toBeGreaterThanOrEqual(nominal / 2);
        expect(d).toBeLessThanOrEqual(nominal);
        expect(Number.isFinite(d)).toBe(true);
      }
    }
  });

  it('spreads commands that failed together', () => {
    const delays = new Set(Array.from({ length: 50 }, () => Math.round(outboxRetryDelaySeconds(6) * 1000)));
    expect(delays.size).toBeGreaterThan(40);
  });

  it('treats a nonsense attempt number as the first attempt', () => {
    for (const bad of [0, -3, Number.NaN]) {
      const d = outboxRetryDelaySeconds(bad as number, undefined, undefined, () => 1);
      expect(d).toBe(OUTBOX_BACKOFF_BASE_SECONDS);
    }
  });
});
