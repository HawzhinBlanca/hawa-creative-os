/**
 * One Desk tab for the load test (scripts/load/run.ts), run as its own process.
 *
 * It is the Desk itself, not a replay of it: apps/desk's App, DeskProviders, query cache, API client
 * and event stream, rendered with React into a jsdom document, exactly as main.tsx mounts them (without
 * the service worker and the stylesheet, which make no request to Core). So the tab makes whatever
 * requests the Desk makes: the queue page, the selected task's detail and history, the panels beside
 * it, the sidebar's health line, the session check, the stream ticket and the event stream.
 *
 * What is not the browser's: `fetch` is Node's, with each `/v1/...` address sent to Core through the
 * chaos fakes' proxy and timed until its body is read; `EventSource` is Node's (run with
 * --experimental-eventsource), given the same absolute address. React is its production build, as
 * the Desk's bundle is (so StrictMode does not render twice).
 *
 * The parent (run.ts) forks this file with IPC and sends: `start` (the fakes' Core address and the
 * sign-in key: through IPC, never in the environment or the arguments), `pages` (press Older N times,
 * then Newer back to page 1), `browse` (open N queue cards, one every `everyMs`), `collect`, `stop`.
 * Each request is reported without its query string, so no stream ticket reaches the report.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PageTracker, routeOf, type TabRequest } from './load-stats.js';

// Before React is loaded: the Desk ships React's production build.
process.env.NODE_ENV = 'production';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESK = path.join(ROOT, 'apps', 'desk');
const deskRequire = createRequire(path.join(DESK, 'package.json'));
const deskModule = (relative: string) => import(pathToFileURL(path.join(DESK, 'src', relative)).href);

export type TabCommand =
  | { type: 'start'; tab: string; coreUrl: string; key: string }
  | { type: 'pages'; count: number }
  | { type: 'browse'; count: number; everyMs: number }
  | { type: 'collect' }
  | { type: 'stop' };

export interface StreamStatusChange {
  at: number;
  status: string;
}

export interface TabRecords {
  tab: string;
  requests: TabRequest[];
  streamOpens: number;
  streamErrors: number;
  statusChanges: StreamStatusChange[];
  events: Record<string, number>;
  consoleErrors: string[];
  uncaught: string[];
  /** Time from pressing Older or Newer to the page label showing the page (the office's wait). */
  pageTurnsMs: number[];
}

export type TabReply =
  | { type: 'ready'; tab: string; ms: number; cards: number; label: string }
  | { type: 'done'; tab: string; command: string; detail: string }
  | { type: 'records'; records: TabRecords }
  | { type: 'failed'; tab: string; error: string };

const send = (reply: TabReply) => process.send?.(reply);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(label: string, probe: () => T | null | undefined | false, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
}

/** The parts of React the tab uses; the Desk's own copy, loaded from apps/desk. */
interface ReactLike {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
}
interface ReactDomClientLike {
  createRoot(container: Element): { render(node: unknown): void; unmount(): void };
}

interface Jsdom {
  window: Window & typeof globalThis;
}

/** Puts a jsdom window's DOM on the global object, as a browser tab has it. */
function installDocument(): Window & typeof globalThis {
  const { JSDOM } = deskRequire('jsdom') as { JSDOM: new (html: string, options: Record<string, unknown>) => Jsdom };
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'http://desk.load.invalid/',
    // Visible, with animation frames: TanStack reads document.visibilityState, and a hidden tab polls nothing.
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const g = globalThis as Record<string, unknown>;
  for (const key of [
    'window', 'document', 'localStorage', 'sessionStorage', 'location', 'history', 'HTMLElement', 'HTMLInputElement',
    'HTMLTextAreaElement', 'HTMLButtonElement', 'HTMLAnchorElement', 'HTMLImageElement', 'Element', 'Node', 'Text',
    'DocumentFragment', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver',
    'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'FocusEvent', 'InputEvent',
  ]) {
    Object.defineProperty(g, key, { value: (w as unknown as Record<string, unknown>)[key], configurable: true, writable: true });
  }
  Object.defineProperty(g, 'navigator', { value: w.navigator, configurable: true, writable: true });
  // jsdom has neither; nothing on the Work screen depends on their answers.
  const media = () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
  Object.defineProperty(w, 'matchMedia', { value: media, configurable: true });
  Object.defineProperty(w.HTMLElement.prototype, 'scrollIntoView', { value() {}, configurable: true });
  return w;
}

function main(): void {
  let tab = 'tab';
  let coreUrl = '';
  const records: TabRecords = { tab, requests: [], streamOpens: 0, streamErrors: 0, statusChanges: [], events: {}, consoleErrors: [], uncaught: [], pageTurnsMs: [] };
  const pages = new PageTracker();

  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    records.consoleErrors.push(args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 300));
    if (process.env.HAWA_LOAD_TAB_VERBOSE === '1') originalError(...args);
  };
  process.on('uncaughtException', (err) => records.uncaught.push(String(err?.message ?? err).slice(0, 300)));
  process.on('unhandledRejection', (err) => records.uncaught.push(String((err as Error)?.message ?? err).slice(0, 300)));

  /** Node's fetch, with the Desk's relative `/v1/...` addresses sent to Core and every call timed. */
  const nodeFetch = globalThis.fetch.bind(globalThis);
  const timedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const relative = raw.startsWith('/');
    const url = relative ? `${coreUrl}${raw}` : raw;
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const pathname = relative ? raw : new URL(raw).pathname + new URL(raw).search;
    const route = routeOf(method, pathname);
    const page = route === 'GET /v1/tasks' ? pages.pageOf(pathname) : undefined;
    const at = Date.now();
    const started = performance.now();
    try {
      const res = await nodeFetch(url, init);
      const body = await res.clone().arrayBuffer();
      const ms = Number((performance.now() - started).toFixed(1));
      if (route === 'GET /v1/tasks' && res.ok) {
        try {
          pages.learn(pathname, JSON.parse(Buffer.from(body).toString('utf8')));
        } catch {
          // Not JSON: the request is still recorded, only its successor's page is unknown.
        }
      }
      records.requests.push({ tab, at, method, route, status: res.status, ms, bytes: body.byteLength, ...(page !== undefined ? { page } : {}) });
      return res;
    } catch (err) {
      records.requests.push({ tab, at, method, route, status: 0, ms: Number((performance.now() - started).toFixed(1)), bytes: 0, error: String((err as Error)?.message ?? err).slice(0, 200) });
      throw err;
    }
  };

  let started = false;
  let rootHandle: { unmount(): void } | null = null;
  let streamHandle: { disconnect(): void } | null = null;

  const pageLabel = () => document.querySelector('.queue-pager [aria-live="polite"]')?.textContent ?? '';
  const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  async function turnPage(label: 'Older tasks' | 'Newer tasks', expectPage: number): Promise<void> {
    const b = await waitFor(`${label} enabled`, () => {
      const el = button(label);
      return el && !el.disabled ? el : null;
    });
    const t0 = performance.now();
    b.click();
    await waitFor(`page ${expectPage}`, () => pageLabel().startsWith(`Page ${expectPage} of`));
    records.pageTurnsMs.push(Number((performance.now() - t0).toFixed(1)));
  }

  async function start(command: Extract<TabCommand, { type: 'start' }>): Promise<void> {
    tab = command.tab;
    records.tab = tab;
    coreUrl = command.coreUrl.replace(/\/+$/, '');
    const t0 = Date.now();
    const w = installDocument();
    Object.defineProperty(globalThis, 'fetch', { value: timedFetch, configurable: true, writable: true });
    Object.defineProperty(w, 'fetch', { value: timedFetch, configurable: true, writable: true });

    const NodeEventSource = (globalThis as { EventSource?: typeof EventSource }).EventSource;
    if (!NodeEventSource) throw new Error('EventSource is missing: run this file with node --experimental-eventsource');
    class TabEventSource extends NodeEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        const s = String(url);
        super(s.startsWith('/') ? `${coreUrl}${s}` : s, init);
        records.streamOpens++;
        this.addEventListener('error', () => {
          records.streamErrors++;
        });
      }
    }
    Object.defineProperty(globalThis, 'EventSource', { value: TabEventSource, configurable: true, writable: true });

    const React = deskRequire('react') as ReactLike;
    const ReactDOMClient = deskRequire('react-dom/client') as ReactDomClientLike;
    const { apiClient } = await deskModule('api/client.ts');
    const { eventStream, TASK_EVENTS } = await deskModule('services/eventStream.ts');
    const { App } = await deskModule('App.tsx');
    const { DeskProviders, createDeskRuntime } = await deskModule('DeskProviders.tsx');

    // Signed in as the office does it (SignIn.tsx): the key buys a session token, kept in the tab.
    await apiClient.auth.login({ key: command.key });
    for (const name of TASK_EVENTS as readonly string[]) {
      eventStream.on(name, () => {
        records.events[name] = (records.events[name] || 0) + 1;
      });
    }
    eventStream.onStatusChange((status: string) => records.statusChanges.push({ at: Date.now(), status }));
    streamHandle = eventStream;

    const runtime = createDeskRuntime({ stream: eventStream, doc: document });
    const root = ReactDOMClient.createRoot(document.getElementById('root')!);
    root.render(React.createElement(DeskProviders, { runtime }, React.createElement(App)));
    rootHandle = root;

    const cards = await waitFor('the queue', () => {
      const n = document.querySelectorAll('.queue-task-card').length;
      return n > 0 && eventStream.getStatus() === 'connected' ? n : null;
    }, 120_000);
    started = true;
    send({ type: 'ready', tab, ms: Date.now() - t0, cards, label: pageLabel() });
  }

  process.on('message', (message: TabCommand) => {
    void (async () => {
      try {
        if (message.type === 'start') {
          if (!started) await start(message);
        } else if (message.type === 'pages') {
          for (let p = 2; p <= message.count + 1; p++) await turnPage('Older tasks', p);
          for (let p = message.count; p >= 1; p--) await turnPage('Newer tasks', p);
          send({ type: 'done', tab, command: 'pages', detail: `${message.count} pages older and back; now "${pageLabel()}"` });
        } else if (message.type === 'browse') {
          for (let i = 0; i < message.count; i++) {
            const cards = document.querySelectorAll<HTMLElement>('.queue-task-card');
            if (cards.length) cards[i % cards.length].click();
            await sleep(message.everyMs);
          }
          send({ type: 'done', tab, command: 'browse', detail: `opened ${message.count} tasks` });
        } else if (message.type === 'collect') {
          send({ type: 'records', records });
        } else if (message.type === 'stop') {
          streamHandle?.disconnect();
          rootHandle?.unmount();
          process.exit(0);
        }
      } catch (err) {
        send({ type: 'failed', tab, error: String((err as Error)?.message ?? err).slice(0, 500) });
      }
    })();
  });
  process.on('disconnect', () => process.exit(0));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
