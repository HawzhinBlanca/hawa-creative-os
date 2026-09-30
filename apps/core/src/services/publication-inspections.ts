import { randomUUID } from 'node:crypto';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { comparePublicationInspection } from '@hawa/domain';
import { SYSTEM_AUTOMATION_USER_ID, type PublicationInspectionInput, type PublicationExternalObservation,
  type PublicationInspector, type PublicationInspectionComparison, type PublicationInspectionState, type PublicationInspectionView } from '@hawa/contracts';

const scope = (tenantId: string) => ({ tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' as const });
type Claim = { id: string; tenant_id: string; publication_id: string; inputs: PublicationInspectionInput; started_at: Date; lease_until: Date };
const interrupted: PublicationInspectionComparison = { status: 'unverified', findings: [], checkedFiles: 0 };
const unavailable = (): PublicationExternalObservation => ({ schemaVersion: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  folder: null, files: [], duplicates: { status: 'unavailable', fileIds: [], code: 'GOOGLE_INSPECTION_UNAVAILABLE' }, sheet: null });

export class PublicationInspectionService {
  constructor(private readonly db: Kysely<Database>, private readonly inspector: PublicationInspector) {}

  async claim(tenantId: string, publicationId?: string): Promise<Claim | null> {
    return withRlsContext(this.db, scope(tenantId), async tx => {
      const candidate = (await sql<{ id: string }>`SELECT p.id FROM hawa.publications p
        JOIN hawa.tasks t ON t.tenant_id=p.tenant_id AND t.id=p.task_id
        LEFT JOIN LATERAL(SELECT i.* FROM hawa.publication_inspections i WHERE i.tenant_id=p.tenant_id AND i.publication_id=p.id
          ORDER BY i.started_at DESC,i.id DESC LIMIT 1) latest ON true
        WHERE p.tenant_id=${tenantId}::uuid AND p.design_revision_id=t.current_design_revision_id AND t.state<>'cancelled' AND p.state<>'cancelled'
          AND (${publicationId ?? null}::uuid IS NULL OR p.id=${publicationId ?? null}::uuid)
          AND (p.state='complete' OR p.updated_at<now()-interval '15 minutes')
          AND NOT EXISTS(SELECT 1 FROM hawa.publications newer WHERE newer.tenant_id=p.tenant_id AND newer.task_id=p.task_id
            AND newer.design_revision_id=p.design_revision_id AND (newer.created_at,newer.id)>(p.created_at,p.id))
          AND (latest.id IS NULL OR latest.state='running' AND latest.lease_until<=now() OR
            latest.slot<date_trunc('hour',now()) OR latest.state='interrupted' AND latest.attempt<3)
          AND NOT (coalesce(latest.state='running' AND latest.lease_until>now(),false))
          AND NOT (coalesce(latest.slot=date_trunc('hour',now()) AND latest.attempt=3 AND latest.state<>'running',false))
        ORDER BY coalesce(latest.started_at,p.created_at),p.id LIMIT 1 FOR UPDATE OF p SKIP LOCKED`.execute(tx)).rows[0];
      if (!candidate) return null;
      // Recheck after acquiring the publication lock: another process may have just claimed it.
      const latest = (await sql<{ id: string; state: string; expired: boolean; current_slot: boolean; attempt: number }>`SELECT id,state,
        lease_until<=now() AS expired,slot=date_trunc('hour',now()) AS current_slot,attempt
        FROM hawa.publication_inspections WHERE tenant_id=${tenantId}::uuid AND publication_id=${candidate.id}::uuid
        ORDER BY started_at DESC,id DESC LIMIT 1`.execute(tx)).rows[0];
      if (latest?.state === 'running') {
        if (!latest.expired) return null;
        await sql`UPDATE hawa.publication_inspections SET state='interrupted',finished_at=date_trunc('milliseconds',transaction_timestamp()),
          report=${JSON.stringify(interrupted)}::jsonb WHERE id=${latest.id}::uuid`.execute(tx);
      }
      if (latest?.current_slot && (latest.attempt >= 3 || ['finished','superseded'].includes(latest.state))) return null;
      const input = (await sql<{ input: PublicationInspectionInput }>`SELECT hawa.publication_inspection_input(${candidate.id}::uuid) AS input`.execute(tx)).rows[0].input;
      if (!input?.clientId) return null;
      const id = randomUUID();
      return (await sql<Claim>`INSERT INTO hawa.publication_inspections(id,tenant_id,publication_id,task_id,client_id,slot,attempt,state,started_at,lease_until,inputs)
        VALUES(${id}::uuid,${tenantId}::uuid,${candidate.id}::uuid,${input.taskId}::uuid,${input.clientId}::uuid,date_trunc('hour',now()),
          ${latest?.current_slot ? latest.attempt + 1 : 1},'running',date_trunc('milliseconds',transaction_timestamp()),
          date_trunc('milliseconds',transaction_timestamp())+interval '2 minutes',${JSON.stringify(input)}::jsonb)
        RETURNING id,tenant_id,publication_id,inputs,started_at,lease_until`.execute(tx)).rows[0];
    });
  }

  async finish(claim: Claim, observation: PublicationExternalObservation): Promise<boolean> {
    const report = comparePublicationInspection(claim.inputs, observation);
    return withRlsContext(this.db, scope(claim.tenant_id), async tx => {
      // Publication -> task -> inspection is the same lock order as claim/expiry.
      const pub = await tx.selectFrom('publications').select(['id','task_id','state','design_revision_id','created_at'])
        .where('tenant_id','=',claim.tenant_id).where('id','=',claim.publication_id).forUpdate().executeTakeFirstOrThrow();
      const task = await tx.selectFrom('tasks').select(['state','current_design_revision_id']).where('tenant_id','=',claim.tenant_id)
        .where('id','=',pub.task_id).forUpdate().executeTakeFirstOrThrow();
      const row = (await sql<{ state: string; expired: boolean; inputs: PublicationInspectionInput; stamp: Date }>`SELECT state,inputs,
        lease_until<=now() AS expired,date_trunc('milliseconds',transaction_timestamp()) AS stamp
        FROM hawa.publication_inspections WHERE tenant_id=${claim.tenant_id}::uuid AND id=${claim.id}::uuid FOR UPDATE`.execute(tx)).rows[0];
      if (!row || row.state !== 'running') return false;
      // The caller's snapshot cannot replace the saved claim, even from a stale service instance.
      const same = (await sql<{ same: boolean }>`SELECT ${JSON.stringify(claim.inputs)}::jsonb=${JSON.stringify(row.inputs)}::jsonb AS same`.execute(tx)).rows[0].same;
      if (!same) throw new Error('PUBLICATION_INSPECTION_INPUT_CONFLICT');
      if (row.expired) {
        await sql`UPDATE hawa.publication_inspections SET state='interrupted',finished_at=${row.stamp},report=${JSON.stringify(interrupted)}::jsonb
          WHERE id=${claim.id}::uuid`.execute(tx); return false;
      }
      // Compare database timestamps in PostgreSQL: JS Date truncates microseconds and
      // can otherwise make the publication appear newer than itself.
      const newer = await tx.selectFrom('publications').select('id').where('tenant_id','=',claim.tenant_id).where('task_id','=',pub.task_id)
        .where('design_revision_id','=',pub.design_revision_id).where(sql<boolean>`(created_at,id)>(SELECT created_at,id FROM hawa.publications
          WHERE tenant_id=${claim.tenant_id}::uuid AND id=${pub.id}::uuid)`).executeTakeFirst();
      const active = pub.state !== 'cancelled' && task.state !== 'cancelled' && task.current_design_revision_id === pub.design_revision_id && !newer;
      // The database clock bounds the observation interval, including credential acquisition.
      const bounded = { ...observation, startedAt: new Date(claim.started_at).toISOString(), finishedAt: new Date(row.stamp).toISOString() };
      await sql`UPDATE hawa.publication_inspections SET state=${active ? 'finished' : 'superseded'},finished_at=${row.stamp},
        observation=${JSON.stringify(bounded)}::jsonb,report=${JSON.stringify(report)}::jsonb WHERE id=${claim.id}::uuid`.execute(tx);
      return active;
    });
  }

  async runPass(tenantId: string, limit = 3): Promise<{ claimed: number; finished: number }> {
    const result = { claimed: 0, finished: 0 };
    for (let i = 0; i < Math.min(Math.max(limit,0),10); i++) {
      const claim = await this.claim(tenantId); if (!claim) break; result.claimed++;
      let observation = unavailable();
      if (claim.inputs.original) {
        try {
          const read = await this.inspector.inspectPublication({ tenantId, actor: { type: 'workflow', id: SYSTEM_AUTOMATION_USER_ID },
            correlationId: claim.id, idempotencyKey: claim.id, deadline: new Date(Date.now()+105_000).toISOString() }, claim.inputs);
          if (Buffer.byteLength(JSON.stringify(read)) <= 512*1024) observation = read;
        } catch { /* Keep the durable claim and record only sanitized uncertainty. */ }
      }
      if (await this.finish(claim, observation)) result.finished++;
    }
    return result;
  }
}

export async function readPublicationInspections(db: Kysely<Database>, actor: { tenantId: string; userId: string; role: string },
  enabled: boolean, after?: string): Promise<PublicationInspectionState> {
  if (after !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(after)) throw new Error('PUBLICATION_INSPECTION_CURSOR_INVALID');
  return withRlsContext(db,actor,async tx => {
    const member = (await sql<{ allowed: boolean }>`SELECT hawa.is_tenant_member(hawa.current_tenant_id()) AS allowed`.execute(tx)).rows[0]?.allowed;
    if (!member) throw new Error('PUBLICATION_INSPECTION_FORBIDDEN');
    const rows = (await sql<{ publication_id: string; task_id: string; client_id: string; id: string | null; state: PublicationInspectionView['state'] | null;
      started_at: Date | null; finished_at: Date | null; inputs_sha256: string | null; result_sha256: string | null; report: PublicationInspectionComparison | null }>`
      SELECT p.id AS publication_id,p.task_id,t.client_id,i.id,i.state,i.started_at,i.finished_at,i.inputs_sha256,i.result_sha256,i.report
      FROM hawa.publications p JOIN hawa.tasks t ON t.tenant_id=p.tenant_id AND t.id=p.task_id
      LEFT JOIN LATERAL(SELECT * FROM hawa.publication_inspections i WHERE i.tenant_id=p.tenant_id AND i.publication_id=p.id
        ORDER BY i.started_at DESC,i.id DESC LIMIT 1) i ON true
      WHERE p.tenant_id=${actor.tenantId}::uuid AND p.design_revision_id=t.current_design_revision_id AND p.state<>'cancelled' AND t.state<>'cancelled'
        AND (${after ?? null}::uuid IS NULL OR p.id>${after ?? null}::uuid)
        AND NOT EXISTS(SELECT 1 FROM hawa.publications newer WHERE newer.tenant_id=p.tenant_id AND newer.task_id=p.task_id
          AND newer.design_revision_id=p.design_revision_id AND (newer.created_at,newer.id)>(p.created_at,p.id))
      ORDER BY p.id LIMIT 51`.execute(tx)).rows;
    return { schemaVersion:1,tenantId:actor.tenantId,userId:actor.userId,checkedAt:new Date().toISOString(),schedule:{enabled,intervalMinutes:60},
      nextAfter:rows.length>50?rows[49].publication_id:null,items:rows.slice(0,50).map(r=>({publicationId:r.publication_id,taskId:r.task_id,clientId:r.client_id,
        inspectionId:r.id,state:r.state??'uninspected',
        status:r.state==='finished'&&r.report&&(r.report.status==='divergent'||r.finished_at&&Date.now()-new Date(r.finished_at).getTime()<2*60*60_000)?r.report.status:'unverified',
        stale:!r.finished_at||Date.now()-new Date(r.finished_at).getTime()>=2*60*60_000,
        startedAt:r.started_at?new Date(r.started_at).toISOString():null,finishedAt:r.finished_at?new Date(r.finished_at).toISOString():null,
        inputsSha256:r.inputs_sha256,resultSha256:r.result_sha256,checkedFiles:r.report?.checkedFiles??0,findings:r.report?.findings??[]})) };
  });
}

/**
 * Why a pass failed, for the log: the error's class, code and first line, with addresses and long
 * token-like strings taken out (a provider's message can carry a signed URL). A pass used to log only
 * "not confirmed", and the 2026-09-30 failures could not be told apart from the Postgres outage.
 */
export function inspectionFailureCause(err: unknown): string {
  if (!(err instanceof Error)) return `non-error ${typeof err}`;
  const code = (err as { code?: unknown }).code;
  const first = (err.message || '').split('\n')[0].replace(/https?:\/\/\S+/g, '<url>').replace(/[A-Za-z0-9_.~+/-]{32,}=*/g, '<redacted>').slice(0, 160);
  return `${err.name}${typeof code === 'string' || typeof code === 'number' ? ` ${code}` : ''}: ${first || '(no message)'}`;
}

/** Timer is merely a wakeup. PostgreSQL determines whether any work is due. */
export function startPublicationInspectionSchedule(service: PublicationInspectionService, tenantId: string, onError: (cause: string) => void) {
  let running = false;
  const pass = async () => { if (running) return; running = true; try { await service.runPass(tenantId); } catch (err) { onError(inspectionFailureCause(err)); } finally { running = false; } };
  const timer = setInterval(() => { void pass(); },60_000); timer.unref?.();
  const initial = setTimeout(() => { void pass(); },30_000); initial.unref?.();
  return () => { clearInterval(timer); clearTimeout(initial); };
}
