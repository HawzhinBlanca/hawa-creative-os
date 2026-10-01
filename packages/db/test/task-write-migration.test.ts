import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const atRoot = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const targets = ['tasks_write', ...['task_events','design_briefs','design_plans','design_documents',
  'design_revisions','artifacts','qc_runs','review_requests','approvals','publications',
  'sheet_syncs','model_invocations','audit_events'].map(t => t+'_task_write'),
  'drive_refs_write','design_operations_write'];

it('forward-upgrades historical task write policies without changing identities, roles, grants, read policies or membership helpers', async () => {
  const owner = new pg.Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL! });
  await owner.connect();
  try {
    await owner.query('BEGIN');
    await owner.query('SET LOCAL search_path=hawa,public');
    const historical = [...atRoot('packages/db/migrations/016_rls_hoisted_membership_checks.sql')
      .matchAll(/^CREATE POLICY (\w+) ON hawa\.(\w+)[\s\S]*?;/gm)]
      .filter(m => targets.includes(m[1]));
    expect(historical).toHaveLength(16);
    for (const m of historical) {
      await owner.query(`DROP POLICY ${m[1]} ON hawa.${m[2]}`);
      await owner.query(m[0]);
    }
    await owner.query('DROP POLICY IF EXISTS audit_events_client_rule_insert ON hawa.audit_events');
    const policies = async () => (await owner.query(`SELECT p.oid::text,p.polname,p.polrelid::text,p.polcmd,
      p.polpermissive,p.polroles::text,pg_get_expr(p.polqual,p.polrelid) AS qual,
      pg_get_expr(p.polwithcheck,p.polrelid) AS check FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hawa' ORDER BY p.oid`)).rows;
    const grants = async () => (await owner.query(`SELECT c.oid::text,c.relacl::text FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hawa' ORDER BY c.oid`)).rows;
    const helpers = async () => (await owner.query(`SELECT p.oid::text,p.proacl::text,p.proowner::text,
      p.prosrc,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='hawa' AND p.proname=ANY($1::text[]) ORDER BY p.oid`,
      [['is_tenant_member','has_tenant_role','can_access_client','can_write_client','member_client_ids']])).rows;
    const trigger = async () => (await owner.query(`SELECT oid::text,tgfoid::text,tgtype,tgenabled,tgattr::text
      FROM pg_trigger WHERE tgrelid='hawa.tasks'::regclass AND tgname='selected_task_scope_immutable'`)).rows;
    const before = await policies(), beforeGrants = await grants(), beforeHelpers = await helpers();
    const tenant = randomUUID(), client = randomUUID(), user = randomUUID(), oldTask = randomUUID();
    await owner.query(`INSERT INTO hawa.tenants(id,name,slug) VALUES($1::uuid,'Synthetic migration office',$2)`,[tenant,tenant]);
    await owner.query(`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES($1::uuid,$2::uuid,$3,'Synthetic migration client')`,[client,tenant,client]);
    await owner.query(`INSERT INTO hawa.users(id,email,display_name,disabled_at) VALUES($1,$2,'Synthetic disabled writer',now())`,[user,user+'@example.test']);
    await owner.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",[tenant,user]);
    await owner.query('SET LOCAL ROLE hawa_app');
    await owner.query(`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES($1,$2,$3,'Historical unauthorized insert')`,[oldTask,tenant,client]);
    await owner.query('RESET ROLE');
    expect((await owner.query('SELECT id FROM hawa.tasks WHERE id=$1',[oldTask])).rowCount).toBe(1);
    // Preserve the surrounding isolated transaction; migration's own transaction is tested by the runner.
    const forward = atRoot('packages/db/migrations/080_task_write_scope_authority.sql')
      .replace(/^BEGIN;\n/m,'').replace(/^COMMIT;\s*$/m,'');
    await owner.query(forward);
    const after = await policies();
    const identity = (rows: typeof before) => rows.map(({ qual: _qual, check: _check, ...metadata }) => metadata);
    const existing = after.filter(p => p.polname !== 'audit_events_client_rule_insert');
    expect(identity(existing)).toEqual(identity(before));
    expect(existing.filter(p => !targets.includes(p.polname))).toEqual(before.filter(p => !targets.includes(p.polname)));
    expect(after.filter(p => p.polname === 'audit_events_client_rule_insert')).toHaveLength(1);
    expect(await grants()).toEqual(beforeGrants);
    expect(await helpers()).toEqual(beforeHelpers);
    expect(after.filter(p => targets.includes(p.polname) && p.polcmd === '*').every(p => p.qual === p.check)).toBe(true);
    expect((await owner.query(`SELECT has_function_privilege('hawa_app','hawa.protect_selected_task_scope()','EXECUTE') AS app,
      has_function_privilege('hawa_worker_login','hawa.protect_selected_task_scope()','EXECUTE') AS worker`)).rows[0]).toEqual({ app: false, worker: false });
    await owner.query('SAVEPOINT denied_insert');
    await owner.query('SET LOCAL ROLE hawa_app');
    await expect(owner.query(`INSERT INTO hawa.tasks(tenant_id,client_id,title) VALUES($1,$2,'Denied new insert')`,[tenant,client]))
      .rejects.toMatchObject({ code: '42501' });
    await owner.query('ROLLBACK TO SAVEPOINT denied_insert');
    await owner.query('RELEASE SAVEPOINT denied_insert');
    const installedTrigger = await trigger();
    expect(installedTrigger).toHaveLength(1);
    await owner.query(forward);
    expect(await policies()).toEqual(after);
    expect(await trigger()).toEqual(installedTrigger);
    expect(await grants()).toEqual(beforeGrants);
    await owner.query('SAVEPOINT altered_trigger');
    await owner.query('ALTER TABLE hawa.tasks DISABLE TRIGGER selected_task_scope_immutable');
    await expect(owner.query(forward)).rejects.toThrow('trigger has unexpected authority');
    await owner.query('ROLLBACK TO SAVEPOINT altered_trigger');
    await owner.query('RELEASE SAVEPOINT altered_trigger');
    expect(await trigger()).toEqual(installedTrigger);
  } finally {
    await owner.query('ROLLBACK');
    await owner.end();
  }
});
