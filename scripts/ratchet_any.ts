#!/usr/bin/env tsx
/**
 * Hawa Creative OS — TypeScript 'any' Strict Ratchet
 *
 * Enforces a monotonically decreasing ceiling on untyped code across packages and apps.
 * Fails CI if new 'any' annotations are introduced.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// Maximum allowed 'any' count in source files. Ratchet must only decrease, never increase.
const BASELINE_ANY_CEILING = 1059;

function walk(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== 'build') {
        results.push(...walk(fullPath));
      }
    } else if (entry.isFile() && fullPath.endsWith('.ts') && !fullPath.endsWith('.d.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

export function countAnyOccurrences(): { total: number; fileBreakdown: Record<string, number> } {
  const targetDirs = [
    path.join(rootDir, 'packages'),
    path.join(rootDir, 'apps'),
  ];

  const files: string[] = [];
  for (const base of targetDirs) {
    const all = walk(base);
    // Only target production source code in src/
    files.push(...all.filter((f) => f.includes(`${path.sep}src${path.sep}`)));
  }

  let total = 0;
  const fileBreakdown: Record<string, number> = {};

  const anyRegex = /(:\s*any\b|\bas\s+any\b|<any>|Array<any>)/g;

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const matches = content.match(anyRegex);
    if (matches && matches.length > 0) {
      const relPath = path.relative(rootDir, file);
      total += matches.length;
      fileBreakdown[relPath] = matches.length;
    }
  }

  return { total, fileBreakdown };
}

export function enforceAnyRatchet(maxAllowed = BASELINE_ANY_CEILING): boolean {
  const { total, fileBreakdown } = countAnyOccurrences();

  console.log(`[Ratchet:any] Scanned production source code: found ${total} 'any' occurrences (ceiling: ${maxAllowed}).`);

  if (total > maxAllowed) {
    console.error(`\n❌ RATCHET BREACH: 'any' count (${total}) exceeds allowed ceiling (${maxAllowed}) by ${total - maxAllowed}!`);
    console.error('Top offending files:');
    const sorted = Object.entries(fileBreakdown).sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [f, count] of sorted) {
      console.error(`  - ${f}: ${count} 'any'`);
    }
    return false;
  }

  console.log(`✅ RATCHET PASSED: 'any' count ${total} is within ceiling ${maxAllowed}.`);
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const passed = enforceAnyRatchet();
  if (!passed) {
    process.exit(1);
  }
}
