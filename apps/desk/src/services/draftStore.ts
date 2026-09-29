// IndexedDB & LocalStorage Brief Draft and Offline Queue Manager
import { getAuthHeaders } from './auth.js';

export interface QueuedTask {
  id: string;
  title: string;
  copy: string;
  clientId: string;
  enqueuedAt: string;
}

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
const QUEUED_TASKS_KEY = 'hawa_desk_queued_tasks';

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

  private inMemoryQueue: QueuedTask[] = [];

  // Offline Queued Tasks
  public enqueueTask(task: { title: string; copy: string; clientId?: string }): QueuedTask {
    const queued: QueuedTask = {
      id: `queue_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      title: task.title,
      copy: task.copy,
      clientId: task.clientId || 'client-office-1',
      enqueuedAt: new Date().toISOString(),
    };

    const existing = this.getQueuedTasks();
    existing.push(queued);
    this.persistQueued(existing);
    return queued;
  }

  public getQueuedTasks(): QueuedTask[] {
    if (typeof window === 'undefined') return [...this.inMemoryQueue];
    try {
      const raw = localStorage.getItem(QUEUED_TASKS_KEY);
      if (!raw) return [...this.inMemoryQueue];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : [...this.inMemoryQueue];
    } catch {
      return [...this.inMemoryQueue];
    }
  }

  public removeQueuedTask(id: string): void {
    const existing = this.getQueuedTasks().filter((t) => t.id !== id);
    this.persistQueued(existing);
  }

  private persistQueued(tasks: QueuedTask[]): void {
    this.inMemoryQueue = [...tasks];
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(QUEUED_TASKS_KEY, JSON.stringify(tasks));
    } catch (err) {
      // Retain in inMemoryQueue so tasks are never dropped on storage quota exhaustion
    }
  }

  // Flush all queued offline tasks to Core API
  public async flushQueuedTasks(): Promise<{ success: number; failed: number }> {
    const tasks = this.getQueuedTasks();
    if (tasks.length === 0) return { success: 0, failed: 0 };

    let success = 0;
    let failed = 0;

    for (const item of [...tasks]) {
      try {
        const idempotencyKey = `task-desk-offline-${item.id}`;
        const res = await fetch('/v1/tasks', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
            ...getAuthHeaders(),
          },
          body: JSON.stringify({
            clientId: item.clientId,
            title: item.title,
            priority: 'routine',
            description: item.copy,
            source: { platform: 'hawa_desk', externalId: 'offline-queue' },
          }),
        });

        if (!res.ok) {
          failed++;
          continue;
        }

        const data = await res.json();
        const taskId = data.id;

        // Route & Brief
        const routeRes = await fetch(`/v1/tasks/${taskId}/route`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders(),
          },
          body: JSON.stringify({ clientId: item.clientId, taskRoute: 'standard_generation' }),
        });
        if (!routeRes.ok) {
          failed++;
          continue;
        }

        const briefRes = await fetch(`/v1/tasks/${taskId}/briefs`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders(),
          },
          body: JSON.stringify({
            objective: item.title,
            rawRequestText: item.copy || item.title,
            copyBlocks: item.copy ? [{ role: 'headline', text: item.copy }] : [],
            taskRoute: 'standard_generation',
            primaryLanguage: 'ckb',
            direction: 'rtl',
            variants: [{ width: 1080, height: 1350, role: 'feed_post' }],
            exactCopy: item.copy ? [{ role: 'headline', text: item.copy, language: 'ckb', direction: 'rtl', approved: true }] : [],
            requiredAssetRoles: ['logo_primary'],
          }),
        });
        if (!briefRes.ok) {
          failed++;
          continue;
        }

        // Generate
        const genRes = await fetch(`/v1/tasks/${taskId}/generate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders(),
          },
        });
        if (!genRes.ok) {
          failed++;
          continue;
        }

        this.removeQueuedTask(item.id);
        success++;
      } catch (err) {
        console.warn(`Failed to flush task ${item.id}:`, err);
        failed++;
      }
    }

    return { success, failed };
  }
}

export const draftStore = new DraftStoreService();
