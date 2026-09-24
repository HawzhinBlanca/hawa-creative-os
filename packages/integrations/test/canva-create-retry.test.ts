import { describe, it, expect, vi } from 'vitest';
import { CanvaConnectClient, CanvaHttpError } from '../src/canva-connect-client.js';

// Chaos baseline R1.K9 (2026-09-24): one Canva 503 on POST /exports ended the draft as
// CANVA_PREVIEW_FAILED with no second attempt. Canva documents no idempotency key for its create
// calls, so what may be repeated depends on what a duplicate would cost (see the client's comment).
const exportJob = { job: { id: 'export-1', status: 'in_progress' } };
const importJob = { job: { id: 'import-1', status: 'in_progress' } };
const design = { design: { id: 'DAtest1', created_at: 1, updated_at: 1, urls: { edit_url: 'https://www.canva.com/design/DAtest1/edit', view_url: 'https://www.canva.com/design/DAtest1/view' } } };
const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
/** A fetch failure raised before any connection existed: the request never left. */
const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
/** A connection that dropped after the request was sent: Canva may have acted on it. */
const reset = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
const client = (fetcher: unknown, extra: Record<string, unknown> = {}) =>
  new CanvaConnectClient({ accessToken: 'token', customFetch: fetcher as typeof fetch, readRetryDelaysMs: [1, 1], createRetryDelaysMs: [1, 1, 1, 1], ...extra });
const posts = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').length;

describe('Canva create calls under transient failures', () => {
  it('asks again after 503 three times and a 429, and returns the export job (chaos R1.K9)', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply(503)).mockResolvedValueOnce(reply(503)).mockResolvedValueOnce(reply(503))
      .mockResolvedValueOnce(reply(429, {}, { 'Retry-After': '0' }))
      .mockResolvedValueOnce(reply(200, exportJob));
    await expect(client(fetcher).createExportJob('DAtest1', 'png')).resolves.toMatchObject({ job: { id: 'export-1' } });
    expect(posts(fetcher)).toBe(5);
  });

  it('asks again after a network error raised before the request left', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(refused()).mockResolvedValueOnce(reply(200, exportJob));
    await expect(client(fetcher).createExportJob('DAtest1', 'png')).resolves.toMatchObject({ job: { id: 'export-1' } });
    expect(posts(fetcher)).toBe(2);
  });

  it('is bounded: an export refused every time is an HTTP error after five attempts', async () => {
    const fetcher = vi.fn().mockImplementation(async () => reply(503));
    await expect(client(fetcher).createExportJob('DAtest1', 'png')).rejects.toBeInstanceOf(CanvaHttpError);
    expect(posts(fetcher)).toBe(5);
  });

  it('never repeats a refusal of the request itself (4xx other than 429)', async () => {
    const fetcher = vi.fn().mockImplementation(async () => reply(400));
    await expect(client(fetcher).createExportJob('DAtest1', 'png')).rejects.toMatchObject({ status: 400 });
    expect(posts(fetcher)).toBe(1);
  });

  it('does not repeat an export whose connection dropped after it was sent: that outcome is left to reconcile', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(reset()).mockResolvedValueOnce(reply(200, exportJob));
    await expect(client(fetcher).createExportJob('DAtest1', 'png')).rejects.toThrow('fetch failed');
    expect(posts(fetcher)).toBe(1);
  });

  it('waits as long as Retry-After says, and gives up at once when Canva asks for longer than the bound', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn().mockResolvedValueOnce(reply(429, {}, { 'Retry-After': '2' })).mockResolvedValueOnce(reply(200, exportJob));
      const pending = client(fetcher, { createRetryDelaysMs: [1] }).createExportJob('DAtest1', 'png');
      await vi.advanceTimersByTimeAsync(1500);
      expect(posts(fetcher)).toBe(1);
      await vi.advanceTimersByTimeAsync(600);
      await expect(pending).resolves.toMatchObject({ job: { id: 'export-1' } });
      expect(posts(fetcher)).toBe(2);

      const tooLong = vi.fn().mockResolvedValue(reply(429, {}, { 'Retry-After': '3600' }));
      await expect(client(tooLong).createExportJob('DAtest1', 'png')).rejects.toMatchObject({ status: 429 });
      expect(posts(tooLong)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('repeats an import or a new design only when Canva cannot have made it: 429 or never sent, not 5xx', async () => {
    const bytes = new Uint8Array(64);
    const limited = vi.fn().mockResolvedValueOnce(reply(429, {}, { 'Retry-After': '0' })).mockRejectedValueOnce(refused()).mockResolvedValueOnce(reply(200, importJob));
    await expect(client(limited).createImportJob(bytes, 'Deck')).resolves.toMatchObject({ job: { id: 'import-1' } });
    expect(posts(limited)).toBe(3);

    // A 5xx may come from a gateway after Canva made the design; a second import would be a second
    // design in the owner's Canva account.
    const down = vi.fn().mockResolvedValueOnce(reply(503)).mockResolvedValueOnce(reply(200, importJob));
    await expect(client(down).createImportJob(bytes, 'Deck')).rejects.toMatchObject({ status: 503 });
    expect(posts(down)).toBe(1);

    const designDown = vi.fn().mockResolvedValueOnce(reply(502)).mockResolvedValueOnce(reply(200, design));
    await expect(client(designDown).createDesign({ title: 'x' })).rejects.toMatchObject({ status: 502 });
    expect(posts(designDown)).toBe(1);
    const designLimited = vi.fn().mockResolvedValueOnce(reply(429)).mockResolvedValueOnce(reply(200, design));
    await expect(client(designLimited).createDesign({ title: 'x' })).resolves.toMatchObject({ design: { id: 'DAtest1' } });
    expect(posts(designLimited)).toBe(2);
  });

  it('status reads honour Retry-After too', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn().mockResolvedValueOnce(reply(429, {}, { 'Retry-After': '2' })).mockResolvedValueOnce(reply(200, exportJob));
      const pending = client(fetcher).getExportJob('export-1');
      await vi.advanceTimersByTimeAsync(1500);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(600);
      await expect(pending).resolves.toMatchObject({ job: { id: 'export-1' } });
    } finally {
      vi.useRealTimers();
    }
  });
});
