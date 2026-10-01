import {createHash} from 'node:crypto';
import {z} from 'zod';
import {canonicalJson,type ClientDNA} from '@hawa/domain';
import {FeedbackRepository,sql,withRlsContext,type Database,type Kysely} from '@hawa/db';
import {FeedbackMiner,globalFeedbackMiner,type ArtboardSnapshot,type ApprovedRefinementEvidence,
  type CandidateRuleProposal,type DesignFeedbackRecord} from '@hawa/creative';
import type {AuthContext,RouteContext} from '../routes/types.js';
import {explicitLearningInstruction} from './learning-inputs.js';
import {CanvaFlowError} from './canva-connect-service.js';
const hex=z.string().regex(/^[0-9a-f]{64}$/i),text=z.string().min(1);
const actor=z.object({id:text,role:z.string().optional(),name:z.string().optional()});
const proposalSchema=z.object({
  id:text.max(200),clientId:text,title:text.max(200),category:z.enum(['typography','palette','copy_token','layout']),
  ruleText:text.max(24000),rationale:z.string().max(4000),frequency:z.number().int().positive(),confidence:z.number().min(0).max(1),
  status:z.enum(['PROPOSED','PROMOTED','DISMISSED']),scope:z.enum(['task_scoped','client_scoped']),
  explicitness:z.enum(['explicit_operator_instruction','inferred_ast_delta']),sha256Digest:hex,
  dataLineage:z.enum(['client_owned','canva_derived_restricted']),evidenceTaskIds:z.array(text),conflicts:z.array(z.string()),
  examples:z.object({positiveExampleTaskIds:z.array(text),negativeExampleTaskIds:z.array(text)}),
  provenance:z.object({clientId:text,taskId:text.optional(),feedbackId:text.optional(),sourcePlatform:z.string().optional(),
    actor:actor.optional(),recordedAt:z.string().datetime()}),
  promotedByRole:z.enum(['art_director','creative_director','administrator']).optional(),promotedAt:z.string().datetime().optional(),
}).passthrough();
type Instruction=z.infer<typeof explicitLearningInstruction>;
function instructionPayload(input:Instruction) {
  return {title:input.title,category:input.category,ruleText:input.ruleText,
    ...(input.taskId?{taskId:input.taskId}:{}),rationale:input.rationale ?? 'Explicit operator guideline proposal'};
}
function instructionHash(tenantId:string,clientId:string,actorId:string,input:Instruction) {
  return createHash('sha256').update(canonicalJson({tenantId,clientId,actorId,input:instructionPayload(input)})).digest('hex');
}
/** Older callers receive a stable content-derived action, rather than a fresh key on retry. */
export function instructionActionId(auth:AuthContext,clientId:string,input:Instruction,provided?:string) {
  if(provided) {
    if(!z.string().uuid().safeParse(provided).success) throw new CanvaFlowError(422,'Invalid Instruction Action','Use a UUID action key.');
    return provided;
  }
  const hash=instructionHash(auth.tenantId!,clientId,auth.userId!,input);
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
export async function recordLearningInstruction(db:Kysely<Database>,auth:AuthContext,clientId:string,actionId:string,input:Instruction) {
  const hash=instructionHash(auth.tenantId!,clientId,auth.userId!,input);
  return withRlsContext(db,{tenantId:auth.tenantId!,clientId,userId:auth.userId,role:auth.role},async trx=>{
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${actionId},0))`.execute(trx);
    if(input.taskId) {
      const task=await trx.selectFrom('tasks').select('client_id').where('tenant_id','=',auth.tenantId!).where('id','=',input.taskId).forShare().executeTakeFirst();
      if(!task || task.client_id!==clientId) throw new CanvaFlowError(409,'Instruction Task Conflict','The task does not belong to this instruction client.');
    }
    const existing=await trx.selectFrom('feedback_events').selectAll().where('tenant_id','=',auth.tenantId!).where('id','=',actionId).executeTakeFirst();
    if(existing) {
      const target=existing.target as {kind?:unknown;requestHash?:unknown};
      if(existing.client_id!==clientId || existing.actor_id!==auth.userId || existing.category!=='client_rule_instruction' ||
        target.kind!=='client_rule_instruction_v1' || target.requestHash!==hash) {
        throw new CanvaFlowError(409,'Instruction Action Conflict','This action already records a different instruction.');
      }
      return {replayed:true,sourceId:existing.id};
    }
    const saved=await new FeedbackRepository(trx).recordFeedback({id:actionId,tenantId:auth.tenantId!,clientId,
      taskId:input.taskId,category:'client_rule_instruction',scope:'client',explicitness:'direct_instruction',actorId:auth.userId,
      target:{kind:'client_rule_instruction_v1',requestHash:hash,input:instructionPayload(input),actorRole:auth.role},
      comment:input.rationale ?? 'Explicit operator guideline proposal',confidence:null},trx);
    return {replayed:false,sourceId:saved.id};
  });
}
interface SourceRow {kind:'ledger'|'studio';id:string;created_at:Date|string;data:Record<string,unknown>}
const iso=(date:Date|string)=>new Date(date).toISOString();
/** Read all source types in one scoped statement; database order is reproducible. No provider calls. */
export async function reconstructClientLearning(trx:Kysely<Database>,tenantId:string,clientId:string,dna?:ClientDNA) {
  // One MVCC statement keeps the source, moderation and DNA views mutually consistent.
  const bundle=(await sql<{sources:SourceRow[];audits:{resource_id:string;data:{proposal:unknown;ruleRevision?:number}}[];dna:ClientDNA|null}>`
    WITH sources AS (
      SELECT 'ledger'::text AS kind,f.id,f.created_at,to_jsonb(f) AS data FROM hawa.feedback_events f
        WHERE f.tenant_id=${tenantId}::uuid AND f.client_id=${clientId}::uuid
          AND f.category IN ('design_refinement','design_rejection','client_rule_instruction')
      UNION ALL
      SELECT 'studio'::text AS kind,f.id,f.created_at,to_jsonb(f) AS data FROM hawa.design_feedback f
        JOIN hawa.tasks t ON t.id=f.task_id AND t.tenant_id=f.tenant_id
        WHERE f.tenant_id=${tenantId}::uuid AND coalesce(f.client_id,t.client_id)=${clientId}::uuid
          AND t.client_id=${clientId}::uuid
    ), audits AS (
      SELECT DISTINCT ON (resource_id) resource_id,data FROM hawa.audit_events
      WHERE tenant_id=${tenantId}::uuid AND client_id=${clientId}::uuid AND task_id IS NULL
        AND resource_type='candidate_rule' AND action IN ('client_rule.promoted','client_rule.dismissed','client_rule.rolled_back')
      ORDER BY resource_id,coalesce((data->>'ruleRevision')::integer,0) DESC,occurred_at DESC,id DESC
    ) SELECT
      coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY created_at,id,kind) FROM sources s),'[]'::jsonb) AS sources,
      coalesce((SELECT jsonb_agg(to_jsonb(a)) FROM audits a),'[]'::jsonb) AS audits,
      (SELECT v.dna FROM hawa.client_dna_versions v WHERE v.tenant_id=${tenantId}::uuid
        AND v.client_id=${clientId}::uuid AND v.status='active') AS dna`.execute(trx)).rows[0];
  const sources=bundle.sources,audits=bundle.audits;
  dna=bundle.dna ?? dna;
  const excludedLegacySourceIds:string[]=[];
  const miner=new FeedbackMiner();
  for(const source of sources) {
    const row=source.data,createdAt=iso(source.created_at);
    if(source.kind==='studio') {
      miner.ingestDesignFeedback({id:source.id,tenantId,clientId,taskId:String(row.task_id),
        runId:row.run_id as string|null,candidateId:row.candidate_id as string|null,actorId:String(row.actor_id),
        ...(typeof row.actor_role==='string'?{actorRole:row.actor_role}:{}),source:row.source as DesignFeedbackRecord['source'],
        verdict:row.verdict as DesignFeedbackRecord['verdict'],rating:row.rating===null?null:Number(row.rating),
        notes:row.notes as string|null,createdAt});
      continue;
    }
    const target=row.target as {kind?:unknown;input?:unknown;requestHash?:unknown;actorRole?:string;refinementEvidence?:ApprovedRefinementEvidence};
    if(row.client_id!==clientId || !row.actor_id) throw new Error('Learning ledger scope/actor is missing');
    if(!target || target.kind===undefined) {excludedLegacySourceIds.push(source.id);continue;}
    if(target.kind==='client_rule_instruction_v1') {
      const input=explicitLearningInstruction.parse(target.input);
      if(target.requestHash!==instructionHash(tenantId,clientId,String(row.actor_id),input)) throw new Error('Learning instruction hash conflict');
      miner.proposeExplicitRule({...input,clientId,sourceId:source.id,recordedAt:createdAt,
        rationale:input.rationale ?? 'Explicit operator guideline proposal',actor:{id:String(row.actor_id),role:target.actorRole}});
    } else if(target.kind==='approved_revision_pair_v1') {
      const evidence=target.refinementEvidence;
      if(!evidence || evidence.feedbackId!==source.id || evidence.clientId!==clientId || evidence.taskId!==row.task_id ||
        evidence.actor.id!==row.actor_id) throw new Error('Recorded refinement source scope conflict');
      miner.ingestTaskRefinements(clientId,String(row.task_id),row.original_value as ArtboardSnapshot,
        row.corrected_value as ArtboardSnapshot,evidence,createdAt);
    } else if(target.kind==='task_rejection_v1') {
      miner.ingestDesignFeedback({id:source.id,tenantId,clientId,taskId:String(row.task_id),actorId:String(row.actor_id),
        actorRole:target.actorRole,source:'desk',verdict:'reject',notes:row.comment as string,createdAt});
    } else if(target.kind===undefined) excludedLegacySourceIds.push(source.id);
    else throw new Error('Stored learning source is unsupported; no evidence was invented');
  }
  for(const audit of audits) {
    const rule=proposalSchema.parse(audit.data.proposal) as CandidateRuleProposal;
    if(rule.id!==audit.resource_id || rule.clientId!==clientId) throw new Error('Stored moderation identity/scope conflict');
    miner.reconcileRecordedRule(clientId,rule,audit.data.ruleRevision ?? 0);
  }
  const rules=miner.getCandidateRules(clientId);
  for(const rule of rules) {
    if(rule.status==='PROMOTED' && !dna?.guidelines?.layoutRules?.includes(rule.ruleText)) {
      throw new CanvaFlowError(409,'Learning DNA Conflict','A recorded active candidate is missing from current client DNA. Review the saved versions.');
    }
    if(rule.status==='PROPOSED' && dna) rule.conflicts=miner.detectConflicts(rule.ruleText,dna.guidelines?.layoutRules ?? [],dna.guidelines?.prohibitedPhrases ?? []);
  }
  return {miner,rules,sourceCount:sources.length,excludedLegacySourceIds};
}
/** A read result becomes a local convenience projection only after the actual transaction. */
export async function recoverClientLearning(ctx:RouteContext,auth:AuthContext,clientId:string) {
  if(!ctx.db) return {miner:globalFeedbackMiner,rules:globalFeedbackMiner.getCandidateRules(clientId),sourceCount:0,excludedLegacySourceIds:[] as string[]};
  try {
    const state=await withRlsContext(ctx.db,{tenantId:auth.tenantId!,clientId,userId:auth.userId,role:auth.role},
      trx=>reconstructClientLearning(trx,auth.tenantId!,clientId));
    globalFeedbackMiner.adoptClientProjection(clientId,state.miner);
    return state;
  } catch(error) {
    if(error instanceof CanvaFlowError) throw error;
    throw new CanvaFlowError(503,'Learning Recovery Unavailable',
      'Stored learning could not be rebuilt. Retry the same action key or refresh the candidate queue.');
  }
}
