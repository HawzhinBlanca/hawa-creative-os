import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { getPendingManualDraft, submitManualTask } from '../src/services/manualTaskIntake.js';
import { draftStore } from '../src/services/draftStore.js';

const draft = { title: 'Invitation', copy: 'Mr. / Ms. / Dr. [Full Name]\nBy Invitation Only', copyCkb: '',
  clientId: 'c1000000-0000-4000-8000-000000000002', designInstructions: 'Navy background. Do not change copy.', referenceAssets: 'approved logo' };
let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { localStorage: storage });
  vi.stubGlobal('navigator', { onLine: true });
});
afterEach(() => vi.unstubAllGlobals());
describe('manual Canva intake', () => {
  it('retains the original request key until a confirmed save has cleared its local draft', async () => {
    draftStore.saveActiveDraft(draft);
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response('{"id":"task-1"}')));
    vi.stubGlobal('fetch', fetcher);
    const remove = localStorage.removeItem;
    localStorage.removeItem = (key: string) => {
      if (key === 'hawa_desk_active_draft') throw new Error('storage denied');
      remove(key);
    };
    await expect(submitManualTask(draft)).rejects.toThrow(/saved.*browser/i);
    expect(getPendingManualDraft()).toEqual(draft);
    localStorage.removeItem = remove;
    await submitManualTask(getPendingManualDraft()!);
    expect(fetcher.mock.calls[0][1].headers['Idempotency-Key']).toBe(fetcher.mock.calls[1][1].headers['Idempotency-Key']);
    expect(draftStore.getActiveDraft()).toBeNull();
    expect(getPendingManualDraft()).toBeNull();
  });
  it('holds damaged retry records with an actionable error and sends no replacement request', async () => {
    values.set('hawa_desk_pending_manual_intake_v1', '{damaged');
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect(() => getPendingManualDraft()).toThrow(/retry record.*cannot be read/i);
    await expect(submitManualTask(draft)).rejects.toThrow(/retry record.*cannot be read/i);
    expect(fetcher).not.toHaveBeenCalled();
    expect(values.get('hawa_desk_pending_manual_intake_v1')).toBe('{damaged');
  });
  it('preserves the complete request and does not call unavailable generation or partial brief endpoints', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'task-1' }), { status: 201 }));
    vi.stubGlobal('fetch', fetcher);
    await submitManualTask(draft);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('/v1/tasks');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ copyEn: draft.copy,
      designInstructions: draft.designInstructions, referenceAssets: draft.referenceAssets, clientId: draft.clientId });
    expect(getPendingManualDraft()).toBeNull();
  });
  it('reuses the exact key and body after a lost response, including after draft recovery', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(new Response('{"id":"task-1"}'));
    vi.stubGlobal('fetch', fetcher);
    await expect(submitManualTask(draft)).rejects.toThrow('unconfirmed');
    expect(getPendingManualDraft()).toEqual(draft);
    await submitManualTask(getPendingManualDraft()!);
    expect(fetcher.mock.calls[0][1].headers['Idempotency-Key']).toBe(fetcher.mock.calls[1][1].headers['Idempotency-Key']);
    expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
  });
  it('retains failed requests and prevents edited retries from becoming duplicates', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(submitManualTask(draft)).rejects.toThrow('503');
    await expect(submitManualTask({ ...draft, clientId: 'different-client' })).rejects.toThrow('Close and reopen');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(getPendingManualDraft()).toEqual(draft);
  });
  it('does not send offline or when durable retry storage is unavailable', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('navigator', { onLine: false });
    await expect(submitManualTask(draft)).rejects.toThrow('offline');
    vi.stubGlobal('navigator', { onLine: true });
    localStorage.setItem = () => { throw new Error('quota'); };
    await expect(submitManualTask(draft)).rejects.toThrow('quota');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('restores instructions, references, both copy fields and client from the local draft', () => {
    draftStore.saveActiveDraft(draft);
    expect(draftStore.getActiveDraft()).toMatchObject(draft);
  });
});

describe('definitive client refusal versus uncertain recovery', () => {
  it('permits correcting a first refused client while retaining the browser draft', async () => {
    draftStore.saveActiveDraft(draft);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })));
    await expect(submitManualTask(draft)).rejects.toThrow('403');
    expect(getPendingManualDraft()).toBeNull();
    expect(draftStore.getActiveDraft()).toMatchObject(draft);
  });
  it('keeps an earlier uncertain request frozen when a later attempt is refused', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('lost'))
      .mockResolvedValueOnce(new Response('{}', { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(submitManualTask(draft)).rejects.toThrow('unconfirmed');
    await expect(submitManualTask(draft)).rejects.toThrow('403');
    expect(getPendingManualDraft()).toEqual(draft);
  });
});

describe('a Google (cookie) session (hunt-3)', () => {
  it('sends the CSRF proof Core requires of a cookie-session write, so the request is not refused with 403', async () => {
    vi.stubGlobal('document', { cookie: 'hawa_csrf=proof-123' });
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
    vi.stubGlobal('window', { localStorage: storage, sessionStorage: storage });
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'task-1' }), { status: 201 }));
    vi.stubGlobal('fetch', fetcher);
    await submitManualTask(draft);
    const headers = fetcher.mock.calls[0][1].headers;
    expect(headers['x-hawa-csrf']).toBe('proof-123');
    expect(headers.Authorization).toBeUndefined();
    expect(fetcher.mock.calls[0][1].credentials).toBe('same-origin');
  });
});
