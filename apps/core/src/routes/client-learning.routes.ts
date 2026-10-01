import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withRlsContext, sql } from '@hawa/db';
import { globalFeedbackMiner, type CandidateRuleProposal } from '@hawa/creative';
import { KAAE_CLIENT_ID } from '@hawa/integrations';
import type { ClientDnaSnapshot, RouteContext } from './types.js';
import { DEFAULT_TENANT_ID, OPERATOR_USER_ID } from '../core-context.js';
import { computeDnaHash } from '../core-helpers.js';
import { log } from '../logging.js';
import { findClientRowId } from '../services/client-row.js';
import { approvedRefinementRequest, recordApprovedRefinement } from '../services/approved-refinement-learning.js';
import { CanvaFlowError } from '../services/canva-connect-service.js';

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
    clientRepo,
    clientDnas,
    clientSnapshots,
    resolveClientDna,
    options,
    broadcastEvent: broadcast,
  } = ctx;
  const defaultTenantId = DEFAULT_TENANT_ID;
  const operatorUserId = OPERATOR_USER_ID;

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
      const proposed=globalFeedbackMiner.ingestTaskRefinements(saved.evidence.clientId,saved.evidence.taskId,saved.initial,saved.final,saved.evidence);
      broadcast('feedback:rules_mined',{clientId:saved.evidence.clientId,taskId:saved.evidence.taskId,count:proposed.length});
      return c.json({proposedRules:proposed,count:proposed.length,feedbackId:actionId,replayed:saved.replayed},saved.replayed ? 200 : 201);
    } catch (error) {
      if (error instanceof CanvaFlowError) return problem(c,error.status,error.code,error.message);
      log.error('[learning:refinement] durable evidence/projection failed');
      return problem(c,503,'Learning Evidence Unavailable','The edit evidence could not be admitted; retry the same action key.');
    }
  });

  registerRoute('get', '/clients/:clientId/candidate-rules', (c: any) => {
    const clientId = c.req.param('clientId');
    const rules = globalFeedbackMiner.getCandidateRules(clientId);
    return c.json({ candidateRules: rules, count: rules.length }, 200);
  });

  registerRoute('post', '/clients/:clientId/candidate-rules/:ruleId/promote', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to promote candidate rules');
    }

    const { clientId, ruleId } = c.req.param();

    let body: any = {};
    try {
      body = await c.req.json();
    } catch {
      // Body may be empty or not json
    }
    const requestedRole = typeof body?.role === 'string' ? body.role.trim().toLowerCase() : undefined;
    if (requestedRole && requestedRole !== 'art_director' && requestedRole !== 'creative_director' && requestedRole !== 'administrator') {
      return problem(c, 403, 'Forbidden', `Role '${requestedRole}' is not authorized to promote candidate rules`);
    }

    const effectiveRole = requestedRole || (auth.actorId === 'test_harness' ? 'art_director' : auth.role);
    if (effectiveRole !== 'art_director' && effectiveRole !== 'creative_director' && effectiveRole !== 'administrator') {
      return problem(c, 403, 'Forbidden', 'Only art_director, creative_director, or administrator can promote candidate rules');
    }
    if (auth.role !== 'art_director' && auth.role !== 'creative_director' && auth.role !== 'administrator' && auth.actorId !== 'test_harness') {
      return problem(c, 403, 'Forbidden', 'Caller role not authorized to promote candidate rules');
    }

    // SA-02: Verify candidate rule exists and verify cross-client boundary BEFORE promotion
    const existingRule = globalFeedbackMiner.getCandidateRules().find((r) => r.id === ruleId);
    if (!existingRule) {
      return problem(c, 404, 'Not Found', `Candidate rule ${ruleId} not found`);
    }
    const normalizeCode = (id: string) => id.replace(/^client-/, '');
    if (normalizeCode(existingRule.clientId) !== normalizeCode(clientId)) {
      return problem(c, 403, 'Forbidden', `Cross-client violation: candidate rule ${ruleId} belongs to '${existingRule.clientId}' and cannot be promoted into '${clientId}'`);
    }

    // 1. Resolve targetId in authoritative DB before mutating proposal state or active DNA
    let targetId: string | undefined = undefined;
    const tenantId = auth.tenantId || defaultTenantId;

    if (db && clientRepo) {
      // Inside a row-level-security context: outside one a client code finds nothing (services/client-row.ts).
      targetId = await findClientRowId(db, clientRepo, { tenantId, userId: auth.userId || operatorUserId, role: auth.role || 'administrator' }, clientId);
      if (!targetId) {
        return problem(c, 404, 'Client Not Found', `Client '${clientId}' not found in authoritative database`);
      }
    }

    const priorStatus = existingRule.status;
    const promoteRole = (effectiveRole === 'administrator' ? 'creative_director' : effectiveRole) as 'art_director' | 'creative_director';
    const result = globalFeedbackMiner.prepareRulePromotion(ruleId, promoteRole);
    if (!result.promoted) {
      if (result.reason === 'CONFLICTING_RULES_PENDING') {
        return problem(c, 409, 'Conflict', 'Candidate rule has unresolved conflicts with existing guidelines and remains pending');
      }
      return problem(c, 404, 'Not Found', `Candidate rule ${ruleId} not found`);
    }

    // Attach to active client DNA and commit immutable snapshot
    const currentDna = await resolveClientDna(clientId, { tenantId: auth.tenantId, userId: auth.userId, role: auth.role });
    if (db && !currentDna) return problem(c,409,'Client DNA Required','Save the client DNA before promoting a rule.');
    if (currentDna && result.rule) {
      let candidateDna = structuredClone(currentDna);
      if (!candidateDna.guidelines) {
        candidateDna.guidelines = { voiceAndTone: '', prohibitedPhrases: [], requiredDisclaimers: [], layoutRules: [] };
      }
      if (!candidateDna.guidelines.layoutRules) {
        candidateDna.guidelines.layoutRules = [];
      }
      if (!candidateDna.guidelines.layoutRules.includes(result.rule.ruleText)) {
        candidateDna.guidelines.layoutRules.push(result.rule.ruleText);
      }

      candidateDna.version = (candidateDna.version || 1) + 1;
      candidateDna.updatedAt = new Date().toISOString();

      let hash = computeDnaHash(candidateDna);
      const snap: ClientDnaSnapshot = {
        snapshotId: `snap_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        clientId,
        version: candidateDna.version,
        sha256: hash,
        commitMessage: `Promoted candidate rule "${result.rule.title}" (Role: ${effectiveRole})`,
        createdBy: auth.userId || effectiveRole,
        createdAt: new Date().toISOString(),
        dna: structuredClone(candidateDna),
      };

      if (db && clientRepo && targetId) {
        let replayedPromotion:{proposal:CandidateRuleProposal;auditHash:string}|undefined;
        try {
          await withRlsContext(db, { tenantId, clientId: targetId, userId: auth.userId || operatorUserId, role: auth.role || 'administrator' }, async (trx) => {
            await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`client-rule-promotion:${tenantId}:${targetId}`},0))`.execute(trx);
            // Another rule may have committed while this request waited for the lock.
            // Read authoritative DNA on this connection before composing the new version.
            const active=await clientRepo.findActiveDna(tenantId,targetId,trx);
            const baseDna=active ? (typeof active.dna==='string' ? JSON.parse(active.dna) : active.dna) as typeof currentDna : currentDna;
            candidateDna=structuredClone(baseDna);
            const replay=(await sql<{data:{proposal:CandidateRuleProposal;activation:{auditHash:string}}}>`
              SELECT a.data FROM hawa.audit_events a JOIN hawa.client_dna_versions d
                ON d.id=(a.data->>'dnaVersionId')::uuid AND d.tenant_id=a.tenant_id AND d.client_id=a.client_id
              WHERE a.tenant_id=${tenantId}::uuid AND a.client_id=${targetId}::uuid AND a.resource_id=${ruleId}
                AND a.action='client_rule.promoted'
              ORDER BY a.occurred_at DESC LIMIT 1`.execute(trx)).rows[0];
            if (replay && candidateDna.guidelines?.layoutRules?.includes(replay.data.proposal.ruleText)) {
              replayedPromotion={proposal:replay.data.proposal,auditHash:replay.data.activation.auditHash};return;
            }
            candidateDna.guidelines ||= {voiceAndTone:'',prohibitedPhrases:[],requiredDisclaimers:[],layoutRules:[]};
            candidateDna.guidelines.layoutRules ||= [];
            if (!candidateDna.guidelines.layoutRules.includes(result.rule!.ruleText)) candidateDna.guidelines.layoutRules.push(result.rule!.ruleText);
            candidateDna.version=(active?.version ?? candidateDna.version ?? 1)+1;
            candidateDna.updatedAt=new Date().toISOString();
            let maxDbVer = 0;
            const existingSnaps = await clientRepo.listDnaSnapshots(tenantId, targetId, trx);
            if (existingSnaps && existingSnaps.length > 0) {
              maxDbVer = Math.max(...existingSnaps.map((s: any) => s.version));
            }
            if (maxDbVer >= candidateDna.version) {
              candidateDna.version = maxDbVer + 1;
            }
            hash=computeDnaHash(candidateDna);
            snap.version=candidateDna.version;snap.sha256=hash;snap.dna=structuredClone(candidateDna);
            const dnaVersion=await clientRepo.saveDnaVersion({
              tenantId,
              clientId: targetId,
              version: candidateDna.version,
              dna: { ...candidateDna, __commitMessage: snap.commitMessage, __createdBy: snap.createdBy },
              contentHash: hash,
              createdBy: (auth.userId && auth.userId.length === 36) ? auth.userId : null,
              approvedBy: (auth.userId && auth.userId.length === 36) ? auth.userId : null,
              expectedVersion: active?.version ?? 0,
            }, trx);
            // This immutable audit is part of the same commit as the active DNA version.
            const rule=result.rule!;
            const evidence={schemaVersion:1,dnaVersionId:dnaVersion.id,dnaVersion:dnaVersion.version,
              proposal:structuredClone(rule),activation:{actorId:auth.userId,role:auth.role,auditHash:result.auditHash}};
            await sql`INSERT INTO hawa.audit_events(tenant_id,actor_type,actor_id,action,resource_type,resource_id,client_id,
              before_hash,after_hash,data) VALUES(${tenantId}::uuid,'user',${auth.userId || null},'client_rule.promoted',
              'candidate_rule',${rule.id},${targetId}::uuid,${computeDnaHash(baseDna)},${hash},${JSON.stringify(evidence)}::jsonb)`.execute(trx);

          });
          if (replayedPromotion) {
            const replay={promoted:true,rule:replayedPromotion.proposal,auditHash:replayedPromotion.auditHash,replayed:true};
            globalFeedbackMiner.commitRulePromotion(replay);
            return c.json(replay,200);
          }
        } catch (err: any) {
          globalFeedbackMiner.restoreRuleStatus(ruleId, priorStatus);
          return problem(c, 500, 'Database Transaction Failed', err.message || 'Failed to persist candidate rule promotion to database');
        }
      }

      clientDnas.set(clientId, candidateDna);
      // With a database the snapshot is the version just saved; the map is the store only without one.
      if (!db) {
        const list = clientSnapshots.get(clientId) || [];
        list.unshift(snap);
        clientSnapshots.set(clientId, list);
      }

      broadcast('dna:snapshot_created', { clientId, version: candidateDna.version, sha256: hash, snapshotId: snap.snapshotId });
    }

    // Persist to disk ONLY if explicitly enabled in options AND specifically matching clientId
    if (options?.persistDnaToDisk && (clientId === KAAE_CLIENT_ID || clientId === 'client-kaae')) {
      try {
        const dnaCandidates = [
          path.join(process.cwd(), 'config', 'clients', 'kaae.dna.json'),
          path.join(process.cwd(), '..', '..', 'config', 'clients', 'kaae.dna.json'),
          '/app/config/clients/kaae.dna.json',
        ];
        const dnaPath = dnaCandidates.find((p) => fs.existsSync(p));
        if (!dnaPath) log.warn(`[Core] The promoted rule was not written to kaae.dna.json: no copy of it here (${dnaCandidates.join(', ')}).`);
        if (dnaPath && result.rule) {
          const dnaContent = JSON.parse(fs.readFileSync(dnaPath, 'utf-8'));
          if (!dnaContent.guidelines) dnaContent.guidelines = {};
          if (!Array.isArray(dnaContent.guidelines.layoutRules)) dnaContent.guidelines.layoutRules = [];
          if (!dnaContent.guidelines.layoutRules.includes(result.rule.ruleText)) {
            dnaContent.guidelines.layoutRules.push(result.rule.ruleText);
            dnaContent.version = (dnaContent.version || 1) + 1;
            dnaContent.updatedAt = new Date().toISOString();
            fs.writeFileSync(dnaPath, JSON.stringify(dnaContent, null, 2), 'utf-8');
          }
        }
      } catch (dnaErr) {
        log.warn('[Core] Failed to update client DNA JSON on disk:', dnaErr);
      }
    }

    globalFeedbackMiner.commitRulePromotion(result);
    broadcast('dna:rule_promoted', { clientId, ruleId, auditHash: result.auditHash });
    return c.json(result, 200);
  });

  registerRoute('post', '/clients/:clientId/candidate-rules/:ruleId/dismiss', (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to dismiss candidate rules');
    }
    const { clientId, ruleId } = c.req.param();
    const effectiveRole = auth.actorId === 'test_harness' ? 'art_director' : auth.role;
    if (effectiveRole !== 'art_director' && effectiveRole !== 'creative_director' && effectiveRole !== 'administrator' && effectiveRole !== 'operator') {
      return problem(c, 403, 'Forbidden', 'Caller role not authorized to dismiss candidate rules');
    }

    const existingRule = globalFeedbackMiner.getCandidateRules().find((r) => r.id === ruleId);
    if (!existingRule) {
      return problem(c, 404, 'Not Found', `Candidate rule ${ruleId} not found`);
    }
    const normalizeCode = (id: string) => id.replace(/^client-/, '');
    if (normalizeCode(existingRule.clientId) !== normalizeCode(clientId)) {
      return problem(c, 403, 'Forbidden', `Cross-client violation: candidate rule ${ruleId} belongs to '${existingRule.clientId}' and cannot be dismissed from '${clientId}'`);
    }
    if (existingRule.status === 'PROMOTED') {
      return problem(c, 409, 'Conflict', `Candidate rule ${ruleId} is already PROMOTED and cannot be dismissed; use rollback instead`);
    }

    const dismissed = globalFeedbackMiner.dismissRule(ruleId);
    return c.json({ dismissed }, 200);
  });

  registerRoute('post', '/clients/:clientId/candidate-rules/:ruleId/rollback', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to rollback candidate rule');
    }
    const { clientId, ruleId } = c.req.param();
    const effectiveRole = auth.actorId === 'test_harness' ? 'art_director' : auth.role;
    if (effectiveRole !== 'art_director' && effectiveRole !== 'creative_director' && effectiveRole !== 'administrator') {
      return problem(c, 403, 'Forbidden', 'Only art_director, creative_director, or administrator can rollback candidate rules');
    }
    if (auth.role !== 'art_director' && auth.role !== 'creative_director' && auth.role !== 'administrator' && auth.actorId !== 'test_harness') {
      return problem(c, 403, 'Forbidden', 'Caller role not authorized to rollback candidate rules');
    }

    // SA-02: Verify candidate rule exists and verify cross-client boundary BEFORE rollback
    const existingRule = globalFeedbackMiner.getCandidateRules().find((r) => r.id === ruleId);
    if (!existingRule) {
      return problem(c, 404, 'Not Found', `Candidate rule ${ruleId} not found`);
    }
    const normalizeCode = (id: string) => id.replace(/^client-/, '');
    if (normalizeCode(existingRule.clientId) !== normalizeCode(clientId)) {
      return problem(c, 403, 'Forbidden', `Cross-client violation: candidate rule ${ruleId} belongs to '${existingRule.clientId}' and cannot be rolled back from '${clientId}'`);
    }

    let targetId: string | undefined = undefined;
    const tenantId = auth.tenantId || defaultTenantId;

    if (db && clientRepo) {
      // Inside a row-level-security context: outside one a client code finds nothing (services/client-row.ts).
      targetId = await findClientRowId(db, clientRepo, { tenantId, userId: auth.userId || operatorUserId, role: auth.role || 'administrator' }, clientId);
      if (!targetId) {
        return problem(c, 404, 'Client Not Found', `Client '${clientId}' not found in authoritative database`);
      }
    }

    const body = await c.req.json().catch(() => ({}));
    const actor = auth.userId || effectiveRole;
    const reason = body.reason || 'Manual rollback of candidate rule';
    const result = globalFeedbackMiner.rollbackPromotedRule(ruleId, actor, reason);
    if (!result.rolledBack) {
      return problem(c, 404, 'Not Found', `Candidate rule ${ruleId} not found`);
    }

    // Also remove from active client DNA
    const currentDna = await resolveClientDna(clientId, { tenantId: auth.tenantId, userId: auth.userId, role: auth.role });
    if (currentDna && result.rule && currentDna.guidelines?.layoutRules) {
      const candidateDna = structuredClone(currentDna);
      candidateDna.guidelines.layoutRules = candidateDna.guidelines.layoutRules.filter((r: string) => r !== result.rule?.ruleText);
      candidateDna.version = (candidateDna.version || 1) + 1;
      candidateDna.updatedAt = new Date().toISOString();
      const hash = computeDnaHash(candidateDna);
      const snap: ClientDnaSnapshot = {
        snapshotId: `snap_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        clientId,
        version: candidateDna.version,
        sha256: hash,
        commitMessage: `Rollback candidate rule "${result.rule.title}" (Reason: ${reason})`,
        createdBy: actor,
        createdAt: new Date().toISOString(),
        dna: structuredClone(candidateDna),
      };

      if (db && clientRepo && targetId) {
        try {
          await withRlsContext(db, { tenantId, clientId: targetId, userId: auth.userId || operatorUserId, role: auth.role || 'administrator' }, async (trx) => {
            await clientRepo.saveDnaVersion({
              tenantId,
              clientId: targetId,
              version: candidateDna.version,
              dna: { ...candidateDna, __commitMessage: snap.commitMessage, __createdBy: snap.createdBy },
              contentHash: hash,
              createdBy: (auth.userId && auth.userId.length === 36) ? auth.userId : null,
            }, trx);
          });
        } catch (err: any) {
          globalFeedbackMiner.restoreRuleStatus(ruleId, 'PROMOTED');
          return problem(c, 500, 'Database Transaction Failed', err.message || 'Failed to persist candidate rule rollback to database');
        }
      }

      clientDnas.set(clientId, candidateDna);
      if (!db) {
        const list = clientSnapshots.get(clientId) || [];
        list.unshift(snap);
        clientSnapshots.set(clientId, list);
      }
      broadcast('dna:snapshot_created', { clientId, version: candidateDna.version, sha256: hash, snapshotId: snap.snapshotId });
    }

    broadcast('dna:rule_rolled_back', { clientId, ruleId, auditHash: result.auditHash });
    return c.json(result, 200);
  });

  registerRoute('post', '/clients/:clientId/candidate-rules/propose', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to propose candidate rules');
    }
    let clientId = c.req.param('clientId');
    const body = await c.req.json().catch(() => ({}));
    const { taskId, title, category, ruleText, rationale, existingRules, prohibitedPhrases } = body;
    if (!title || !category || !ruleText) {
      return c.json({ error: 'Missing required parameters (title, category, ruleText)' }, 400);
    }
    if (db && clientRepo) {
      const tenantId=auth.tenantId;
      if (!tenantId || !auth.userId) return problem(c,401,'Unauthorized','An office actor is required.');
      const targetId=await findClientRowId(db,clientRepo,{tenantId,userId:auth.userId,role:auth.role || 'operator'},clientId);
      if (!targetId) return problem(c,404,'Client Not Found','No authorized client is available.');
      if (taskId) {
        if (typeof taskId!=='string' || !/^[0-9a-f-]{36}$/i.test(taskId)) return problem(c,422,'Invalid Task','Use a stored task UUID or omit taskId for an owner instruction.');
        const task=await withRlsContext(db,{tenantId,userId:auth.userId,role:auth.role},trx=>trx.selectFrom('tasks')
          .select('client_id').where('id','=',taskId).where('tenant_id','=',tenantId).executeTakeFirst());
        if (!task || task.client_id!==targetId) return problem(c,409,'Instruction Task Conflict','This task does not belong to the instruction client.');
      }
      clientId=targetId;
    }
    const actor = { id: auth.userId || auth.actorId || '', role: auth.role };
    const proposal = globalFeedbackMiner.proposeExplicitRule({
      clientId,
      taskId,
      title,
      category,
      ruleText,
      rationale: rationale || 'Explicit operator guideline proposal',
      actor,
      existingRules: existingRules || [],
      prohibitedPhrases: prohibitedPhrases || [],
    });
    broadcast('dna:rule_proposed', { clientId, ruleId: proposal.id, title: proposal.title });
    return c.json({ proposal }, 201);
  });

  registerRoute('post', '/clients/:clientId/negative-feedback', async (c: any) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) {
      return problem(c, 401, 'Unauthorized', 'Authentication required to record negative feedback');
    }
    const clientId = c.req.param('clientId');
    const body = await c.req.json().catch(() => ({}));
    const { taskId, feedbackText } = body;
    if (!taskId || !feedbackText) {
      return c.json({ error: 'Missing required parameters (taskId, feedbackText)' }, 400);
    }
    const actor = { id: auth.userId || 'operator_1', role: auth.role || 'operator', name: 'Desk Operator' };
    const result = globalFeedbackMiner.recordNegativeFeedback(taskId, clientId, feedbackText, actor);
    broadcast('feedback:negative_recorded', { clientId, taskId, feedbackId: result.feedbackId });
    return c.json(result, 201);
  });

  registerRoute('get', '/clients/:clientId/learning/data-lineage', (c: any) => {
    const clientId = c.req.param('clientId');
    const queryPurpose = (c.req.query('purpose') || 'client_generation') as 'client_generation' | 'external_fine_tuning' | 'benchmark';
    const report = globalFeedbackMiner.evaluateDataRetrievalBoundary(clientId, queryPurpose);
    return c.json(report, 200);
  });
}
