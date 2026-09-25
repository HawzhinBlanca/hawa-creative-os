/**
 * A small stand-in for a Restate Virtual Object or Workflow context, for handler tests
 * (architecture programme Phase 2, slice 2.3; PHASE2_DESIGN.md section 3, "Handler").
 *
 * It keeps what Restate keeps for one invocation, a journal of what the handler did (state reads and
 * writes, steps, the clock, sleeps, sends and cancellations), and replays it the way Restate does:
 * a new attempt runs the handler again from the start, every entry already journaled answers with
 * its recorded result without doing anything, and only what comes after the last entry runs for
 * real. So a test can "crash" the handler after any recorded entry, replay it, and check that the
 * outcome is the one an uninterrupted run gives: nothing sent twice, no step's side effect lost.
 *
 * What it models, because the handlers depend on it:
 * - a send is committed when it is journaled: it happens once, even when the attempt that journaled
 *   it crashes afterwards (`sends` lists each once, in order);
 * - state written by an attempt is the object's only once the invocation completes (`commit()`);
 *   until then a replay reads what the journal recorded;
 * - a step's action runs again when the process died after it ran and before its result was
 *   journaled (`crashInStep`): Restate's at-least-once, which idempotency keys must make harmless;
 * - a step whose retries are bounded (maxRetryAttempts / maxRetryDuration) gives up with a terminal
 *   error after a few failed attempts, and that failure is journaled; an unbounded one fails the
 *   attempt instead (Restate retries the invocation, or pauses it).
 * - a replay that asks for a different entry than the journal holds is a journal mismatch (what
 *   Restate reports as RT0016), thrown as FakeJournalMismatch.
 *
 * It has no dependency on the Restate SDK: it is passed where a handler expects a context, and it
 * reads send options through their `getOpts()`, as `restate.rpc.sendOpts` builds them.
 */

export type FakeEntry =
  | { kind: 'get'; name: string; value: unknown }
  | { kind: 'set'; name: string; value: unknown }
  | { kind: 'clear'; name: string }
  | { kind: 'run'; name: string; ok: true; value: unknown }
  | { kind: 'run'; name: string; ok: false; message: string }
  | { kind: 'now'; value: number }
  | { kind: 'sleep'; ms: number }
  | { kind: 'send'; send: FakeSend }
  | { kind: 'call'; send: FakeSend; value: unknown }
  | { kind: 'cancel'; invocationId: string };

/** One journaled one-way send (or call) to another handler. */
export interface FakeSend {
  service: string;
  key: string | undefined;
  handler: string;
  arg: unknown;
  delayMs: number;
  idempotencyKey?: string;
  /** The id Restate would give the invocation this starts. */
  invocationId: string;
  /** 'object' | 'workflow' | 'service' */
  target: 'object' | 'workflow' | 'service';
}

/** Thrown when a test's armed crash fires. */
export class FakeCrash extends Error {
  constructor(where: string) {
    super(`[FAKE_CRASH] the process died ${where}`);
    this.name = 'FakeCrash';
  }
}

/** A replay met a different entry than the one journaled (Restate's RT0016). */
export class FakeJournalMismatch extends Error {
  constructor(index: number, expected: string, got: string) {
    super(`journal mismatch at entry ${index}: journaled ${expected}, replay asked for ${got}`);
    this.name = 'FakeJournalMismatch';
  }
}

export interface FakeObjectContextOptions {
  /** The object's (or workflow's) key. */
  key: string;
  /** The object's durable state; shared between invocations of one key. */
  state?: Map<string, unknown>;
  /** The clock `date.now()` reads (the first time; replays read the journal). */
  clock?: () => number;
  /**
   * Builds the error a step gives up with. Pass `(m) => new restate.TerminalError(m)` so the handler
   * under test sees what Restate would hand it.
   */
  terminalError?: (message: string) => Error;
  /** How many attempts a bounded step makes before it gives up (default 3). */
  boundedStepAttempts?: number;
  /** Answers an awaited call (objectClient / workflowClient); by default a call is refused. */
  onCall?: (send: FakeSend) => Promise<unknown> | unknown;
}

type RunOptions = { maxRetryAttempts?: number; maxRetryDuration?: unknown } | undefined;

const describe = (e: FakeEntry): string => {
  switch (e.kind) {
    case 'get': case 'set': case 'clear': case 'run': return `${e.kind}(${e.name})`;
    case 'send': case 'call': return `${e.kind}(${e.send.service}/${e.send.key ?? ''}/${e.send.handler})`;
    case 'cancel': return `cancel(${e.invocationId})`;
    default: return e.kind;
  }
};

const isTerminal = (err: unknown): boolean => {
  const name = String((err as { name?: unknown })?.name ?? '');
  return name.includes('Terminal') || name === 'CancelledError' || name === 'TimeoutError';
};

const optsOf = (raw: unknown): { delay?: unknown; idempotencyKey?: string } => {
  const withGetter = raw as { getOpts?: () => unknown } | undefined;
  const opts = typeof withGetter?.getOpts === 'function' ? withGetter.getOpts() : raw;
  return (opts && typeof opts === 'object' ? opts : {}) as { delay?: unknown; idempotencyKey?: string };
};

const millisOf = (d: unknown): number => {
  if (typeof d === 'number') return d;
  if (d && typeof d === 'object') {
    const x = d as { milliseconds?: number; seconds?: number; minutes?: number; hours?: number; days?: number };
    return (x.milliseconds ?? 0) + (x.seconds ?? 0) * 1000 + (x.minutes ?? 0) * 60_000 + (x.hours ?? 0) * 3_600_000 + (x.days ?? 0) * 86_400_000;
  }
  return 0;
};

export class FakeObjectContext {
  readonly key: string;
  readonly state: Map<string, unknown>;
  /** Every entry the invocation journaled, across its attempts. */
  readonly journal: FakeEntry[] = [];
  /** Sends and calls, each once, in the order they were journaled. */
  readonly sends: FakeSend[] = [];
  /** How often each step's action really ran (a replayed step does not run). */
  readonly stepRuns = new Map<string, number>();
  readonly console: Console = console;
  readonly date = { now: (): Promise<number> => this.now(), toJSON: async (): Promise<string> => new Date(await this.now()).toISOString() };
  attempts = 0;

  private cursor = 0;
  private overlay = new Map<string, { value: unknown } | { cleared: true }>();
  private crashAfterEntry: number | null = null;
  private crashInStepName: string | null = null;
  private sendSeq = 0;
  private readonly options: FakeObjectContextOptions;

  constructor(options: FakeObjectContextOptions) {
    this.options = options;
    this.key = options.key;
    this.state = options.state ?? new Map();
    this.attempts = 1;
  }

  /** Crash once the journal holds `n` entries (1 = right after the first entry). */
  crashAfter(n: number): this {
    this.crashAfterEntry = n;
    return this;
  }

  /** Crash inside the step named `name`, after its action ran and before its result was journaled. */
  crashInStep(name: string): this {
    this.crashInStepName = name;
    return this;
  }

  /** A new attempt of the same invocation: the journal is kept and replayed from its start. */
  replay(): this {
    this.cursor = 0;
    this.overlay = new Map();
    this.crashAfterEntry = null;
    this.crashInStepName = null;
    this.attempts += 1;
    return this;
  }

  /** The invocation completed: what it wrote becomes the object's state. */
  commit(): void {
    for (const [name, v] of this.overlay) {
      if ('cleared' in v) this.state.delete(name);
      else this.state.set(name, structuredClone(v.value));
    }
    this.overlay = new Map();
  }

  request(): { id: string } {
    return { id: `inv_fake_${this.key}` };
  }

  // ------------------------------------------------------------------------------------------
  // The journal

  private next<E extends FakeEntry>(want: E['kind'], label: string): E | null {
    if (this.cursor < this.journal.length) {
      const entry = this.journal[this.cursor];
      const wanted = `${want}${label}`;
      const got = describe(entry);
      if (entry.kind !== want || (label && got !== wanted)) throw new FakeJournalMismatch(this.cursor, got, wanted);
      this.cursor++;
      return entry as E;
    }
    return null;
  }

  private record(entry: FakeEntry): void {
    this.journal.push(entry);
    this.cursor++;
    if (this.crashAfterEntry !== null && this.journal.length >= this.crashAfterEntry) {
      this.crashAfterEntry = null;
      throw new FakeCrash(`after journal entry ${this.journal.length} (${describe(entry)})`);
    }
  }

  // ------------------------------------------------------------------------------------------
  // The context's surface

  async get<T>(name: string): Promise<T | null> {
    const replayed = this.next<Extract<FakeEntry, { kind: 'get' }>>('get', `(${name})`);
    if (replayed) return structuredClone(replayed.value) as T | null;
    const o = this.overlay.get(name);
    const value = o ? ('cleared' in o ? null : o.value) : this.state.has(name) ? this.state.get(name) : null;
    this.record({ kind: 'get', name, value: value === undefined ? null : structuredClone(value) });
    return (value === undefined ? null : structuredClone(value)) as T | null;
  }

  set(name: string, value: unknown): void {
    const replayed = this.next<Extract<FakeEntry, { kind: 'set' }>>('set', `(${name})`);
    // Restate compares a replayed command with the journaled one: a different value is a mismatch.
    if (replayed && JSON.stringify(replayed.value) !== JSON.stringify(value)) {
      throw new FakeJournalMismatch(this.cursor - 1, `set(${name}) = ${JSON.stringify(replayed.value).slice(0, 200)}`, `set(${name}) = ${JSON.stringify(value).slice(0, 200)}`);
    }
    this.overlay.set(name, { value: structuredClone(value) });
    if (!replayed) this.record({ kind: 'set', name, value: structuredClone(value) });
  }

  clear(name: string): void {
    const replayed = this.next('clear', `(${name})`);
    this.overlay.set(name, { cleared: true });
    if (!replayed) this.record({ kind: 'clear', name });
  }

  async run<T>(nameOrAction: string | (() => Promise<T>), actionOrOptions?: (() => Promise<T>) | RunOptions, maybeOptions?: RunOptions): Promise<T> {
    const name = typeof nameOrAction === 'string' ? nameOrAction : 'run';
    const action = (typeof nameOrAction === 'function' ? nameOrAction : actionOrOptions) as () => Promise<T>;
    const options = (typeof nameOrAction === 'function' ? actionOrOptions : maybeOptions) as RunOptions;
    const replayed = this.next<Extract<FakeEntry, { kind: 'run' }>>('run', `(${name})`);
    if (replayed) {
      if (replayed.ok) return structuredClone(replayed.value) as T;
      throw this.terminal(replayed.message);
    }
    const bounded = Boolean(options && (options.maxRetryAttempts !== undefined || options.maxRetryDuration !== undefined));
    const attempts = bounded ? Math.max(1, Math.min(options?.maxRetryAttempts ?? Infinity, this.options.boundedStepAttempts ?? 3)) : 1;
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      this.stepRuns.set(name, (this.stepRuns.get(name) ?? 0) + 1);
      try {
        const value = await action();
        if (this.crashInStepName === name) {
          this.crashInStepName = null;
          throw new FakeCrash(`inside step ${name}, after its action and before its result was journaled`);
        }
        this.record({ kind: 'run', name, ok: true, value: value === undefined ? null : structuredClone(value) });
        return value;
      } catch (err) {
        if (err instanceof FakeCrash) throw err;
        if (isTerminal(err)) {
          const message = err instanceof Error ? err.message : String(err);
          this.record({ kind: 'run', name, ok: false, message });
          throw err;
        }
        // A pause, or an unbounded step's failure: the attempt ends and nothing is journaled.
        if (String((err as { name?: unknown })?.name) === 'PauseError' || !bounded) throw err;
        lastError = err;
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    this.record({ kind: 'run', name, ok: false, message });
    throw this.terminal(message);
  }

  private terminal(message: string): Error {
    if (this.options.terminalError) return this.options.terminalError(message);
    const err = new Error(message);
    err.name = 'TerminalError';
    return err;
  }

  private async now(): Promise<number> {
    const replayed = this.next<Extract<FakeEntry, { kind: 'now' }>>('now', '');
    if (replayed) return replayed.value;
    const value = (this.options.clock ?? Date.now)();
    this.record({ kind: 'now', value });
    return value;
  }

  async sleep(ms: number | Record<string, number>): Promise<void> {
    const replayed = this.next('sleep', '');
    if (!replayed) this.record({ kind: 'sleep', ms: millisOf(ms) });
  }

  cancel(invocationId: string): void {
    const replayed = this.next('cancel', `(${invocationId})`);
    if (!replayed) this.record({ kind: 'cancel', invocationId });
  }

  objectSendClient(def: { name: string }, key: string) {
    return this.sendProxy(def.name, key, 'object');
  }

  workflowSendClient(def: { name: string }, key: string) {
    return this.sendProxy(def.name, key, 'workflow');
  }

  serviceSendClient(def: { name: string }) {
    return this.sendProxy(def.name, undefined, 'service');
  }

  objectClient(def: { name: string }, key: string) {
    return this.callProxy(def.name, key, 'object');
  }

  workflowClient(def: { name: string }, key: string) {
    return this.callProxy(def.name, key, 'workflow');
  }

  private sendOf(service: string, key: string | undefined, target: FakeSend['target'], handler: string, arg: unknown, rawOpts: unknown): FakeSend {
    const opts = optsOf(rawOpts);
    return {
      service, key, handler, target,
      arg: arg === undefined ? null : structuredClone(arg),
      delayMs: millisOf(opts.delay),
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      invocationId: `inv_${service}_${key ?? ''}_${handler}_${this.sendSeq}`,
    };
  }

  private sendProxy(service: string, key: string | undefined, target: FakeSend['target']): Record<string, (arg?: unknown, opts?: unknown) => { invocationId: Promise<string> }> {
    return new Proxy({}, {
      get: (_t, handler) => {
        if (typeof handler !== 'string' || handler === 'then') return undefined;
        return (arg?: unknown, opts?: unknown) => {
          const send = this.sendOf(service, key, target, handler, arg, opts);
          const replayed = this.next<Extract<FakeEntry, { kind: 'send' }>>('send', `(${service}/${key ?? ''}/${handler})`);
          if (replayed) {
            const was = JSON.stringify([replayed.send.arg, replayed.send.idempotencyKey, replayed.send.delayMs]);
            const now = JSON.stringify([send.arg, send.idempotencyKey, send.delayMs]);
            if (was !== now) throw new FakeJournalMismatch(this.cursor - 1, `send ${was.slice(0, 200)}`, `send ${now.slice(0, 200)}`);
            return { invocationId: Promise.resolve(replayed.send.invocationId) };
          }
          this.sendSeq++;
          this.sends.push(send);
          this.record({ kind: 'send', send });
          return { invocationId: Promise.resolve(send.invocationId) };
        };
      },
    });
  }

  private callProxy(service: string, key: string, target: FakeSend['target']): Record<string, (arg?: unknown, opts?: unknown) => Promise<unknown>> {
    return new Proxy({}, {
      get: (_t, handler) => {
        if (typeof handler !== 'string' || handler === 'then') return undefined;
        return async (arg?: unknown, opts?: unknown) => {
          const replayed = this.next<Extract<FakeEntry, { kind: 'call' }>>('call', `(${service}/${key}/${handler})`);
          if (replayed) return structuredClone(replayed.value);
          const send = this.sendOf(service, key, target, handler, arg, opts);
          this.sendSeq++;
          this.sends.push(send);
          if (!this.options.onCall) throw this.terminal(`no answer is configured for a call to ${service}/${key}/${handler}`);
          const value = await this.options.onCall(send);
          this.record({ kind: 'call', send, value: value === undefined ? null : structuredClone(value) });
          return value;
        };
      },
    });
  }
}
