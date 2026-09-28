/**
 * The pre-deploy check on production's data (ADR-137, predeploy-invariants.ts and
 * predeploy-dump-check.ts). The DB-gated part stands in for the 2026-09-28 release: an unquoted
 * historical Studio call that no migration froze must fail the check, as the 79 such records in
 * production would have failed it before ADR-133 (replayed on the real dump in
 * plans/lean-design-implementation-2026-09-28/CHAOS_ON_PRODUCTION_DATA_PROOF.json).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createDb, withRlsContext } from '../src/client.js';
import { DesignStudioRepository } from '../src/repositories/design-studio.repository.js';
import { checkPredeployInvariants, diffShapes, incompleteScopes, refusalClass } from '../src/predeploy-invariants.js';
import { newestDump, sanitizeRestoreError } from '../src/predeploy-dump-check.js';

describe('pre-deploy dump check, without a database', () => {
  it('picks the newest predeploy or nightly dump by its stamp and ignores partial and checksum files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hawa-predeploy-'));
    expect(newestDump(dir)).toBeNull();
    expect(newestDump(join(dir, 'absent'))).toBeNull();
    for (const f of ['predeploy_20260928T135006Z.dump', 'hawa_20260928T003003Z.dump', 'predeploy_20260928T181301Z.dump.sha256',
      'predeploy_20260929T000000Z.dump.partial', 'predeploy_20260927T120000Z.dump']) writeFileSync(join(dir, f), '');
    expect(newestDump(dir)).toBe(join(dir, 'predeploy_20260928T135006Z.dump'));
    writeFileSync(join(dir, 'hawa_20260929T003003Z.dump'), '');
    expect(newestDump(dir)).toBe(join(dir, 'hawa_20260929T003003Z.dump'));
  });

  it('never repeats row values from a restore error', () => {
    const line = 'pg_restore: error: COPY failed for table "users": ERROR:  duplicate key value violates unique constraint "users_email_key" DETAIL:  Key (email)=(someone@example.com) already exists.';
    const clean = sanitizeRestoreError(line);
    expect(clean).not.toContain('someone@example.com');
    expect(clean).toContain('users_email_key');
    expect(sanitizeRestoreError('error: Key (chat_id)=(12345) is not present')).not.toContain('12345');
  });

  it('names incomplete scopes and refusal classes without details', () => {
    expect(incompleteScopes({ scopes: [
      { scope: 'office', subject: 'office', historyIncomplete: true },
      { scope: 'role', subject: 'creative_director', historyIncomplete: false },
    ] })).toEqual(['office:office']);
    expect(incompleteScopes(null)).toEqual([]);
    expect(refusalClass('OFFICE_BUDGET_HISTORY_INCOMPLETE: unresolved historical spending')).toBe('OFFICE_BUDGET_HISTORY_INCOMPLETE');
  });

  it('fails parity on what production lacks or has differently, and only reports what it has in addition', () => {
    const d = diffShapes({ 'function a()': 'x', 'privilege t.SELECT': 'granted', 'column t.c': 'int4|NO|' },
      { 'function a()': 'y', 'column t.c': 'int4|NO|', 'privilege t.TRUNCATE': 'granted' });
    expect(d).toEqual({ missing: ['privilege t.SELECT'], differing: ['function a()'], extra: ['privilege t.TRUNCATE'] });
  });
});

const url = process.env.HAWA_ISOLATED_TEST_DB;
describe.skipIf(!url)('pre-deploy invariants on a database with production-shaped history', () => {
  const db = createDb(url), repo = new DesignStudioRepository(db);
  afterAll(() => db.destroy());

  async function tenantWithRun() {
    const tenantId = randomUUID(), actorId = randomUUID(), clientId = randomUUID(), taskId = randomUUID(), runId = randomUUID();
    await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES(${tenantId}::uuid,'Pre-deploy fixture',${tenantId})`.execute(db);
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${actorId}::uuid,${actorId + '@example.test'},'Synthetic operator')`.execute(db);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${actorId}::uuid,'operator')`.execute(db);
    await withRlsContext(db, { tenantId, userId: actorId }, async (tx) => {
      await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${tenantId}::uuid,${clientId},'Pre-deploy fixture')`.execute(tx);
      await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${taskId}::uuid,${tenantId}::uuid,${clientId}::uuid,'Pre-deploy fixture')`.execute(tx);
    });
    await repo.createRun({ id: runId, taskId, tenantId, clientId, actorId, requestKey: runId, requestHash: 'a'.repeat(64), request: {},
      tier: 'premium', budget: { maxUsd: 20, maxCalls: 100, spentUsd: 0, calls: 0 } });
    return { tenantId, actorId, clientId, runId };
  }

  /** A Studio call admitted before migration 051 (no quote, no policy version), days ago, unresolved. */
  async function legacyCall(f: Awaited<ReturnType<typeof tenantWithRun>>) {
    const id = randomUUID();
    await repo.recordCallStart({ id, runId: f.runId, tenantId: f.tenantId, actorId: f.actorId, stage: 'laying_out', provider: 'openai',
      model: 'synthetic', requestedModel: 'synthetic', callOrdinal: null, logicalCallSha256: createHash('sha256').update(id).digest('hex'),
      reservation: { version: 1 as const, policy: 'synthetic-test', requestSha256: 'a'.repeat(64), usd: 0.4, inputTokens: 100, outputTokens: 100 } });
    await db.transaction().execute(async (tx) => {
      await sql`ALTER TABLE hawa.design_studio_calls DISABLE TRIGGER enforce_studio_scope_budget`.execute(tx);
      await sql`ALTER TABLE hawa.design_studio_calls DISABLE TRIGGER immutable_design_studio_call`.execute(tx);
      await sql`UPDATE hawa.design_studio_calls SET started_at=now()-interval '12 days', reservation=NULL, spending_policy_version=NULL,
        budget_role=NULL WHERE id=${id}::uuid`.execute(tx);
      await sql`ALTER TABLE hawa.design_studio_calls ENABLE TRIGGER immutable_design_studio_call`.execute(tx);
      await sql`ALTER TABLE hawa.design_studio_calls ENABLE TRIGGER enforce_studio_scope_budget`.execute(tx);
    });
    return id;
  }

  it('passes a database whose history is complete, and changes nothing', async () => {
    const f = await tenantWithRun();
    const before = await sql<{ n: number }>`SELECT count(*)::int AS n FROM hawa.design_studio_calls`.execute(db);
    const report = await checkPredeployInvariants(url!);
    expect(report.invariants.filter((i) => !i.ok)).toEqual([]);
    expect(report.counts.tenants).toBeGreaterThanOrEqual(1);
    expect(report.counts.admissions).toBeGreaterThan(0);
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM hawa.design_studio_calls`.execute(db)).rows).toEqual(before.rows);
    expect(f.tenantId).toBeTruthy();
  });

  it('fails on an unquoted historical call that no migration froze: every paid call would be refused', async () => {
    const f = await tenantWithRun();
    await legacyCall(f);
    const report = await checkPredeployInvariants(url!);
    const byName = Object.fromEntries(report.invariants.map((i) => [i.name, i]));
    expect(report.ok).toBe(false);
    expect(byName['budget-history'].ok).toBe(false);
    expect(byName['budget-history'].problems!.join('\n')).toContain(`client ${f.clientId} office:office`);
    expect(byName.admission.ok).toBe(false);
    expect(byName.admission.problems!.join('\n')).toContain('HISTORY_INCOMPLETE');
    // Row contents never appear: only scope names, ids and error classes.
    expect(JSON.stringify(report)).not.toContain('@example.test');
  });

  it('passes again once the record is frozen as pre-admission spending (what migration 067 does)', async () => {
    const f = await tenantWithRun();
    const id = await legacyCall(f);
    await sql`INSERT INTO hawa.pre_admission_spending(tenant_id,kind,record_id,reason) VALUES(${f.tenantId}::uuid,'studio_call',${id}::uuid,'Synthetic pre-admission call')`.execute(db);
    const report = await checkPredeployInvariants(url!);
    const mine = report.invariants.flatMap((i) => (i.problems ?? []).filter((p) => p.includes(f.clientId)));
    expect(mine).toEqual([]);
  });
});
