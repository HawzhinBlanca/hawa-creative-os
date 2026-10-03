import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { defaultFontsDir } from './font-environment.js';
import type { TextShapingJob, TextShapingOutcome } from './text-shaping-job.js';

/**
 * ADR-290 addendum: the Sorani shaping check off the caller's event loop.
 *
 * The check (blocks and raster comparison) is synchronous CPU work, 0.4 to 1.5 s a poster; run in
 * Core's main thread it held HTTP, Telegram replies and Restate handlers for that long on every Canva
 * capture and every Studio QA. Here it runs on worker threads (`text-shaping-worker.ts`), started on
 * first use, one by default. Each call has a deadline counted from the call (5 s by default): a job
 * still queued at the deadline is dropped, a job still running has its worker terminated (sync work
 * cannot be interrupted any other way) and the next job starts a fresh one. A worker that dies answers
 * its job `worker-failed`; nothing here throws or rejects. The queue is bounded: past it a call answers
 * `queue-full` at once rather than wait behind a backlog it would time out in anyway.
 *
 * The job carries paths and bytes only: the fonts folder is the caller's (`defaultFontsDir()` of this
 * package unless the job names one), so the worker reads the same pinned faces the main thread does.
 */
export type TextShapingRun =
  | { ran: true; result: TextShapingOutcome }
  /** `timeout`, `worker-failed`, `queue-full`, `shut-down`, or `Not measured: <why>` for a check that threw. */
  | { ran: false; reason: string };

export interface TextShapingPoolOptions {
  /** Worker threads (default 1). */
  size?: number;
  /** Deadline per call in milliseconds, queueing included (default 5000). */
  timeoutMs?: number;
  /** Calls that may wait for a worker (default 8). */
  maxQueue?: number;
  /** The worker's entry file (tests); by default this package's `text-shaping-worker`. */
  workerFile?: string;
  /** Told when a job times out, a worker fails or the queue is full (a logger). */
  onEvent?: (event: { kind: 'timeout' | 'worker-failed' | 'queue-full'; detail?: string }) => void;
}

interface Pending {
  id: number;
  job: TextShapingJob;
  resolve: (run: TextShapingRun) => void;
  timer: ReturnType<typeof setTimeout>;
  slot?: Slot;
  settled: boolean;
}
interface Slot { worker: Worker; job?: Pending }

/** The worker entry beside this file: the built `.js`, or under a TypeScript runner the `.ts` source. */
function defaultWorkerFile(): string {
  const here = fileURLToPath(import.meta.url);
  const ext = path.extname(here);
  return path.join(path.dirname(here), `text-shaping-worker${ext === '.ts' ? '.ts' : '.js'}`);
}

export class TextShapingPool {
  readonly size: number;
  readonly timeoutMs: number;
  readonly maxQueue: number;
  private readonly workerFile: string;
  private readonly onEvent?: TextShapingPoolOptions['onEvent'];
  private readonly slots: Slot[] = [];
  private readonly queue: Pending[] = [];
  private readonly exits = new Set<Promise<unknown>>();
  private nextId = 1;
  private closed = false;

  constructor(options: TextShapingPoolOptions = {}) {
    this.size = Math.max(1, Math.floor(options.size ?? 1));
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 5000);
    this.maxQueue = Math.max(0, Math.floor(options.maxQueue ?? 8));
    this.workerFile = options.workerFile ?? defaultWorkerFile();
    this.onEvent = options.onEvent;
  }

  /** Worker threads alive now (for tests and health). */
  get threads(): number { return this.slots.length; }

  /** Runs one check on a worker. Never rejects. `timeoutMs` overrides the pool's deadline for this call. */
  run(job: TextShapingJob, options: { timeoutMs?: number } = {}): Promise<TextShapingRun> {
    if (this.closed) return Promise.resolve({ ran: false, reason: 'shut-down' });
    const idle = this.slots.some((s) => !s.job) || this.slots.length < this.size;
    if (!idle && this.queue.length >= this.maxQueue) {
      this.onEvent?.({ kind: 'queue-full', detail: `${this.queue.length} check(s) waiting` });
      return Promise.resolve({ ran: false, reason: 'queue-full' });
    }
    const pinned: TextShapingJob = { ...job, fontsDir: job.fontsDir || defaultFontsDir() };
    return new Promise<TextShapingRun>((resolve) => {
      const pending: Pending = { id: this.nextId++, job: pinned, resolve, settled: false, timer: undefined as never };
      const deadline = Math.max(1, options.timeoutMs ?? this.timeoutMs);
      pending.timer = setTimeout(() => this.expire(pending, deadline), deadline);
      this.queue.push(pending);
      this.pump();
    });
  }

  /** Stops every worker; calls waiting or running answer `shut-down`. Resolves when the threads have exited. */
  async close(): Promise<void> {
    this.closed = true;
    for (const p of this.queue.splice(0)) this.settle(p, { ran: false, reason: 'shut-down' });
    for (const slot of this.slots.splice(0)) {
      if (slot.job) this.settle(slot.job, { ran: false, reason: 'shut-down' });
      slot.job = undefined;
      this.stop(slot);
    }
    await Promise.all([...this.exits]);
  }

  private pump(): void {
    while (this.queue.length && !this.closed) {
      let slot = this.slots.find((s) => !s.job);
      if (!slot && this.slots.length < this.size) {
        try {
          slot = this.spawn();
        } catch (err) {
          const p = this.queue.shift()!;
          this.onEvent?.({ kind: 'worker-failed', detail: err instanceof Error ? err.message : String(err) });
          this.settle(p, { ran: false, reason: 'worker-failed' });
          continue;
        }
      }
      if (!slot) return;
      const p = this.queue.shift()!;
      try {
        slot.worker.postMessage({ id: p.id, job: p.job });
      } catch (err) {
        // A job that cannot be copied to the thread (a value structured clone refuses): the worker is fine.
        this.settle(p, { ran: false, reason: `Not measured: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
      slot.job = p;
      p.slot = slot;
      slot.worker.ref();
    }
  }

  private spawn(): Slot {
    const ts = this.workerFile.endsWith('.ts');
    if (!fs.existsSync(this.workerFile)) throw new Error(`no worker entry at ${this.workerFile}`);
    // From source (the package's own tests) the entry is TypeScript: tsx's loader is registered in the
    // thread first. The built package runs the compiled `.js` with nothing else.
    const worker = ts
      ? new Worker(`const { register } = require(${JSON.stringify(createRequire(import.meta.url).resolve('tsx/esm/api'))}); register();
import(${JSON.stringify(pathToFileURL(this.workerFile).href)});`, { eval: true })
      : new Worker(this.workerFile);
    const slot: Slot = { worker };
    worker.on('message', (m: { id: number; ok: true; result: TextShapingOutcome } | { id: number; ok: false; message: string }) => {
      const p = slot.job;
      if (!p || p.id !== m.id) return;
      slot.job = undefined;
      worker.unref();
      this.settle(p, m.ok ? { ran: true, result: m.result } : { ran: false, reason: `Not measured: ${m.message}` });
      this.pump();
    });
    worker.on('error', (err) => this.lose(slot, err.message));
    worker.on('exit', (code) => this.lose(slot, `the worker exited with code ${code}`));
    // An idle worker does not keep the process alive; a busy one does until it answers.
    worker.unref();
    this.slots.push(slot);
    return slot;
  }

  /** A worker died (an error, an exit): its job answers `worker-failed` and the next job starts another. */
  private lose(slot: Slot, detail: string): void {
    const at = this.slots.indexOf(slot);
    if (at < 0) return;
    this.slots.splice(at, 1);
    const p = slot.job;
    slot.job = undefined;
    this.stop(slot);
    this.onEvent?.({ kind: 'worker-failed', detail });
    if (p) this.settle(p, { ran: false, reason: 'worker-failed' });
    this.pump();
  }

  private expire(p: Pending, deadline: number): void {
    if (p.settled) return;
    const slot = p.slot;
    if (slot) {
      // The check cannot be interrupted: its worker goes, and the next job gets a new one.
      const at = this.slots.indexOf(slot);
      if (at >= 0) this.slots.splice(at, 1);
      slot.job = undefined;
      this.stop(slot);
    } else {
      const at = this.queue.indexOf(p);
      if (at >= 0) this.queue.splice(at, 1);
    }
    this.onEvent?.({ kind: 'timeout', detail: `${slot ? 'running' : 'queued'} past ${deadline} ms` });
    this.settle(p, { ran: false, reason: 'timeout' });
    this.pump();
  }

  private stop(slot: Slot): void {
    const exit = slot.worker.terminate().catch(() => undefined);
    this.exits.add(exit);
    void exit.finally(() => this.exits.delete(exit));
  }

  private settle(p: Pending, run: TextShapingRun): void {
    if (p.settled) return;
    p.settled = true;
    clearTimeout(p.timer);
    p.resolve(run);
  }
}

/** Pool settings from the environment: HAWA_TEXT_SHAPING_WORKERS, HAWA_TEXT_SHAPING_TIMEOUT_MS, HAWA_TEXT_SHAPING_QUEUE. */
export function textShapingPoolOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): TextShapingPoolOptions {
  const int = (name: string, min: number, max: number): number | undefined => {
    const n = Number(env[name]);
    return env[name]?.trim() && Number.isInteger(n) && n >= min && n <= max ? n : undefined;
  };
  const size = int('HAWA_TEXT_SHAPING_WORKERS', 1, 8), timeoutMs = int('HAWA_TEXT_SHAPING_TIMEOUT_MS', 100, 120_000), maxQueue = int('HAWA_TEXT_SHAPING_QUEUE', 0, 256);
  return { ...(size ? { size } : {}), ...(timeoutMs ? { timeoutMs } : {}), ...(maxQueue !== undefined ? { maxQueue } : {}) };
}

let shared: TextShapingPool | undefined;
let sharedEvents: TextShapingPoolOptions['onEvent'];

/** The process's pool, created on first use from the environment. `onEvent` (a logger) applies to it from then on. */
export function sharedTextShapingPool(onEvent?: TextShapingPoolOptions['onEvent']): TextShapingPool {
  if (onEvent) sharedEvents = onEvent;
  return (shared ??= new TextShapingPool({ ...textShapingPoolOptionsFromEnv(), onEvent: (e) => sharedEvents?.(e) }));
}

/** Stops the process's pool (a shutdown hook); a later call starts a new one. */
export async function closeSharedTextShapingPool(): Promise<void> {
  const pool = shared;
  shared = undefined;
  await pool?.close();
}
