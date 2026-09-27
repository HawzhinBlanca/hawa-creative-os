import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createDb, sql, withRlsContext } from '../../../packages/db/src/index.ts';
import { googleOidcSettings } from '../../../apps/core/src/services/google-oidc.ts';

const root = new URL('../../../', import.meta.url);
const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: root }).trim();
const wanted = ['core', 'desk', 'worker-blue'];
const inspections = ['hawa-production', 'hawa-chaos'].map(project => {
  const containers = JSON.parse(execFileSync('docker', ['inspect', ...wanted.map(service => `${project}-${service}-1`)], { encoding: 'utf8' }));
  return { project, containers };
});
const config = inspections[0].containers[0];
const env = Object.fromEntries(config.Config.Env.map((line: string) => {
  const separator = line.indexOf('='); return [line.slice(0, separator), line.slice(separator + 1)];
}));
const report: Record<string, unknown> = {
  checkedAt: new Date().toISOString(), sourceCommit: source,
  scope: 'Read-only deployment/provider prerequisites; no task, migration, approval, export, message or model call.',
  deployments: inspections.map(({ project, containers }) => ({ project, services: containers.map((c: any, index: number) => ({
    service: wanted[index], imageId: c.Image, commit: c.Config.Labels?.['org.opencontainers.image.revision'] ?? null,
    status: c.State.Status, health: c.State.Health?.Status ?? null,
  })) })),
  configuration: {
    namedGoogleReviewConfigured: googleOidcSettings(env) !== null,
    googleOidcFieldsPresent: Object.fromEntries(['HAWA_GOOGLE_OIDC_CLIENT_ID', 'HAWA_GOOGLE_OIDC_CLIENT_SECRET',
      'HAWA_GOOGLE_OIDC_REDIRECT_URI', 'HAWA_GOOGLE_OIDC_HOSTED_DOMAINS'].map(name => [name, Boolean(env[name]?.trim())])),
    canvaFieldsPresent: Object.fromEntries(['CANVA_CLIENT_ID', 'CANVA_CLIENT_SECRET', 'CANVA_REDIRECT_URI', 'CANVA_TOKEN_ENCRYPTION_KEY'].map(name => [name, Boolean(env[name]?.trim())])),
  },
};
const address = new URL(env.DATABASE_URL); address.hostname = '127.0.0.1'; address.port = '54332';
const db = createDb(address.href);
try {
  const tables = (await sql<{ table_name: string }>`SELECT table_name FROM information_schema.tables WHERE table_schema='hawa'`.execute(db)).rows;
  const names = new Set(tables.map(row => row.table_name));
  const required = ['schema_upgrades', 'office_review_assignments', 'office_oidc_flows', 'canva_connections',
    'design_revisions', 'requests', 'design_studio_calls', 'canva_remote_operations', 'client_documents'];
  report.tablesPresent = Object.fromEntries(required.map(name => [name, names.has(name)]));
  if (names.has('schema_upgrades')) {
    const applied = (await sql<{ name: string; sha256: string }>`SELECT name,sha256 FROM hawa.schema_upgrades ORDER BY name`.execute(db)).rows;
    const files = readdirSync(new URL('packages/db/migrations/', root)).filter(name => /^\d{3}_.*\.sql$/.test(name) && !name.includes('_down')).sort();
    report.schema = { applied: applied.length, required: files.length, latestApplied: applied.at(-1)?.name ?? null,
      missing: files.filter(name => !applied.some(row => row.name === name)),
      changed: applied.filter(row => files.includes(row.name) && row.sha256 !== createHash('sha256').update(readFileSync(new URL(`packages/db/migrations/${row.name}`, root))).digest('hex')).map(row => row.name) };
  }
  report.visibleClientCount = await withRlsContext(db, { tenantId:'00000000-0000-4000-a000-000000000001', userId:'00000000-0000-4000-b000-000000000001', role:'operator' },
    async trx => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      return (await sql<{ count: string }>`SELECT COUNT(*) AS count FROM hawa.clients`.execute(trx)).rows[0];
    });
} catch (error) {
  report.databaseInspectionFailure = { name: error instanceof Error ? error.name : 'unknown', code: (error as {code?:string})?.code ?? null };
} finally { await db.destroy(); }
for (const [name, path] of [['health', '/v1/health'], ['canvaConnection', '/v1/integrations/canva/status']] as const) {
  try {
    const response = await fetch(`http://127.0.0.1:8080${path}`, { headers: { Authorization: `Bearer ${env.HAWA_BEARER_TOKEN}` }, signal: AbortSignal.timeout(10000) });
    const body = await response.json() as any;
    report[name] = { httpStatus: response.status, ...(name === 'canvaConnection'
      ? Object.fromEntries(['configured', 'authorized', 'status', 'tokenExpired'].filter(key => key in body).map(key => [key, body[key]]))
      : { status: typeof body.status === 'string' ? body.status : null }) };
  } catch (error) { report[name] = { errorClass: error instanceof Error ? error.name : 'unknown' }; }
}
writeFileSync(new URL('preflight.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
