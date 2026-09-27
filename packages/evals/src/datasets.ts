import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const FIXTURE_DATASETS = [
  { id: 'brief', name: 'Routing & Brief Fixtures', file: 'evals/routing_brief.jsonl', description: 'Routing fixture diagnostics; not model admission evidence.' },
  { id: 'rtl', name: 'RTL Golden Suite', file: 'evals/rtl_golden_cases.jsonl', description: 'Case definitions only. The fixture tournament does not execute this RTL corpus.' },
  { id: 'retrieval', name: 'Retrieval & Leakage', file: 'evals/retrieval_eval.jsonl', description: 'Synthetic label-derived retrieval contracts; not an independent relevance study.' },
] as const;

export function readFixtureDataset(id: string) {
  const definition = FIXTURE_DATASETS.find(dataset => dataset.id === id);
  if (!definition) return null;
  const direct = resolve(process.cwd(), definition.file);
  const target = existsSync(direct) ? direct : resolve(process.cwd(), '../../', definition.file);
  const bytes = readFileSync(target);
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const ids = new Set<string>();
  const cases = content.split('\n').filter(line => line.trim()).map(line => {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !('id' in value) || typeof value.id !== 'string' || !value.id.trim() || ids.has(value.id)) {
      throw new Error('Invalid fixture case identity');
    }
    ids.add(value.id);
    return value as { id: string; [key: string]: unknown };
  });
  return { ...definition, content, cases, source: { file: definition.file, sha256: createHash('sha256').update(bytes).digest('hex') } };
}

export function fixtureDatasetCatalog() {
  return FIXTURE_DATASETS.map(definition => {
    try {
      const loaded = readFixtureDataset(definition.id)!;
      return { ...definition, casesCount: loaded.cases.length, status: 'available', source: loaded.source };
    } catch {
      return { ...definition, casesCount: null, status: 'unavailable', source: null };
    }
  });
}
