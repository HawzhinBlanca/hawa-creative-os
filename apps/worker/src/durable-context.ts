/**
 * Hawa Creative OS — Worker Durable Workflow Context & Journal
 * Requirements: FR-060, FR-061, FR-062, NFR-001, NFR-003, NFR-014
 *
 * Provides the durable execution context contract compatible with Restate's
 * `restate.WorkflowContext` / `restate.Context` and an in-memory journal for
 * restart/resume traces, deterministic replays, and crash simulation.
 */

export interface WorkflowDurableContext {
  /**
   * Runs an external side effect or computation step, memoizing its output in the journal.
   * If replaying after a crash/restart, returns the cached result without repeating the effect.
   */
  run<T>(name: string, action: () => Promise<T>, options?: { maxRetryAttempts?: number }): Promise<T>;

  /** Stable workflow execution key / identifier */
  readonly key?: string;

  /** Sleep/timer activity within durable workflow */
  sleep?: (millis: number) => Promise<void>;

  /** Observable console for logging without duplicate spam during replay */
  console?: Console;
}

export interface WorkflowJournalRecord {
  stepName: string;
  result: unknown;
  executedAt: string;
  attempt: number;
}

export class DurableStepJournal implements WorkflowDurableContext {
  private journal = new Map<string, WorkflowJournalRecord>();
  private executionTrace: string[] = [];
  private crashBeforeStepName?: string;
  private crashAfterStepName?: string;

  constructor(
    public readonly key: string = `wf_${crypto.randomUUID()}`,
    existingJournal?: Record<string, WorkflowJournalRecord> | Map<string, WorkflowJournalRecord>
  ) {
    if (existingJournal) {
      const entries = existingJournal instanceof Map
        ? existingJournal.entries()
        : Object.entries(existingJournal);
      for (const [k, v] of entries) {
        this.journal.set(k, v);
      }
    }
  }

  /**
   * Injects an intentional crash before executing the given step name.
   */
  setCrashBefore(stepName: string): void {
    this.crashBeforeStepName = stepName;
  }

  /**
   * Injects an intentional crash immediately after executing the step action
   * but before persisting its journal record, simulating an uncommitted side-effect.
   */
  setCrashAfter(stepName: string): void {
    this.crashAfterStepName = stepName;
  }

  /**
   * Returns the chronological step trace (invoked, replayed, completed, crashed).
   */
  getExecutionTrace(): string[] {
    return [...this.executionTrace];
  }

  /**
   * Returns a snapshot of all memoized step records.
   */
  getJournalSnapshot(): Record<string, WorkflowJournalRecord> {
    const out: Record<string, WorkflowJournalRecord> = {};
    for (const [k, v] of this.journal.entries()) {
      out[k] = { ...v };
    }
    return out;
  }

  hasStep(stepName: string): boolean {
    return this.journal.has(stepName);
  }

  getStepResult<T>(stepName: string): T | undefined {
    return this.journal.get(stepName)?.result as T | undefined;
  }

  async run<T>(name: string, action: () => Promise<T>, _options?: { maxRetryAttempts?: number }): Promise<T> {
    this.executionTrace.push(`invoked:${name}`);

    // Replay check: if already journaled in a previous attempt, return cached result!
    if (this.journal.has(name)) {
      this.executionTrace.push(`replayed:${name}`);
      return this.journal.get(name)!.result as T;
    }

    // Check for crash injection before execution
    if (this.crashBeforeStepName === name) {
      this.executionTrace.push(`crashed_before:${name}`);
      throw new Error(`[CRASH_SIMULATION] Process crashed before step '${name}'`);
    }

    // Execute the action
    const result = await action();

    // Check for crash injection after execution (before journal commit)
    if (this.crashAfterStepName === name) {
      this.executionTrace.push(`crashed_after:${name}`);
      throw new Error(`[CRASH_SIMULATION] Process crashed after step '${name}' executed`);
    }

    // Commit to journal
    this.journal.set(name, {
      stepName: name,
      result,
      executedAt: new Date().toISOString(),
      attempt: 1,
    });
    this.executionTrace.push(`completed:${name}`);

    return result;
  }
}
