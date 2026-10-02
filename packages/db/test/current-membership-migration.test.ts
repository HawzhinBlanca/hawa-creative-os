import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const atRoot = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const signatures = ['is_tenant_member', 'has_tenant_role', 'can_access_client', 'can_write_client', 'member_client_ids'];

it('upgrades the historical helpers without changing policy text, function identity, ownership, ACLs or restricted worker grants', async () => {
  const owner = new pg.Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL! });
  const tenantId = '00000000-0000-4000-a000-000000000001', userId = randomUUID(), clientId = randomUUID();
  await owner.connect();
  try {
    await owner.query('BEGIN');
    await owner.query('SET LOCAL search_path=hawa,public');
    await owner.query(`INSERT INTO hawa.users(id,email,display_name,disabled_at) VALUES($1,$2,'Synthetic migration reader',now())`, [userId, userId+'@example.test']);
    await owner.query(`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'designer')`, [tenantId,userId]);
    await owner.query(`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES($1,$2,$3,'Synthetic migration client')`, [clientId,tenantId,clientId]);
    await owner.query(`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role) VALUES($1,$2,$3,'designer')`, [tenantId,clientId,userId]);
    await owner.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)", [tenantId,userId]);
    const schema = atRoot('db/rls.sql'), hoisted = atRoot('packages/db/migrations/016_rls_hoisted_membership_checks.sql');
    const old = [...schema.matchAll(/CREATE OR REPLACE FUNCTION (?:is_tenant_member|has_tenant_role|can_access_client|can_write_client)\([\s\S]*?\$\$;/g)].map(match=>match[0]);
    const member = hoisted.match(/CREATE OR REPLACE FUNCTION hawa\.member_client_ids\([\s\S]*?\$\$;/)?.[0];
    expect(old).toHaveLength(4); expect(member).toBeDefined();
    for (const definition of [...old,member!]) await owner.query(definition);
    const metadata = async () => (await owner.query(`SELECT p.oid::text,p.proname,p.proowner::regrole::text AS owner,
      p.proacl::text,p.prosecdef,p.provolatile,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='hawa' AND p.proname=ANY($1::text[]) ORDER BY p.proname`,[signatures])).rows;
    const policies = async () => (await owner.query(`SELECT p.polrelid::text,p.polname,pg_get_expr(p.polqual,p.polrelid) AS qual,
      pg_get_expr(p.polwithcheck,p.polrelid) AS check FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hawa' ORDER BY p.polrelid,p.polname`)).rows;
    const worker = async () => (await owner.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='hawa' AND has_function_privilege('hawa_worker_login',p.oid,'EXECUTE') ORDER BY p.proname`)).rows;
    const before = await metadata(), beforePolicies = await policies(), beforeWorker = await worker();
    expect(before).toHaveLength(5);
    expect((await owner.query('SELECT hawa.can_access_client($1,$2) AS allowed',[tenantId,clientId])).rows[0].allowed).toBe(true);
    const forward = atRoot('packages/db/migrations/079_current_membership_authority.sql');
    await owner.query(forward);
    expect((await owner.query('SELECT hawa.can_access_client($1,$2) AS allowed',[tenantId,clientId])).rows[0].allowed).toBe(false);
    expect(await metadata()).toEqual(before);
    expect(await policies()).toEqual(beforePolicies);
    expect(await worker()).toEqual(beforeWorker);
    await owner.query(forward);
    expect(await metadata()).toEqual(before);
    await owner.query('COMMIT');
  } finally {
    await owner.query('ROLLBACK');
    await owner.end();
  }
});
