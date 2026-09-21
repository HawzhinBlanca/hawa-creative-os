import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as appModule from '../src/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../../..');

describe('Task 1: Elimination of Second System & Test-Environment Backdoors', () => {
  it('proves no module-level global shared Maps exist in apps/core/src/app.ts', () => {
    // 1. Module export check: globalSharedInMemoryOutbox must be deleted
    expect((appModule as any).globalSharedInMemoryOutbox).toBeUndefined();

    // 2. Source text check: no globalShared Maps declared in apps/core/src/app.ts
    const appTsPath = path.resolve(__dirname, '../src/app.ts');
    const appTsContent = fs.readFileSync(appTsPath, 'utf8');
    const globalSharedMatches = appTsContent.match(/const globalShared[A-Za-z0-9_]+\s*=\s*new Map/g);
    expect(globalSharedMatches).toBeNull();
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
