/** Office availability is unmeasured until independent, durable observations exist. */
export interface OperationsReliabilityReport {
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
