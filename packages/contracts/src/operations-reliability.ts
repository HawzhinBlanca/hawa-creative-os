/** Office availability is unmeasured until independent, durable observations exist. */
export interface UnmeasuredOperationsReliabilityReport {
  schemaVersion: 1;
  evidenceKind: 'unmeasured';
  checkedAt: string;
  availability: {
    targetPercent: 99.5;
    window: 'calendar_month';
    timeZone: 'Asia/Baghdad';
    observedPercent: null;
    sloCompliant: null;
    observationCount: 0;
  };
  latency: { p50Ms: null; p95Ms: null; p99Ms: null; observationCount: 0 };
  nextAction: string;
}

export type ProbeOutcome = 'available' | 'unavailable' | 'unknown';
export type ProbeError = 'none' | 'http_error' | 'network_error' | 'invalid_response' | 'unauthorized' | 'interrupted';
export interface AvailabilityProbeResult {
  outcome: ProbeOutcome;
  error: ProbeError;
  httpStatus: number | null;
  durationMs: number | null;
}
export interface AvailabilityObservation {
  schemaVersion: 1;
  observationId: string;
  monitorId: string;
  targetOrigin: string;
  slotStart: string;
  observedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  probes: { desk: AvailabilityProbeResult; office: AvailabilityProbeResult };
  buildCommit: string | null;
}
export interface AvailabilityObservationReceipt {
  observationId: string;
  monitorId: string;
  slotStart: string;
  payloadSha256: string;
  observationSha256: string;
  recordedAt: string;
  replayed: boolean;
}
export interface ObservedOperationsReliabilityReport {
  schemaVersion: 2;
  evidenceKind: 'independent_probe';
  checkedAt: string;
  basis: 'sampled_office_readiness';
  period: { month: string; startAt: string; endAt: string; throughAt: string; complete: boolean };
  monitor: {
    id: string;
    targetOrigin: string;
    scopeSha256: string;
    intervalSeconds: 60;
    status: 'awaiting_observations' | 'fresh' | 'stale';
    lastObservedAt: string | null;
    lastReceivedAt: string | null;
  };
  availability: {
    targetPercent: 99.5;
    window: 'calendar_month';
    timeZone: 'Asia/Baghdad';
    elapsedSlots: number;
    observationCount: number;
    availableSlots: number;
    unavailableSlots: number;
    unknownSlots: number;
    missingSlots: number;
    coveragePercent: number | null;
    observedPercent: number | null;
    minimumPercent: number | null;
    maximumPercent: number | null;
    sloCompliant: boolean | null;
  };
  latency: {
    scope: 'successful_readiness_probe_round_trip';
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
    observationCount: number;
  };
  recentFailures: Array<Pick<AvailabilityObservation, 'slotStart' | 'probes'>>;
  nextAction: string;
}
export type OperationsReliabilityReport = UnmeasuredOperationsReliabilityReport | ObservedOperationsReliabilityReport;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const iso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const duration = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 60_000;

/** Credentials, query strings, fragments and non-loopback cleartext targets are never accepted. */
export function availabilityTargetOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 300) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname) || value !== url.origin) return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return null;
    return url.origin;
  } catch { return null; }
}
export function parseAvailabilityProbe(value: unknown): AvailabilityProbeResult | null {
  if (!isObject(value) || Object.keys(value).length !== 4 ||
      !['available', 'unavailable', 'unknown'].includes(String(value.outcome)) ||
      !['none', 'http_error', 'network_error', 'invalid_response', 'unauthorized', 'interrupted'].includes(String(value.error)) ||
      !(value.httpStatus === null || Number.isInteger(value.httpStatus) && Number(value.httpStatus) >= 100 && Number(value.httpStatus) <= 599) ||
      !(value.durationMs === null || duration(value.durationMs))) return null;
  if (value.error === 'interrupted') {
    if (value.outcome !== 'unknown' || value.durationMs !== null || value.httpStatus !== null) return null;
  } else {
    if (value.durationMs === null) return null;
    if (value.error === 'none' && (value.outcome !== 'available' || value.httpStatus !== 200)) return null;
    if (value.error === 'unauthorized' && (value.outcome !== 'unknown' || ![401, 403].includes(Number(value.httpStatus)))) return null;
    if (!['none', 'unauthorized'].includes(String(value.error)) && value.outcome !== 'unavailable') return null;
    if (value.error === 'network_error' && value.httpStatus !== null) return null;
    if (value.error === 'http_error' && (value.httpStatus === null || value.httpStatus === 200)) return null;
  }
  return value as unknown as AvailabilityProbeResult;
}
export function parseAvailabilityObservation(value: unknown): AvailabilityObservation | null {
  if (!isObject(value) || Object.keys(value).length !== 10 || value.schemaVersion !== 1 ||
      !uuid(value.observationId) || !uuid(value.monitorId) || !availabilityTargetOrigin(value.targetOrigin) ||
      !iso(value.slotStart) || Date.parse(value.slotStart) % 60_000 !== 0 || !iso(value.observedAt) ||
      Date.parse(value.observedAt) < Date.parse(value.slotStart) || Date.parse(value.observedAt) >= Date.parse(value.slotStart) + 60_000 ||
      !isObject(value.probes) || Object.keys(value.probes).length !== 2 ||
      !(value.buildCommit === null || typeof value.buildCommit === 'string' && /^[a-f0-9]{40}$/.test(value.buildCommit))) return null;
  const desk = parseAvailabilityProbe(value.probes.desk), office = parseAvailabilityProbe(value.probes.office);
  if (!desk || !office) return null;
  const interrupted = desk.error === 'interrupted' || office.error === 'interrupted';
  if (interrupted) {
    if (value.completedAt !== null || value.durationMs !== null) return null;
  } else if (!iso(value.completedAt) || !duration(value.durationMs) ||
      Date.parse(value.completedAt) < Date.parse(value.observedAt) || Date.parse(value.completedAt) > Date.parse(value.observedAt) + 60_000 ||
      value.durationMs < Math.max(desk.durationMs!, office.durationMs!)) return null;
  return { ...value, observationId: value.observationId.toLowerCase(), monitorId: value.monitorId.toLowerCase(), probes: { desk, office } } as AvailabilityObservation;
}
export function availabilityOutcome(observation: Pick<AvailabilityObservation, 'probes'>): ProbeOutcome {
  const outcomes = [observation.probes.desk.outcome, observation.probes.office.outcome];
  return outcomes.includes('unavailable') ? 'unavailable' : outcomes.includes('unknown') ? 'unknown' : 'available';
}

/** Validate evidence relationships as well as shape before the browser renders measurements. */
export function parseOperationsReliabilityReport(value: unknown): OperationsReliabilityReport | null {
  if (!isObject(value) || !iso(value.checkedAt) || typeof value.nextAction !== 'string' || !value.nextAction ||
      !isObject(value.availability) || !isObject(value.latency)) return null;
  const a = value.availability, l = value.latency;
  if (a.targetPercent !== 99.5 || a.window !== 'calendar_month' || a.timeZone !== 'Asia/Baghdad') return null;
  if (value.schemaVersion === 1) return value.evidenceKind === 'unmeasured' && a.observedPercent === null && a.sloCompliant === null &&
    a.observationCount === 0 && l.p50Ms === null && l.p95Ms === null && l.p99Ms === null && l.observationCount === 0 ? value as unknown as UnmeasuredOperationsReliabilityReport : null;
  if (value.schemaVersion !== 2 || value.evidenceKind !== 'independent_probe' || value.basis !== 'sampled_office_readiness' ||
      !isObject(value.period) || !isObject(value.monitor) || !Array.isArray(value.recentFailures)) return null;
  const p = value.period, m = value.monitor;
  if (typeof p.month !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(p.month) || !iso(p.startAt) || !iso(p.endAt) || !iso(p.throughAt) ||
      typeof p.complete !== 'boolean' || !uuid(m.id) || !availabilityTargetOrigin(m.targetOrigin) ||
      typeof m.scopeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.scopeSha256) || m.intervalSeconds !== 60 ||
      !(m.lastObservedAt === null || iso(m.lastObservedAt)) || !(m.lastReceivedAt === null || iso(m.lastReceivedAt))) return null;
  const local = (at: string) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at)).map(part => [part.type, part.value]));
  const first = local(p.startAt), after = local(p.endAt);
  const nextMonth = new Date(Date.UTC(Number(p.month.slice(0, 4)), Number(p.month.slice(5)), 1)).toISOString().slice(0, 7);
  if (`${first.year}-${first.month}` !== p.month || `${after.year}-${after.month}` !== nextMonth ||
      [first, after].some(v => v.day !== '01' || v.hour !== '00' || v.minute !== '00' || v.second !== '00')) return null;
  const start = Date.parse(p.startAt), end = Date.parse(p.endAt), now = Date.parse(value.checkedAt), through = Date.parse(p.throughAt);
  if (start % 60000 || end % 60000 || end <= start || end - start > 32 * 86400000 || p.complete !== (now >= end) ||
      through !== Math.max(start, Math.min(end, Math.floor(now / 60000) * 60000))) return null;
  const expectedStatus = m.lastObservedAt === null ? 'awaiting_observations' : now - Date.parse(m.lastObservedAt) > 120000 ? 'stale' : 'fresh';
  if ((m.lastObservedAt === null) !== (m.lastReceivedAt === null) || m.status !== expectedStatus) return null;
  const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (!count(a.elapsedSlots) || !count(a.observationCount) || !count(a.availableSlots) || !count(a.unavailableSlots) ||
      !count(a.unknownSlots) || !count(a.missingSlots)) return null;
  const elapsed = a.elapsedSlots, good = a.availableSlots, bad = a.unavailableSlots, known = good + bad;
  if (elapsed !== (through - start) / 60000 || a.observationCount > elapsed || known > a.observationCount ||
      a.unknownSlots !== elapsed - known || a.missingSlots !== elapsed - a.observationCount) return null;
  const ratio = (n: number, d: number) => d ? n / d * 100 : null;
  const same = (v: unknown, expected: number | null) => expected === null ? v === null : typeof v === 'number' && Math.abs(v - expected) < 1e-7;
  if (!same(a.coveragePercent, ratio(known, elapsed)) || !same(a.observedPercent, ratio(good, known)) ||
      !same(a.minimumPercent, ratio(good, elapsed)) || !same(a.maximumPercent, ratio(good + a.unknownSlots, elapsed)) ||
      a.sloCompliant !== (p.complete && elapsed > 0 && a.unknownSlots === 0 ? good / elapsed >= .995 : null)) return null;
  if (l.scope !== 'successful_readiness_probe_round_trip' || l.observationCount !== good ||
      (good ? !duration(l.p50Ms) || !duration(l.p95Ms) || !duration(l.p99Ms) || l.p50Ms > l.p95Ms || l.p95Ms > l.p99Ms :
        l.p50Ms !== null || l.p95Ms !== null || l.p99Ms !== null)) return null;
  if (value.recentFailures.length !== Math.min(10, a.observationCount - good)) return null;
  let previous = through;
  for (const f of value.recentFailures) {
    if (!isObject(f) || !iso(f.slotStart) || !isObject(f.probes)) return null;
    const slot = Date.parse(f.slotStart), desk = parseAvailabilityProbe(f.probes.desk), office = parseAvailabilityProbe(f.probes.office);
    if (slot % 60000 || slot < start || slot >= previous || !desk || !office || availabilityOutcome({ probes: { desk, office } }) === 'available') return null;
    previous = slot;
  }
  return value as unknown as ObservedOperationsReliabilityReport;
}
