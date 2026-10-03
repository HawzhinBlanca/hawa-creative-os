import { sql, withRlsContext } from '@hawa/db';
import { globalFeedbackMiner, type LearningInventoryItem } from '@hawa/creative';
import type { RouteContext } from './types.js';
import { log } from '../logging.js';
import { approvedRefinementRequest, recordApprovedRefinement } from '../services/approved-refinement-learning.js';
import { CanvaFlowError } from '../services/canva-connect-service.js';
import { authorizedLearningClient, explicitLearningInstruction, moderateLearningRule, moderationInput,
  negativeLearningInput, recordLearningRejection } from '../services/learning-governance.js';
import {instructionActionId,recordLearningInstruction,recoverClientLearning} from '../services/learning-recovery.js';
import { clientRuleEffect } from '../services/rule-effect.js';

/**
 * What the office learns about a client: generation budgets, candidate rules mined from feedback and
 * their promotion into the client's DNA, negative feedback and the learning data lineage. Moved out
 * of app.ts by group G2 (clients and DNA) of the split (architecture programme 1.3, SPLIT_PLAN.md
 * section 2), beside clients.routes.ts.
 */
export function registerClientLearningRoutes(ctx: RouteContext): void {
  const {
    registerRoute,
    verifyRequestAuth,
    problem,
    db,
    resolveClientDna,
    broadcastEvent: broadcast,
  } = ctx;

  // Seeded monthly fixture balances are not the paid-call ledger (ADR-102).
  for (const [method, route] of [
    ['get', '/clients/budgets'], ['get', '/clients/:clientId/budget'],
    ['post', '/clients/:clientId/budget/allocate'],
  ] as const) registerRoute(method, route, (c: any) => {
    c.header('Cache-Control', 'no-store');
    return problem(c, 410, 'Legacy Monthly Budget Retired',
      'Use /v1/spending/policy for audited office, client and role daily limits and /v1/spending/calls for recorded cost evidence. Monthly fixture balances are not billing records.');
  });

  // --- Governed Learning & Studio Feedback Loop Miner (B-055, B-056, B-057) ---
  registerRoute('post', '/feedback/mine', async (c: any) => {
    const auth=verifyRequestAuth(c);
    if (!auth.authenticated || !auth.tenantId || !auth.userId) return problem(c,401,'Unauthorized','An office reviewer is required.');
    if (!['administrator','art_director','creative_director','operator','designer'].includes(auth.role || '')) {
      return problem(c,403,'Forbidden','This role cannot record design learning.');
    }
    if (!db) return problem(c,503,'Database Unavailable','Learning evidence is only held in PostgreSQL.');
    const body = await c.req.json().catch(() => ({}));
    const parsed=approvedRefinementRequest.safeParse(body),actionId=c.req.header('Idempotency-Key');
    if (!parsed.success || !actionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actionId)) {
      return problem(c,422,'Approved Revision Pair Required','Provide task/client/before/after revision UUIDs and a UUID action key. Supplied artboards are not learning evidence.');
    }
    try {
      const saved=await recordApprovedRefinement(db,{tenantId:auth.tenantId,actorId:auth.userId,role:auth.role!},actionId,parsed.data);
      const recovered=await recoverClientLearning(ctx,auth,saved.evidence.clientId);
      const proposed=saved.replayed ? [] : recovered.rules.filter(rule=>rule.provenance.feedbackId===actionId);
      broadcast('feedback:rules_mined',{clientId:saved.evidence.clientId,taskId:saved.evidence.taskId,count:proposed.length});
      return c.json({proposedRules:proposed,count:proposed.length,feedbackId:actionId,replayed:saved.replayed},saved.replayed ? 200 : 201);
    } catch (error) {
      if (error instanceof CanvaFlowError) return problem(c,error.status,error.code,error.message);
      log.error('[learning:refinement] durable evidence/projection failed');
      return problem(c,503,'Learning Evidence Unavailable','The edit evidence could not be admitted; retry the same action key.');
    }
  });

  registerRoute('get', '/clients/:clientId/candidate-rules', async (c: any) => {
    try {
      const auth=verifyRequestAuth(c);
      const clientId=await authorizedLearningClient(ctx,auth,c.req.param('clientId'));
      const state=await recoverClientLearning(ctx,auth,clientId);
      // ADR-291: per active rule, whether code applies it, only a model reads it, or no design reads it.
      // Null without a database or when the read fails; the candidate list does not depend on it.
      const ruleEffect=db ? await clientRuleEffect(db,{tenantId:auth.tenantId!,userId:auth.userId!,role:auth.role!},clientId).catch((error)=>{log.warn(`[learning] rule effect for ${clientId} could not be read: ${error instanceof Error ? error.message : String(error)}`);return null;}) : null;
      return c.json({candidateRules:state.rules,count:state.rules.length,excludedLegacySourceIds:state.excludedLegacySourceIds,ruleEffect},200);
    } catch(error) {return learningFailure(c,error);}
  });

  for (const [action,route] of [
    ['promote','/clients/:clientId/candidate-rules/:ruleId/promote'],
    ['dismiss','/clients/:clientId/candidate-rules/:ruleId/dismiss'],
    ['rollback','/clients/:clientId/candidate-rules/:ruleId/rollback'],
  ] as const) registerRoute('post',route,async(c:any)=>{
    const auth=verifyRequestAuth(c);
    if(!auth.authenticated) return problem(c,401,'Authentication Required','An office reviewer is required.');
    const roles=action==='dismiss' ? ['operator','art_director','creative_director','administrator'] : ['art_director','creative_director','administrator'];
    if(!roles.includes(auth.role || '')) return problem(c,403,'Forbidden','The verified actor cannot perform this action.');
    try {
      const raw=await c.req.text();
      const body=moderationInput.safeParse(raw.trim() ? JSON.parse(raw) : {});
      if(!body.success) return problem(c,422,'Invalid Moderation','Use bounded moderation fields. Role fields cannot change authority.');
      const clientId=await authorizedLearningClient(ctx,auth,c.req.param('clientId'),true);
      const reason=body.data.reason || (action==='promote'?'Human candidate approval':action==='dismiss'?'Candidate dismissed':'Manual rollback of candidate rule');
      const result=await moderateLearningRule(ctx,auth,clientId,c.req.param('ruleId'),action,reason);
      if(!result.replayed) {
        if(result.snapshot) broadcast('dna:snapshot_created',{clientId,version:result.snapshot.version,sha256:result.snapshot.sha256,snapshotId:result.snapshot.snapshotId});
        broadcast(action==='promote'?'dna:rule_promoted':action==='rollback'?'dna:rule_rolled_back':'dna:rule_dismissed',
          {clientId,ruleId:result.rule.id,auditHash:result.auditHash});
      }
      return c.json(result,200);
    } catch(error) {return learningFailure(c,error);}
  });

  registerRoute('post', '/clients/:clientId/candidate-rules/propose', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to propose candidate rules');
    }
    let clientId:string;
    const parsed=explicitLearningInstruction.safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success) return problem(c,422,'Invalid Instruction','Provide bounded text, a supported category and an optional stored task UUID.');
    const {taskId,title,category,ruleText,rationale}=parsed.data;
    try {clientId=await authorizedLearningClient(ctx,auth,c.req.param('clientId'),true);}
    catch(error) {return learningFailure(c,error);}
    if(db) {
      try {
        const actionId=instructionActionId(auth,clientId,parsed.data,c.req.header('Idempotency-Key'));
        const saved=await recordLearningInstruction(db,auth,clientId,actionId,parsed.data);
        const state=await recoverClientLearning(ctx,auth,clientId);
        const proposal=state.rules.find(rule=>rule.provenance.feedbackId===saved.sourceId);
        if(!proposal) throw new Error('Committed instruction was not reconstructed');
        if(!saved.replayed) broadcast('dna:rule_proposed',{clientId,ruleId:proposal.id,title:proposal.title});
        return c.json({proposal,replayed:saved.replayed},saved.replayed?200:201);
      } catch(error) {return learningFailure(c,error);}
    }
    const dna=await resolveClientDna(clientId,{tenantId:auth.tenantId,userId:auth.userId,role:auth.role});
    const proposal=globalFeedbackMiner.proposeExplicitRule({clientId,taskId,title,category,ruleText,
      rationale:rationale || 'Explicit operator guideline proposal',actor:{id:auth.userId!,role:auth.role},
      existingRules:dna?.guidelines?.layoutRules || [],prohibitedPhrases:dna?.guidelines?.prohibitedPhrases || []});
    broadcast('dna:rule_proposed', { clientId, ruleId: proposal.id, title: proposal.title });
    return c.json({ proposal }, 201);
  });

  registerRoute('post', '/clients/:clientId/negative-feedback', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to record negative feedback');
    }
    if(!db) return problem(c,503,'Database Unavailable','Feedback evidence requires PostgreSQL.');
    const parsed=negativeLearningInput.safeParse(await c.req.json().catch(()=>null));
    const actionId=c.req.header('Idempotency-Key');
    if(!parsed.success || !actionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actionId)) {
      return problem(c,422,'Invalid Feedback','Provide a stored task UUID, bounded feedback text and a UUID action key.');
    }
    try {
      const clientId=await authorizedLearningClient(ctx,auth,c.req.param('clientId'),true);
      const saved=await recordLearningRejection(db,auth,clientId,actionId,parsed.data);
      await recoverClientLearning(ctx,auth,clientId);
      if(!saved.replayed) broadcast('feedback:negative_recorded',{clientId,taskId:saved.taskId,feedbackId:saved.feedbackId});
      return c.json({feedbackId:saved.feedbackId,taskId:saved.taskId,negativeExampleRecorded:true,replayed:saved.replayed},saved.replayed?200:201);
    } catch(error) {return learningFailure(c,error);}
  });

  registerRoute('get', '/clients/:clientId/learning/data-lineage', async (c: any) => {
    try {
      const auth=verifyRequestAuth(c);
      const clientId=await authorizedLearningClient(ctx,auth,c.req.param('clientId'));
      const purpose=c.req.query('purpose') || 'client_generation';
      if(!['client_generation','external_fine_tuning','benchmark'].includes(purpose)) return problem(c,422,'Invalid Purpose','Choose a supported retrieval purpose.');
      const inventory=db ? await withRlsContext(db,{tenantId:auth.tenantId!,clientId,userId:auth.userId,role:auth.role},async trx=>{
        const rows=(await sql<{id:string;client_id:string;kind:string;name:string;metadata:{lineage?:unknown}}> `
          SELECT id,client_id,kind,name,metadata FROM hawa.brand_assets
          WHERE tenant_id=${auth.tenantId}::uuid AND client_id=${clientId}::uuid AND status='active' ORDER BY id`.execute(trx)).rows;
        return rows.map(row=>({id:row.id,clientId:row.client_id,type:row.kind,name:row.name,
          lineage:row.metadata?.lineage==='client_owned' || row.metadata?.lineage==='canva_derived_restricted'
            ? row.metadata.lineage : 'rights_unknown'} satisfies LearningInventoryItem));
      }) : [];
      const report=globalFeedbackMiner.evaluateDataRetrievalBoundary(clientId,purpose as 'client_generation'|'external_fine_tuning'|'benchmark',inventory);
      return c.json(report,200);
    } catch(error) {return learningFailure(c,error);}
  });

  function learningFailure(c:any,error:unknown) {
    if(error instanceof CanvaFlowError) return problem(c,error.status,error.code,error.message);
    if(error instanceof SyntaxError) return problem(c,422,'Invalid JSON','Provide valid JSON before changing learning state.');
    log.error('[learning:governance] authoritative operation failed');
    return problem(c,500,'Learning Transaction Failed','Learning state could not be committed. Refresh before retrying.');
  }
}
