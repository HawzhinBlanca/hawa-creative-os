import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as appModule from '../src/app.js';
import { createApp } from '../src/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../../..');

describe('Task 1: Elimination of Second System & Test-Environment Backdoors', () => {
  const operator = { 'Content-Type': 'application/json', Authorization: 'Bearer test_bearer' };

  it('exports no process-wide shared outbox from app.ts', () => {
    expect((appModule as any).globalSharedInMemoryOutbox).toBeUndefined();
  });

  // Two Core instances in one process must not see each other's state: a map every createApp()
  // shares is a second system of record next to Postgres. This used to search app.ts's text for
  // `const globalShared… = new Map`, which a move to another file would pass; it now asks two apps.
  it('keeps each app\'s tasks to itself: a task created in one app is unknown to another', async () => {
    const a = createApp();
    const b = createApp();
    const created = await a.request('/v1/tasks', { method: 'POST', headers: operator, body: JSON.stringify({ title: 'Isolation', clientId: 'kaae' }) });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    expect((await a.request(`/v1/tasks/${id}`, { headers: operator })).status).toBe(200);
    expect((await b.request(`/v1/tasks/${id}`, { headers: operator })).status).toBe(404);
  });

  // The kill switches were module-level until architecture programme item 1.3 (step P): switching
  // Telegram intake off in one app switched it off in every app of the process.
  it('keeps each app\'s channel kill switches to itself', async () => {
    const a = createApp();
    const b = createApp();
    const channels = async (app: ReturnType<typeof createApp>) =>
      (await (await app.request('/v1/ingress/status', { headers: operator })).json()).channels;

    const toggled = await a.request('/v1/ingress/channels/telegram/toggle', { method: 'POST', headers: operator, body: JSON.stringify({ enabled: false }) });
    expect(toggled.status).toBe(200);
    expect(await channels(a)).toEqual({ telegram: false, waha: true });
    expect(await channels(b)).toEqual({ telegram: true, waha: true });

    const killed = await a.request('/v1/operations/kill-switch', { method: 'POST', headers: operator, body: JSON.stringify({ channel: 'waha', active: true }) });
    expect(killed.status).toBe(200);
    expect(await channels(a)).toEqual({ telegram: false, waha: false });
    expect(await channels(b)).toEqual({ telegram: true, waha: true });
  });

  it('proves apps/*/src and packages/*/src contain no test-backdoor NODE_ENV or VITEST branches', () => {
    const scanDirs = [
      path.resolve(rootDir, 'apps/core/src'),
      path.resolve(rootDir, 'apps/worker/src'),
      path.resolve(rootDir, 'apps/desk/src'),
      path.resolve(rootDir, 'packages/contracts/src'),
      path.resolve(rootDir, 'packages/creative/src'),
      path.resolve(rootDir, 'packages/db/src'),
      path.resolve(rootDir, 'packages/domain/src'),
      path.resolve(rootDir, 'packages/evals/src'),
      path.resolve(rootDir, 'packages/integrations/src'),
      path.resolve(rootDir, 'packages/observability/src'),
      path.resolve(rootDir, 'packages/qa/src'),
      path.resolve(rootDir, 'packages/retrieval/src'),
      path.resolve(rootDir, 'packages/testkit/src'),
    ];

    const violations: { file: string; line: number; text: string }[] = [];

    // Allowed config-only patterns
    // e.g., (process.env.NODE_ENV || '').trim().toLowerCase() === 'production' in provider-policy
    // or standard production error logging check in index.ts / app.ts error handler
    const isAllowedConfig = (lineText: string, filePath: string): boolean => {
      // Configuration checks for production mode
      if (
        lineText.includes("process.env.NODE_ENV === 'production'") ||
        lineText.includes('process.env.NODE_ENV !== "production"') ||
        lineText.includes("process.env.NODE_ENV || ''") ||
        lineText.includes('(process.env.NODE_ENV || "")')
      ) {
        // Must be purely environment tier resolution or standard production error masking
        if (
          filePath.endsWith('provider-policy.ts') ||
          filePath.endsWith('app.ts') ||
          filePath.endsWith('index.ts')
        ) {
          // If it grants auth bypasses, it is NOT allowed
          if (
            lineText.includes('x-user-role') ||
            lineText.includes('bearer') ||
            lineText.includes('mock') ||
            lineText.includes('fake') ||
            lineText.includes('emulate')
          ) {
            return false;
          }
          return true;
        }
      }
      return false;
    };

    for (const dir of scanDirs) {
      if (!fs.existsSync(dir)) continue;
      const walk = (currentDir: string) => {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(currentDir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') || entry.name.endsWith('.js'))) {
            const content = fs.readFileSync(fullPath, 'utf8');
            const lines = content.split('\n');
            lines.forEach((line, idx) => {
              if (line.includes('NODE_ENV') || line.includes('VITEST')) {
                if (!isAllowedConfig(line, fullPath)) {
                  violations.push({
                    file: path.relative(rootDir, fullPath),
                    line: idx + 1,
                    text: line.trim(),
                  });
                }
              }
            });
          }
        }
      };
      walk(dir);
    }

    expect(violations).toEqual([]);
  });
});
