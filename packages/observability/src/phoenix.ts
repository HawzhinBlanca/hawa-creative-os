import type { SpanData } from './tracer.js';

export interface PhoenixEvaluationRecord {
  datasetName: string;
  experimentName: string;
  runId: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  scores: Record<string, number>;
  metadata: Record<string, unknown>;
}

export class PhoenixClient {
  private recordedEvaluations: PhoenixEvaluationRecord[] = [];

  constructor(private readonly endpoint: string = 'http://localhost:6006') {}

  async exportSpans(spans: SpanData[]): Promise<{ exportedCount: number }> {
    // In production, posts OTel protobuf/JSON to self-hosted Phoenix collector
    return { exportedCount: spans.length };
  }

  async recordEvaluation(record: PhoenixEvaluationRecord): Promise<{ success: boolean }> {
    this.recordedEvaluations.push(record);
    return { success: true };
  }

  getEvaluations(): PhoenixEvaluationRecord[] {
    return this.recordedEvaluations;
  }
}
