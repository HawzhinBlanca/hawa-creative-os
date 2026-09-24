import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readTaskDetail } from '../src/services/taskDetail.js';

/**
 * The queue (`GET /tasks`) carries no captured preview; only the task detail (`GET /tasks/:id`) does.
 * The Work screen used to read the detail only after an action, so a studio design that existed was
 * shown as "No captured design yet". The detail is a query of its own (ADR-037): read when a task is
 * selected, and again when a live event names it (test/server-state.test.ts renders that).
 */

const detail = {
  id: 't-1',
  title: 'Studio poster',
  status: 'AWAITING_APPROVAL',
  latestRevision: { id: 'r-1', version: 1, previewUrl: 'data:image/png;base64,iVBORw0KGgo=', sha256: 'abc', format: 'png' },
};

describe('the selected task\'s detail', () => {
  it('is read from GET /tasks/:id', async () => {
    const api = { get: vi.fn().mockResolvedValue(detail) };
    expect(await readTaskDetail(api, 't-1')).toBe(detail);
    expect(api.get).toHaveBeenCalledWith('t-1');
  });

  it('fails when it cannot be read or names another task, so the query layer sees the failure', async () => {
    await expect(readTaskDetail({ get: vi.fn().mockRejectedValue(new Error('HTTP 500')) }, 't-1')).rejects.toThrow('HTTP 500');
    await expect(readTaskDetail({ get: vi.fn().mockResolvedValue({ id: 't-9' }) }, 't-1')).rejects.toThrow(/another task/);
    await expect(readTaskDetail({ get: vi.fn().mockResolvedValue(null) }, 't-1')).rejects.toThrow(/another task/);
  });

  it('is a query of the Work screen, keyed by the selected task and laid over its list entry', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/screens/WorkScreen.tsx'), 'utf8');
    expect(source).toMatch(
      /useQuery\(\{\s*queryKey: queryKeys\.taskDetail\(selectedTaskId\),\s*queryFn: \(\) => readTaskDetail<LiveTask>\(apiClient\.tasks, selectedTaskId\),\s*enabled: Boolean\(selectedTaskId\),/
    );
    expect(source).toMatch(/if \(entry && detail\) return \{ \.\.\.entry, \.\.\.detail \};/);
  });
});
