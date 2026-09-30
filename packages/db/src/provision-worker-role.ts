/** ADR182: owner-only provision of the separate worker login. No plaintext reaches SQL/logs. */
import pg from 'pg';
import { scramSha256Verifier } from './rotate-app-role.js';
import { assertTestDatabaseEnv } from './test-database-guard.js';

export async function provisionWorkerDatabase(adminUrl: string, workerUrl: string, production = false): Promise<void> {
  if (!production) assertTestDatabaseEnv({ TEST_DATABASE_URL: adminUrl });
  const owner = new URL(adminUrl), worker = new URL(workerUrl);
  if (!['postgres:', 'postgresql:'].includes(worker.protocol) || worker.username !== 'hawa_worker_login' ||
      decodeURIComponent(worker.password).length < 32 || worker.pathname !== owner.pathname) {
    throw new Error('Invalid worker database identity or target');
  }
  const admin = new pg.Client({ connectionString: adminUrl, application_name: 'hawa-worker-provision', connectionTimeoutMillis: 10000 });
  await admin.connect();
  try {
    await admin.query('BEGIN');
    await admin.query("SELECT pg_advisory_xact_lock(hashtextextended('hawa.worker-db-provision',0))");
    const group = (await admin.query("SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname='hawa_worker'")).rows[0];
    if (!group || group.rolsuper || group.rolcreatedb || group.rolcreaterole || group.rolreplication || group.rolbypassrls || group.rolcanlogin) {
      throw new Error('Restricted worker grants must be migrated before provisioning');
    }
    const existing = (await admin.query("SELECT oid,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname='hawa_worker_login'")).rows[0];
    if (existing) {
      const unexpected = (await admin.query("SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid WHERE m.member=$1 AND r.rolname<>'hawa_worker'", [existing.oid])).rowCount;
      if (unexpected || existing.rolsuper || existing.rolcreatedb || existing.rolcreaterole || existing.rolreplication || existing.rolbypassrls) {
        throw new Error('Existing worker login has unexpected authority');
      }
      const owned = (await admin.query("SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=$1 AND classid IN ('pg_class'::regclass,'pg_namespace'::regclass,'pg_proc'::regclass,'pg_type'::regclass,'pg_database'::regclass,'pg_default_acl'::regclass) LIMIT 1", [existing.oid])).rowCount;
      if (owned) throw new Error('Worker login must own no objects or direct grants');
    } else {
      await admin.query('CREATE ROLE hawa_worker_login LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    }
    const verifier = scramSha256Verifier(decodeURIComponent(worker.password));
    // SCRAM verifier has a fixed alphabet; it holds no quote/backslash or plaintext password.
    if (!/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(verifier)) throw new Error('Invalid verifier encoding');
    await admin.query(`ALTER ROLE hawa_worker_login LOGIN PASSWORD '${verifier}'`);
    await admin.query('GRANT hawa_worker TO hawa_worker_login WITH INHERIT TRUE, SET FALSE, ADMIN FALSE');
    await admin.query('COMMIT');
    const probeUrl = new URL(worker.toString()); probeUrl.hostname = owner.hostname; probeUrl.port = owner.port;
    const probe = new pg.Client({ connectionString: probeUrl.toString(), connectionTimeoutMillis: 10000 });
    try {
      await probe.connect();
      const result = (await probe.query(`SELECT current_user AS identity,
        pg_has_role(current_user,'hawa_app','MEMBER') AS app_member,
        has_table_privilege(current_user,'hawa.approvals','INSERT') AS approval_write,
        has_table_privilege(current_user,'hawa.tasks','UPDATE') AS task_write,
        has_schema_privilege(current_user,'hawa','CREATE') AS schema_create,
        has_database_privilege(current_user,current_database(),'TEMPORARY') AS temp_create`)).rows[0];
      if (result.identity !== 'hawa_worker_login' || result.app_member || result.approval_write || result.task_write || result.schema_create || result.temp_create) {
        throw new Error('Worker effective-privilege verification failed');
      }
    } finally { await probe.end(); }
  } catch {
    await admin.query('ROLLBACK').catch(() => undefined);
    // Driver errors can include connection parameters. The caller gets only this fixed message.
    throw new Error('Worker database provisioning or privilege verification failed');
  } finally { await admin.end(); }
}

