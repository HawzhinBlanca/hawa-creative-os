import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withRlsContext } from '@hawa/db';
import { globalFeedbackMiner } from '@hawa/creative';
import { KAAE_CLIENT_ID } from '@hawa/integrations';
import type { ClientDnaSnapshot, RouteContext } from './types.js';
import { DEFAULT_TENANT_ID, OPERATOR_USER_ID } from '../core-context.js';
import { computeDnaHash } from '../core-helpers.js';
import { log } from '../logging.js';
import { findClientRowId } from '../services/client-row.js';

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
    const body = await c.req.json().catch(() => ({}));
    const { clientId, taskId, initialArtboard, finalArtboard } = body;
    if (!clientId || !taskId || !initialArtboard || !finalArtboard) {
      return c.json({ error: 'Missing required parameters (clientId, taskId, initialArtboard, finalArtboard)' }, 400);
    }
    const proposed = globalFeedbackMiner.ingestTaskRefinements(clientId, taskId, initialArtboard, finalArtboard);
    broadcast('feedback:rules_mined', { clientId, taskId, count: proposed.length });
    return c.json({ proposedRules: proposed, count: proposed.length }, 201);
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
    const result = globalFeedbackMiner.promoteRule(ruleId, promoteRole);
    if (!result.promoted) {
      if (result.reason === 'CONFLICTING_RULES_PENDING') {
        return problem(c, 409, 'Conflict', 'Candidate rule has unresolved conflicts with existing guidelines and remains pending');
      }
      return problem(c, 404, 'Not Found', `Candidate rule ${ruleId} not found`);
    }

    // Attach to active client DNA and commit immutable snapshot
    const currentDna = await resolveClientDna(clientId, { tenantId: auth.tenantId, userId: auth.userId, role: auth.role });
    if (currentDna && result.rule) {
      const candidateDna = structuredClone(currentDna);
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
        try {
          await withRlsContext(db, { tenantId, clientId: targetId, userId: auth.userId || operatorUserId, role: auth.role || 'administrator' }, async (trx) => {
            let maxDbVer = 0;
            const existingSnaps = await clientRepo.listDnaSnapshots(tenantId, targetId, trx);
            if (existingSnaps && existingSnaps.length > 0) {
              maxDbVer = Math.max(...existingSnaps.map((s: any) => s.version));
            }
            if (maxDbVer >= candidateDna.version) {
              candidateDna.version = maxDbVer + 1;
              hash = computeDnaHash(candidateDna);
              snap.version = candidateDna.version;
              snap.sha256 = hash;
              snap.dna = structuredClone(candidateDna);
            }
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
    const clientId = c.req.param('clientId');
    const body = await c.req.json().catch(() => ({}));
    const { taskId, title, category, ruleText, rationale, existingRules, prohibitedPhrases } = body;
    if (!taskId || !title || !category || !ruleText) {
      return c.json({ error: 'Missing required parameters (taskId, title, category, ruleText)' }, 400);
    }
    const actor = { id: auth.userId || 'operator_1', role: auth.role || 'operator', name: 'Desk Operator' };
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
