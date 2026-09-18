import { describe, it, expect, vi } from 'vitest';
import { CanvaConnectClient } from '../src/canva-connect-client.js';

// Task e8da3cec (2026-09-18): one HTTP 500 from GET /imports/{id} failed the design, although the
// import had succeeded; resuming it a minute later returned the design.
const job = { job: { id: 'job-1', status: 'success', result: { designs: [{ id: 'DAHVleLlNqA', urls: { edit_url: 'e', view_url: 'v' } }] } } };
const reply = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const client = (fetcher: typeof fetch) => new CanvaConnectClient({ accessToken: 'token', customFetch: fetcher, readRetryDelaysMs: [1, 1] });

describe('Canva status reads', () => {
  it('asks again after a transient server error, and returns the finished import', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply(500)).mockResolvedValueOnce(reply(200, job));
    const result = await client(fetcher as any).getImportJob('job-1');
    expect(result.job.result?.designs[0].id).toBe('DAHVleLlNqA');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('asks again after a rate limit or a network error', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply(429)).mockRejectedValueOnce(new Error('socket hang up')).mockResolvedValueOnce(reply(200, job));
    await expect(client(fetcher as any).getImportJob('job-1')).resolves.toMatchObject({ job: { status: 'success' } });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('does not repeat a refusal, and gives up after three attempts', async () => {
    const notFound = vi.fn().mockResolvedValue(reply(404));
    await expect(client(notFound as any).getImportJob('job-1')).rejects.toThrow('HTTP 404');
    expect(notFound).toHaveBeenCalledTimes(1);
    const down = vi.fn().mockResolvedValue(reply(503));
    await expect(client(down as any).getExportJob('export-1')).rejects.toThrow('HTTP 503');
    expect(down).toHaveBeenCalledTimes(3);
  });
});
