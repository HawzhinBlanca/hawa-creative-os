/**
 * The action id the Desk sends with an office decision (approve, request a revision, deliver, re-drive):
 * header Idempotency-Key, which Core forwards to RequestLifecycle as `desk:<actionId>` (architecture
 * programme Phase 2, slice 2.4; PHASE2_DESIGN.md section 2.9).
 *
 * One id per press: made when the office presses, kept while that press has no answer Core gave (the
 * request is in flight, the network failed, Core answered 5xx), and sent again when the office presses
 * again, which is then a retry of the same decision. A double click during the press reuses it too. An
 * answer from Core (accepted, or refused with a reason) ends the press: the next one is a new decision.
 */

/** Whether an error is an answer Core gave (a 4xx other than 408 and 429), not a failure to hear one. */
export function isAnsweredFailure(err: unknown): boolean {
  const status = Number((err as { status?: unknown })?.status);
  return Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export class OfficeActionIds {
  private readonly pending = new Map<string, string>();

  constructor(private readonly newId: () => string = () => crypto.randomUUID()) {}

  /** The press's id for this decision (`approve:<task>:<revision>`, …): the pending one, or a new one. */
  idFor(scope: string): string {
    let id = this.pending.get(scope);
    if (!id) {
      id = this.newId();
      this.pending.set(scope, id);
    }
    return id;
  }

  /** Core answered: the press is over. */
  answered(scope: string): void {
    this.pending.delete(scope);
  }

  /**
   * Runs one press of a decision with its id. Core's answer (a result, or a refusal it gave) ends the
   * press; anything else keeps the id for the retry.
   */
  async run<T>(scope: string, send: (actionId: string) => Promise<T>): Promise<T> {
    const id = this.idFor(scope);
    try {
      const result = await send(id);
      this.answered(scope);
      return result;
    } catch (err) {
      if (isAnsweredFailure(err)) this.answered(scope);
      throw err;
    }
  }
}

/** The Desk's one keeper: a retry after a failed press, from any screen, reuses the press's id. */
export const officeActionIds = new OfficeActionIds();
