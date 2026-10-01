import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FeedbackRepository, sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { canonicalJson } from '@hawa/domain';
import { refinementSnapshotFromManifest, refinementSnapshotHash, type ArtboardSnapshot, type ApprovedRefinementEvidence } from '@hawa/creative';
import { CanvaFlowError } from './canva-connect-service.js';

export const approvedRefinementRequest = z.object({
  clientId:z.string().uuid(), taskId:z.string().uuid(),
  beforeRevisionId:z.string().uuid(), afterRevisionId:z.string().uuid(),
}).strict();

interface StoredRefinement {
  initial: ArtboardSnapshot;
  final: ArtboardSnapshot;
  evidence: ApprovedRefinementEvidence;
  replayed: boolean;
}

/** Read authorized source and append the evidence event in one database transaction. */
export async function recordApprovedRefinement(db:Kysely<Database>, scope:{tenantId:string;actorId:string;role:string},
  actionId:string, input:z.infer<typeof approvedRefinementRequest>):Promise<StoredRefinement> {
  const requestHash=createHash('sha256').update(canonicalJson({tenantId:scope.tenantId,actorId:scope.actorId,input})).digest('hex');
  return withRlsContext(db,{tenantId:scope.tenantId,userId:scope.actorId,role:scope.role},async trx=>{
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${actionId},0))`.execute(trx);
    const task=await trx.selectFrom('tasks').select(['id','client_id','project_id','current_design_revision_id'])
      .where('id','=',input.taskId).where('tenant_id','=',scope.tenantId).forShare().executeTakeFirst();
    if (!task) throw new CanvaFlowError(404,'TASK_NOT_FOUND','No authorized task is available.');
    if (task.client_id!==input.clientId) throw new CanvaFlowError(409,'REFINEMENT_CLIENT_CONFLICT','Learning must use the task client.');
    if (task.current_design_revision_id!==input.afterRevisionId || input.beforeRevisionId===input.afterRevisionId) {
      throw new CanvaFlowError(409,'REFINEMENT_REVISION_CONFLICT','Select an earlier source revision and the current approved revision.');
    }
    const revisions=await trx.selectFrom('design_revisions').selectAll().where('tenant_id','=',scope.tenantId)
      .where('task_id','=',task.id).where('id','in',[input.beforeRevisionId,input.afterRevisionId]).forShare().execute();
    const before=revisions.find(r=>r.id===input.beforeRevisionId),after=revisions.find(r=>r.id===input.afterRevisionId);
    if (!before || !after || before.design_document_id!==after.design_document_id || before.revision>=after.revision) {
      throw new CanvaFlowError(409,'REFINEMENT_REVISION_CONFLICT','Both ordered revisions must belong to this task and document.');
    }
    const approval=await trx.selectFrom('approvals').selectAll().where('tenant_id','=',scope.tenantId)
      .where('task_id','=',task.id).orderBy('created_at','desc').orderBy('id','desc').executeTakeFirst();
    if (after.status!=='approved' || !approval || approval.decision!=='approved' || approval.design_revision_id!==after.id) {
      throw new CanvaFlowError(409,'APPROVED_REFINEMENT_REQUIRED','Learning requires the matching server-recorded approval of the current revision.');
    }
    const qc=await trx.selectFrom('qc_runs').selectAll().where('tenant_id','=',scope.tenantId)
      .where('task_id','=',task.id).where('design_revision_id','=',after.id)
      .orderBy('started_at','desc').orderBy('id','desc').forShare().executeTakeFirst();
    if (approval.decision_payload.sourceHash!==after.source_sha256 || !qc || qc.id!==approval.qc_run_id ||
        qc.status!=='passed' || qc.critical_pass!==true || !qc.report_sha256 ||
        approval.decision_payload.qcReportHash!==qc.report_sha256) {
      throw new CanvaFlowError(409,'REFINEMENT_SOURCE_EVIDENCE_CHANGED','The approved source or current QA evidence no longer matches the recorded decision.');
    }
    let initial:ArtboardSnapshot,final:ArtboardSnapshot;
    try {
      initial=refinementSnapshotFromManifest(task.client_id,task.id,before.neutral_manifest);
      final=refinementSnapshotFromManifest(task.client_id,task.id,after.neutral_manifest);
    } catch {
      throw new CanvaFlowError(422,'REFINEMENT_MANIFEST_UNSUPPORTED','The recorded source nodes cannot support edit mining. Capture a supported source manifest.');
    }
    const evidence:ApprovedRefinementEvidence={feedbackId:actionId,clientId:task.client_id,taskId:task.id,
      beforeRevisionId:before.id,afterRevisionId:after.id,beforeSourceSha256:before.source_sha256,afterSourceSha256:after.source_sha256,
      beforeSnapshotSha256:refinementSnapshotHash(initial),afterSnapshotSha256:refinementSnapshotHash(final),
      approvalId:approval.id,approvedBy:approval.decided_by,actor:{id:scope.actorId,role:scope.role}};
    const existing=await trx.selectFrom('feedback_events').selectAll().where('id','=',actionId)
      .where('tenant_id','=',scope.tenantId).executeTakeFirst();
    if (existing) {
      const target=existing.target as {requestHash?:unknown;refinementEvidence?:ApprovedRefinementEvidence};
      if (existing.client_id!==task.client_id || existing.task_id!==task.id || existing.actor_id!==scope.actorId ||
          existing.explicitness!=='manual_edit' || target.requestHash!==requestHash ||
          target.refinementEvidence?.beforeSnapshotSha256!==evidence.beforeSnapshotSha256 ||
          target.refinementEvidence?.afterSnapshotSha256!==evidence.afterSnapshotSha256 ||
          target.refinementEvidence?.beforeSourceSha256!==evidence.beforeSourceSha256 ||
          target.refinementEvidence?.afterSourceSha256!==evidence.afterSourceSha256 ||
          target.refinementEvidence?.approvalId!==approval.id) {
        throw new CanvaFlowError(409,'REFINEMENT_ACTION_CONFLICT','This action already records different or changed source evidence.');
      }
      // Use the immutable original actor role and source receipts on reconciliation.
      return {initial:existing.original_value as ArtboardSnapshot,final:existing.corrected_value as ArtboardSnapshot,
        evidence:target.refinementEvidence,replayed:true};
    }
    await new FeedbackRepository(trx).recordFeedback({id:actionId,tenantId:scope.tenantId,clientId:task.client_id,
      taskId:task.id,projectId:task.project_id,beforeRevisionId:before.id,afterRevisionId:after.id,
      category:'design_refinement',scope:'one_time',explicitness:'manual_edit',actorId:scope.actorId,
      target:{kind:'approved_revision_pair_v1',requestHash,refinementEvidence:evidence},originalValue:initial,correctedValue:final,
      comment:'Derived from recorded revision manifests and the current server-recorded approval.',confidence:null},trx);
    return {initial,final,evidence,replayed:false};
  });
}
