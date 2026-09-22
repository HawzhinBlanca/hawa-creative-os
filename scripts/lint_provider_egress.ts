/**
 * Egress Policy Linter (Task 10 Remediation)
 *
 * Enforces that external model provider API hostnames are strictly governed and cannot be
 * introduced into arbitrary frontend, worker, or domain components without admission.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const BANNED_HOSTNAMES = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
];

const ALLOWED_EGRESS_FILES = new Set([
  'packages/integrations/src/model-gateway.ts',
  'packages/integrations/src/voice-transcriber.ts',
  'packages/creative/src/studio/art-generator-v3.ts',
  'packages/creative/src/studio/gemini-image-provider.ts',
  'packages/creative/src/studio/openai-studio-client.ts',
  'apps/core/src/app.ts',
  'apps/core/src/routes/system.routes.ts',
  'apps/core/src/services/canva-design-planner.ts',
  'apps/core/src/services/telegram-classifier.ts',
  'scripts/lint_provider_egress.ts',
]);

function scanDirectory(dir: string, violations: Array<{ file: string; host: string }>) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(rootDir, fullPath);

    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'output', 'coverage'].includes(entry.name)) continue;
      scanDirectory(fullPath, violations);
    } else if (entry.isFile() && /\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      if (relPath.includes('test') || relPath.includes('fixtures')) continue;
      if (ALLOWED_EGRESS_FILES.has(relPath)) continue;

      const content = fs.readFileSync(fullPath, 'utf8');
      for (const host of BANNED_HOSTNAMES) {
        if (content.includes(host)) {
          violations.push({ file: relPath, host });
        }
      }
    }
  }
}

export function lintProviderEgress(): { success: boolean; violations: Array<{ file: string; host: string }> } {
  const violations: Array<{ file: string; host: string }> = [];

  scanDirectory(path.join(rootDir, 'apps'), violations);
  scanDirectory(path.join(rootDir, 'packages'), violations);

  return {
    success: violations.length === 0,
    violations,
  };
}

if (process.argv[1] && process.argv[1].endsWith('lint_provider_egress.ts')) {
  const result = lintProviderEgress();
  if (!result.success) {
    console.error('❌ EGRESS LINT FAILED: External provider hostnames found outside authorized egress points:');
    for (const v of result.violations) {
      console.error(`   ${v.file}: contains ${v.host}`);
    }
    process.exit(1);
  } else {
    console.log('✅ EGRESS LINT PASSED: All external model provider hostnames are strictly governed.');
  }
}
