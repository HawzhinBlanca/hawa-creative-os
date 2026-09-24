import { apiClient } from '../api/client.js';

export type StreamConnectionStatus = 'connected' | 'connecting' | 'disconnected';

export interface SystemEventPayload<T = any> {
  id: string;
  event: string;
  data: T;
  timestamp: string;
}

/** Every task event Core broadcasts (apps/core/src/app.ts `broadcast('task:…')`). */
export const TASK_EVENTS = [
  'task:created',
  'task:transitioned',
  'task:qa_completed',
  'task:approved',
  'task:requester_approved',
  'task:designer_requested',
  'task:revision_requested',
  'task:revision_created',
  'task:rejected',
  'task:comment_added',
  'task:published',
  'task:publish_reconciliation',
] as const;

export type EventHandler<T = any> = (data: T, rawEvent: MessageEvent) => void;
export type StatusHandler = (status: StreamConnectionStatus) => void;

class EventStreamService {
  private eventSource: EventSource | null = null;
  private status: StreamConnectionStatus = 'disconnected';
  private listeners: Map<string, Set<EventHandler>> = new Map();
  private statusListeners: Set<StatusHandler> = new Set();
  private reconnectTimeout: any = null;
  private reconnectAttempt = 0;
  private maxReconnectDelayMs = 10000;
  private endpoint = '/v1/events/stream';
  private eventCount = 0;
  /** A ticket is being fetched; the stream opens when it arrives. */
  private opening = false;
  /** Bumped by disconnect(), so a ticket that arrives after it opens nothing. */
  private generation = 0;

  // The stream is opened by the session (DeskProviders), once per tab, when the tab is signed in: it
  // needs a ticket, and a ticket needs a session. It used to open itself when this file loaded.

  public getStatus(): StreamConnectionStatus {
    return this.status;
  }

  public getEventCount(): number {
    return this.eventCount;
  }

  public connect(): void {
    if (this.eventSource || this.opening || typeof EventSource === 'undefined') {
      return;
    }

    this.setStatus('connecting');

    // EventSource cannot send a header. The session token used to go in the stream's address, and so
    // into every access log on the way; now a one-use ticket, asked for with the bearer header, opens
    // the stream (ADR-037). Every reconnect asks for a new one.
    this.opening = true;
    const generation = this.generation;
    apiClient.auth.streamTicket().then(
      ({ ticket }) => {
        this.opening = false;
        if (generation === this.generation) this.open(`${this.endpoint}?ticket=${encodeURIComponent(ticket)}`);
      },
      () => {
        this.opening = false;
        if (generation !== this.generation) return;
        this.setStatus('connecting');
        this.scheduleReconnect();
      }
    );
  }

  private open(url: string): void {
    try {
      this.eventSource = new EventSource(url);

      this.eventSource.addEventListener('open', () => {
        this.setStatus('connected');
        this.reconnectAttempt = 0;
      });

      this.eventSource.addEventListener('system:connected', (event: MessageEvent) => {
        this.setStatus('connected');
        this.emit('system:connected', this.safeParse(event.data), event);
      });

      this.eventSource.addEventListener('system:ping', (event: MessageEvent) => {
        this.emit('system:ping', this.safeParse(event.data), event);
      });

      // Domain & task events. An EventSource hears only the names listed here: the task events Core
      // broadcast beyond the six listed before (a requester's approval in Telegram, a new revision,
      // …) never reached the Desk (2026-09-24).
      const domainEvents = [
        ...TASK_EVENTS,
        'webhook:received',
        'dna:updated',
        'asset:ingested',
        'slo:probe_completed',
        'reconciliation:completed',
      ];

      domainEvents.forEach((eventType) => {
        this.eventSource?.addEventListener(eventType, (event: MessageEvent) => {
          this.eventCount++;
          const parsed = this.safeParse(event.data);
          this.emit(eventType, parsed, event);
        });
      });

      this.eventSource.onerror = () => {
        this.setStatus('connecting');
        this.cleanup();
        this.scheduleReconnect();
      };
    } catch (err) {
      console.warn('Failed to initialize EventSource:', err);
      this.setStatus('disconnected');
      this.scheduleReconnect();
    }
  }

  public disconnect(): void {
    this.generation++;
    this.reconnectAttempt = 0; // the next session starts without the last one's backoff
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.cleanup();
    this.setStatus('disconnected');
  }

  private cleanup(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return;

    this.reconnectAttempt++;
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempt - 1), this.maxReconnectDelayMs);

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, delay);
  }

  public on<T = any>(event: string, handler: EventHandler<T>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);

    return () => this.off(event, handler);
  }

  public off<T = any>(event: string, handler: EventHandler<T>): void {
    this.listeners.get(event)?.delete(handler);
  }

  public onStatusChange(handler: StatusHandler): () => void {
    this.statusListeners.add(handler);
    handler(this.status);
    return () => this.statusListeners.delete(handler);
  }

  private setStatus(newStatus: StreamConnectionStatus): void {
    if (this.status !== newStatus) {
      this.status = newStatus;
      this.statusListeners.forEach((fn) => {
        try {
          fn(newStatus);
        } catch (e) {
          console.error('Error in status listener:', e);
        }
      });
    }
  }

  private emit(event: string, data: any, raw: MessageEvent): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.forEach((fn) => {
        try {
          fn(data, raw);
        } catch (err) {
          console.error(`Error in event handler for ${event}:`, err);
        }
      });
    }
  }

  private safeParse(data: string): any {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }
}

export const eventStream = new EventStreamService();
