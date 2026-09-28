import { describe, expect, it } from 'vitest';
import { parseAvailabilityObservation, parseAvailabilityProbe, availabilityOutcome, availabilityTargetOrigin, type AvailabilityObservation } from '@hawa/contracts';
import { summarizeAvailability } from '../src/availability.js';
const monitor = { id: '00000000-0000-4000-a000-000000000020', targetOrigin: 'https://office.example.test', scopeSha256: 'a'.repeat(64), latest: null };
const window = { month: '2026-09', startAt: '2026-08-31T21:00:00.000Z', endAt: '2026-09-30T21:00:00.000Z', now: '2026-08-31T21:03:30.000Z' };
const good = { outcome: 'available', error: 'none', httpStatus: 200, durationMs: 20 } as const;
function observation(minute = 0): AvailabilityObservation {
 const slot = Date.parse(window.startAt) + minute * 60000;
 return { schemaVersion: 1, observationId: '00000000-0000-4000-a000-000000000021', monitorId: monitor.id, targetOrigin: monitor.targetOrigin,
  slotStart: new Date(slot).toISOString(), observedAt: new Date(slot + 100).toISOString(), completedAt: new Date(slot + 200).toISOString(),
  durationMs: 100, probes: { desk: { ...good }, office: { ...good } }, buildCommit: null };
}
describe('readiness evidence and scope', () => {
 it('accepts canonical observations and normalizes UUID casing', () => {
  const v = observation(); expect(parseAvailabilityObservation({ ...v, monitorId: v.monitorId.toUpperCase() })).toEqual(v);
 });
 it('refuses partial, extra, inconsistent and impossible observation fields', () => {
  const v = observation();
  for (const change of [{ extra: true }, { completedAt: null }, { durationMs: 1 }, { slotStart: v.observedAt },
    { observedAt: '2026-08-31T21:01:00.000Z' }, { completedAt: '2026-08-31T21:02:00.000Z' }, { buildCommit: 'unknown' }, { schemaVersion: 2 }])
    expect(parseAvailabilityObservation({ ...v, ...change })).toBeNull();
 });
 it('unknown interruption cannot be presented as a successful timed result', () => {
  const v = observation(); v.probes.office = { outcome: 'unknown', error: 'interrupted', httpStatus: null, durationMs: null };
  expect(parseAvailabilityObservation(v)).toBeNull(); v.completedAt = null; v.durationMs = null;
  expect(parseAvailabilityObservation(v)).toEqual(v); expect(availabilityOutcome(v)).toBe('unknown');
  v.probes.desk = { outcome: 'unavailable', error: 'network_error', httpStatus: null, durationMs: 20 };
  expect(availabilityOutcome(v)).toBe('unavailable');
 });
 it('rejects success on error, missing timings and misleading HTTP combinations', () => {
  for (const v of [{ ...good, httpStatus: 503 }, { ...good, durationMs: null }, { ...good, error: 'network_error' },
    { ...good, outcome: 'unknown' }, { outcome: 'unavailable', error: 'http_error', httpStatus: 200, durationMs: 4 }])
    expect(parseAvailabilityProbe(v)).toBeNull();
 });
 it('accepts HTTPS or exact loopback origins only', () => {
  for (const v of ['http://office.test', 'https://user:secret@office.test', 'https://office.test/path', 'https://office.test?q=x',
    'https://office.test#x', 'file:///tmp', 'https://office.test/']) expect(availabilityTargetOrigin(v)).toBeNull();
  expect(availabilityTargetOrigin('http://127.0.0.1:56081')).toBe('http://127.0.0.1:56081');
 });
});
describe('monthly aggregation', () => {
 it('keeps empty elapsed time unmeasured and excludes the current minute', () => {
  const r = summarizeAvailability([], window, monitor);
  expect(r.availability).toMatchObject({ elapsedSlots: 3, observationCount: 0, unknownSlots: 3, missingSlots: 3,
   coveragePercent: 0, observedPercent: null, minimumPercent: 0, maximumPercent: 100, sloCompliant: null });
  expect(r.latency.p95Ms).toBeNull(); expect(r.monitor.status).toBe('awaiting_observations');
  expect(summarizeAvailability([observation(3)], window, monitor).availability.observationCount).toBe(0);
  expect(summarizeAvailability([], { ...window, now: window.startAt }, monitor).availability.coveragePercent).toBeNull();
 });
 it('separates successes, failures, explicit unknowns and missing observations', () => {
  const failed = observation(1); failed.probes.office = { outcome: 'unavailable', error: 'http_error', httpStatus: 503, durationMs: 30 };
  const unknown = observation(2); unknown.probes.office = { outcome: 'unknown', error: 'unauthorized', httpStatus: 401, durationMs: 30 };
  const r = summarizeAvailability([observation(), failed, unknown], { ...window, now: '2026-08-31T21:04:10.000Z' }, monitor);
  expect(r.availability).toMatchObject({ elapsedSlots: 4, observationCount: 3, availableSlots: 1, unavailableSlots: 1,
   unknownSlots: 2, missingSlots: 1, coveragePercent: 50, observedPercent: 50, minimumPercent: 25, maximumPercent: 75, sloCompliant: null });
  expect(r.latency).toMatchObject({ observationCount: 1, p50Ms: 100, p95Ms: 100 });
  expect(r.recentFailures.map(f => f.slotStart)).toEqual([unknown.slotStart, failed.slotStart]);
 });
 it('refuses duplicate slots and foreign monitor scope', () => {
  expect(() => summarizeAvailability([observation(), observation()], window, monitor)).toThrow('Duplicate');
  expect(() => summarizeAvailability([{ ...observation(), targetOrigin: 'https://another.test' }], window, monitor)).toThrow('scope');
 });
 it('only evaluates a completed fully observed month, including the 99.5% boundary', () => {
  const count = 30 * 1440, rows = Array.from({ length: count }, (_, i) => observation(i));
  const complete = { ...window, now: window.endAt };
  expect(summarizeAvailability(rows, window, monitor).availability.sloCompliant).toBeNull();
  expect(summarizeAvailability(rows, complete, monitor).availability.sloCompliant).toBe(true);
  for (let i = 0; i < count * .005; i++) rows[i].probes.office = { outcome: 'unavailable', error: 'http_error', httpStatus: 503, durationMs: 20 };
  expect(summarizeAvailability(rows, complete, monitor).availability.sloCompliant).toBe(true);
  rows[count - 1].probes.office = { outcome: 'unavailable', error: 'http_error', httpStatus: 503, durationMs: 20 };
  expect(summarizeAvailability(rows, complete, monitor).availability.sloCompliant).toBe(false);
  expect(summarizeAvailability(rows.slice(1), complete, monitor).availability.sloCompliant).toBeNull();
 });
 it('does not let recent receipt of an old backlog imply fresh monitoring', () => {
  const r = summarizeAvailability([], window, { ...monitor, latest: { observedAt: window.startAt, receivedAt: window.now } });
  expect(r.monitor.status).toBe('stale');
  expect(summarizeAvailability([], window, { ...monitor, latest: { observedAt: '2026-08-31T21:03:00.000Z', receivedAt: window.now } }).monitor.status).toBe('fresh');
 });
});

it('the report parser rejects fabricated compliance, percentages, latency and hidden failures', async () => {
 const { parseOperationsReliabilityReport } = await import('@hawa/contracts');
 const r = summarizeAvailability([observation()], window, monitor);
 expect(parseOperationsReliabilityReport(r)).toEqual(r);
 for (const change of [{ sloCompliant: true }, { observedPercent: 99 }, { coveragePercent: 100 }, { missingSlots: 0 }, { unknownSlots: 0 }])
  expect(parseOperationsReliabilityReport({ ...r, availability: { ...r.availability, ...change } })).toBeNull();
 expect(parseOperationsReliabilityReport({ ...r, latency: { ...r.latency, observationCount: 3 } })).toBeNull();
 expect(parseOperationsReliabilityReport({ ...r, period: { ...r.period, complete: true } })).toBeNull();
 expect(parseOperationsReliabilityReport({ ...r, period: { ...r.period, month: '2026-08' } })).toBeNull();
 const failed = observation(); failed.probes.office = { outcome: 'unavailable', error: 'http_error', httpStatus: 503, durationMs: 20 };
 const f = summarizeAvailability([failed], window, monitor);expect(parseOperationsReliabilityReport(f)).toEqual(f);
 expect(parseOperationsReliabilityReport({ ...f, recentFailures: [] })).toBeNull();
});
