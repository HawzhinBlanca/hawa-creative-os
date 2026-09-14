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

function cleanAttributeValue(v: unknown): unknown {
  if (typeof v === 'string') {
    return redactSecrets(v);
  }
  if (Array.isArray(v)) {
    return v.map(cleanAttributeValue);
  }
  if (v !== null && typeof v === 'object') {
    const res: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      res[k] = cleanAttributeValue(val);
    }
    return res;
  }
  return v;
}

export class OfficeTracer {
  private spans: SpanData[] = [];
  private readonly maxSpans: number;

  constructor(maxSpans = 2000) {
    this.maxSpans = maxSpans;
  }

  startSpan(name: string, traceId?: string, attributes: Record<string, unknown> = {}): {
    spanId: string;
    traceId: string;
    end: (extraAttrs?: Record<string, unknown>) => SpanData;
    addEvent: (eventName: string, eventAttrs?: Record<string, unknown>) => void;
  } {
    const spanId = crypto.randomUUID();
    const resolvedTraceId = traceId || crypto.randomUUID();
    const startTime = Date.now();

    // Redact attributes recursively
    const cleanAttrs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(attributes)) {
      cleanAttrs[k] = cleanAttributeValue(v);
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
        const cleanEventAttrs: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(eventAttrs)) {
          cleanEventAttrs[k] = cleanAttributeValue(v);
        }
        span.events.push({
          name: eventName,
          timestamp: Date.now(),
          attributes: cleanEventAttrs,
        });
      },
      end: (extraAttrs: Record<string, unknown> = {}) => {
        span.endTime = Date.now();
        for (const [k, v] of Object.entries(extraAttrs)) {
          span.attributes[k] = cleanAttributeValue(v);
        }
        this.spans.push(span);
        if (this.spans.length > this.maxSpans) {
          this.spans.shift();
        }
        return span;
      },
    };
  }

  getSpans(): SpanData[] {
    return this.spans;
  }

  clear(): void {
    this.spans = [];
  }
}
