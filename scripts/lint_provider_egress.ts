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

/**
 * ADR-289: every file allowed to reach a provider, and the ledger that records each paid call it sends.
 * A new entry must name its ledger (or say why it has none); the inventory table of ADR-289 is this map.
 */
export const PROVIDER_EGRESS_LEDGERS: Record<string, string> = {
  // ADR-096/ADR-093: evaluation runs only (DurableEvaluationService), one eval_model_calls row per call.
  'packages/integrations/src/model-gateway.ts': 'hawa.eval_model_calls',
  // Lifecycle voice (lifecycle-voice.ts): an inbox_events lifecycle_voice_attempt row admitted before dispatch.
  'packages/integrations/src/voice-transcriber.ts': 'hawa.inbox_events (lifecycle_voice_attempt)',
  // generateConditionedArtLayer only: no production caller (UNLEDGERED_PAID_EXPORTS).
  'packages/creative/src/studio/art-generator-v3.ts': 'none: no production caller',
  // Studio art and its vision check: Core injects requestImage and visionClient (design-studio-service.ts).
  'packages/creative/src/studio/gemini-image-provider.ts': 'hawa.design_studio_calls (when Core injects the ledger)',
  // Every Studio text call: Core wraps the client so a row is admitted before dispatch.
  'packages/creative/src/studio/openai-studio-client.ts': 'hawa.design_studio_calls (when Core injects the ledger)',
  'apps/core/src/services/paid-model-probe.ts': 'hawa.paid_model_probe_calls',
  'apps/core/src/services/canva-planner-call.ts': 'hawa.canva_planner_calls',
  // classifyInboundTelegramMessage only: no production caller (UNLEDGERED_PAID_EXPORTS).
  'apps/core/src/services/telegram-classifier.ts': 'none: no production caller',
  // ADR-144: the intake router, admitted per update against the office's shared allowance.
  'apps/core/src/services/requester-intent-model.ts': 'hawa.requester_intent_calls',
};
const ALLOWED_EGRESS_FILES = new Set(Object.keys(PROVIDER_EGRESS_LEDGERS));

/**
 * ADR-289: paid functions that write no ledger row. Each has no caller in production code today; one
 * that gains a caller would spend on the office key without a trace, so the lint refuses it until the
 * call is routed through a ledger (requester-intent-model.ts `readOnce` for a message reading, the
 * Studio's ledger client for design work) and the entry is removed.
 */
export const UNLEDGERED_PAID_EXPORTS: Record<string, string[]> = {
  'apps/core/src/services/telegram-classifier.ts': ['classifyInboundTelegramMessage'],
  'packages/creative/src/studio/art-generator-v3.ts': ['generateConditionedArtLayer'],
};

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

function productionSources(dir: string, scanRoot: string, out: Array<{ rel: string; content: string }>) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'output', 'coverage', 'test', 'tests', 'fixtures', '__tests__'].includes(entry.name)) continue;
      productionSources(fullPath, scanRoot, out);
    } else if (entry.isFile() && /\.(ts|tsx|js|mjs)$/.test(entry.name) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
      out.push({ rel: path.relative(scanRoot, fullPath).split(path.sep).join('/'), content: fs.readFileSync(fullPath, 'utf8') });
    }
  }
}

export function lintProviderEgress(scanRoot = rootDir): { success: boolean; violations: Array<{ file: string; host: string }> } {
  const violations: Array<{ file: string; host: string }> = [];
  const sources: Array<{ rel: string; content: string }> = [];

  for (const group of ['apps', 'packages']) {
    const groupDir = path.join(scanRoot, group);
    if (!fs.existsSync(groupDir)) continue;
    for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      scanDirectory(path.join(groupDir, entry.name, 'src'), scanRoot, violations);
      productionSources(path.join(groupDir, entry.name, 'src'), scanRoot, sources);
    }
  }

  // ADR-289: an unledgered paid function stays without a production caller.
  for (const [owner, names] of Object.entries(UNLEDGERED_PAID_EXPORTS)) {
    for (const name of names) {
      const use = new RegExp(`\\b${name}\\b`);
      for (const source of sources) {
        if (source.rel !== owner && use.test(source.content)) {
          violations.push({ file: source.rel, host: `unledgered paid call ${name} (ADR-289)` });
        }
      }
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
    console.log(`✅ EGRESS LINT PASSED: provider calls only in the ${ALLOWED_EGRESS_FILES.size} files of the ADR-289 ledger inventory; unledgered paid functions have no production caller.`);
  }
}
