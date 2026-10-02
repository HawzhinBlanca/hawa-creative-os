import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, type ClientDNA } from '@hawa/domain';
import { FeedbackRepository, sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { globalFeedbackMiner, planRuleModeration, RuleModerationConflict, type FeedbackMiner, type CandidateRuleProposal, type RuleModerationAction } from '@hawa/creative';
import type { AuthContext, ClientDnaSnapshot, RouteContext } from '../routes/types.js';
import { computeDnaHash } from '../core-helpers.js';
import { CanvaFlowError } from './canva-connect-service.js';
import {explicitLearningInstruction,moderationInput,negativeLearningInput} from './learning-inputs.js';
export {explicitLearningInstruction,moderationInput,negativeLearningInput};
import {reconstructClientLearning} from './learning-recovery.js';
/** A rejection is an immutable task event; project it only after the real commit. */
export async function recordLearningRejection(db: Kysely<Database>, auth: AuthContext, clientId: string, actionId: string, input: z.infer<typeof negativeLearningInput>) {
    const requestHash = createHash('sha256').update(canonicalJson({ tenantId: auth.tenantId, actorId: auth.userId, clientId, input })).digest('hex');
    return withRlsContext(db, { tenantId: auth.tenantId!, clientId, userId: auth.userId, role: auth.role }, async (trx) => {
        await sql `SELECT pg_advisory_xact_lock(hashtextextended(${actionId},0))`.execute(trx);
        const task = await trx.selectFrom('tasks').select(['id', 'client_id', 'project_id']).where('tenant_id', '=', auth.tenantId!)
            .where('id', '=', input.taskId).forShare().executeTakeFirst();
        if (!task)
            throw new CanvaFlowError(404, 'Task Not Found', 'No authorized task is available.');
        if (task.client_id !== clientId)
            throw new CanvaFlowError(409, 'Feedback Client Conflict', 'The task belongs to another client.');
        const previous = await trx.selectFrom('feedback_events').selectAll().where('tenant_id', '=', auth.tenantId!).where('id', '=', actionId).executeTakeFirst();
        if (previous) {
            const target = previous.target as {
                kind?: unknown;
                requestHash?: unknown;
                actorRole?: string;
            };
            if (target.kind !== (input.revisionId?'revision_rejection_v1':'task_rejection_v1') || target.requestHash !== requestHash || previous.client_id !== clientId ||
                previous.task_id !== task.id || previous.actor_id !== auth.userId)
                throw new CanvaFlowError(409, 'Feedback Action Conflict', 'This action already records different feedback.');
            return {
                feedbackId: previous.id, taskId: task.id, clientId, actorId: previous.actor_id!, actorRole: target.actorRole,
                feedbackText: previous.comment!, recordedAt: previous.created_at.toISOString(), replayed: true
            };
        }
        let designTarget:Record<string,string>|undefined;
        if(input.revisionId) {
          const revision=await trx.selectFrom('design_revisions').select(['id','source_sha256'])
            .where('tenant_id','=',auth.tenantId!).where('task_id','=',task.id).where('id','=',input.revisionId).forShare().executeTakeFirst();
          if(!revision || !/^[a-f0-9]{64}$/i.test(revision.source_sha256))
            throw new CanvaFlowError(409,'Feedback Revision Conflict','No verified revision belongs to this task.');
          designTarget={kind:'design_revision',revisionId:revision.id,sourceSha256:revision.source_sha256};
        }
        const saved = await new FeedbackRepository(trx).recordFeedback({
            id: actionId, tenantId: auth.tenantId!, clientId, taskId: task.id,
            projectId: task.project_id, category: 'design_rejection', scope: 'one_time', explicitness: 'direct_instruction', actorId: auth.userId,
            target: { kind: designTarget?'revision_rejection_v1':'task_rejection_v1', requestHash, actorRole: auth.role,...(designTarget?{designTarget}:{}) }, comment: input.feedbackText, confidence: null
        }, trx);
        return {
            feedbackId: saved.id, taskId: task.id, clientId, actorId: auth.userId!, actorRole: auth.role,
            feedbackText: saved.comment!, recordedAt: saved.created_at.toISOString(), replayed: false
        };
    });
}
/** An identifier is not authorization. Look up UUIDs and aliases under actual client RLS. */
export async function authorizedLearningClient(ctx: RouteContext, auth: AuthContext, identifier: string, writable = false): Promise<string> {
    if (!auth.authenticated || !auth.tenantId || !auth.userId)
        throw new CanvaFlowError(401, 'Authentication Required', 'An office actor is required.');
    if (!ctx.db)
        return identifier;
    if (!ctx.clientRepo)
        throw new CanvaFlowError(503, 'Client Authority Unavailable', 'Client access cannot be verified.');
    const tenantId = auth.tenantId;
    return withRlsContext(ctx.db, { tenantId, userId: auth.userId, role: auth.role || 'operator' }, async (trx) => {
        const uuid = z.string().uuid().safeParse(identifier);
        const row = uuid.success ? await trx.selectFrom('clients').select('id').where('tenant_id', '=', tenantId).where('id', '=', identifier).executeTakeFirst()
            : await ctx.clientRepo!.findByCode(tenantId, identifier, trx);
        if (!row)
            throw new CanvaFlowError(404, 'Client Not Found', 'No authorized client is available.');
        if (writable) {
            const permitted = (await sql<{
                allowed: boolean;
            }> `SELECT hawa.can_write_client(${tenantId}::uuid,${row.id}::uuid) AS allowed`.execute(trx)).rows[0];
            if (!permitted?.allowed)
                throw new CanvaFlowError(403, 'Client Write Forbidden', 'The actor cannot change this client.');
        }
        return row.id;
    });
}
// This only serializes the process projection around its transaction; PostgreSQL is the authority.
const moderationTails = new Map<string, Promise<void>>();
async function serializeModeration<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = moderationTails.get(key) || Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    moderationTails.set(key, tail);
    await previous;
    try {
        return await run();
    }
    finally {
        release();
        if (moderationTails.get(key) === tail)
            moderationTails.delete(key);
    }
}
type ModerationData = {
    proposal: CandidateRuleProposal;
    ruleRevision?: number;
    activation?: {
        auditHash: string;
    };
    moderation?: {
        action: RuleModerationAction;
        reason: string;
        actorId: string;
        role: string;
        auditHash: string;
    };
    dnaVersionId?: string;
};
export async function moderateLearningRule(ctx: RouteContext, auth: AuthContext, clientId: string, ruleId: string, action: RuleModerationAction, reason: string) {
    const tenantId = auth.tenantId!, actor = { id: auth.userId!, role: auth.role! };
    return serializeModeration(JSON.stringify([tenantId, clientId]), async () => {
        const fallback = ctx.db ? undefined : await ctx.resolveClientDna(clientId, { tenantId, userId: actor.id, role: actor.role });
        let snapshot: ClientDnaSnapshot | undefined;
        let finalDna: ClientDNA | undefined;
        let recovered:FeedbackMiner|undefined;
        const apply = async (trx?: Kysely<Database>) => {
            if (ctx.db && trx)
                await sql `SELECT pg_advisory_xact_lock(hashtextextended(${`client-rule-promotion:${tenantId}:${clientId}`},0))`.execute(trx);
            const active = ctx.clientRepo && trx ? await ctx.clientRepo.findActiveDna(tenantId, clientId, trx) : undefined;
            const dna = active ? (typeof active.dna === 'string' ? JSON.parse(active.dna) : active.dna) as ClientDNA : fallback;
            recovered=trx ? (await reconstructClientLearning(trx,tenantId,clientId,dna)).miner : undefined;
            const candidates=(recovered ?? globalFeedbackMiner).getCandidateRules(clientId);
            const cached=candidates.find(rule=>rule.id===ruleId);
            if(!cached) throw new CanvaFlowError(404,'Candidate Not Found','No candidate is available in this client scope.');
            const latest = trx ? (await sql<{
                data: ModerationData;
                action: string;
            }> `SELECT data,action FROM hawa.audit_events
        WHERE tenant_id=${tenantId}::uuid AND client_id=${clientId}::uuid AND resource_id=${ruleId}
          AND resource_type='candidate_rule' AND task_id IS NULL
          AND action IN ('client_rule.promoted','client_rule.dismissed','client_rule.rolled_back')
        ORDER BY coalesce((data->>'ruleRevision')::integer,0) DESC,occurred_at DESC,id DESC LIMIT 1`.execute(trx)).rows[0] : undefined;
            const recorded = latest?.data.proposal;
            if (recorded && (recorded.id !== ruleId || recorded.clientId !== clientId || recorded.sha256Digest !== cached.sha256Digest)) {
                throw new CanvaFlowError(409, 'Candidate Evidence Conflict', 'Stored moderation does not match this candidate.');
            }
            const before = structuredClone(cached);
            if (recorded) {
                before.status = recorded.status;
                before.promotedByRole = recorded.promotedByRole;
                before.promotedAt = recorded.promotedAt;
                before.moderationRevision=latest?.data.ruleRevision ?? 0;
            }
            if (action === 'promote' && dna)
                before.conflicts = globalFeedbackMiner.detectConflicts(before.ruleText, (dna.guidelines?.layoutRules || []).filter(rule => rule !== before.ruleText), dna.guidelines?.prohibitedPhrases || []);
            let plan: ReturnType<typeof planRuleModeration>;
            try {
                plan = planRuleModeration(before, action, actor, reason, new Date().toISOString());
            }
            catch (error) {
                if (error instanceof RuleModerationConflict)
                    throw new CanvaFlowError(error.code === 'RULE_MODERATION_FORBIDDEN' ? 403 : 409, error.code, error.message);
                throw error;
            }
            if (!plan.changed && latest) {
                if (action === 'promote' && !dna?.guidelines?.layoutRules?.includes(before.ruleText)) {
                    throw new CanvaFlowError(409, 'Candidate DNA Conflict', 'The recorded activation is absent from current DNA.');
                }
                const expectedAction = action === 'promote' ? 'client_rule.promoted' : action === 'dismiss' ? 'client_rule.dismissed' : 'client_rule.rolled_back';
                if (latest.action !== expectedAction)
                    throw new CanvaFlowError(409, 'Candidate State Conflict', 'This candidate has a different recorded moderation decision.');
                return { rule: before, auditHash: latest.data.moderation?.auditHash || latest.data.activation?.auditHash || '', replayed: true };
            }
            if (!plan.changed)
                return { rule: before, auditHash: plan.auditHash, replayed: true };
            let dnaVersionId = active?.id;
            if (action !== 'dismiss') {
                if (!dna)
                    throw new CanvaFlowError(409, 'Client DNA Required', 'Save the client DNA before changing active rules.');
                finalDna = structuredClone(dna);
                finalDna.guidelines ||= { voiceAndTone: '', prohibitedPhrases: [], requiredDisclaimers: [], layoutRules: [] };
                finalDna.guidelines.layoutRules ||= [];
                const otherActive=candidates.some(rule=>rule.id!==ruleId && rule.status==='PROMOTED' && rule.ruleText===plan.proposal.ruleText);
                finalDna.guidelines.layoutRules = action === 'promote' ? [...new Set([...finalDna.guidelines.layoutRules, plan.proposal.ruleText])]
                    : finalDna.guidelines.layoutRules.filter(rule => rule !== plan.proposal.ruleText || otherActive);
                const versions = ctx.clientRepo && trx ? await ctx.clientRepo.listDnaSnapshots(tenantId, clientId, trx) : [];
                finalDna.version = Math.max(dna.version || 1, ...versions.map(row => row.version)) + 1;
                finalDna.updatedAt = new Date().toISOString();
                const hash = computeDnaHash(finalDna), commitMessage = `${action === 'promote' ? 'Promoted' : 'Rollback'} candidate rule "${plan.proposal.title}" (${reason})`;
                snapshot = {
                    snapshotId: '', clientId, version: finalDna.version, sha256: hash, commitMessage, createdBy: actor.id,
                    createdAt: finalDna.updatedAt, dna: structuredClone(finalDna)
                };
                if (ctx.clientRepo && trx) {
                    const saved = await ctx.clientRepo.saveDnaVersion({
                        tenantId, clientId, version: finalDna.version,
                        dna: { ...finalDna, __commitMessage: commitMessage, __createdBy: actor.id }, contentHash: hash, createdBy: actor.id, approvedBy: actor.id,
                        expectedVersion: active?.version ?? 0
                    }, trx);
                    dnaVersionId = saved.id;
                    snapshot.snapshotId = saved.id;
                }
            }
            if (trx) {
                plan.proposal.moderationRevision=(latest?.data.ruleRevision ?? 0)+1;
                const data: ModerationData = {
                    proposal: plan.proposal, ruleRevision: (latest?.data.ruleRevision || 0) + 1,
                    ...(dnaVersionId ? { dnaVersionId } : {}), moderation: { action, reason, actorId: actor.id, role: actor.role, auditHash: plan.auditHash }
                };
                if (action === 'promote')
                    data.activation = { auditHash: plan.auditHash };
                const auditAction = action === 'promote' ? 'client_rule.promoted' : action === 'dismiss' ? 'client_rule.dismissed' : 'client_rule.rolled_back';
                await sql `INSERT INTO hawa.audit_events(tenant_id,client_id,actor_type,actor_id,action,resource_type,resource_id,before_hash,after_hash,data)
          VALUES(${tenantId}::uuid,${clientId}::uuid,'user',${actor.id},${auditAction},'candidate_rule',${ruleId},
            ${dna ? computeDnaHash(dna) : null},${finalDna ? computeDnaHash(finalDna) : null},${JSON.stringify(data)}::jsonb)`.execute(trx);
            }
            return { rule: plan.proposal, auditHash: plan.auditHash, replayed: false };
        };
        const result = ctx.db ? await withRlsContext(ctx.db, { tenantId, clientId, userId: actor.id, role: actor.role }, apply) : await apply();
        if(recovered) {
            recovered.commitRuleSnapshot(result.rule);
            globalFeedbackMiner.adoptClientProjection(clientId,recovered);
        } else globalFeedbackMiner.commitRuleSnapshot(result.rule);
        if (finalDna)
            ctx.clientDnas.set(clientId, finalDna);
        if (snapshot && !ctx.db) {
            snapshot.snapshotId = createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
            const snapshots = ctx.clientSnapshots.get(clientId) || [];
            snapshots.unshift(snapshot);
            ctx.clientSnapshots.set(clientId, snapshots);
        }
        return { ...result, ...(action === 'promote' ? { promoted: true } : action === 'dismiss' ? { dismissed: true } : { rolledBack: true }), snapshot };
    });
}
