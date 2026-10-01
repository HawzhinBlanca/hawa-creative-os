import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createDb, withRlsContext } from '../src/client.js';
import { hoist, PER_ROW_CALL } from '../src/generate-rls-hoist-migration.js';

/**
 * ADR-033: row-level-security membership checks run once per statement. The helpers are SECURITY
 * DEFINER functions PostgreSQL cannot inline, and called with a row's columns they ran once per row:
 * counting 25,000 tasks took half a second. Every policy now calls them with current_tenant_id()
 * inside a scalar subquery, and compares the row's columns itself.
 */
describe('the policy rewrite', () => {
  it('turns each per-row helper call into a once-per-statement check and a column comparison', () => {
    expect(hoist('hawa.is_tenant_member(tenant_id)')).toBe('((tenant_id = hawa.current_tenant_id()) AND (SELECT hawa.is_tenant_member(hawa.current_tenant_id())))');
    expect(hoist("hawa.has_tenant_role(r.tenant_id, ARRAY['administrator'::hawa.membership_role])")).toBe(
      "((r.tenant_id = hawa.current_tenant_id()) AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(), ARRAY['administrator'::hawa.membership_role])))"
    );
    const access = hoist('hawa.can_access_client(tx.tenant_id, tx.client_id)');
    expect(access).toContain('(tx.tenant_id = hawa.current_tenant_id())');
    expect(access).toContain("'auditor'::hawa.membership_role");
    expect(access).toContain('(tx.client_id = ANY ((SELECT hawa.member_client_ids(false))::uuid[]))');
    const write = hoist('hawa.can_write_client(tenant_id, id)');
    expect(write).not.toContain('auditor');
    expect(write).toContain('(id = ANY ((SELECT hawa.member_client_ids(true))::uuid[]))');
  });

  it('refuses a helper call in any other form rather than guess', () => {
    expect(() => hoist('hawa.can_access_client(coalesce(a, b), c)')).toThrow(/unexpected form/);
    expect(() => hoist("hawa.has_tenant_role(tenant_id, some_roles)")).toThrow(/unexpected form/);
  });
});

const ownerUrl = process.env.HAWA_ISOLATED_TEST_DB;
const runtimeUrl = process.env.HAWA_ISOLATED_RUNTIME_DB;

describe.skipIf(!ownerUrl || !runtimeUrl)('policies in the database (PostgreSQL)', () => {
  const owner = createDb(ownerUrl || 'postgres://localhost/hawa_repair');
  const app = createDb(runtimeUrl || 'postgres://localhost/hawa_repair');
  afterAll(async () => {
    await owner.destroy();
    await app.destroy();
  });

  it('no policy calls a membership helper once per row', async () => {
    const policies = await owner.transaction().execute(async (trx) => {
      await sql`SET LOCAL search_path = ''`.execute(trx);
      return (
        await sql<{ name: string; expr: string }>`SELECT c.relname || '.' || p.polname AS name,
            COALESCE(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '') || ' ' || COALESCE(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '') AS expr
          FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'hawa'`.execute(trx)
      ).rows;
    });
    expect(policies.length).toBeGreaterThan(100);
    expect(policies.filter((p) => PER_ROW_CALL.test(p.expr)).map((p) => p.name)).toEqual([]);
  });

  it('a client-level designer still sees their client\'s tasks and no other; an administrator sees all; a stranger none', async () => {
    const tenantId = '00000000-0000-4000-a000-000000000001';
    const [mine, other] = [randomUUID(), randomUUID()];
    const designer = randomUUID();
    const stranger = randomUUID();
    const admin = randomUUID();
    const marker = `rls-hoist-${randomUUID().slice(0, 8)}`;
    await owner.transaction().execute(async (trx) => {
      for (const [id, code] of [[mine, `${marker}-a`], [other, `${marker}-b`]]) {
        await sql`INSERT INTO hawa.clients (id, tenant_id, code, name) VALUES (${id}::uuid, ${tenantId}::uuid, ${code}, ${code})`.execute(trx);
      }
      for (const [id, label] of [[designer, 'designer'], [stranger, 'stranger'], [admin, 'admin']]) {
        await sql`INSERT INTO hawa.users (id, email, display_name) VALUES (${id}::uuid, ${`${label}-${marker}@test.invalid`}, ${label})`.execute(trx);
      }
      await sql`INSERT INTO hawa.client_memberships (tenant_id, client_id, user_id, role, active) VALUES (${tenantId}::uuid, ${mine}::uuid, ${designer}::uuid, 'designer', true)`.execute(trx);
      // ADR224: a client grant narrows active office admission; it does not replace it.
      await sql`INSERT INTO hawa.tenant_memberships (tenant_id, user_id, role, active) VALUES (${tenantId}::uuid, ${designer}::uuid, 'designer', true)`.execute(trx);
      await sql`INSERT INTO hawa.tenant_memberships (tenant_id, user_id, role, active) VALUES (${tenantId}::uuid, ${admin}::uuid, 'administrator', true)`.execute(trx);
      for (const client of [mine, other, mine]) {
        await sql`INSERT INTO hawa.tasks (tenant_id, client_id, title) VALUES (${tenantId}::uuid, ${client}::uuid, ${marker})`.execute(trx);
      }
    });
    const seen = (userId: string) =>
      withRlsContext(app, { tenantId, userId, role: 'operator' }, async (trx) =>
        (await sql<{ client_id: string }>`SELECT client_id FROM hawa.tasks WHERE title = ${marker}`.execute(trx)).rows.map((r) => r.client_id)
      );
    expect(await seen(designer)).toEqual([mine, mine]);
    expect((await seen(admin)).length).toBe(3);
    expect(await seen(stranger)).toEqual([]);
    // Writing needs a writing membership: the designer may change their client's task, not the other's.
    const moved = (userId: string) =>
      withRlsContext(app, { tenantId, userId, role: 'operator' }, async (trx) =>
        Number((await sql`UPDATE hawa.tasks SET title = title WHERE title = ${marker}`.execute(trx)).numAffectedRows ?? 0)
      );
    expect(await moved(designer)).toBe(2);
    expect(await moved(stranger)).toBe(0);
  });
});
