/**
 * Named places in the code where the chaos suite (packages/testkit/chaos) can stop a process and kill
 * it: after a side effect and before its record, which is where a crash is hardest to recover from
 * (architecture programme, PHASE2_DESIGN.md section 6.2).
 *
 * `await chaosPoint('worker.sender.after-telegram', { step })` does nothing unless
 * HAWA_CHAOS_CONTROL_URL is set, which only the chaos compose project does. Then it reports the point
 * to the control server, which answers at once when nobody armed it, or holds the answer until the
 * driver has killed this process (or released it). A control server that cannot be reached, or
 * answers badly, never stops the caller: the point is passed and the work goes on.
 */

const DONE: Promise<void> = Promise.resolve();

/** How long one held point may wait for its release before the work goes on by itself. */
const DEFAULT_HOLD_LIMIT_MS = 15 * 60 * 1000;

let warned = false;

export type ChaosDetail = Record<string, string | number | boolean | null | undefined>;

export function chaosPoint(name: string, detail?: ChaosDetail): Promise<void> {
  const url = process.env.HAWA_CHAOS_CONTROL_URL;
  if (!url) return DONE;
  return reach(url, name, detail);
}

async function reach(url: string, name: string, detail?: ChaosDetail): Promise<void> {
  const limit = Number(process.env.HAWA_CHAOS_HOLD_LIMIT_MS) || DEFAULT_HOLD_LIMIT_MS;
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/reach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ point: name, detail: detail ?? {}, service: process.env.HAWA_CHAOS_SERVICE || null, pid: process.pid }),
      signal: AbortSignal.timeout(limit),
    });
    // The control server answers with headers at once and ends the body on release, writing a
    // newline now and then so no idle timeout ends a long hold early. Reading the body is the wait.
    await res.text();
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn(`[chaos] Point ${name} passed without the control server (${err instanceof Error ? err.message : String(err)})`);
    }
  }
}
