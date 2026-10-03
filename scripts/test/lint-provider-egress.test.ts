import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lintProviderEgress, PROVIDER_EGRESS_LEDGERS, UNLEDGERED_PAID_EXPORTS } from '../lint_provider_egress.js';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-egress-lint-'));

function source(rel: string, content: string): void {
  const file = path.join(fixtureRoot, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

afterEach(() => {
  fs.rmSync(path.join(fixtureRoot, 'apps'), { recursive: true, force: true });
  fs.rmSync(path.join(fixtureRoot, 'packages'), { recursive: true, force: true });
});

describe('provider egress architecture guard', () => {
  it('detects endpoints in production files even when their names contain test or fixtures', () => {
    source('apps/core/src/testimonials.ts', "fetch('https://api.openai.com/v1/chat/completions')");
    source('packages/creative/src/fixtures_manager.ts', "fetch('https://api.anthropic.com/v1/messages')");
    const result = lintProviderEgress(fixtureRoot);
    expect(result.violations.map((violation) => violation.file).sort()).toEqual([
      'apps/core/src/testimonials.ts', 'packages/creative/src/fixtures_manager.ts',
    ]);
  });

  it('detects a provider SDK import without a literal endpoint', () => {
    source('apps/worker/src/model.ts', "import OpenAI from 'openai';");
    expect(lintProviderEgress(fixtureRoot).violations).toEqual([
      { file: 'apps/worker/src/model.ts', host: 'direct provider SDK import' },
    ]);
  });

  it('omits test trees while scanning production sources', () => {
    source('apps/core/src/test/provider.ts', "fetch('https://api.openai.com/v1/chat/completions')");
    source('apps/core/src/provider.test.ts', "fetch('https://api.openai.com/v1/chat/completions')");
    expect(lintProviderEgress(fixtureRoot).success).toBe(true);
  });

  it('ADR-289: refuses a production caller of a paid function that writes no ledger row', () => {
    source('apps/core/src/services/telegram-classifier.ts', "export async function classifyInboundTelegramMessage() { await fetch('https://api.openai.com/v1/chat/completions'); }");
    source('apps/core/src/services/telegram-classifier-user.ts', "import { classifyInboundTelegramMessage } from './telegram-classifier.js';\nawait classifyInboundTelegramMessage();");
    source('apps/core/src/services/classifier.test.ts', "import { classifyInboundTelegramMessage } from './telegram-classifier.js';");
    expect(lintProviderEgress(fixtureRoot).violations).toEqual([
      { file: 'apps/core/src/services/telegram-classifier-user.ts', host: 'unledgered paid call classifyInboundTelegramMessage (ADR-289)' },
    ]);
  });

  it('ADR-289: the repository passes, and every provider file names the ledger of its calls', () => {
    expect(lintProviderEgress().violations).toEqual([]);
    for (const [file, ledger] of Object.entries(PROVIDER_EGRESS_LEDGERS)) {
      expect(fs.existsSync(path.join(__dirname, '..', '..', file)), file).toBe(true);
      expect(ledger).toMatch(/^(hawa\.[a-z_]+|none: .+)/);
    }
    for (const file of Object.keys(UNLEDGERED_PAID_EXPORTS)) expect(PROVIDER_EGRESS_LEDGERS[file]).toMatch(/^none: /);
  });
});
