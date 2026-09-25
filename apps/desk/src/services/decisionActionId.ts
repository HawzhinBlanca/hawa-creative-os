/**
 * A review click keeps its UUID after a lost response, including a tab reload. The stored key is a
 * digest of the exact action inputs, so revision notes and export selections are not put in browser
 * storage. Core still checks the full request fingerprint and refuses a key reused with new intent.
 */
export interface ReservedDecisionAction {
  actionId: string;
  storageKey: string | null;
}

const pending = new Map<string, ReservedDecisionAction>();
const inFlight = new Map<string, Promise<ReservedDecisionAction>>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function browserStorage(): Storage | null {
  try { return typeof window !== 'undefined' ? window.sessionStorage : null; }
  catch { return null; }
}

async function keyFor(input: string): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return `hawa:decision:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  } catch { return null; }
}

export async function reserveDecisionAction(input: string): Promise<ReservedDecisionAction> {
  const reserved = pending.get(input);
  if (reserved) return reserved;
  const running = inFlight.get(input);
  if (running) return running;
  const work = (async () => {
    const storageKey = await keyFor(input);
    const storage = browserStorage();
    let prior: string | null = null;
    try { if (storage && storageKey) prior = storage.getItem(storageKey); }
    catch { /* Private storage may be unavailable; keep the key in memory for this screen. */ }
    const actionId = prior && UUID.test(prior) ? prior : globalThis.crypto.randomUUID();
    try { if (storage && storageKey) storage.setItem(storageKey, actionId); }
    catch { /* The in-memory reservation still covers retries while the screen is mounted. */ }
    const result = { actionId, storageKey };
    pending.set(input, result);
    return result;
  })();
  inFlight.set(input, work);
  try { return await work; }
  finally { inFlight.delete(input); }
}

export function completeDecisionAction(input: string, reserved: ReservedDecisionAction): void {
  if (pending.get(input)?.actionId === reserved.actionId) pending.delete(input);
  const storage = browserStorage();
  try {
    if (storage && reserved.storageKey && storage.getItem(reserved.storageKey) === reserved.actionId) {
      storage.removeItem(reserved.storageKey);
    }
  } catch { /* A committed decision is read from Core even when browser storage is unavailable. */ }
}
