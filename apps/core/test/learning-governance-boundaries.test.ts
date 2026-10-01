import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { FeedbackMiner, globalFeedbackMiner } from '@hawa/creative';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';
const db = createDb(process.env.TEST_DATABASE_URL!), owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const tenantId = '00000000-0000-4000-a000-000000000001', actorId = '00000000-0000-4000-b000-000000000002';
const mine = 'c1000000-0000-4000-8000-000000000003', other = 'c1000000-0000-4000-8000-000000000002', viewer = randomUUID();
const viewerToken = ['test', 'learning', 'viewer'].join('_');
const app = createAppWithClientFixtures({ db, extraBearerTokens: { [viewerToken]: { role: 'art_director', sub: viewer } } });
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_ART_DIRECTOR_KEY}` };
const viewerHeaders = { ...headers, Authorization: `Bearer ${viewerToken}` };
const scope = { tenantId, clientId: mine, userId: actorId, role: 'art_director' };
const propose = async (text: string) => {
    const response = await app.request(`/v1/clients/${mine}/candidate-rules/propose`, {
        method: 'POST', headers,
        body: JSON.stringify({ title: text, category: 'layout', ruleText: text })
    });
    expect(response.status).toBe(201);
    return (await response.json()).proposal as {
        id: string;
        ruleText: string;
    };
};
const mutate = (ruleId: string, action: string, body: unknown = {}) => app.request(`/v1/clients/${mine}/candidate-rules/${ruleId}/${action}`, { method: 'POST', headers, body: JSON.stringify(body) });
afterAll(async () => { await db.destroy(); await owner.destroy(); });
beforeAll(async () => {
    await sql `INSERT INTO hawa.users(id,email,display_name) VALUES(${viewer}::uuid,${`${viewer}@test.invalid`},'Isolated viewer')`.execute(owner);
    await sql `INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role,active)
    VALUES(${tenantId}::uuid,${mine}::uuid,${viewer}::uuid,'designer',true)`.execute(owner);
});
describe('Learning governance boundaries', () => {
    it('authorizes actual client scope before exposing proposals or lineage', async () => {
        const own = await propose('Scoped own rule');
        const foreign = globalFeedbackMiner.proposeExplicitRule({
            clientId: other, title: 'Private foreign rule', category: 'layout', ruleText: 'Private scope',
            rationale: 'Synthetic boundary control', actor: { id: actorId, role: 'art_director' }
        });
        for (const path of ['candidate-rules', 'learning/data-lineage']) {
            expect((await app.request(`/v1/clients/${other}/${path}`, { headers: viewerHeaders })).status).toBe(404);
            expect((await app.request(`/v1/clients/${randomUUID()}/${path}`, { headers: viewerHeaders })).status).toBe(404);
        }
        const list = await app.request('/v1/clients/client-drustee/candidate-rules', { headers: viewerHeaders });
        expect(list.status).toBe(200);
        expect((await list.json()).candidateRules.some((r: {
            id: string;
        }) => r.id === own.id)).toBe(true);
        const dismiss = await app.request(`/v1/clients/${other}/candidate-rules/${foreign.id}/dismiss`, { method: 'POST', headers: viewerHeaders, body: '{}' });
        expect(dismiss.status).toBe(404);
        expect(foreign.status).toBe('PROPOSED');
    });
    it('rejects malformed proposals before adding any process state', async () => {
        const before = globalFeedbackMiner.getCandidateRules(mine).map(r => r.id);
        for (const body of [
            { title: [], category: 'layout', ruleText: 'Invalid title' },
            { title: 'Invalid category', category: 'arbitrary', ruleText: 'Invalid category' },
            { title: 'Invalid text', category: 'layout', ruleText: { instruction: 'object' } },
            { title: 'Invalid task', category: 'layout', ruleText: 'Invalid task', taskId: '-'.repeat(36) },
            { title: 'Invalid arrays', category: 'layout', ruleText: 'Invalid arrays', existingRules: [{}] },
        ]) {
            const response = await app.request(`/v1/clients/${mine}/candidate-rules/propose`, { method: 'POST', headers, body: JSON.stringify(body) });
            expect(response.status).toBe(422);
        }
        expect(globalFeedbackMiner.getCandidateRules(mine).map(r => r.id)).toEqual(before);
    });
    it('does not invent a director approval from a filesystem DNA rule', () => {
        const miner = new FeedbackMiner();
        expect(miner.getCandidateRules(other)).toEqual([]);
    });
    it('takes promotion authority from the verified reviewer rather than a requested role', async () => {
        const rule = await propose('Verified reviewer rule');
        const response = await mutate(rule.id, 'promote', { role: 'creative_director' });
        expect(response.status).toBe(200);
        expect((await response.json()).rule.promotedByRole).toBe('art_director');
    });
    it('preserves both different concurrent rule rollbacks and records each decision', async () => {
        const rules = [await propose('Concurrent removal A'), await propose('Concurrent removal B')];
        for (const rule of rules)
            expect((await mutate(rule.id, 'promote')).status).toBe(200);
        for (const response of await Promise.all(rules.map(rule => mutate(rule.id, 'rollback', { reason: 'Isolated concurrent removal' }))))
            expect(response.status).toBe(200);
        const active = await withRlsContext(db, scope, trx => trx.selectFrom('client_dna_versions').select('dna')
            .where('client_id', '=', mine).where('status', '=', 'active').executeTakeFirstOrThrow());
        for (const rule of rules)
            expect(active.dna).toMatchObject({ guidelines: { layoutRules: expect.not.arrayContaining([rule.ruleText]) } });
        const audits = await withRlsContext(db, scope, trx => sql<{
            resource_id: string;
        }> `SELECT resource_id FROM hawa.audit_events
      WHERE action='client_rule.rolled_back' AND resource_id IN (${sql.join(rules.map(r => r.id))})`.execute(trx));
        expect(audits.rows).toHaveLength(2);
    });
    it('keeps rollback pending until commit and orders dismissal after promotion', async () => {
        const active = await propose('Pending rollback remains active');
        expect((await mutate(active.id, 'promote')).status).toBe(200);
        const pending = await propose('Ordered activation cannot be dismissed halfway');
        const pause = async (run: () => ReturnType<typeof mutate>) => {
            let release!: () => void, ready!: () => void;
            const opened = new Promise<void>(resolve => { ready = resolve; });
            const unlock = new Promise<void>(resolve => { release = resolve; });
            const holder = owner.transaction().execute(async trx => {
                await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`client-rule-promotion:${tenantId}:${mine}`},0))`.execute(trx);
                ready(); await unlock;
            });
            await opened;
            const operation = run();
            try {
                await expect.poll(async () => Number((await sql<{count:string}>`SELECT count(*) FROM pg_locks l
                  JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND NOT l.granted AND a.datname=current_database()`.execute(owner)).rows[0].count), {timeout:5000}).toBeGreaterThan(0);
            } catch(error) { release(); await holder; await operation; throw error; }
            return {operation,release:async()=>{release();await holder;}};
        };
        const rollback = await pause(() => mutate(active.id, 'rollback'));
        try {
            expect(globalFeedbackMiner.getCandidateRules(mine).find(r => r.id === active.id)?.status).toBe('PROMOTED');
        } finally { await rollback.release(); }
        expect((await rollback.operation).status).toBe(200);
        // Prove promotion reached the lock before dispatching dismissal. HTTP request
        // start order alone does not establish transaction order across authorization.
        const promotion = await pause(() => mutate(pending.id, 'promote'));
        let dismissal: ReturnType<typeof mutate> | undefined;
        try {
            expect(globalFeedbackMiner.getCandidateRules(mine).find(r => r.id === pending.id)?.status).toBe('PROPOSED');
            dismissal = mutate(pending.id, 'dismiss');
        } finally { await promotion.release(); }
        expect((await promotion.operation).status).toBe(200);
        expect((await dismissal!).status).toBe(409);
        expect(globalFeedbackMiner.getCandidateRules(mine).find(r => r.id === pending.id)?.status).toBe('PROMOTED');
    });
    it('leaves DNA and local activation unchanged on an actual deferred rollback failure', async () => {
        const rule = await propose('Failed rollback remains active');
        expect((await mutate(rule.id, 'promote')).status).toBe(200);
        const before = await withRlsContext(db, scope, trx => trx.selectFrom('client_dna_versions').select('id').where('client_id', '=', mine).execute());
        await sql.raw(`CREATE FUNCTION hawa.test_rollback_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'isolated deferred rollback failure'; END $$`).execute(owner);
        await sql.raw(`CREATE CONSTRAINT TRIGGER test_rollback_commit_failure AFTER INSERT ON hawa.audit_events
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.action='client_rule.rolled_back')
      EXECUTE FUNCTION hawa.test_rollback_commit_failure()`).execute(owner);
        try {
            expect((await mutate(rule.id, 'rollback')).status).toBe(500);
        }
        finally {
            await sql.raw('DROP TRIGGER test_rollback_commit_failure ON hawa.audit_events').execute(owner);
            await sql.raw('DROP FUNCTION hawa.test_rollback_commit_failure()').execute(owner);
        }
        const after = await withRlsContext(db, scope, trx => trx.selectFrom('client_dna_versions').select('id').where('client_id', '=', mine).execute());
        expect(after.map(r => r.id).sort()).toEqual(before.map(r => r.id).sort());
        expect(globalFeedbackMiner.getCandidateRules(mine).find(r => r.id === rule.id)?.status).toBe('PROMOTED');
        expect((await mutate(rule.id, 'rollback')).status).toBe(200);
        expect((await mutate(rule.id, 'rollback')).status).toBe(200);
        expect((await mutate(rule.id, 'dismiss')).status).toBe(409);
    });
    it('reports only stored scoped assets and excludes unknown rights', async () => {
        const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
        for (const [index, lineage] of ['client_owned', 'canva_derived_restricted', null, 'client_owned'].entries()) {
            await withRlsContext(db, scope, trx => sql `INSERT INTO hawa.brand_assets(id,tenant_id,client_id,kind,name,mime_type,sha256,metadata)
        VALUES(${ids[index]}::uuid,${tenantId}::uuid,${index === 3 ? other : mine}::uuid,'logo',${`Stored item ${index}`},'image/png',
          ${String(index).repeat(64)},${JSON.stringify({ lineage })}::jsonb)`.execute(trx));
        }
        const read = async (purpose: string) => {
            const response = await app.request(`/v1/clients/${mine}/learning/data-lineage?purpose=${purpose}`, { headers: viewerHeaders });
            expect(response.status).toBe(200);
            return response.json();
        };
        const report = await read('client_generation');
        expect(report.permittedItems).toEqual([{ id: ids[0], type: 'logo', name: 'Stored item 0', lineage: 'client_owned' }]);
        expect(report.restrictedExcludedItems.map((r: {
            id: string;
        }) => r.id).sort()).toEqual(ids.slice(1, 3).sort());
        expect(report.restrictedExcludedItems.some((r: {
            lineage: string;
        }) => r.lineage === 'rights_unknown')).toBe(true);
        const external = await read('external_fine_tuning');
        expect(external.permittedItems).toEqual([]);
        expect(external.restrictedExcludedItems).toHaveLength(3);
        const empty = new FeedbackMiner().evaluateDataRetrievalBoundary(mine, 'client_generation');
        expect(empty.permittedItems).toEqual([]);
        expect(empty.restrictedExcludedItems).toEqual([]);
        expect(() => new FeedbackMiner().evaluateDataRetrievalBoundary(mine, 'client_generation', [
            { id: 'foreign', clientId: other, type: 'logo', name: 'Foreign', lineage: 'client_owned' },
        ])).toThrow('scope');
    });
    it('persists scoped rejection evidence before mining and reconciles action keys', async () => {
        const task = randomUUID(), foreignTask = randomUUID();
        for (const [id, client] of [[task, mine], [foreignTask, other]])
            await withRlsContext(db, scope, trx => sql `
      INSERT INTO hawa.tasks(id,tenant_id,client_id,title,state) VALUES(${id}::uuid,${tenantId}::uuid,${client}::uuid,'Isolated rejection','received')`.execute(trx));
        const key = randomUUID(), body = { taskId: task, feedbackText: 'Reject this contrast choice' };
        const reject = (input: unknown, actionId = key) => app.request(`/v1/clients/${mine}/negative-feedback`, {
            method: 'POST',
            headers: { ...headers, 'Idempotency-Key': actionId }, body: JSON.stringify(input)
        });
        expect((await reject({ ...body, taskId: foreignTask })).status).toBe(409);
        expect((await reject({ ...body, taskId: randomUUID() })).status).toBe(404);
        expect((await reject({ ...body, feedbackText: { text: 'Malformed' } })).status).toBe(422);
        expect((await reject(body)).status).toBe(201);
        expect((await reject(body)).status).toBe(200);
        expect((await reject({ ...body, feedbackText: 'Changed request' })).status).toBe(409);
        const stored = await withRlsContext(db, scope, trx => trx.selectFrom('feedback_events').selectAll().where('id', '=', key).executeTakeFirstOrThrow());
        expect(stored).toMatchObject({ client_id: mine, task_id: task, actor_id: actorId, category: 'design_rejection' });
        expect(globalFeedbackMiner.isTaskRejected(task, mine)).toBe(true);
        expect(globalFeedbackMiner.isTaskRejected(task, other)).toBe(false);
    });
    it('does not mine a rejection whose real database commit fails', async () => {
        const task = randomUUID(), action = randomUUID();
        await withRlsContext(db, scope, trx => sql `INSERT INTO hawa.tasks(id,tenant_id,client_id,title,state)
      VALUES(${task}::uuid,${tenantId}::uuid,${mine}::uuid,'Failed rejection control','received')`.execute(trx));
        await sql.raw(`CREATE FUNCTION hawa.test_rejection_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'isolated deferred rejection failure'; END $$`).execute(owner);
        await sql.raw(`CREATE CONSTRAINT TRIGGER test_rejection_commit_failure AFTER INSERT ON hawa.feedback_events
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.category='design_rejection')
      EXECUTE FUNCTION hawa.test_rejection_commit_failure()`).execute(owner);
        const reject = () => app.request(`/v1/clients/${mine}/negative-feedback`, {
            method: 'POST', headers: { ...headers, 'Idempotency-Key': action },
            body: JSON.stringify({ taskId: task, feedbackText: 'Rejected only after commit' })
        });
        try {
            expect((await reject()).status).toBe(500);
        }
        finally {
            await sql.raw('DROP TRIGGER test_rejection_commit_failure ON hawa.feedback_events').execute(owner);
            await sql.raw('DROP FUNCTION hawa.test_rejection_commit_failure()').execute(owner);
        }
        expect(globalFeedbackMiner.isTaskRejected(task, mine)).toBe(false);
        const stored = await withRlsContext(db, scope, trx => trx.selectFrom('feedback_events').select('id').where('id', '=', action).execute());
        expect(stored).toEqual([]);
        expect((await reject()).status).toBe(201);
    });
    it('allows client readers to inspect moderation receipts without allowing forged writers', async () => {
        const reader = randomUUID();
        await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${reader}::uuid,${`${reader}@test.invalid`},'Read-only receipt viewer')`.execute(owner);
        await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role,active)
          VALUES(${tenantId}::uuid,${mine}::uuid,${reader}::uuid,'requester',true)`.execute(owner);
        const readerScope = {...scope,userId:reader,role:'requester'};
        const rows = await withRlsContext(db,readerScope,trx=>sql<{id:string}>`SELECT id FROM hawa.audit_events
          WHERE client_id=${mine}::uuid AND action='client_rule.rolled_back'`.execute(trx));
        expect(rows.rows.length).toBeGreaterThan(0);
        const insert = (actor:string,context=scope)=>withRlsContext(db,context,trx=>sql`
          INSERT INTO hawa.audit_events(tenant_id,client_id,actor_type,actor_id,action,resource_type,resource_id)
          VALUES(${tenantId}::uuid,${mine}::uuid,'user',${actor},'client_rule.dismissed','candidate_rule','isolated_forged')`.execute(trx));
        await expect(insert('forged_actor')).rejects.toMatchObject({code:'42501'});
        await expect(insert(reader,readerScope)).rejects.toMatchObject({code:'42501'});
        const foreign = await withRlsContext(db,{...readerScope,tenantId:'00000000-0000-4000-a000-000000000005'},trx=>sql`
          SELECT id FROM hawa.audit_events WHERE client_id=${mine}::uuid AND action='client_rule.rolled_back'`.execute(trx));
        expect(foreign.rows).toEqual([]);
    });
    it('preserves newer rejection evidence while an activation commit is pending', async () => {
        const task = randomUUID();
        await withRlsContext(db, scope, trx => sql `INSERT INTO hawa.tasks(id,tenant_id,client_id,title,state)
      VALUES(${task}::uuid,${tenantId}::uuid,${mine}::uuid,'Concurrent feedback control','received')`.execute(trx));
        const proposed = await app.request(`/v1/clients/${mine}/candidate-rules/propose`, {
            method: 'POST', headers,
            body: JSON.stringify({ taskId: task, title: 'Preserve later evidence', category: 'layout', ruleText: 'Preserve later evidence' })
        });
        expect(proposed.status).toBe(201);
        const rule = (await proposed.json()).proposal;
        const lockKey = randomUUID();
        await sql.raw(`CREATE FUNCTION hawa.test_activation_commit_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0],0)); RETURN NEW; END $$`).execute(owner);
        await sql.raw(`CREATE CONSTRAINT TRIGGER test_activation_commit_wait AFTER INSERT ON hawa.audit_events
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.action='client_rule.promoted')
      EXECUTE FUNCTION hawa.test_activation_commit_wait('${lockKey}')`).execute(owner);
        let release!: () => void, ready!: () => void;
        const opened = new Promise<void>(resolve => { ready = resolve; }), unlock = new Promise<void>(resolve => { release = resolve; });
        const holder = owner.transaction().execute(async (trx) => {
            await sql `SELECT pg_advisory_xact_lock(hashtextextended(${lockKey},0))`.execute(trx);
            ready();
            await unlock;
        });
        await opened;
        let promotion: ReturnType<typeof mutate> | undefined;
        try {
            promotion = mutate(rule.id, 'promote');
            await expect.poll(async () => Number((await sql<{
                count: string;
            }> `SELECT count(*) FROM pg_locks l
        JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND NOT l.granted AND a.datname=current_database()`.execute(owner)).rows[0].count), { timeout: 5000 }).toBeGreaterThan(0);
            const rejection = await app.request(`/v1/clients/${mine}/negative-feedback`, {
                method: 'POST', headers: { ...headers, 'Idempotency-Key': randomUUID() },
                body: JSON.stringify({ taskId: task, feedbackText: 'This task remains a negative example' })
            });
            expect(rejection.status).toBe(201);
            expect(globalFeedbackMiner.getCandidateRules(mine).find(r => r.id === rule.id)?.examples.negativeExampleTaskIds).toContain(task);
        }
        finally {
            release();
            await holder;
            if (promotion)
                await promotion;
            await sql.raw('DROP TRIGGER test_activation_commit_wait ON hawa.audit_events').execute(owner);
            await sql.raw('DROP FUNCTION hawa.test_activation_commit_wait()').execute(owner);
        }
        expect((await promotion!).status).toBe(200);
        const after = globalFeedbackMiner.getCandidateRules(mine).find(r => r.id === rule.id)!;
        expect(after.status).toBe('PROMOTED');
        expect(after.examples.negativeExampleTaskIds).toContain(task);
        expect(after.examples.positiveExampleTaskIds).not.toContain(task);
    });
});
