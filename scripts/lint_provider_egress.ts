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

const PROVIDER_SDK_IMPORT = /(?:from\s*|require\(\s*|import\(\s*)['"](?:openai|@anthropic-ai\/sdk|@google\/genai|@google\/generative-ai)(?:\/[^'"]*)?['"]/;

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
]);

function scanDirectory(dir: string, scanRoot: string, violations: Array<{ file: string; host: string }>) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(scanRoot, fullPath).split(path.sep).join('/');

    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'output', 'coverage'].includes(entry.name)) continue;
      if (entry.name === 'test' || entry.name === 'tests' || entry.name === 'fixtures' || entry.name === '__tests__') continue;
      scanDirectory(fullPath, scanRoot, violations);
    } else if (entry.isFile() && /\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue;
      if (ALLOWED_EGRESS_FILES.has(relPath)) continue;

      const content = fs.readFileSync(fullPath, 'utf8');
      for (const host of BANNED_HOSTNAMES) {
        if (content.includes(host)) {
          violations.push({ file: relPath, host });
        }
      }
      if (PROVIDER_SDK_IMPORT.test(content)) violations.push({ file: relPath, host: 'direct provider SDK import' });
    }
  }
}

export function lintProviderEgress(scanRoot = rootDir): { success: boolean; violations: Array<{ file: string; host: string }> } {
  const violations: Array<{ file: string; host: string }> = [];

  for (const group of ['apps', 'packages']) {
    const groupDir = path.join(scanRoot, group);
    if (!fs.existsSync(groupDir)) continue;
    for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
      if (entry.isDirectory()) scanDirectory(path.join(groupDir, entry.name, 'src'), scanRoot, violations);
    }
  }

  return {
    success: violations.length === 0,
    violations,
  };
}

if (process.argv[1] && process.argv[1].endsWith('lint_provider_egress.ts')) {
  const result = lintProviderEgress();
  if (!result.success) {
    console.error('❌ EGRESS LINT FAILED: Direct provider references found outside the current exception list:');
    for (const v of result.violations) {
      console.error(`   ${v.file}: contains ${v.host}`);
    }
    process.exit(1);
  } else {
    console.log(`✅ EGRESS LINT PASSED: No new direct provider references outside ${ALLOWED_EGRESS_FILES.size} existing exceptions. Existing calls still need policy migration.`);
  }
}
