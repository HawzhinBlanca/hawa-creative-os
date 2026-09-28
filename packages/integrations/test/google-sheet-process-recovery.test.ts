import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { FakeSheets } from './fake-sheets.js';

it('recovers after SIGKILL following atomic row creation but before the response reaches the publisher', async () => {
  const sheets = new FakeSheets(); sheets.tabs.set(7, [['header']]);
  let victim: ChildProcess | undefined; let killAfterCreate = true;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const response = await sheets.fetch(`http://localhost${req.url}`, {
      method: req.method, ...(req.method === 'GET' ? {} : { body: Buffer.concat(chunks).toString() }),
    });
    if (req.url === '/v4/spreadsheets/recovery:batchUpdate' && killAfterCreate && response.ok) {
      killAfterCreate = false; victim?.kill('SIGKILL'); res.destroy(); return;
    }
    res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const module = fileURLToPath(new URL('../src/google-sheet-row.ts', import.meta.url));
  const scope = { tenantId: 'tenant-a', spreadsheetId: 'recovery', sheetId: 7, taskId: 'task-a' };
  const values = ['task-a', 'client-a', 'folder-a', '2026-09-27T00:00:00.000Z', 'COMPLETE', 'https://example.test/file', 'sha-a'];
  const code = `import { GoogleSheetRow } from ${JSON.stringify(module)}; const result = await new GoogleSheetRow(${JSON.stringify(`http://127.0.0.1:${port}`)}, ${JSON.stringify(randomUUID())}).sync(${JSON.stringify(scope)}, ${JSON.stringify(values)}, true); process.stdout.write(JSON.stringify(result));`;
  const run = () => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += String(b); }); child.stderr.on('data', b => { stderr += String(b); });
    const done = new Promise<{ exit: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Sheet recovery child exceeded 10 seconds')); }, 10_000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('close', (exit, signal) => { clearTimeout(timeout); resolve({ exit, signal, stdout, stderr }); });
    });
    return { child, done };
  };
  try {
    const first = run(); victim = first.child;
    expect(await first.done).toMatchObject({ signal: 'SIGKILL', stdout: '' });
    const restarted = run(); victim = restarted.child; const completed = await restarted.done;
    expect(completed, completed.stderr).toMatchObject({ exit: 0, signal: null });
    expect(JSON.parse(completed.stdout)).toMatchObject({ synced: true, rowNumber: 2 });
    expect(sheets.tabs.get(7)).toEqual([['header'], values]);
    expect(sheets.metadata.size).toBe(1);
    expect(sheets.calls.filter(c => c.path.endsWith(':batchUpdate'))).toHaveLength(1);
  } finally {
    victim?.kill('SIGKILL'); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
