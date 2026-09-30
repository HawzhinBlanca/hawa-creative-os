/**
 * Rotate the runtime database credential without a moment in which Core or the worker cannot log in
 * (PLAN 2026-09-24, item 0.6).
 *
 * Postgres keeps one password per role, so the password of `hawa_app` cannot be changed while the
 * running services still use the old one. Instead two login roles, `hawa_app_a` and `hawa_app_b`,
 * take turns. Both are INHERIT members of `hawa_app` and hold nothing of their own: every grant,
 * row-level security policy (all are `TO public` and key on hawa.* settings, not on the role name)
 * and migration keeps naming `hawa_app`, which ends up NOLOGIN with no stored password. A rotation
 * gives the idle login role a fresh password, the services move to it, and the previous one retires.
 *
 * Invoked through infra/ops/rotate_app_role.sh (see infra/ops/README.md for the runbook):
 *   rotate       create or re-enable the idle login role, verify it, write its password to a 0600 file
 *   status       the group and login roles: can they log in, do they hold a password, open sessions
 *   verify       rotate's comparison again, for an existing login role (e.g. on another database)
 *   retire       NOLOGIN and PASSWORD NULL for a role nothing connects as any more
 *   install-env  put a rotated credential into a URL line of an env file (backup kept, value never shown)
 *   check-login  try to log in with the credentials of a URL line in an env file (for the leaked one)
 *
 * Every command takes the target explicitly (--url, with no password in it: argv is visible to ps)
 * and refuses the production server unless --production is given. The admin password comes from a
 * KEY in an env file (--password-env-file/--password-key) or PGPASSWORD. New passwords reach the
 * server only as SCRAM verifiers, so neither the server log nor pg_stat_activity can show them, and
 * they are written only to a file under ~/.hawa/db-roles with mode 0600.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PRODUCTION_CONTAINER_PREFIX, connectionTargetOf, productionTargetReason } from './test-database-guard.js';

export const DEFAULT_APP_ROLE = 'hawa_app';
export const DEFAULT_SECRET_DIR = path.join(homedir(), '.hawa', 'db-roles');
const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const POSTGRES_URL = /^postgres(ql)?:\/\//i;
/** Rows counted per table and context when comparing what RLS lets each role see. */
const RLS_SAMPLE_LIMIT = 1001;

export function loginRolesOf(appRole: string): [string, string] {
  return [`${appRole}_a`, `${appRole}_b`];
}

function assertRoleName(name: string): string {
  if (!ROLE_NAME.test(name)) throw new Error(`"${name}" is not a plain role name`);
  return name;
}

/** 32 random bytes, base64url: 43 characters that need no quoting in SQL or percent-encoding in a URL. */
export function generatePassword(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The verifier Postgres stores for a SCRAM-SHA-256 password (RFC 5802/7677), computed here so that
 * ALTER ROLE ... PASSWORD carries no plaintext. psql's \password does the same. The generated
 * passwords are ASCII, for which SASLprep changes nothing.
 */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const storedKey = createHash('sha256').update(createHmac('sha256', salted).update('Client Key').digest()).digest('base64');
  const serverKey = createHmac('sha256', salted).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey}:${serverKey}`;
}

export interface AdminTarget {
  url: string;
  host: string;
  port: number;
  database: string;
  user: string;
  production: boolean;
}

/**
 * The server a command acts on. A password in the URL is refused because the URL arrives in argv;
 * production (published port 54332, the database `hawa`, or the compose network's `postgres` host)
 * needs --production, so a test rehearsal cannot reach the office's database by a typo.
 */
export function parseAdminTarget(url: string, options: { production: boolean }): AdminTarget {
  if (!POSTGRES_URL.test(url)) throw new Error('--url must be a postgresql:// URL');
  const parsed = new URL(url);
  if (parsed.password) {
    throw new Error('--url must not carry a password (argv is visible to ps); pass --password-env-file and --password-key, or PGPASSWORD');
  }
  const target = connectionTargetOf(url);
  const host = parsed.hostname;
  const reason =
    productionTargetReason(target) ??
    (host === 'postgres' || host.startsWith(PRODUCTION_CONTAINER_PREFIX) ? `host "${host}" is the production compose network's database` : null);
  if (reason && !options.production) {
    throw new Error(`Refusing ${host}:${target.port}/${target.database}: ${reason}. Pass --production to act on it deliberately.`);
  }
  return {
    url,
    host,
    port: Number(target.port),
    database: String(target.database),
    user: decodeURIComponent(parsed.username),
    production: Boolean(reason),
  };
}

/** One KEY=value line of an env file; with passwordOnly, a postgres URL value yields its password. */
export function readEnvValue(text: string, key: string, options: { passwordOnly?: boolean } = {}): string {
  const lines = text.split('\n').filter((line) => line.startsWith(`${key}=`));
  if (lines.length === 0) throw new Error(`${key} is not set in the env file`);
  if (lines.length > 1) throw new Error(`${key} appears more than once in the env file`);
  const value = lines[0].slice(key.length + 1).trim();
  if (!value) throw new Error(`${key} is empty in the env file`);
  if (!options.passwordOnly || !POSTGRES_URL.test(value)) return value;
  const password = decodeURIComponent(new URL(value).password);
  if (!password) throw new Error(`${key} is a URL without a password`);
  return password;
}

/**
 * The same env text with the user and password of one URL line replaced. Host, port, database and
 * query stay as they are, so the file keeps pointing where it did (postgres:5432 inside compose).
 */
export function replaceUrlCredentials(text: string, key: string, role: string, password: string): string {
  const lines = text.split('\n');
  const indexes = lines.flatMap((line, i) => (line.startsWith(`${key}=`) ? [i] : []));
  if (indexes.length === 0) throw new Error(`The env file has no ${key} line`);
  if (indexes.length > 1) throw new Error(`${key} appears more than once in the env file (the last line would win silently)`);
  const value = lines[indexes[0]].slice(key.length + 1).trim();
  if (!POSTGRES_URL.test(value)) throw new Error(`${key} is not a postgres URL`);
  const url = new URL(value);
  url.username = assertRoleName(role);
  url.password = encodeURIComponent(password);
  lines[indexes[0]] = `${key}=${url.toString()}`;
  return lines.join('\n');
}

export interface RoleState {
  name: string;
  exists: boolean;
  canLogin: boolean;
  sessions: number;
}

/**
 * The login role to give a fresh password: the one nothing logs in as. When both can log in, the
 * previous rotation was never finished, and a third password would leave nobody knowing which role
 * the services use; the owner retires one first.
 */
export function chooseNextLoginRole(appRole: string, states: RoleState[], requested?: string): string {
  const family = loginRolesOf(appRole);
  const stateOf = (name: string): RoleState => states.find((s) => s.name === name) ?? { name, exists: false, canLogin: false, sessions: 0 };
  let chosen: string;
  if (requested) {
    if (!family.includes(requested)) throw new Error(`--role must be ${family[0]} or ${family[1]}`);
    chosen = requested;
  } else {
    const idle = family.filter((name) => !stateOf(name).canLogin);
    if (idle.length === 0) {
      throw new Error(`${family[0]} and ${family[1]} can both log in: the last rotation is unfinished. Retire the one the services no longer use (status shows its sessions), then rotate.`);
    }
    chosen = idle[0];
  }
  const sessions = stateOf(chosen).sessions;
  if (sessions > 0) {
    throw new Error(`${chosen} has ${sessions} open session(s): it is in use, and a new password would lock out the services' next connections`);
  }
  return chosen;
}

interface Connection {
  target: AdminTarget;
  password: string;
}

function clientFor(conn: Connection, user?: string, password?: string): pg.Client {
  return new pg.Client({
    host: conn.target.host,
    port: conn.target.port,
    database: conn.target.database,
    user: user ?? conn.target.user,
    password: password ?? conn.password,
    connectionTimeoutMillis: 10000,
    application_name: 'hawa-rotate-app-role',
  });
}

async function withAdmin<T>(conn: Connection, fn: (admin: pg.Client) => Promise<T>): Promise<T> {
  const admin = clientFor(conn);
  await admin.connect();
  try {
    const me = (await admin.query(`SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user`)).rows[0];
    if (!me?.rolsuper && !me?.rolcreaterole) throw new Error(`${conn.target.user} cannot manage roles (needs SUPERUSER or CREATEROLE)`);
    // Belt and braces: the statements carry verifiers, not passwords, but none of them needs logging.
    if (me.rolsuper) await admin.query(`SET log_statement = 'none'`);
    return await fn(admin);
  } finally {
    await admin.end().catch(() => {});
  }
}

/** Rows of a query the server may refuse (no such table, not allowed to read pg_hba): none then. */
async function rowsOrNone<T extends pg.QueryResultRow>(client: pg.Client, text: string, params: unknown[] = []): Promise<T[]> {
  try {
    return (await client.query<T>(text, params)).rows;
  } catch {
    return [];
  }
}

async function readStates(admin: pg.Client, names: string[]): Promise<Array<RoleState & { hasPassword: boolean | null }>> {
  const rows = (
    await admin.query(
      `SELECT n.name, r.rolname IS NOT NULL AS exists, COALESCE(r.rolcanlogin, false) AS can_login,
              (SELECT count(*)::int FROM pg_stat_activity a WHERE a.usename = n.name) AS sessions,
              CASE WHEN (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
                   THEN (SELECT rolpassword IS NOT NULL FROM pg_authid WHERE rolname = n.name) END AS has_password
         FROM unnest($1::text[]) WITH ORDINALITY AS n(name, i)
         LEFT JOIN pg_roles r ON r.rolname = n.name
        ORDER BY n.i`,
      [names]
    )
  ).rows;
  return rows.map((r) => ({ name: r.name, exists: r.exists, canLogin: r.can_login, sessions: r.sessions, hasPassword: r.has_password }));
}

export interface CommonOptions {
  appRole?: string;
  adminPassword: string;
  production?: boolean;
  /** How the steps should spell the connection arguments (the CLI passes what it was given). */
  cliArgs?: string;
}

function connectionOf(adminUrl: string, options: CommonOptions): Connection {
  return { target: parseAdminTarget(adminUrl, { production: options.production ?? false }), password: options.adminPassword };
}

export interface VerificationReport {
  problems: string[];
  warnings: string[];
  tablesCompared: number;
  contextsCompared: number;
}

/**
 * Does `role` behave exactly like `appRole`? Compared from the catalogue (every privilege on every
 * table, column, sequence, function, schema and the database, including what PUBLIC gives), from the
 * role's own login (identity, membership, attributes), and by what row-level security lets each see
 * in the same snapshot under the contexts Core sets. Read-only throughout: nothing here writes.
 */
export async function verifyLoginRole(admin: pg.Client, conn: Connection, appRole: string, role: string, password: string): Promise<VerificationReport> {
  const problems: string[] = [];
  const warnings: string[] = [];

  const attrs = (await admin.query(`SELECT rolsuper, rolbypassrls, rolinherit, rolcanlogin, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname = $1`, [role])).rows[0];
  if (!attrs) return { problems: [`${role} does not exist`], warnings, tablesCompared: 0, contextsCompared: 0 };
  for (const [flag, expected] of Object.entries({ rolsuper: false, rolbypassrls: false, rolinherit: true, rolcanlogin: true, rolcreaterole: false, rolcreatedb: false, rolreplication: false })) {
    if (attrs[flag] !== expected) problems.push(`${role}: ${flag} is ${attrs[flag]}, expected ${expected}`);
  }
  const memberships = (await admin.query(`SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = $1 ORDER BY 1`, [role])).rows.map((r) => r.rolname);
  if (memberships.join(',') !== appRole) problems.push(`${role} is a member of [${memberships.join(', ')}], expected exactly [${appRole}]`);

  const differences = (
    await admin.query(
      `WITH rels AS (
         SELECT c.oid, format('%I.%I', n.nspname, c.relname) AS name, c.relkind
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN ('hawa', 'public') AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       ), checks AS (
         SELECT 'table ' || name AS object, p AS privilege, has_table_privilege($1, oid, p) AS g, has_table_privilege($2, oid, p) AS l
           FROM rels, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE relkind <> 'S'
         UNION ALL
         SELECT 'sequence ' || name, p, has_sequence_privilege($1, oid, p), has_sequence_privilege($2, oid, p)
           FROM rels, unnest(ARRAY['USAGE','SELECT','UPDATE']) p WHERE relkind = 'S'
         UNION ALL
         SELECT format('column %I.%I.%I', n.nspname, c.relname, a.attname), p,
                has_column_privilege($1, c.oid, a.attnum, p), has_column_privilege($2, c.oid, a.attnum, p)
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace,
                unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p
          WHERE n.nspname IN ('hawa', 'public') AND a.attacl IS NOT NULL AND NOT a.attisdropped
         UNION ALL
         SELECT format('function %s', f.oid::regprocedure), 'EXECUTE', has_function_privilege($1, f.oid, 'EXECUTE'), has_function_privilege($2, f.oid, 'EXECUTE')
           FROM pg_proc f JOIN pg_namespace n ON n.oid = f.pronamespace WHERE n.nspname IN ('hawa', 'public')
         UNION ALL
         SELECT 'schema ' || s, p, has_schema_privilege($1, s, p), has_schema_privilege($2, s, p)
           FROM unnest(ARRAY['hawa','public']) s, unnest(ARRAY['USAGE','CREATE']) p WHERE EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = s)
         UNION ALL
         SELECT 'database ' || current_database(), p, has_database_privilege($1, current_database(), p), has_database_privilege($2, current_database(), p)
           FROM unnest(ARRAY['CONNECT','CREATE','TEMPORARY']) p
       )
       SELECT object, privilege, g, l FROM checks WHERE g IS DISTINCT FROM l ORDER BY object, privilege`,
      [appRole, role]
    )
  ).rows;
  for (const d of differences) problems.push(`${d.object}: ${d.privilege} is ${d.g} for ${appRole} but ${d.l} for ${role}`);

  const tables = (
    await admin.query(
      `SELECT format('%I.%I', n.nspname, c.relname) AS name, c.relrowsecurity AS rls
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'hawa' AND c.relkind IN ('r', 'p') ORDER BY 1`
    )
  ).rows as Array<{ name: string; rls: boolean }>;
  const readable = (
    await admin.query(`SELECT t FROM unnest($1::text[]) t WHERE has_table_privilege($2, t, 'SELECT')`, [tables.map((t) => t.name), appRole])
  ).rows.map((r) => r.t as string);

  // The contexts Core's withRlsContext sets: none at all, a tenant, and a tenant's administrator.
  type Context = Record<string, string>;
  const contexts: Array<{ label: string; settings: Context }> = [{ label: 'no context', settings: {} }];
  const tenants = await rowsOrNone<{ id: string }>(admin, `SELECT id::text FROM hawa.tenants ORDER BY id LIMIT 3`);
  for (const { id } of tenants) {
    contexts.push({ label: `tenant ${id}`, settings: { 'app.tenant_id': id, 'hawa.current_tenant_id': id } });
    const adminUser = (
      await rowsOrNone<{ user_id: string }>(admin, `SELECT user_id::text FROM hawa.tenant_memberships WHERE tenant_id = $1 AND role = 'administrator' AND active ORDER BY user_id LIMIT 1`, [id])
    )[0]?.user_id;
    if (adminUser) {
      contexts.push({
        label: `tenant ${id} administrator ${adminUser}`,
        settings: {
          'app.tenant_id': id, 'hawa.current_tenant_id': id,
          'app.user_id': adminUser, 'hawa.current_user_id': adminUser,
          'app.role': 'administrator', 'hawa.current_role': 'administrator',
        },
      });
    }
  }

  const login = clientFor(conn, role, password);
  try {
    await login.connect();
  } catch (err) {
    problems.push(`${role} cannot log in: ${err instanceof Error ? err.message : String(err)}`);
    return { problems, warnings, tablesCompared: tables.length, contextsCompared: 0 };
  }
  let contextsCompared = 0;
  try {
    const who = (await login.query(`SELECT current_user AS cu, session_user AS su, pg_has_role(current_user, $1, 'USAGE') AS member`, [appRole])).rows[0];
    if (who.cu !== role || who.su !== role) problems.push(`${role} logs in as ${who.su}/${who.cu}`);
    if (!who.member) problems.push(`${role} does not use the privileges of ${appRole}`);

    // Both sides read one exported snapshot, so live traffic between the two counts cannot differ them.
    await admin.query(`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    await login.query(`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    try {
      const snapshot = (await admin.query(`SELECT pg_export_snapshot() AS s`)).rows[0].s as string;
      await login.query(`SET TRANSACTION SNAPSHOT '${snapshot.replace(/'/g, '')}'`);
      await admin.query(`SET LOCAL ROLE ${assertRoleName(appRole)}`);
      // 30 s a statement, and a context's counts are one statement: the limit covers every table of a
      // context together (it was 30 s a table). With no context RLS hides every row, so LIMIT does not
      // stop that pass and it reads each table in full; at the office's volumes that is well under it.
      for (const side of [admin, login]) await side.query(`SET LOCAL statement_timeout = '30s'`);
      const names = ['app.tenant_id', 'hawa.current_tenant_id', 'app.client_id', 'hawa.current_client_id', 'app.user_id', 'hawa.current_user_id', 'app.role', 'hawa.current_role'];
      // One statement sets a context and one counts every table, on each side, both sides at once.
      // They were a statement a setting and a statement a table: over a thousand round trips a
      // rotation, which a loaded server made take minutes. The counts are the same statements, under
      // the same settings and snapshot.
      const setAll = `SELECT ${names.map((_, i) => `set_config($${2 * i + 1}, $${2 * i + 2}, true)`).join(', ')}`;
      const countAll = readable.length
        ? `SELECT ${readable.map((table, i) => `(SELECT count(*)::int FROM (SELECT 1 FROM ${table} LIMIT ${RLS_SAMPLE_LIMIT}) s) AS c${i}`).join(', ')}`
        : '';
      const counts = async (side: pg.Client, params: string[]): Promise<number[]> => {
        await side.query(setAll, params);
        if (!countAll) return [];
        const row = (await side.query(countAll)).rows[0] as Record<string, number>;
        return readable.map((_, i) => row[`c${i}`]);
      };
      for (const context of contexts) {
        const params = names.flatMap((name) => [name, context.settings[name] ?? '']);
        const [group, own] = await Promise.all([counts(admin, params), counts(login, params)]);
        readable.forEach((table, i) => {
          if (group[i] !== own[i]) problems.push(`${table} under ${context.label}: ${appRole} sees ${group[i]} rows, ${role} sees ${own[i]}`);
        });
        contextsCompared += 1;
      }
    } finally {
      await admin.query('ROLLBACK').catch(() => {});
      await login.query('ROLLBACK').catch(() => {});
    }
  } finally {
    await login.end().catch(() => {});
  }
  const unreadable = tables.map((t) => t.name).filter((name) => !readable.includes(name));
  if (unreadable.length) warnings.push(`${unreadable.join(', ')}: not readable by ${appRole}, so compared by privilege only`);
  return { problems, warnings, tablesCompared: tables.length, contextsCompared };
}

export interface RotationResult {
  role: string;
  secretFile: string;
  verification: VerificationReport;
  warnings: string[];
  steps: string;
}

/**
 * A file-name stamp that two files written in the same second do not share: the files are created
 * with 'wx', and a rotation that takes under a second after another (retire, then rotate again) was
 * refused for a secret file that already existed. Milliseconds and a random suffix.
 */
function stamp(): string {
  return `${new Date().toISOString().replace(/[-:]/g, '').replace('.', '')}-${randomBytes(2).toString('hex')}`;
}

/**
 * Give the idle login role a fresh password and prove it works like the group role. The password is
 * written to its file before the role changes, so a crash in between cannot lose it; if the new role
 * does not behave like the group it is disabled again and the file removed.
 */
export async function rotateAppRole(adminUrl: string, options: CommonOptions & { role?: string; secretDir?: string }): Promise<RotationResult> {
  const appRole = assertRoleName(options.appRole ?? DEFAULT_APP_ROLE);
  const conn = connectionOf(adminUrl, options);
  const family = loginRolesOf(appRole);
  return withAdmin(conn, async (admin) => {
    const group = (await admin.query(`SELECT oid, rolcanlogin, rolconnlimit FROM pg_roles WHERE rolname = $1`, [appRole])).rows[0];
    if (!group) throw new Error(`${appRole} does not exist on ${conn.target.host}:${conn.target.port}`);
    const states = await readStates(admin, family);
    const role = chooseNextLoginRole(appRole, states, options.role);
    const exists = states.find((s) => s.name === role)!.exists;
    const previous = [appRole, ...family].filter((name) => name !== role && (name === appRole ? group.rolcanlogin : states.find((s) => s.name === name)!.canLogin));

    // Role settings (ALTER ROLE ... SET) apply to the role that logs in, not to the roles it is a
    // member of, so the group's are copied. A list value would need its own quoting: refused.
    const settings = (await admin.query(`SELECT d.datname, s.setconfig FROM pg_db_role_setting s LEFT JOIN pg_database d ON d.oid = s.setdatabase WHERE s.setrole = $1`, [group.oid])).rows as Array<{ datname: string | null; setconfig: string[] }>;
    const settingStatements: string[] = [];
    for (const { datname, setconfig } of settings) {
      for (const entry of setconfig) {
        const eq = entry.indexOf('=');
        const name = entry.slice(0, eq);
        const value = entry.slice(eq + 1);
        if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) || value.includes(',')) {
          throw new Error(`${appRole} has the role setting ${name}${datname ? ` in ${datname}` : ''}, which this script cannot copy; copy it to ${role} by hand and rerun`);
        }
        settingStatements.push(`ALTER ROLE ${role}${datname ? ` IN DATABASE ${pg.escapeIdentifier(datname)}` : ''} SET ${name} TO ${pg.escapeLiteral(value)}`);
      }
    }

    const warnings: string[] = [];
    const hba = await rowsOrNone<{ line_number: number }>(
      admin,
      `SELECT line_number FROM pg_hba_file_rules WHERE $1 = ANY(user_name) AND NOT ($2 = ANY(user_name))`,
      [appRole, role]
    );
    for (const rule of hba) warnings.push(`pg_hba.conf line ${rule.line_number} names ${appRole} but not ${role}; the login check below shows whether ${role} is let in`);

    // The file first: from here on the password exists somewhere the owner can find it.
    const secretDir = options.secretDir ?? DEFAULT_SECRET_DIR;
    mkdirSync(secretDir, { recursive: true, mode: 0o700 });
    chmodSync(secretDir, 0o700);
    const secretFile = path.join(secretDir, `${conn.target.database}-${role}-${stamp()}.env`);
    const password = generatePassword();
    writeFileSync(
      secretFile,
      `# ${role} on ${conn.target.host}:${conn.target.port}/${conn.target.database}, rotated ${new Date().toISOString()} by rotate_app_role.\n` +
        `# Owner-only. Use: infra/ops/rotate_app_role.sh install-env --secret-file <this file> --env-file <env file>\n` +
        `HAWA_APP_ROLE=${role}\nHAWA_APP_PASSWORD=${password}\n`,
      { mode: 0o600, flag: 'wx' }
    );

    const version = Number((await admin.query(`SHOW server_version_num`)).rows[0].server_version_num);
    const verifier = scramSha256Verifier(password);
    const attributes = `LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${Number(group.rolconnlimit)}`;
    try {
      await admin.query('BEGIN');
      await admin.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${role} WITH ${attributes} PASSWORD '${verifier}'`);
      // INHERIT is the Postgres 16+ per-grant option; before 16 it follows the member's INHERIT attribute.
      await admin.query(`GRANT ${appRole} TO ${role}${version >= 160000 ? ' WITH INHERIT TRUE' : ''}`);
      if (exists) await admin.query(`ALTER ROLE ${role} RESET ALL`);
      for (const statement of settingStatements) await admin.query(statement);
      await admin.query('COMMIT');
    } catch (err) {
      await admin.query('ROLLBACK').catch(() => {});
      unlinkSync(secretFile);
      throw err;
    }

    const verification = await verifyLoginRole(admin, conn, appRole, role, password);
    if (verification.problems.length > 0) {
      await admin.query(`ALTER ROLE ${role} NOLOGIN PASSWORD NULL`);
      unlinkSync(secretFile);
      throw new Error(`${role} does not behave like ${appRole}, so it was disabled again:\n  - ${verification.problems.join('\n  - ')}`);
    }
    warnings.push(...verification.warnings);
    const cli = options.cliArgs ?? `--url ${adminUrl}${conn.target.production ? ' --production' : ''}`;
    return { role, secretFile, verification, warnings, steps: ownerSteps({ appRole, role, previous, secretFile, cli, conn, verification }) };
  });
}

function ownerSteps(input: { appRole: string; role: string; previous: string[]; secretFile: string; cli: string; conn: Connection; verification: VerificationReport }): string {
  const { appRole, role, previous, secretFile, cli, conn, verification } = input;
  const t = conn.target;
  const retireOrder = [...previous.filter((name) => name !== appRole), ...previous.filter((name) => name === appRole)];
  const lines = [
    `${role} can log in on ${t.host}:${t.port}/${t.database} and behaves like ${appRole}: ${verification.tablesCompared} tables compared by privilege, ${verification.contextsCompared} RLS contexts compared row for row.`,
    `Its password is only in ${secretFile} (mode 0600). Nothing below has been done yet.`,
    '',
    `1. Point the application at ${role}: this changes the user and password of DATABASE_URL in infra/docker/.env,`,
    '   nothing else, and keeps an owner-only backup of the old file.',
    `     bash infra/ops/rotate_app_role.sh install-env --secret-file ${secretFile} --env-file infra/docker/.env`,
    '',
    '2. Recreate the services that connect with DATABASE_URL (core and the worker), with the images they run now.',
    '   First check nothing is in flight in Restate (a replaced worker replays running invocations):',
    `     docker exec hawa-production-worker-1 node -e "fetch('http://restate:9070/query',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({query:\\"SELECT count(*) AS n FROM sys_invocation WHERE status <> 'completed'\\"})}).then(r=>r.text()).then(console.log)"`,
    '   Then:',
    '     cd infra/docker',
    `     export HAWA_BUILD_COMMIT="$(docker inspect hawa-production-core-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^HAWA_BUILD_COMMIT=//p')"`,
    '     docker compose -f docker-compose.prod.yml -f canva-release.override.yml --env-file .env up -d --no-deps --no-build --force-recreate core worker',
    '   (If the worker runs as two colours, name every worker service; docker compose ... config --services lists them.)',
    '   postgres is not recreated here. Its HAWA_APP_DATABASE_URL (used only on an empty data directory) now differs,',
    '   so the next deploy.sh recreates the postgres container once, on the same volume.',
    '',
    `3. Wait until nothing connects as ${previous.length ? previous.join(' or ') : 'the old role'} any more, and ${role} has sessions:`,
    `     bash infra/ops/rotate_app_role.sh status ${cli}`,
    `     docker inspect --format '{{.State.Health.Status}}' hawa-production-core-1   # healthy: /health reaches the database as ${role}`,
  ];
  let n = 4;
  for (const old of retireOrder) {
    lines.push(
      '',
      `${n}. ${old === appRole ? `Finally, ${appRole} itself: NOLOGIN` : `Retire ${old}: NOLOGIN`} and its stored password removed (refused while it has sessions):`,
      `     bash infra/ops/rotate_app_role.sh retire --role ${old} ${cli}`
    );
    n += 1;
  }
  lines.push(
    '',
    `${n}. Prove the old credential is refused, with the backup install-env wrote (its path is printed by step 1):`,
    `     bash infra/ops/rotate_app_role.sh check-login --url postgresql://${t.host}:${t.port}/${t.database}${t.production ? ' --production' : ''} --credentials-env-file <backup file> --credentials-key DATABASE_URL`
  );
  return lines.join('\n');
}

export interface RoleStatus {
  name: string;
  exists: boolean;
  canLogin: boolean;
  hasPassword: boolean | null;
  sessions: number;
}

/**
 * The same comparison rotate runs, for a login role that already exists: after the services moved,
 * or on another database of the same server (roles are cluster-wide, grants are per database).
 */
export async function verifyExistingRole(adminUrl: string, options: CommonOptions & { role: string; secretFile: string }): Promise<VerificationReport> {
  const appRole = assertRoleName(options.appRole ?? DEFAULT_APP_ROLE);
  const conn = connectionOf(adminUrl, options);
  const secret = readFileSync(options.secretFile, 'utf8');
  if (readEnvValue(secret, 'HAWA_APP_ROLE') !== options.role) throw new Error(`${options.secretFile} holds the password of another role`);
  return withAdmin(conn, (admin) => verifyLoginRole(admin, conn, appRole, assertRoleName(options.role), readEnvValue(secret, 'HAWA_APP_PASSWORD')));
}

export async function roleStatus(adminUrl: string, options: CommonOptions): Promise<RoleStatus[]> {
  const appRole = assertRoleName(options.appRole ?? DEFAULT_APP_ROLE);
  const conn = connectionOf(adminUrl, options);
  return withAdmin(conn, (admin) => readStates(admin, [appRole, ...loginRolesOf(appRole)]));
}

/**
 * NOLOGIN, and the stored verifier removed so no copy of the old password is worth anything. Refused
 * while the role has sessions (the services still use it) or when no other role could log in.
 */
export async function retireRole(adminUrl: string, options: CommonOptions & { role: string }): Promise<{ role: string; stillLogin: string[] }> {
  const appRole = assertRoleName(options.appRole ?? DEFAULT_APP_ROLE);
  const conn = connectionOf(adminUrl, options);
  const family = [appRole, ...loginRolesOf(appRole)];
  if (!family.includes(options.role)) throw new Error(`--role must be one of ${family.join(', ')}`);
  return withAdmin(conn, async (admin) => {
    const states = await readStates(admin, family);
    const target = states.find((s) => s.name === options.role)!;
    if (!target.exists) throw new Error(`${options.role} does not exist`);
    if (target.sessions > 0) {
      throw new Error(`${options.role} still has ${target.sessions} open session(s); move the services off it first (status shows where they connect)`);
    }
    const stillLogin = states.filter((s) => s.name !== options.role && s.canLogin).map((s) => s.name);
    if (stillLogin.length === 0) throw new Error(`${options.role} is the last role that can log in as the application; rotate first`);
    await admin.query(`ALTER ROLE ${assertRoleName(options.role)} NOLOGIN PASSWORD NULL`);
    return { role: options.role, stillLogin };
  });
}

/** Whether these credentials get in. The URL is built in memory from a file; it is never printed. */
export async function checkLogin(url: string): Promise<{ accepted: boolean; code?: string; message: string }> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10000, application_name: 'hawa-rotate-app-role' });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return { accepted: true, message: 'accepted' };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { accepted: false, code: e.code, message: e.message ?? String(err) };
  } finally {
    await client.end().catch(() => {});
  }
}

/** Write the rotated role and password into URL lines of an env file, keeping a 0600 backup. */
export function installEnv(envFile: string, secretFile: string, keys: string[], backupDir = DEFAULT_SECRET_DIR): { role: string; backup: string; targets: string[] } {
  const secret = readFileSync(secretFile, 'utf8');
  const role = readEnvValue(secret, 'HAWA_APP_ROLE');
  const password = readEnvValue(secret, 'HAWA_APP_PASSWORD');
  const before = readFileSync(envFile, 'utf8');
  let after = before;
  for (const key of keys) after = replaceUrlCredentials(after, key, role, password);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  chmodSync(backupDir, 0o700);
  const backup = path.join(backupDir, `${path.basename(envFile).replace(/^\./, '')}.${stamp()}.bak`);
  writeFileSync(backup, before, { mode: 0o600, flag: 'wx' });
  // In a release directory infra/docker/.env is a link to ~/.hawa/shared (ADR-158): the new file
  // replaces the file the link names, beside it, so the link and every other release keep reading it.
  // Renaming onto the link itself would have left the shared file on the old credential.
  const target = realpathSync(envFile);
  const mode = statSync(target).mode & 0o777;
  const tmp = `${target}.rotate-${process.pid}`;
  writeFileSync(tmp, after, { mode: mode & 0o700 });
  renameSync(tmp, target);
  const targets = keys.map((key) => {
    const u = new URL(readEnvValue(after, key));
    return `${key} -> ${u.username}@${u.host}${u.pathname}`;
  });
  return { role, backup, targets };
}

// ---------------------------------------------------------------------------------------------
// Command line

function argValues(argv: string[], name: string): string[] {
  const values: string[] = [];
  argv.forEach((arg, i) => {
    if (arg === name && argv[i + 1] !== undefined) values.push(argv[i + 1]);
    else if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1));
  });
  return values;
}

function argValue(argv: string[], name: string): string | undefined {
  const values = argValues(argv, name);
  if (values.length > 1) throw new Error(`${name} given more than once`);
  return values[0];
}

function requireArg(argv: string[], name: string): string {
  const value = argValue(argv, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function adminPasswordFrom(argv: string[]): string {
  const file = argValue(argv, '--password-env-file');
  const key = argValue(argv, '--password-key');
  if (file || key) {
    if (!file || !key) throw new Error('--password-env-file and --password-key go together');
    return readEnvValue(readFileSync(file, 'utf8'), key, { passwordOnly: true });
  }
  if (process.env.PGPASSWORD) return process.env.PGPASSWORD;
  throw new Error('No admin password: pass --password-env-file <file> --password-key <KEY> (e.g. infra/docker/.env POSTGRES_PASSWORD), or set PGPASSWORD');
}

const USAGE = `usage: infra/ops/rotate_app_role.sh <command> [options]
  rotate       --url <postgresql://owner@host:port/db> [--role hawa_app_a|hawa_app_b] [--secret-dir DIR]
  status       --url <...>
  verify       --url <...> --role <login role> --secret-file FILE
  retire       --url <...> --role <hawa_app|hawa_app_a|hawa_app_b>
  install-env  --secret-file FILE --env-file FILE [--key DATABASE_URL]...
  check-login  --url <postgresql://host:port/db> --credentials-env-file FILE --credentials-key KEY
common: --production (required for the production server), --app-role NAME (default hawa_app),
        --password-env-file FILE --password-key KEY (admin password; or PGPASSWORD)`;

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const production = rest.includes('--production');
  const appRole = argValue(rest, '--app-role') ?? DEFAULT_APP_ROLE;
  const quoted = (value: string) => (/^[A-Za-z0-9_./:@=+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);
  const cliArgs = () => {
    const parts = ['--url', quoted(requireArg(rest, '--url'))];
    for (const name of ['--password-env-file', '--password-key', '--app-role']) {
      const value = argValue(rest, name);
      if (value) parts.push(name, quoted(value));
    }
    if (production) parts.push('--production');
    return parts.join(' ');
  };
  // The target is judged before any password is read, so a production URL without --production
  // stops here even when no credential file was given.
  if (['rotate', 'status', 'retire', 'verify'].includes(command)) parseAdminTarget(requireArg(rest, '--url'), { production });
  switch (command) {
    case 'rotate': {
      const result = await rotateAppRole(requireArg(rest, '--url'), {
        appRole, production, adminPassword: adminPasswordFrom(rest), role: argValue(rest, '--role'),
        secretDir: argValue(rest, '--secret-dir'), cliArgs: cliArgs(),
      });
      for (const warning of result.warnings) console.log(`warning: ${warning}`);
      console.log(result.steps);
      return;
    }
    case 'verify': {
      const report = await verifyExistingRole(requireArg(rest, '--url'), {
        appRole, production, adminPassword: adminPasswordFrom(rest), role: requireArg(rest, '--role'), secretFile: requireArg(rest, '--secret-file'),
      });
      for (const warning of report.warnings) console.log(`warning: ${warning}`);
      for (const problem of report.problems) console.log(`PROBLEM: ${problem}`);
      console.log(`${report.problems.length === 0 ? 'ok' : 'FAILED'}: ${report.tablesCompared} tables compared by privilege, ${report.contextsCompared} RLS contexts compared row for row`);
      if (report.problems.length) process.exitCode = 1;
      return;
    }
    case 'status': {
      const rows = await roleStatus(requireArg(rest, '--url'), { appRole, production, adminPassword: adminPasswordFrom(rest) });
      for (const r of rows) {
        console.log(`${r.name.padEnd(16)} ${!r.exists ? 'absent' : `${r.canLogin ? 'LOGIN  ' : 'NOLOGIN'}  password ${r.hasPassword === null ? '?' : r.hasPassword ? 'stored' : 'none'}  sessions ${r.sessions}`}`);
      }
      return;
    }
    case 'retire': {
      const result = await retireRole(requireArg(rest, '--url'), { appRole, production, adminPassword: adminPasswordFrom(rest), role: requireArg(rest, '--role') });
      console.log(`${result.role} is NOLOGIN with no stored password. Still able to log in: ${result.stillLogin.join(', ')}.`);
      return;
    }
    case 'install-env': {
      const keys = argValues(rest, '--key');
      const result = installEnv(requireArg(rest, '--env-file'), requireArg(rest, '--secret-file'), keys.length ? keys : ['DATABASE_URL'], argValue(rest, '--backup-dir'));
      console.log(`${result.targets.join('\n')}\nbackup of the previous file: ${result.backup} (mode 0600)`);
      return;
    }
    case 'check-login': {
      const target = parseAdminTarget(requireArg(rest, '--url'), { production });
      const source = readEnvValue(readFileSync(requireArg(rest, '--credentials-env-file'), 'utf8'), requireArg(rest, '--credentials-key'));
      if (!POSTGRES_URL.test(source)) throw new Error('--credentials-key must name a postgres URL line');
      const from = new URL(source);
      const url = new URL(`postgresql://${target.host}:${target.port}/${encodeURIComponent(target.database)}`);
      url.username = from.username;
      url.password = from.password;
      const result = await checkLogin(url.toString());
      console.log(result.accepted
        ? `ACCEPTED: ${decodeURIComponent(from.username)} logs in to ${target.host}:${target.port}/${target.database} with these credentials`
        : `refused (${result.code ?? 'no code'}): ${result.message}`);
      if (result.accepted) process.exitCode = 3;
      return;
    }
    default:
      console.error(USAGE);
      process.exitCode = 2;
  }
}

// Only when run directly: the tests import the functions above and must not start a command.
const isEntryPoint = (() => {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return path.resolve(invoked) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`rotate_app_role: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

