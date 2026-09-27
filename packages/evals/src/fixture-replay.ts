import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROUTING_RESPONSE_SCHEMA, VISUAL_RESPONSE_SCHEMA } from './response-schemas.js';

const locate = (name: string) => existsSync(resolve(name)) ? resolve(name) : resolve('../../', name);
/** Changing scoring/replay semantics requires a new protocol version. Source seal also binds deployment. */
export function fixtureEvaluationIdentity() {
  const names = ['evals/routing_brief.jsonl', 'evals/retrieval_eval.jsonl', 'evals/rtl_golden_cases.jsonl'];
  const files = names.map(name => readFileSync(locate(name), 'utf8'));
  const seal = readFileSync(locate('RELEASE_MANIFEST.json'), 'utf8');
  const imageHash = createHash('sha256').update(readFileSync(locate('packages/creative/assets/logos/kaae-official-logo.png'))).digest('hex');
  const hash = createHash('sha256').update(JSON.stringify({ protocol: 'fixture-replay-v2', files, imageHash, seal,
    responseSchemas: [ROUTING_RESPONSE_SCHEMA, VISUAL_RESPONSE_SCHEMA] })).digest('hex');
  const routing = files[0].split('\n').filter(Boolean).map(line => JSON.parse(line));
  const normalize = (value: unknown, prefix: string) => String(value).trim().toUpperCase().replace(new RegExp(`^${prefix}-`), '');
  return { hash,
    clients: new Set<string>(routing.filter(c => c.expected?.client).map(c => normalize(c.expected.client, 'CLIENT'))),
    projects: new Set<string>(routing.filter(c => c.expected?.project).map(c => normalize(c.expected.project, 'PROJECT'))),
  };
}

/** Only fields consumed by this fixed fixture evaluator may cross the replay boundary. */
export function projectFixtureScore(value: unknown, role: string, labels: { clients: Set<string>; projects: Set<string> }): Record<string, unknown> {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const decision = typeof data.decision === 'string' && role === 'visual_judge' ? data.decision.toLowerCase() : data.decision;
  const allowed = role === 'intake_router' ? ['route_matched', 'abstain', 'needs_clarification', 'route_ambiguous']
    : ['approved', 'rejected', 'revision_requested', 'qualified', 'pass'];
  const result: Record<string, unknown> = { decision: typeof decision === 'string' && allowed.includes(decision) ? decision : '__invalid__' };
  if (data.confidence !== undefined) result.confidence = typeof data.confidence === 'number' && Number.isFinite(data.confidence) ? data.confidence : '__invalid__';
  if (role === 'intake_router') {
    for (const [field, fallback, prefix, set] of [['clientId', 'client', 'CLIENT', labels.clients], ['projectId', 'project', 'PROJECT', labels.projects]] as const) {
      const raw = data[field] || data[fallback];
      const normalized = String(raw).trim().toUpperCase().replace(new RegExp(`^${prefix}-`), '');
      result[field] = !/[|:,;]/.test(normalized) && set.has(normalized) ? normalized : '__invalid__';
    }
  } else {
    if (data.passed !== undefined) result.passed = typeof data.passed === 'boolean' ? data.passed : '__invalid__';
    if (data.overallScore !== undefined) result.overallScore = typeof data.overallScore === 'number' && Number.isFinite(data.overallScore) ? data.overallScore : -1;
    const rubric = data.rubricScores && typeof data.rubricScores === 'object' ? data.rubricScores as Record<string, unknown> : {};
    const scores: Record<string, number> = {};
    for (const field of ['brandResemblance', 'artifacts']) {
      if (rubric[field] !== undefined) scores[field] = typeof rubric[field] === 'number' && Number.isFinite(rubric[field]) ? rubric[field] : field === 'artifacts' ? 100 : -1;
    }
    result.rubricScores = scores;
  }
  return result;
}
