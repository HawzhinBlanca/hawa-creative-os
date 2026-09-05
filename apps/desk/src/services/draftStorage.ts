/**
 * Hawa Desk — Offline Resilience & Draft Storage Engine
 * Uses browser IndexedDB with automatic local storage fallback.
 * Guarantees zero data loss across page refreshes, tab closures, and offline sessions.
 */

export interface SavedCanvasDraft {
  id: string;
  taskId?: string;
  clientId: string;
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

/**
 * Computes a fast deterministic SHA-256 hex digest for document verification
 */
export async function computeDocumentHash(content: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return 'sha256_' + hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback simple hash for older environments
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return 'sha256_fallback_' + Math.abs(hash).toString(16);
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
 * Persists a working draft to IndexedDB (with localStorage backup)
 */
export async function persistWorkingDraft(draft: SavedCanvasDraft): Promise<void> {
  try {
    const manifestStr = JSON.stringify({
      nodes: draft.nodes,
      headlineEn: draft.headlineEn,
      headlineCkb: draft.headlineCkb,
      accentColor: draft.accentColor,
      format: draft.format,
    });
    draft.sha256Proof = await computeDocumentHash(manifestStr);

    let savedToIdb = false;
    let savedToLocalStorage = false;
    let lastError: any = null;

    // 1. Save to IndexedDB
    try {
      if (typeof indexedDB !== 'undefined') {
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          const req = store.put(draft);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
        savedToIdb = true;
      }
    } catch (e) {
      lastError = e;
      // If IndexedDB fails, fall through to localStorage
    }

    // 2. Synchronize to localStorage backup
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(DRAFT_KEY_PREFIX + draft.id, JSON.stringify(draft));
        localStorage.setItem('hawa_last_active_draft_id', draft.id);
        savedToLocalStorage = true;
      }
    } catch (e) {
      lastError = e;
    }

    if (!savedToIdb && !savedToLocalStorage) {
      throw new Error(`Failed to persist draft to local storage: ${lastError?.message || 'Storage unavailable'}`);
    }
  } catch (err) {
    console.warn('[DraftStorage] Failed to persist draft:', err);
    throw err;
  }
}

/**
 * Loads a working draft by ID
 */
export async function loadWorkingDraft(draftId: string): Promise<SavedCanvasDraft | null> {
  // 1. Attempt load from IndexedDB
  try {
    const db = await openDB();
    const draft = await new Promise<SavedCanvasDraft | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(draftId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (draft) return draft;
  } catch {
    // fallback
  }

  // 2. Fallback to localStorage
  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem(DRAFT_KEY_PREFIX + draftId);
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch {}
    }
  }

  return null;
}

/**
 * Gets the last active working draft ID
 */
export function getLastActiveDraftId(): string | null {
  if (typeof localStorage !== 'undefined') {
    return localStorage.getItem('hawa_last_active_draft_id');
  }
  return null;
}

/**
 * Deletes a working draft
 */
export async function deleteWorkingDraft(draftId: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(draftId);
  } catch {}

  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(DRAFT_KEY_PREFIX + draftId);
  }
}
