import { availabilityOutcome, type AvailabilityObservation, type ObservedOperationsReliabilityReport } from '@hawa/contracts';

export interface AvailabilityWindow {
  month: string;
  startAt: string;
  endAt: string;
  now: string;
}
export interface AvailabilityMonitor {
  id: string;
  targetOrigin: string;
  scopeSha256: string;
  latest: { observedAt: string; receivedAt: string } | null;
}

/** Aggregate observed closed minute slots only. Missing time is never fabricated as success. */
export function summarizeAvailability(
  records: readonly AvailabilityObservation[], window: AvailabilityWindow, monitor: AvailabilityMonitor,
): ObservedOperationsReliabilityReport {
  const start = Date.parse(window.startAt), end = Date.parse(window.endAt), now = Date.parse(window.now);
  if (![start, end, now].every(Number.isFinite) || end <= start || start % 60_000 || end % 60_000 || end - start > 32 * 86400_000)
    throw new Error('Invalid availability window');
  const through = Math.max(start, Math.min(end, Math.floor(now / 60_000) * 60_000));
  const elapsed = (through - start) / 60_000, slots = new Map<number, AvailabilityObservation>();
  for (const record of records) {
    const slot = Date.parse(record.slotStart);
    if (record.monitorId !== monitor.id || record.targetOrigin !== monitor.targetOrigin) throw new Error('Availability scope mismatch');
    if (!Number.isFinite(slot) || slot % 60_000) throw new Error('Invalid availability slot');
    if (slot < start || slot >= through) continue;
    if (slots.has(slot)) throw new Error('Duplicate availability slot');
    slots.set(slot, record);
  }
  let available = 0, unavailable = 0;
  const latencies: number[] = [], failures: ObservedOperationsReliabilityReport['recentFailures'] = [];
  for (const record of [...slots.values()].sort((a, b) => b.slotStart.localeCompare(a.slotStart))) {
    const outcome = availabilityOutcome(record);
    if (outcome === 'available') {
      if (record.durationMs === null) throw new Error('Available observation has no timing');
      available++; latencies.push(record.durationMs);
    } else {
      if (outcome === 'unavailable') unavailable++;
      if (failures.length < 10) failures.push({ slotStart: record.slotStart, probes: record.probes });
    }
  }
  latencies.sort((a, b) => a - b);
  const percentile = (p: number) => latencies.length ? latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)] : null;
  const known = available + unavailable, unknown = elapsed - known, complete = now >= end;
  const ratio = (a: number, b: number) => b ? a / b * 100 : null;
  const status = !monitor.latest ? 'awaiting_observations' :
    now - Date.parse(monitor.latest.observedAt) > 120_000 ? 'stale' : 'fresh';
  return {
    schemaVersion: 2, evidenceKind: 'independent_probe', checkedAt: window.now, basis: 'sampled_office_readiness',
    period: { month: window.month, startAt: window.startAt, endAt: window.endAt, throughAt: new Date(through).toISOString(), complete },
    monitor: { id: monitor.id, targetOrigin: monitor.targetOrigin, scopeSha256: monitor.scopeSha256, intervalSeconds: 60,
      status, lastObservedAt: monitor.latest?.observedAt ?? null, lastReceivedAt: monitor.latest?.receivedAt ?? null },
    availability: { targetPercent: 99.5, window: 'calendar_month', timeZone: 'Asia/Baghdad', elapsedSlots: elapsed,
      observationCount: slots.size, availableSlots: available, unavailableSlots: unavailable, unknownSlots: unknown,
      missingSlots: elapsed - slots.size, coveragePercent: ratio(known, elapsed), observedPercent: ratio(available, known),
      minimumPercent: ratio(available, elapsed), maximumPercent: ratio(available + unknown, elapsed),
      sloCompliant: complete && elapsed > 0 && unknown === 0 ? available / elapsed >= .995 : null },
    latency: { scope: 'successful_readiness_probe_round_trip', p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), observationCount: latencies.length },
    recentFailures: failures,
    nextAction: status === 'awaiting_observations' ? 'Start the independently operated collector and verify its first stored observation.' :
      status === 'stale' ? 'Inspect the collector and its durable upload backlog. Missing time remains unknown.' :
        unavailable > 0 ? 'Inspect the observed failures and their timestamps. Restored readiness does not erase past outages.' :
          unknown > 0 ? 'Keep the independent collector running. Earlier missing or interrupted observations cannot be backfilled.' :
            complete ? 'Review the completed monthly readiness evidence alongside live workflow and supported-host acceptance.' :
              'Continue collecting through the month. Current-month readiness remains provisional.',
  };
}
