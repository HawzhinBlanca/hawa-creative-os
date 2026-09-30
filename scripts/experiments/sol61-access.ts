/** ADR-148: read-only access probe. No prompts, paid completions or raw errors are emitted. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const target = 'gpt-6.1-sol';
const envPath = resolve('infra/docker/.env.production');
const artifact = resolve(`plans/model-migration-2026-09-30/access-history/${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

async function main(): Promise<void> {
  const local = await readFile(envPath, 'utf8');
  const fromFile = local.match(/^OPENAI_API_KEY=(.*)$/m)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
  // The owner authorized the existing production key specifically, not an unrelated shell key.
  const key = fromFile;
  if (!key) throw new Error('Existing key is absent from the authorized location.');
  const headers = { Authorization: `Bearer ${key}` };
  async function inspect(route: string): Promise<{ status: number; present?: boolean }> {
    const response = await fetch(`https://api.openai.com/v1/${route}`, { headers, signal: AbortSignal.timeout(20000) });
    if (!response.ok) return { status: response.status };
    const data: unknown = await response.json();
    if (route !== 'models') return { status: response.status };
    const list = (data as { data?: Array<{ id?: string }> }).data;
    return { status: response.status, present: list?.some(model => model.id === target) ?? false };
  }
  const catalog = await inspect('models');
  const targetAccess = await inspect(`models/${target}`);
  const baselineAccess = await inspect('models/gpt-6-astra');
  const available = catalog.status === 200 && catalog.present === true && targetAccess.status === 200;
  const evidence = { version: 1, checkedAt: new Date().toISOString(), requestedModel: target,
    catalog, targetAccess, baselineAccess, available, verdict: available ? 'ACCESS_ONLY' : 'BLOCKED_ACCESS',
    paidCalls: 0, productionPromoted: false, creativeQualityEvaluated: false };
  await mkdir(dirname(artifact), { recursive: true });
  await writeFile(artifact, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(evidence));
  if (!available) process.exitCode = 2;
}

main().catch(() => {
  // Provider/network exceptions may contain sensitive request details; retain only a safe outcome.
  console.error('Sol access probe could not complete; access remains unverified.');
  process.exitCode = 1;
});
