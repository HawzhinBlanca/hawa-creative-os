#!/usr/bin/env tsx
/**
 * Hawa Creative OS — Test Suite Typecheck Validator
 *
 * Verifies that all active test suites across packages and apps typecheck cleanly
 * without compiler errors.
 */

import { exec } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

export async function runTypecheckTests(): Promise<boolean> {
  console.log('[Typecheck:tests] Running TypeScript typecheck on test suites...');

  return new Promise((resolve) => {
    exec('npx tsc -p tsconfig.test.json --pretty false', { cwd: rootDir }, (error, stdout, stderr) => {
      const output = (stdout || '') + (stderr || '');
      const lines = output.split('\n');

      // Filter for errors occurring specifically in test files
      const testErrors = lines.filter((line) => {
        return /\/test\/[a-zA-Z0-9_\-\.\/]+\.ts(\(\d+,\d+\))?: error TS/.test(line);
      });

      if (testErrors.length > 0) {
        console.error(`❌ [Typecheck:tests] Found ${testErrors.length} type errors in test files:`);
        for (const err of testErrors.slice(0, 20)) {
          console.error(`  ${err}`);
        }
        if (testErrors.length > 20) {
          console.error(`  ... and ${testErrors.length - 20} more errors.`);
        }
        resolve(false);
      } else {
        console.log('✅ [Typecheck:tests] All included test suites typecheck cleanly with 0 errors.');
        resolve(true);
      }
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runTypecheckTests().then((ok) => {
    if (!ok) process.exit(1);
  });
}
