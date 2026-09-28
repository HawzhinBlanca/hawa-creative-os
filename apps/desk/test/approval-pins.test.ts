import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../src/api/client.js';
import { approvalBlocker, defaultPins, describeExport, togglePin, type StoredExport } from '../src/services/approvalPins.js';

const stored: StoredExport[] = [
  { id: '11111111-1111-4111-8111-111111111111', format: 'png', sha256: 'a'.repeat(64), byte_size: '48213' },
  { id: '22222222-2222-4222-8222-222222222222', format: 'pdf', sha256: 'b'.repeat(64), byte_size: 90112 },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the approval pins stored exports the reviewer selects', () => {
  it('preselects the newest capture, and describes each export from what Core stored', () => {
    expect(defaultPins(stored)).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect(defaultPins([])).toEqual([]);
    expect(describeExport(stored[0])).toBe(`PNG · 48,213 bytes · SHA-256 ${'a'.repeat(12)}…`);
    expect(describeExport({ ...stored[1], byte_size: 'n/a' })).toBe(`PDF · size not reported · SHA-256 ${'b'.repeat(12)}…`);
    expect(togglePin(['x'], 'y')).toEqual(['x', 'y']);
    expect(togglePin(['x', 'y'], 'x')).toEqual(['y']);
  });

  it('cannot be confirmed without a stored, selected export', () => {
    expect(approvalBlocker('loading', [], [])).toBe('Reading the stored exports…');
    expect(approvalBlocker('unknown', [], [])).toBe('The stored exports could not be read, so there is nothing to pin.');
    expect(approvalBlocker('known', [], [])).toMatch(/^No export is stored for this task\. Capture for Review first/);
    expect(approvalBlocker('known', stored, [])).toBe('Select at least one export: delivery sends exactly the selected files.');
    expect(approvalBlocker('known', stored, [stored[0].id])).toBeNull();
  });

  it('preselects the exact QA checked deck and refuses an image-only Canva approval', () => {
    const checked = { id: '33333333-3333-4333-8333-333333333333', format: 'pptx', sha256: 'c'.repeat(64), byte_size: 51200, capture_version: '200' };
    const exports = [{ ...stored[0], capture_version: '200' }, { ...stored[1], capture_version: '199' }, checked];
    expect(defaultPins(exports, checked.id)).toEqual([stored[0].id, checked.id]);
    expect(defaultPins(exports, checked.id, '200')).toEqual([stored[0].id, checked.id]);
    expect(defaultPins([{ ...stored[0], capture_version: '199' }, checked], checked.id, '200')).toEqual([checked.id]);
    expect(approvalBlocker('known', exports, [stored[0].id], checked.id)).toMatch(/PPTX checked by QA/);
    expect(approvalBlocker('known', exports, [stored[0].id, checked.id], checked.id)).toBeNull();
    expect(approvalBlocker('known', exports, [stored[1].id, checked.id], checked.id, '200')).toMatch(/Canva version checked by QA/);
    expect(approvalBlocker('known', stored, [stored[0].id], checked.id)).toMatch(/missing/);
    expect(approvalBlocker('known', stored, [stored[0].id], null)).toMatch(/no linked Canva capture/);
  });

  it('sends the pinned export ids with the approval, under the operator token', async () => {
    vi.stubGlobal('window', {
      localStorage: { getItem: (k: string) => (k === 'hawa_operator_token' ? 'reviewer-token' : null) },
      sessionStorage: { getItem: () => null },
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ decisionId: 'd1' }), { status: 201, headers: { 'content-type': 'application/json' } })
    );
    vi.stubGlobal('fetch', fetchMock);

    const actionId = '33333333-3333-4333-8333-333333333333';
    await apiClient.tasks.recordDecision('task-1', 'rev-1', { action: 'approve', pinnedExportIds: [stored[0].id] }, actionId);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/v1/tasks/task-1/revisions/rev-1/decisions');
    expect(new Headers(init!.headers as Record<string, string>).get('Authorization')).toBe('Bearer reviewer-token');
    expect(new Headers(init!.headers as Record<string, string>).get('Idempotency-Key')).toBe(actionId);
    expect(JSON.parse(String(init!.body))).toEqual({ action: 'approve', pinnedExportIds: [stored[0].id] });
  });
});
