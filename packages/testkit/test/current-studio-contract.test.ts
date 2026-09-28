import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

describe('ADR 025 current studio contract', () => {
  it('keeps the master specification, decision summary and QA contract on Canva', () => {
    for (const file of ['MASTER_SPEC.md', 'DECISION_SUMMARY.md', 'docs/06_EDITABLE_DOCUMENT_STRATEGY.md', 'docs/11_QA_RTL_MULTILINGUAL.md']) {
      const content = read(file);
      expect(content).toContain('Canva');
      expect(content).not.toMatch(/(?:source\/design\.hyc|valid `\.hyc` schema|Editable studio \| \*\*HyCanvas)/);
    }
    expect(read('MASTER_SPEC.md')).toContain('docs/30_CURRENT_STUDIO_CONTRACT.md');
    expect(read('DECISION_SUMMARY.md')).toContain('docs/30_CURRENT_STUDIO_CONTRACT.md');
  });

  it('excludes the retired HyCanvas proof from active build instructions and NFR-010', () => {
    const prompt = read('AI_BUILD_PROMPT.md');
    const active = prompt.split('### Historical Phase 0B')[0];
    expect(active).toMatch(/6\. `docs\/30_CURRENT_STUDIO_CONTRACT\.md`/);
    const nfr010 = read('plans/traceability.csv').split(/\r?\n/).find((line) => line.startsWith('NFR-010,'));
    expect(nfr010).toBeDefined();
    expect(nfr010!.split(',MASTER_SPEC.md,')[0]).not.toContain('`.hyc`');
    expect(nfr010).toContain('remain OPEN');
  });
});
