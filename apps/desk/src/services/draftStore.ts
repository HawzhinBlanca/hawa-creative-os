// IndexedDB & LocalStorage Brief Draft and Offline Queue Manager

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
  savedAt: string;
}

const ACTIVE_DRAFT_KEY = 'hawa_desk_active_draft';
const QUEUED_TASKS_KEY = 'hawa_desk_queued_tasks';

class DraftStoreService {
  // Active in-memory draft
  public saveActiveDraft(draft: { title: string; copy: string }): void {
    if (typeof window === 'undefined') return;
    try {
      const payload: ActiveDraft = {
        title: draft.title,
        copy: draft.copy,
        savedAt: new Date().toISOString(),
      };
      localStorage.setItem(ACTIVE_DRAFT_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn('Failed to save active draft:', e);
    }
  }

  public getActiveDraft(): ActiveDraft | null {
    if (typeof window === 'undefined') return null;
    try {
      const raw = localStorage.getItem(ACTIVE_DRAFT_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  public clearActiveDraft(): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.removeItem(ACTIVE_DRAFT_KEY);
    } catch {}
  }

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
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem(QUEUED_TASKS_KEY);
      if (!raw) return [];
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  public removeQueuedTask(id: string): void {
    const existing = this.getQueuedTasks().filter((t) => t.id !== id);
    this.persistQueued(existing);
  }

  private persistQueued(tasks: QueuedTask[]): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(QUEUED_TASKS_KEY, JSON.stringify(tasks));
    } catch (e) {
      console.warn('Failed to persist queued tasks:', e);
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
          },
          body: JSON.stringify({
            clientId: item.clientId,
            title: item.title,
            priority: 'routine',
            description: item.copy,
            source: { platform: 'hawa_desk', externalId: 'offline-queue' },
          }),
        });

        if (res.ok) {
          const data = await res.json();
          const taskId = data.id;

          // Route & Brief
          await fetch(`/v1/tasks/${taskId}/route`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskRoute: 'standard_generation' }),
          }).catch(() => {});

          await fetch(`/v1/tasks/${taskId}/briefs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              objective: item.title,
              taskRoute: 'standard_generation',
              primaryLanguage: 'ckb',
              direction: 'rtl',
              variants: [{ width: 1080, height: 1350, role: 'feed_post' }],
              exactCopy: item.copy ? [{ role: 'headline', text: item.copy, language: 'ckb', direction: 'rtl', approved: true }] : [],
              requiredAssetRoles: ['logo_primary'],
            }),
          }).catch(() => {});

          // Generate
          await fetch(`/v1/tasks/${taskId}/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          }).catch(() => {});

          this.removeQueuedTask(item.id);
          success++;
        } else {
          failed++;
        }
      } catch (err) {
        console.warn(`Failed to flush task ${item.id}:`, err);
        failed++;
      }
    }

    return { success, failed };
  }
}

export const draftStore = new DraftStoreService();
