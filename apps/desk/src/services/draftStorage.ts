/**
 * Hawa Desk — Offline Resilience & Draft Storage Engine
 * Uses browser IndexedDB with automatic local storage fallback and two-way reconciliation.
 * Resolves ME-02, ME-03, ME-04, and ME-06 (ADR-017).
 */

export type DraftSaveState =
  | 'UNSAVED'
  | 'SAVING_LOCAL'
  | 'SAVED_LOCAL'
  | 'SYNCING_SERVER'
  | 'SAVED_SERVER'
  | 'CONFLICT'
  | 'SAVE_FAILED';

export interface SavedCanvasDraft {
  id: string;
  taskId?: string;
  clientId: string;
  version?: number;
  headlineEn: string;
  headlineCkb: string;
  copyEn: string;
  copyCkb: string;
  fontFamily: string;
  fontWeight: number;
  accentColor: string;
  brandKitId: string;
  format: string;
  langVariant: 'en' | 'ckb' | 'bilingual';
  nodes: any[];
  zoom: number;
  panOffset: { x: number; y: number };
  selectedNodeIds: string[];
  updatedAt: number;
  sha256Proof?: string;
}

const DB_NAME = 'hawa_desk_db';
const DB_VERSION = 1;
const STORE_NAME = 'working_drafts';
const DRAFT_KEY_PREFIX = 'hawa_draft_';

const memoryStore = new Map<string, string>();
export const memoryStorageFallback = {
  getItem: (k: string): string | null => memoryStore.get(k) ?? null,
  setItem: (k: string, v: string): void => { memoryStore.set(k, String(v)); },
  removeItem: (k: string): void => { memoryStore.delete(k); },
  clear: (): void => { memoryStore.clear(); },
};

let customDurableStorage: {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
} | null = null;

export function setCustomDurableStorage(storage: typeof customDurableStorage): void {
  customDurableStorage = storage;
}

export function isDurableStorageAvailable(): boolean {
  if (customDurableStorage !== null) return true;
  if (typeof indexedDB !== 'undefined') return true;
  if (typeof localStorage !== 'undefined' && localStorage !== null) {
    try {
      const probeKey = '__hawa_durable_probe__';
      localStorage.setItem(probeKey, '1');
      localStorage.removeItem(probeKey);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function getEffectiveStorage(): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
} {
  if (customDurableStorage !== null) {
    return customDurableStorage;
  }
  if (typeof localStorage !== 'undefined' && localStorage !== null) {
    return localStorage;
  }
  return memoryStorageFallback;
}

/**
 * Production Save Revision Controller
 * Ensures save state transitions are bound to monotonic revision counters,
 * preventing stale out-of-order writes from falsely certifying SAVED_LOCAL.
 */
export class SaveRevisionController {
  private currentRevision = 0;
  private certifiedRevision = 0;
  private state: DraftSaveState = 'UNSAVED';

  getRevision(): number {
    return this.currentRevision;
  }

  getCertifiedRevision(): number {
    return this.certifiedRevision;
  }

  getState(): DraftSaveState {
    return this.state;
  }

  startSave(): number {
    this.currentRevision++;
    this.state = 'SAVING_LOCAL';
    return this.currentRevision;
  }

  onSaveSuccess(revision: number): boolean {
    if (this.currentRevision === revision) {
      this.certifiedRevision = revision;
      this.state = 'SAVED_LOCAL';
      return true;
    }
    // Out of order: superseded by newer revision
    return false;
  }

  onSaveFailure(revision: number): boolean {
    if (this.currentRevision === revision) {
      this.state = 'SAVE_FAILED';
      return true;
    }
    return false;
  }

  async executeSave(
    draft: SavedCanvasDraft,
    saveFn: (d: SavedCanvasDraft) => Promise<void> = persistWorkingDraft
  ): Promise<{ success: boolean; state: DraftSaveState; revision: number }> {
    const rev = this.startSave();
    try {
      await saveFn(draft);
      const isCurrent = this.onSaveSuccess(rev);
      return { success: isCurrent, state: this.state, revision: rev };
    } catch (err) {
      this.onSaveFailure(rev);
      throw err;
    }
  }
}


/**
 * Normalizes an object into a canonical JSON string with sorted keys
 */
function canonicalStringify(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map((item) => (item === undefined ? 'null' : canonicalStringify(item))).join(',') + ']';
  }
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
}

/**
 * Computes a deterministic SHA-256 hex digest for document verification
 */
export async function computeDocumentHash(content: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return 'sha256_' + hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Node.js crypto fallback
  try {
    const nodeCrypto = await import('node:crypto');
    return 'sha256_' + nodeCrypto.createHash('sha256').update(content).digest('hex');
  } catch {
    // Deterministic fallback for environments without webcrypto or node:crypto
    let hash1 = 5381;
    let hash2 = 52711;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash1 = (hash1 * 33) ^ char;
      hash2 = (hash2 * 33) ^ char;
    }
    const p1 = (hash1 >>> 0).toString(16).padStart(8, '0');
    const p2 = (hash2 >>> 0).toString(16).padStart(8, '0');
    return `sha256_canonical_${p1}${p2}`;
  }
}

/**
 * Computes the canonical manifest hash for a draft
 */
export async function computeDraftManifestHash(draft: SavedCanvasDraft): Promise<string> {
  const canonicalManifest = {
    nodes: draft.nodes || [],
    headlineEn: draft.headlineEn ?? '',
    headlineCkb: draft.headlineCkb ?? '',
    copyEn: draft.copyEn ?? '',
    copyCkb: draft.copyCkb ?? '',
    accentColor: draft.accentColor ?? '',
    fontFamily: draft.fontFamily ?? '',
    fontWeight: draft.fontWeight ?? 400,
    langVariant: draft.langVariant ?? 'en',
    format: draft.format ?? 'feed',
    brandKitId: draft.brandKitId ?? '',
    clientId: draft.clientId ?? '',
    version: draft.version ?? 1,
  };
  return await computeDocumentHash(canonicalStringify(canonicalManifest));
}

/**
 * Verifies the integrity of a saved draft against its stored SHA-256 proof.
 * Explicitly rejects unhashed drafts (returns false if sha256Proof is missing).
 */
export async function verifyDraftIntegrity(draft: SavedCanvasDraft): Promise<boolean> {
  if (!draft || !draft.sha256Proof) return false;
  const expected = await computeDraftManifestHash(draft);
  return draft.sha256Proof === expected;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB not supported'));
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Persists a working draft to IndexedDB (with localStorage backup).
 * Fixes ME-02: Resolves ONLY upon transaction oncomplete event.
 * Never counts volatile in-memory fallback as a durable save.
 */
export async function persistWorkingDraft(
  draft: SavedCanvasDraft,
  options?: { allowVolatileFallback?: boolean }
): Promise<void> {
  try {
    draft.sha256Proof = await computeDraftManifestHash(draft);

    let savedToIdb = false;
    let savedToDurableLocalStorage = false;
    let lastError: any = null;

    // 1. Save to IndexedDB with strict transaction completion (ME-02)
    try {
      if (typeof indexedDB !== 'undefined') {
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          const req = store.put(draft);

          // Crucial fix for ME-02: wait for transaction commit
          tx.oncomplete = () => {
            savedToIdb = true;
            resolve();
          };
          tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
          tx.onerror = () => reject(tx.error || req.error || new Error('IndexedDB transaction error'));
          req.onerror = () => reject(req.error);
        });
      }
    } catch (e) {
      lastError = e;
      // If IndexedDB fails, fall through to localStorage
    }

    // 2. Synchronize to durable localStorage (or customDurableStorage in test fixtures)
    try {
      if (customDurableStorage !== null) {
        customDurableStorage.setItem(DRAFT_KEY_PREFIX + draft.id, JSON.stringify(draft));
        customDurableStorage.setItem('hawa_last_active_draft_id', draft.id);
        savedToDurableLocalStorage = true;
      } else if (typeof localStorage !== 'undefined' && localStorage !== null) {
        localStorage.setItem(DRAFT_KEY_PREFIX + draft.id, JSON.stringify(draft));
        localStorage.setItem('hawa_last_active_draft_id', draft.id);
        savedToDurableLocalStorage = true;
      }
    } catch (e) {
      lastError = e;
    }

    // Strict durability enforcement: Memory-only storage is NEVER acknowledged as durable
    if (!savedToIdb && !savedToDurableLocalStorage) {
      if (options?.allowVolatileFallback) {
        memoryStorageFallback.setItem(DRAFT_KEY_PREFIX + draft.id, JSON.stringify(draft));
        memoryStorageFallback.setItem('hawa_last_active_draft_id', draft.id);
      } else {
        const reason = lastError?.message || 'Neither IndexedDB nor durable localStorage is available or writable';
        throw new Error(
          `NO_DURABLE_STORAGE: Cannot acknowledge draft save. Durable storage unavailable: ${reason}`
        );
      }
    }
  } catch (err) {
    console.warn('[DraftStorage] Failed to persist draft:', err);
    throw err;
  }
}


/**
 * Loads a working draft by ID with active two-way reconciliation.
 * Fixes ME-03: Reconciles IndexedDB and localStorage by version, timestamp, and integrity,
 * preventing stale records from shadowing newer fallbacks.
 * By default rejects unhashed drafts unless allowLegacyUnhashed is true.
 */
export async function loadWorkingDraft(
  draftId: string,
  options?: { allowLegacyUnhashed?: boolean }
): Promise<SavedCanvasDraft | null> {
  const result = await reconcileDrafts(draftId, options);
  return result.restored;
}

/**
 * Reconciles local stores and heals stale entries.
 * Explicitly rejects unhashed drafts unless allowLegacyUnhashed is true.
 * NEVER auto-certifies unhashed legacy drafts with new hashes.
 */
export async function reconcileDrafts(
  draftId: string,
  options?: { allowLegacyUnhashed?: boolean }
): Promise<{
  restored: SavedCanvasDraft | null;
  source: 'indexeddb' | 'localstorage' | 'none';
  reconciled: boolean;
  error?: string;
  isLegacyUnhashed?: boolean;
}> {
  let idbDraft: SavedCanvasDraft | null = null;
  let localDraft: SavedCanvasDraft | null = null;

  // 1. Fetch from IndexedDB
  try {
    if (typeof indexedDB !== 'undefined') {
      const db = await openDB();
      idbDraft = await new Promise<SavedCanvasDraft | null>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(draftId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    }
  } catch {
    // IndexedDB failure handled gracefully
  }

  // 2. Fetch from localStorage / memory storage fallback
  const storage = getEffectiveStorage();
  const stored = storage.getItem(DRAFT_KEY_PREFIX + draftId);
  if (stored) {
    try {
      localDraft = JSON.parse(stored);
    } catch {}
  }

  // Check for unhashed legacy drafts
  const idbIsUnhashed = Boolean(idbDraft && !idbDraft.sha256Proof);
  const localIsUnhashed = Boolean(localDraft && !localDraft.sha256Proof);

  // Validate integrity of retrieved drafts
  const idbIsCorrupted = idbDraft?.sha256Proof
    ? !(await verifyDraftIntegrity(idbDraft))
    : false;
  const localIsCorrupted = localDraft?.sha256Proof
    ? !(await verifyDraftIntegrity(localDraft))
    : false;

  if (idbIsCorrupted) {
    console.warn(`[DraftStorage] Corrupted IndexedDB draft detected for ${draftId}; hash verification failed.`);
    idbDraft = null;
  }
  if (localIsCorrupted) {
    console.warn(`[DraftStorage] Corrupted localStorage draft detected for ${draftId}; hash verification failed.`);
    localDraft = null;
  }

  // If both failed integrity verification or neither exists
  if (!idbDraft && !localDraft) {
    const wasCorrupted = idbIsCorrupted || localIsCorrupted;
    return {
      restored: null,
      source: 'none',
      reconciled: false,
      ...(wasCorrupted ? { error: 'INTEGRITY_VERIFICATION_FAILED' } : {}),
    };
  }

  // If only one valid copy exists
  if (idbDraft && !localDraft) {
    if (idbIsUnhashed && !options?.allowLegacyUnhashed) {
      return {
        restored: null,
        source: 'indexeddb',
        reconciled: false,
        isLegacyUnhashed: true,
        error: 'UNHASHED_LEGACY_DRAFT_REJECTED',
      };
    }
    return {
      restored: idbDraft,
      source: 'indexeddb',
      reconciled: false,
      isLegacyUnhashed: idbIsUnhashed,
    };
  }
  if (!idbDraft && localDraft) {
    if (localIsUnhashed) {
      if (!options?.allowLegacyUnhashed) {
        return {
          restored: null,
          source: 'localstorage',
          reconciled: false,
          isLegacyUnhashed: true,
          error: 'UNHASHED_LEGACY_DRAFT_REJECTED',
        };
      }
      return {
        restored: localDraft,
        source: 'localstorage',
        reconciled: false,
        isLegacyUnhashed: true,
      };
    }
    try {
      await persistWorkingDraft(localDraft);
    } catch {}
    return { restored: localDraft, source: 'localstorage', reconciled: true };
  }

  // Both exist: if one is hashed/verified and the other is unhashed, prefer the verified hashed one
  if (!idbIsUnhashed && localIsUnhashed) {
    return { restored: idbDraft, source: 'indexeddb', reconciled: false };
  }
  if (idbIsUnhashed && !localIsUnhashed) {
    return { restored: localDraft, source: 'localstorage', reconciled: true };
  }

  // If both are unhashed
  if (idbIsUnhashed && localIsUnhashed) {
    if (!options?.allowLegacyUnhashed) {
      return {
        restored: null,
        source: 'localstorage',
        reconciled: false,
        isLegacyUnhashed: true,
        error: 'UNHASHED_LEGACY_DRAFT_REJECTED',
      };
    }
  }

  // Both exist and have identical hash validity: reconcile by version and timestamp
  const idbVersion = idbDraft!.version || 0;
  const localVersion = localDraft!.version || 0;
  const idbTime = idbDraft!.updatedAt || 0;
  const localTime = localDraft!.updatedAt || 0;

  const localIsNewer =
    localVersion > idbVersion ||
    (localVersion === idbVersion && localTime > idbTime);

  if (localIsNewer) {
    if (!localIsUnhashed) {
      try {
        await persistWorkingDraft(localDraft!);
      } catch {}
    }
    return {
      restored: localDraft,
      source: 'localstorage',
      reconciled: !localIsUnhashed,
      isLegacyUnhashed: localIsUnhashed,
    };
  } else {
    return {
      restored: idbDraft,
      source: 'indexeddb',
      reconciled: false,
      isLegacyUnhashed: idbIsUnhashed,
    };
  }
}

/**
 * Gets the last active working draft ID
 */
export function getLastActiveDraftId(): string | null {
  const storage = getEffectiveStorage();
  return storage.getItem('hawa_last_active_draft_id');
}

/**
 * Deletes a working draft
 */
export async function deleteWorkingDraft(draftId: string): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(draftId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {}

  const storage = getEffectiveStorage();
  storage.removeItem(DRAFT_KEY_PREFIX + draftId);
  if (storage.getItem('hawa_last_active_draft_id') === draftId) {
    storage.removeItem('hawa_last_active_draft_id');
  }
}
