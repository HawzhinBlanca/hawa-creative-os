import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadTaskDetail, mergeTaskDetail } from '../src/services/taskDetail.js';

/**
 * The queue (`GET /tasks`) carries no captured preview; only the task detail (`GET /tasks/:id`) does.
 * The Work screen used to read the detail only after an action, so a studio design that existed was
 * shown as "No captured design yet". The detail is now read when a task is selected.
 */

const listEntry = { id: 't-1', title: 'Studio poster', status: 'AWAITING_APPROVAL', latestRevision: { id: 'r-1', version: 1 } };
const detail = {
  ...listEntry,
  latestRevision: { id: 'r-1', version: 1, previewUrl: 'data:image/png;base64,iVBORw0KGgo=', sha256: 'abc', format: 'png' },
};

describe('the selected task\'s detail', () => {
  it('is read from GET /tasks/:id and laid over its queue entry only', async () => {
    const api = { get: vi.fn().mockResolvedValue(detail) };
    const loaded = await loadTaskDetail(api, 't-1');
    expect(api.get).toHaveBeenCalledWith('t-1');
    const other = { id: 't-2', title: 'Other', status: 'RECEIVED' };
    const merged = mergeTaskDetail<any>([listEntry, other], loaded);
    expect(merged[0].latestRevision.previewUrl).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(merged[1]).toBe(other);
  });

  it('leaves the queue entry as it is when the detail cannot be read or names another task', async () => {
    expect(await loadTaskDetail({ get: vi.fn().mockRejectedValue(new Error('HTTP 500')) }, 't-1')).toBeNull();
    expect(await loadTaskDetail({ get: vi.fn().mockResolvedValue({ id: 't-9' }) }, 't-1')).toBeNull();
    expect(await loadTaskDetail({ get: vi.fn() }, '')).toBeNull();
    const queue = [listEntry];
    expect(mergeTaskDetail(queue, null)).toBe(queue);
  });

  it('is read by the Work screen whenever the selection changes or the queue reloads', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/screens/WorkScreen.tsx'), 'utf8');
    const effect = /useEffect\(\(\) => \{[^]*?loadTaskDetail<LiveTask>\(apiClient\.tasks, selectedTaskId\)[^]*?mergeTaskDetail\(prev, detail\)[^]*?\}, \[selectedTaskId, queueLoads\]\);/;
    expect(source).toMatch(effect);
    expect(source).toMatch(/setTasks\(items\);\s*\/\/[^\n]*\n\s*setQueueLoads\(\(n\) => n \+ 1\);/);
  });
});
