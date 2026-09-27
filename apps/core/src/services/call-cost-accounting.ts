import { createHash } from 'node:crypto';
import { sql, withRlsContext, type Kysely, type Database, type RlsContext } from '@hawa/db';
import { parseEvaluationSettlement } from '@hawa/domain';
import type { CallCostDetail, CallCostEvidence, CallCostKind, CallCostPage } from '@hawa/contracts';
import { lockNamedOfficeAdministrator } from './named-review-authority.js';
import { CanvaFlowError } from './canva-flow-error.js';

type Scope = RlsContext & { userId: string; sessionHash?: string };
type Receipt = { id: string; revision: number; request_hash: string; actor_user_id: string; recorded_at: Date };
type PageKey = { startedAt: string; kind: CallCostKind; id: string };
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const kindOf = (v: unknown): v is CallCostKind => ['studio','evaluation','voice','health_probe','canva_planner'].includes(String(v));
const fail = (status: number, code: string, message: string): never => { throw new CanvaFlowError(status, code, message); };
const receiptView = (r: Receipt) => ({ id:r.id, revision:r.revision, actorUserId:r.actor_user_id, recordedAt:new Date(r.recorded_at).toISOString() });

/** Records financial evidence only. No provider, workflow, or task-control dependency. */
export class CallCostAccountingService {
  constructor(private db: Kysely<Database>) {}
  private scoped<T>(s: Scope, fn: (tx: Kysely<Database>) => Promise<T>) { return withRlsContext(this.db,s,fn); }
  private async evidence(tx: Kysely<Database>, kind: string, id: string): Promise<CallCostEvidence> {
    if (!kindOf(kind) || !uuid(id)) return fail(400,'CALL_COST_INVALID','Use a saved call kind and ID.');
    const row = (await sql<{ evidence:CallCostEvidence|null }>`SELECT hawa.office_call_cost_evidence(${kind},${id}::uuid) AS evidence`.execute(tx)).rows[0];
    return row.evidence ?? fail(404,'CALL_COST_NOT_FOUND','Call cost evidence was not found in this office.');
  }
  async get(s: Scope, kind: string, id: string): Promise<CallCostDetail> {
    return this.scoped(s,async tx => ({ ...await this.evidence(tx,kind,id),
      canRecord:!!s.sessionHash && await lockNamedOfficeAdministrator(tx,{...s,sessionHash:s.sessionHash}) }));
  }
  async list(s: Scope, cursor?: string): Promise<CallCostPage> {
    let before: PageKey | null = null;
    if (cursor) {
      if (cursor.length>500) return fail(400,'CALL_COST_INVALID','Reload the first page of call costs.');
      try { before=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')) as PageKey; } catch { /* checked below */ }
      if (!before || !uuid(before.id) || !kindOf(before.kind) || typeof before.startedAt!=='string' ||
        !/^\d{4}-\d{2}-\d{2}T/.test(before.startedAt) || !Number.isFinite(Date.parse(before.startedAt)))
        return fail(400,'CALL_COST_INVALID','Reload the first page of call costs.');
    }
    return this.scoped(s,async tx => {
      const page=(await sql<{ page:PageKey[] }>`SELECT hawa.office_call_cost_page(${before?.startedAt??null}::timestamptz,
        ${before?.kind??null},${before?.id??null}::uuid) AS page`.execute(tx)).rows[0].page;
      const keys=page.slice(0,50);
      const items=(await sql<{evidence:CallCostEvidence}>`SELECT hawa.office_call_cost_evidence(p.kind,p.id) AS evidence
        FROM jsonb_to_recordset(${JSON.stringify(keys)}::jsonb) AS p(kind text,id uuid,"startedAt" timestamptz)
        ORDER BY p."startedAt" DESC,p.kind DESC,p.id DESC`.execute(tx)).rows.map(row=>row.evidence);
      const last=keys.at(-1);
      return {items,nextCursor:page.length>50&&last ? Buffer.from(JSON.stringify(last)).toString('base64url') : null};
    });
  }
  async record(s: Scope, kind: string, id: string, actionId: unknown, body: unknown) {
    const input=parseEvaluationSettlement(body);
    if (!kindOf(kind)||!uuid(id)||!uuid(actionId)||!input||input.calls.length!==1||input.calls[0].callId!==id)
      return fail(400,'CALL_COST_INVALID','Supply the exact call, current snapshot, reason and terminal provider evidence with a known final cost.');
    if (!s.sessionHash) return fail(403,'NAMED_ADMINISTRATOR_REQUIRED','Sign in as a named office administrator.');
    const requestHash=createHash('sha256').update(JSON.stringify({kind,id,actorId:s.userId,...input})).digest('hex');
    try {
      return await this.scoped(s,async tx => {
        if (!await lockNamedOfficeAdministrator(tx,{...s,sessionHash:s.sessionHash!}))
          return fail(403,'NAMED_ADMINISTRATOR_REQUIRED','The named administrator session or membership is no longer active.');
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`call-cost:${s.tenantId}:${actionId}`},0))`.execute(tx);
        const prior=(await sql<Receipt>`SELECT * FROM hawa.call_cost_attestations WHERE tenant_id=${s.tenantId}::uuid AND action_id=${actionId}::uuid`.execute(tx)).rows[0];
        if (prior) {
          if (prior.request_hash!==requestHash) return fail(409,'CALL_COST_ACTION_CONFLICT','This action already records different evidence. Retry its original inputs.');
          return {replayed:true,receipt:receiptView(prior)};
        }
        const observed=await this.evidence(tx,kind,id), call=input.calls[0];
        await sql`SELECT set_config('hawa.call_cost_session_hash',${s.sessionHash},true)`.execute(tx);
        const row=(await sql<Receipt>`INSERT INTO hawa.call_cost_attestations
          (tenant_id,call_kind,call_id,revision,action_id,actor_user_id,request_hash,snapshot_hash,reason,
           conclusion,reported_cost_usd,evidence_reference,evidence_sha256)
          VALUES(${s.tenantId}::uuid,${kind},${id}::uuid,${observed.revision+1},${actionId}::uuid,${s.userId}::uuid,
            ${requestHash},${input.expectedSnapshot},${input.reason},${call.conclusion},${call.reportedCostUsd},${call.evidenceReference},${call.evidenceSha256}) RETURNING *`.execute(tx)).rows[0];
        return {replayed:false,receipt:receiptView(row)};
      });
    } catch (error) {
      if (error instanceof Error && error.message==='CALL_COST_SNAPSHOT_CHANGED')
        return fail(409,'CALL_COST_SNAPSHOT_CHANGED','The call or its accounting changed. Reload it before recording corrected evidence.');
      if (error instanceof Error && error.message==='CALL_COST_CONTRADICTORY_EVIDENCE')
        return fail(409,'CALL_COST_CONTRADICTORY_EVIDENCE','The original call already proves acceptance or a charge. Review the conflicting evidence.');
      throw error;
    }
  }
}
