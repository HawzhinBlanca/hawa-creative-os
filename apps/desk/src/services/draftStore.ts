// The brief draft kept in this browser (localStorage) until it is sent.

export interface ActiveDraft {
  title: string;
  copy: string;
  copyCkb?: string;
  clientId?: string;
  designInstructions?: string;
  referenceAssets?: string;
  sourceDocument?: { id: string; sourceSha256: string; extractionSha256: string; confirmed: true };
  savedAt: string;
}

const ACTIVE_DRAFT_KEY = 'hawa_desk_active_draft';

class DraftStoreService {
  // Active in-memory draft
  public saveActiveDraft(draft: Omit<ActiveDraft, 'savedAt'>): void {
    if (typeof window === 'undefined') return;
    const payload: ActiveDraft = {
      ...draft,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(ACTIVE_DRAFT_KEY, JSON.stringify(payload));
  }

  public getActiveDraft(): ActiveDraft | null {
    if (typeof window === 'undefined') return null;
    try {
      const raw = localStorage.getItem(ACTIVE_DRAFT_KEY);
      if (raw === null) return null;
      const draft = JSON.parse(raw) as ActiveDraft | null;
      if (!draft || typeof draft.title !== 'string' || typeof draft.copy !== 'string') throw new Error();
      return draft;
    } catch {
      throw new Error('The saved draft cannot be read. Keep this browser data and ask an operator to recover it before starting a new request.');
    }
  }

  public clearActiveDraft(): void {
    if (typeof window === 'undefined') return;
    localStorage.removeItem(ACTIVE_DRAFT_KEY);
  }
}

export const draftStore = new DraftStoreService();
