import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { determineBaseDirection, analyzeBidi } from '../src/rtl-validator.js';

interface GoldenCase {
  id: string;
  language: string;
  text: string;
  declared_direction: string;
  expected_base_direction: 'rtl' | 'ltr';
  critical: boolean;
  checks: string[];
  font_groups: string[];
}

describe('QA: RTL & Multilingual Golden Cases', () => {
  const filePath = resolve(__dirname, '../../../evals/rtl_golden_cases.jsonl');
  const lines = readFileSync(filePath, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const cases: GoldenCase[] = lines.map((l) => JSON.parse(l));

  it('loaded all 40 golden RTL cases', () => {
    expect(cases.length).toBe(40);
  });

  for (const c of cases) {
    it(`Case ${c.id}: ${c.language} - "${c.text}" resolves to ${c.expected_base_direction}`, () => {
      const baseDir = determineBaseDirection(c.text);
      expect(baseDir).toBe(c.expected_base_direction);

      const analysis = analyzeBidi(c.text);
      expect(analysis.baseDirection).toBe(c.expected_base_direction);

      if (c.checks.includes('paired_brackets')) {
        expect(analysis.hasPairedBrackets).toBe(true);
        expect(analysis.bracketPairsMatched).toBe(true);
      }

      if (c.language === 'ckb') {
        expect(analysis.hasRtlCharacters).toBe(true);
      }
    });
  }
});
