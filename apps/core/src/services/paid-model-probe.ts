import { createHash, randomUUID } from 'node:crypto';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { reserveStudioText, studioTextUsage } from '@hawa/creative';
import type { StudioCallReservation } from '@hawa/domain';
import { paidModelConfigFingerprint, isBillableChatCompletion, type PaidModelProbeResult } from './paid-model-health.js';

type Scope = { tenantId: string; userId: string; role: string };
export type ProbeSpendingState = 'ready' | 'budget_held' | 'history_incomplete' | 'reconciliation_required' | 'unquotable';
export interface ProbeAdmissionHealth { spendingStatus: ProbeSpendingState; callId: string | null }
interface ProbeRequest { model: string; configSha256: string; body: string; reservation: StudioCallReservation }
interface ProbeOutcome {
  status: PaidModelProbeResult; acceptance: 'response_received' | 'not_accepted' | 'unknown';
  costBasis: 'usage' | 'not_accepted' | 'unavailable'; costUsd: number | null; requiresReconciliation: boolean;
  inputTokens: number | null; outputTokens: number | null; providerRequestId: string | null;
  responseId: string | null; servedModel: string | null; responseSha256: string | null; latencyMs: number;
}
export interface ProbeExecution { status: PaidModelProbeResult | ProbeSpendingState | 'not_due'; callId: string | null; dispatched: boolean }
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const identifier = (v: unknown, max = 200): string | null => typeof v === 'string' && v.length <= max && /^[a-zA-Z0-9_.:-]+$/.test(v) ? v : null;

function request(key: string, model: string): ProbeRequest {
  // Share the reviewed Studio rate policy; an expired policy cannot authorize new probe spending.
  if (!key || Date.now() >= Date.parse('2026-11-22T00:00:00Z')) throw new Error('Unquotable paid health probe');
  const body = JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }],
    response_format: { type: 'text' }, max_completion_tokens: 1, service_tier: 'default' });
  return { model, configSha256: paidModelConfigFingerprint(key, model), body, reservation: reserveStudioText(body) };
}

/** Bounded response read; AbortSignal on fetch covers headers and streamed bytes. */
async function responseText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); throw new Error('Probe response exceeded limit'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}

async function transport(key: string, input: ProbeRequest, fetcher: typeof fetch): Promise<ProbeOutcome> {
  const started = performance.now();
  const out: ProbeOutcome = { status: 'unreachable', acceptance: 'unknown', costBasis: 'unavailable', costUsd: null,
    requiresReconciliation: true, inputTokens: null, outputTokens: null, providerRequestId: null,
    responseId: null, servedModel: null, responseSha256: null, latencyMs: 0 };
  try {
    const response = await fetcher('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: input.body, signal: AbortSignal.timeout(7000), redirect: 'error',
    });
    out.providerRequestId = identifier(response.headers.get('x-request-id'));
    out.status = 'http_error';
    const rejected = [400,401,403,422,429].includes(response.status);
    if (rejected) {
      out.acceptance = 'not_accepted'; out.costBasis = 'not_accepted'; out.costUsd = 0; out.requiresReconciliation = false;
      if (response.status === 401 || response.status === 403) out.status = 'unauthorized';
      if (response.status === 429) out.status = 'rate_limited';
    } else if (response.ok) out.acceptance = 'response_received';
    const raw = await responseText(response); out.responseSha256 = hash(raw);
    let data: Record<string, unknown>;
    try { data = object(JSON.parse(raw)); } catch { return out; }
    if (response.status === 429) {
      const error = object(data.error);
      if (error.code === 'credit_balance_exhausted' || error.type === 'insufficient_quota' || error.code === 'insufficient_quota') out.status = 'billing_exhausted';
    }
    if (!response.ok) return out;
    out.responseId = identifier(data.id); out.servedModel = identifier(data.model,160);
    const usage = studioTextUsage(input.model,out.servedModel,data.usage);
    if (usage) {
      out.inputTokens = usage.inputTokens; out.outputTokens = usage.outputTokens;
      out.costUsd = usage.estimatedCostUsd; out.costBasis = 'usage';
    }
    const complete = Boolean(usage?.modelMatches && out.responseId && isBillableChatCompletion(data));
    const withinBound = !!usage && usage.inputTokens <= input.reservation.inputTokens &&
      usage.outputTokens <= input.reservation.outputTokens && usage.estimatedCostUsd <= input.reservation.usd;
    out.requiresReconciliation = !complete || !withinBound;
    if (!out.requiresReconciliation) out.status = 'connected';
    return out;
  } catch { return out; }
  finally { out.latencyMs = Math.min(2147483647,Math.max(0,Math.round(performance.now()-started))); }
}

/** No provider access until the original admission is committed. Never retry a retained attempt. */
export class PaidModelProbeService {
  constructor(private readonly db: Kysely<Database>, private readonly fetcher: typeof fetch = fetch) {}

  async admissionHealth(scope: Scope, key: string, model: string): Promise<ProbeAdmissionHealth> {
    let input: ProbeRequest;
    try { input = request(key,model); } catch { return { spendingStatus:'unquotable',callId:null }; }
    return withRlsContext(this.db,scope,async tx => {
      const held = (await sql<{ id: string }>`SELECT c.id FROM hawa.paid_model_probe_calls c
        WHERE c.tenant_id=${scope.tenantId}::uuid AND c.reconciliation_required AND NOT EXISTS(
          SELECT 1 FROM hawa.call_cost_attestations a WHERE a.tenant_id=c.tenant_id AND a.call_kind='health_probe' AND a.call_id=c.id)
        ORDER BY c.started_at,c.id LIMIT 1`.execute(tx)).rows[0];
      if (held) return { spendingStatus:'reconciliation_required',callId:held.id };
      const daily = (await sql<{ daily: {scopes: Array<{scope:string;subject:string;historyIncomplete:boolean;remainingUsd:number}>} }>`
        SELECT hawa.office_scope_budget() AS daily`.execute(tx)).rows[0]!.daily;
      const scopes = daily.scopes.filter(s=>s.scope==='office'||(s.scope==='role'&&s.subject==='health_probe'));
      if (scopes.length!==2) throw new Error('Paid probe policy unavailable');
      return { spendingStatus: scopes.some(s=>s.historyIncomplete) ? 'history_incomplete' :
        scopes.some(s=>s.remainingUsd<input.reservation.usd) ? 'budget_held' : 'ready',callId:null };
    });
  }

  async execute(scope: Scope, key: string, model: string, intervalMs: number): Promise<ProbeExecution> {
    let input: ProbeRequest;
    try { input = request(key,model); } catch { return { status:'unquotable',callId:null,dispatched:false }; }
    const id = randomUUID();
    try {
      await withRlsContext(this.db,scope,tx=>sql`INSERT INTO hawa.paid_model_probe_calls
        (id,tenant_id,config_sha256,model,interval_ms,reservation,spending_policy_version)
        VALUES(${id}::uuid,${scope.tenantId}::uuid,${input.configSha256},${model},${intervalMs},${JSON.stringify(input.reservation)}::jsonb,1)`.execute(tx));
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const status = message.startsWith('PAID_PROBE_NOT_DUE') ? 'not_due' :
        message.startsWith('PAID_PROBE_RECONCILIATION_REQUIRED') ? 'reconciliation_required' :
        message.startsWith('OFFICE_BUDGET_EXHAUSTED:') ? 'budget_held' :
        message.startsWith('OFFICE_BUDGET_HISTORY_INCOMPLETE:') ? 'history_incomplete' : null;
      if (status) return {status,callId:null,dispatched:false};
      throw error; // An uncertain database commit cannot authorize transport.
    }
    const outcome = await transport(key,input,this.fetcher);
    await withRlsContext(this.db,scope,async tx=>{
      const updated = await sql`UPDATE hawa.paid_model_probe_calls SET status='completed',
        probe_status=${outcome.status},acceptance=${outcome.acceptance},cost_basis=${outcome.costBasis},cost_usd=${outcome.costUsd},
        reconciliation_required=${outcome.requiresReconciliation},input_tokens=${outcome.inputTokens},output_tokens=${outcome.outputTokens},
        provider_request_id=${outcome.providerRequestId},response_id=${outcome.responseId},served_model=${outcome.servedModel},
        response_sha256=${outcome.responseSha256},latency_ms=${outcome.latencyMs}
        WHERE tenant_id=${scope.tenantId}::uuid AND id=${id}::uuid AND status='started'`.execute(tx);
      if (updated.numAffectedRows!==1n) throw new Error('Paid probe outcome was not recorded');
      await sql`INSERT INTO hawa.paid_model_health_observations(tenant_id,provider,schema_version,config_sha256,status)
        VALUES(${scope.tenantId}::uuid,'openai',1,${input.configSha256},${outcome.status})`.execute(tx);
    });
    return {status:outcome.status,callId:id,dispatched:true};
  }
}
