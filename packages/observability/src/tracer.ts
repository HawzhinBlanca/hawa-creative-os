import { redactSecrets } from './redactor.js';

export interface SpanData {
  traceId: string;
  spanId: string;
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, unknown>;
  events: Array<{ name: string; timestamp: number; attributes?: Record<string, unknown> }>;
}

export class OfficeTracer {
  private spans: SpanData[] = [];

  startSpan(name: string, traceId?: string, attributes: Record<string, unknown> = {}): {
    spanId: string;
    traceId: string;
    end: (extraAttrs?: Record<string, unknown>) => SpanData;
    addEvent: (eventName: string, eventAttrs?: Record<string, unknown>) => void;
  } {
    const spanId = crypto.randomUUID();
    const resolvedTraceId = traceId || crypto.randomUUID();
    const startTime = Date.now();

    // Redact attributes
    const cleanAttrs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(attributes)) {
      cleanAttrs[k] = typeof v === 'string' ? redactSecrets(v) : v;
    }

    const span: SpanData = {
      traceId: resolvedTraceId,
      spanId,
      name,
      startTime,
      attributes: cleanAttrs,
      events: [],
    };

    return {
      spanId,
      traceId: resolvedTraceId,
      addEvent: (eventName: string, eventAttrs: Record<string, unknown> = {}) => {
        span.events.push({
          name: eventName,
          timestamp: Date.now(),
          attributes: eventAttrs,
        });
      },
      end: (extraAttrs: Record<string, unknown> = {}) => {
        span.endTime = Date.now();
        Object.assign(span.attributes, extraAttrs);
        this.spans.push(span);
        return span;
      },
    };
  }

  getSpans(): SpanData[] {
    return this.spans;
  }
}
