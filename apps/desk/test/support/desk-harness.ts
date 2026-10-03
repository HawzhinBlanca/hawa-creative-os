import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { vi } from 'vitest';
import type { StreamConnectionStatus } from '../../src/services/eventStream.js';
import type { LiveEventSource } from '../../src/services/liveUpdates.js';

/**
 * A Desk in jsdom for the query-layer tests (ADR-037): a fake event stream, a fake Core behind
 * `fetch`, and React rendered for real. Test files that use it start with `// @vitest-environment jsdom`.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** The tab's event stream, driven by the test. */
export class FakeStream implements LiveEventSource {
  private handlers = new Map<string, Set<(data: any) => void>>();
  private statusHandlers = new Set<(status: StreamConnectionStatus) => void>();
  status: StreamConnectionStatus;
  connects = 0;
  disconnects = 0;
  constructor(status: StreamConnectionStatus = 'connected') {
    this.status = status;
  }
  on(event: string, handler: (data: any) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => {
      this.handlers.get(event)!.delete(handler);
    };
  }
  onStatusChange(handler: (status: StreamConnectionStatus) => void) {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }
  getStatus() {
    return this.status;
  }
  connect() {
    this.connects++;
  }
  disconnect() {
    this.disconnects++;
  }
  setStatus(status: StreamConnectionStatus) {
    this.status = status;
    this.statusHandlers.forEach((h) => h(status));
  }
  emit(event: string, data: any) {
    this.handlers.get(event)?.forEach((h) => h(data));
  }
  listeners(event: string) {
    return this.handlers.get(event)?.size ?? 0;
  }
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export interface FetchCall {
  method: string;
  path: string;
  search: URLSearchParams;
  body?: any;
  headers: Headers;
}

/** Answers every request with `route` (a 404 problem when it returns nothing) and records it. */
export function stubCore(route: (call: FetchCall) => Response | Promise<Response> | undefined) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://desk.test');
      const call: FetchCall = {
        method: (init?.method || 'GET').toUpperCase(),
        path: url.pathname,
        search: url.searchParams,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        headers: new Headers(init?.headers),
      };
      calls.push(call);
      return (await route(call)) ?? json({ title: 'Not Found', status: 404 }, 404);
    })
  );
  return calls;
}

/** GET /v1/tasks (the list), not /v1/tasks/:id. */
export const isListRead = (c: FetchCall) => c.method === 'GET' && c.path === '/v1/tasks';

export async function mount(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return {
    container,
    text: () => container.textContent || '',
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** Lets fake time pass inside act, so React renders what the timers and fetches produced. */
export async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Settles pending promises and renders (no time passes). */
export async function flush() {
  await advance(0);
}

export async function click(el: Element | null | undefined) {
  if (!el) throw new Error('nothing to click');
  await act(async () => {
    (el as HTMLElement).click();
  });
}

export function byText(container: HTMLElement, selector: string, text: string | RegExp): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>(selector)].find((el) =>
    typeof text === 'string' ? (el.textContent || '').includes(text) : text.test(el.textContent || '')
  );
}
