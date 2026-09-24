import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import {
  chooseNextLoginRole,
  checkLogin,
  generatePassword,
  installEnv,
  parseAdminTarget,
  readEnvValue,
  replaceUrlCredentials,
  retireRole,
  roleStatus,
  rotateAppRole,
  scramSha256Verifier,
} from '../src/rotate-app-role.js';

/**
 * Phase 0.6: the hawa_app password was committed once, and Postgres has no second password per
 * role. The rotation alternates two login roles (hawa_app_a, hawa_app_b) that inherit hawa_app, which
 * keeps every grant, policy and default privilege and finally stops logging in itself.
 */
describe('app role rotation: pure parts', () => {
  it('generates long URL-safe passwords that differ every time', () => {
    const a = generatePassword();
    const b = generatePassword();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(a).not.toBe(b);
  });

  it('builds a SCRAM-SHA-256 verifier, so the plaintext never reaches the server', () => {
    const verifier = scramSha256Verifier('pencil', Buffer.alloc(16, 7));
    expect(verifier).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/);
    expect(verifier).not.toContain('pencil');
    // RFC 5802 derivation, spelled out independently.
    const salted = pbkdf2Sync('pencil', Buffer.alloc(16, 7), 4096, 32, 'sha256');
    const stored = createHash('sha256').update(createHmac('sha256', salted).update('Client Key').digest()).digest('base64');
    const server = createHmac('sha256', salted).update('Server Key').digest('base64');
    expect(verifier).toBe(`SCRAM-SHA-256$4096:${Buffer.alloc(16, 7).toString('base64')}$${stored}:${server}`);
  });

  it('takes the target explicitly, never with a password in argv, and refuses production without --production', () => {
    const secret = ['x', 'y', 'z'].join('_');
    expect(() => parseAdminTarget(`postgresql://hawa_owner:${secret}@127.0.0.1:55432/hawa_test`, { production: false })).toThrow(/password/i);
    expect(() => parseAdminTarget('postgresql://hawa_owner@127.0.0.1:54332/hawa', { production: false })).toThrow(/--production/);
    expect(() => parseAdminTarget('postgresql://hawa_owner@127.0.0.1:5432/hawa', { production: false })).toThrow(/--production/);
    expect(() => parseAdminTarget('postgresql://hawa_owner@postgres:5432/other', { production: false })).toThrow(/--production/);
    expect(parseAdminTarget('postgresql://hawa_owner@127.0.0.1:54332/hawa', { production: true }).production).toBe(true);
    const test = parseAdminTarget('postgresql://hawa_owner@127.0.0.1:55432/hawa_test_s6', { production: false });
    expect(test.production).toBe(false);
    expect(test.database).toBe('hawa_test_s6');
    expect(() => parseAdminTarget('not a url', { production: false })).toThrow();
  });

  it('chooses the login role that is not in use, and refuses an unfinished rotation', () => {
    const state = (name: string, exists: boolean, canLogin: boolean, sessions = 0) => ({ name, exists, canLogin, sessions });
    const none = [state('hawa_app_a', false, false), state('hawa_app_b', false, false)];
    expect(chooseNextLoginRole('hawa_app', none)).toBe('hawa_app_a');
    expect(chooseNextLoginRole('hawa_app', [state('hawa_app_a', true, true, 4), state('hawa_app_b', false, false)])).toBe('hawa_app_b');
    expect(chooseNextLoginRole('hawa_app', [state('hawa_app_a', true, false), state('hawa_app_b', true, true, 3)])).toBe('hawa_app_a');
    expect(() => chooseNextLoginRole('hawa_app', [state('hawa_app_a', true, true), state('hawa_app_b', true, true)])).toThrow(/retire/i);
    expect(() => chooseNextLoginRole('hawa_app', [state('hawa_app_a', true, true, 2), state('hawa_app_b', false, false)], 'hawa_app_a')).toThrow(/session/);
    expect(() => chooseNextLoginRole('hawa_app', none, 'hawa_owner')).toThrow(/hawa_app_a or hawa_app_b/);
    expect(chooseNextLoginRole('hawa_app', none, 'hawa_app_b')).toBe('hawa_app_b');
  });

  it('swaps only the user and password of one URL line and keeps everything else', () => {
    const old = ['o', 'l', 'd'].join('');
    const text = `# comment\nPOSTGRES_PASSWORD=keep\nDATABASE_URL=postgresql://hawa_app:${old}@postgres:5432/hawa?sslmode=disable\nOTHER=1\n`;
    const fresh = ['n3w', '-pw'].join('_');
    const next = replaceUrlCredentials(text, 'DATABASE_URL', 'hawa_app_a', fresh);
    expect(next).toBe(`# comment\nPOSTGRES_PASSWORD=keep\nDATABASE_URL=postgresql://hawa_app_a:${fresh}@postgres:5432/hawa?sslmode=disable\nOTHER=1\n`);
    expect(() => replaceUrlCredentials('A=1\n', 'DATABASE_URL', 'r', 'p')).toThrow(/no DATABASE_URL/);
    expect(() => replaceUrlCredentials(`${text}DATABASE_URL=postgresql://x:y@h/d\n`, 'DATABASE_URL', 'r', 'p')).toThrow(/more than once/);
    expect(() => replaceUrlCredentials('DATABASE_URL=hello\n', 'DATABASE_URL', 'r', 'p')).toThrow(/not a postgres URL/);
  });

  it('installs a rotated credential into the env file, keeping the file mode and an owner-only backup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hawa-install-env-'));
    const old = ['o', 'l', 'd'].join('');
    const fresh = ['f', 'r', 'e', 's', 'h'].join('');
    const envFile = join(dir, '.env');
    const secretFile = join(dir, 'secret.env');
    const envText = `POSTGRES_PASSWORD=keep\nDATABASE_URL=postgresql://hawa_app:${old}@postgres:5432/hawa\n`;
    writeFileSync(envFile, envText, { mode: 0o640 });
    writeFileSync(secretFile, `# c\nHAWA_APP_ROLE=hawa_app_a\nHAWA_APP_PASSWORD=${fresh}\n`, { mode: 0o600 });
    const result = installEnv(envFile, secretFile, ['DATABASE_URL'], join(dir, 'backups'));
    expect(result.role).toBe('hawa_app_a');
    expect(result.targets).toEqual(['DATABASE_URL -> hawa_app_a@postgres:5432/hawa']);
    expect(result.targets.join('')).not.toContain(fresh);
    expect(readFileSync(envFile, 'utf8')).toBe(`POSTGRES_PASSWORD=keep\nDATABASE_URL=postgresql://hawa_app_a:${fresh}@postgres:5432/hawa\n`);
    expect(statSync(envFile).mode & 0o777).toBe(0o600); // group bits dropped: the file holds a credential
    expect(readFileSync(result.backup, 'utf8')).toBe(envText);
    expect(statSync(result.backup).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).sort()).toEqual(['.env', 'backups', 'secret.env']);
  });

  it('reads the admin password from a key that holds either a password or a URL', () => {
    const pw = ['s', '3', 'c'].join('');
    expect(readEnvValue(`A=1\nPOSTGRES_PASSWORD=${pw}\n`, 'POSTGRES_PASSWORD', { passwordOnly: true })).toBe(pw);
    expect(readEnvValue(`TEST_DATABASE_OWNER_URL=postgresql://hawa_owner:${pw}@127.0.0.1:55432/x\n`, 'TEST_DATABASE_OWNER_URL', { passwordOnly: true })).toBe(pw);
    expect(() => readEnvValue('A=1\n', 'POSTGRES_PASSWORD', { passwordOnly: true })).toThrow(/POSTGRES_PASSWORD/);
  });
});

/**
 * Against the slot's own test database. The group role is a throwaway (hawa_rot_<hex>) that is a
 * member of hawa_app, so it has hawa_app's grants and policies; retiring it cannot lock out the other
 * suites on this shared server the way retiring hawa_app itself would.
 */
const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;
describe.skipIf(!ownerUrl)('app role rotation against Postgres', () => {
  const base = `hawa_rot_${randomBytes(4).toString('hex')}`;
  const legacyPassword = generatePassword();
  const secretDir = mkdtempSync(join(tmpdir(), 'hawa-rotation-test-'));
  const admin = new URL(ownerUrl ?? 'postgresql://unset@127.0.0.1:1/unset');
  const adminPassword = decodeURIComponent(admin.password);
  admin.password = '';
  const adminUrl = admin.toString();
  const owner = new pg.Client({ connectionString: ownerUrl });
  const loginUrl = (role: string, password: string) => {
    const u = new URL(adminUrl);
    u.username = role;
    u.password = password;
    return u.toString();
  };
  const secretOf = (file: string) => {
    const values: Record<string, string> = {};
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line);
      if (m) values[m[1]] = m[2];
    }
    return values;
  };
  const opts = { appRole: base, secretDir, adminPassword };

  beforeAll(async () => {
    await owner.connect();
    // The legacy shape: the group role itself logs in, like hawa_app did before the rotation.
    await owner.query(`CREATE ROLE ${base} LOGIN PASSWORD '${scramSha256Verifier(legacyPassword)}'`);
    await owner.query(`GRANT hawa_app TO ${base}`);
    await owner.query(`ALTER ROLE ${base} SET statement_timeout = '7s'`);
  });

  afterAll(async () => {
    for (const role of [`${base}_a`, `${base}_b`, base]) {
      await owner.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`, [role]).catch(() => {});
      await owner.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    }
    await owner.end();
  });

  it('creates the first login role, verifies it behaves like the group under RLS, and keeps the password in a 0600 file only', async () => {
    const result = await rotateAppRole(adminUrl, opts);
    expect(result.role).toBe(`${base}_a`);
    expect(result.verification.problems).toEqual([]);
    expect(result.verification.tablesCompared).toBeGreaterThan(20);
    expect(result.verification.contextsCompared).toBeGreaterThanOrEqual(3);
    expect(statSync(result.secretFile).mode & 0o777).toBe(0o600);
    expect(statSync(secretDir).mode & 0o077).toBe(0);
    const secret = secretOf(result.secretFile);
    expect(secret.HAWA_APP_ROLE).toBe(`${base}_a`);
    expect(secret.HAWA_APP_PASSWORD).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    // The owner's instructions name the file, never the value.
    expect(result.steps).toContain(result.secretFile);
    expect(result.steps).not.toContain(secret.HAWA_APP_PASSWORD);
    expect(result.steps).toContain('NOLOGIN');

    const stored = (await owner.query(`SELECT rolpassword, rolcanlogin, rolinherit, rolbypassrls, rolsuper FROM pg_authid WHERE rolname = $1`, [`${base}_a`])).rows[0];
    expect(stored).toMatchObject({ rolcanlogin: true, rolinherit: true, rolbypassrls: false, rolsuper: false });
    expect(stored.rolpassword).toMatch(/^SCRAM-SHA-256\$4096:/);
    // A role setting of the group does not apply to its members' logins, so it is copied.
    const settings = (await owner.query(`SELECT s.setconfig FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole WHERE r.rolname = $1`, [`${base}_a`])).rows;
    expect(settings.flatMap((r: { setconfig: string[] }) => r.setconfig)).toContain('statement_timeout=7s');

    const client = new pg.Client({ connectionString: loginUrl(`${base}_a`, secret.HAWA_APP_PASSWORD) });
    await client.connect();
    try {
      const who = (await client.query(`SELECT current_user AS u, pg_has_role(current_user, $1, 'USAGE') AS member, current_setting('statement_timeout') AS st`, [base])).rows[0];
      expect(who).toEqual({ u: `${base}_a`, member: true, st: '7s' });
      // What the group may do to an append-only table, the login role may do, no more and no less.
      // (On the test server hawa_app may DELETE task_events: pnpm test:db does not apply
      // db/03-grants.sql, which production's initdb does. The comparison is what matters here.)
      const priv = (await client.query(`SELECT has_table_privilege('hawa.task_events', 'DELETE') AS del, has_table_privilege('hawa.task_events', 'TRUNCATE') AS trunc, has_table_privilege('hawa.tasks', 'SELECT') AS sel`)).rows[0];
      const groupPriv = (await owner.query(`SELECT has_table_privilege($1, 'hawa.task_events', 'DELETE') AS del, has_table_privilege($1, 'hawa.task_events', 'TRUNCATE') AS trunc, has_table_privilege($1, 'hawa.tasks', 'SELECT') AS sel`, [base])).rows[0];
      expect(priv).toEqual(groupPriv);
      expect(priv).toMatchObject({ trunc: false, sel: true });
    } finally {
      await client.end();
    }
  });

  it('refuses to retire a role that still has sessions, or the last role that can log in', async () => {
    const secret = secretOf(readdirSync(secretDir).map((f) => join(secretDir, f)).find((f) => f.includes(`${base}_a`))!);
    const held = new pg.Client({ connectionString: loginUrl(`${base}_a`, secret.HAWA_APP_PASSWORD) });
    await held.connect();
    try {
      await expect(retireRole(adminUrl, { ...opts, role: `${base}_a` })).rejects.toThrow(/session/);
    } finally {
      await held.end();
    }
  });

  it('retires the leaked group login: NOLOGIN, no stored password, and the old password is refused', async () => {
    expect((await checkLogin(loginUrl(base, legacyPassword))).accepted).toBe(true);
    const report = await retireRole(adminUrl, { ...opts, role: base });
    expect(report.role).toBe(base);
    const row = (await owner.query(`SELECT rolcanlogin, rolpassword FROM pg_authid WHERE rolname = $1`, [base])).rows[0];
    expect(row).toEqual({ rolcanlogin: false, rolpassword: null });
    const refused = await checkLogin(loginUrl(base, legacyPassword));
    expect(refused.accepted).toBe(false);
    expect(refused.code).toBe('28P01');
  });

  it('alternates to the other login role, then refuses a third rotation until one is retired', async () => {
    const second = await rotateAppRole(adminUrl, opts);
    expect(second.role).toBe(`${base}_b`);
    expect(second.verification.problems).toEqual([]);
    expect(second.steps).toContain(`${base}_a`);
    await expect(rotateAppRole(adminUrl, opts)).rejects.toThrow(/retire/i);

    const status = await roleStatus(adminUrl, opts);
    expect(status.map((s) => [s.name, s.canLogin])).toEqual([[base, false], [`${base}_a`, true], [`${base}_b`, true]]);

    await retireRole(adminUrl, { ...opts, role: `${base}_a` });
    await expect(retireRole(adminUrl, { ...opts, role: `${base}_b` })).rejects.toThrow(/last/);
    const third = await rotateAppRole(adminUrl, opts);
    expect(third.role).toBe(`${base}_a`);
    const secret = secretOf(third.secretFile);
    expect((await checkLogin(loginUrl(`${base}_a`, secret.HAWA_APP_PASSWORD))).accepted).toBe(true);
  });

  it('verifies in a number of round trips that does not grow with the number of tables', async () => {
    // Each rotation compared every table's row count one query at a time, under every context, on
    // both connections: several hundred round trips. Under the suite's parallel load that took the
    // test above past its 30 s limit (it takes 1.5 s on a quiet machine). Counted, not timed: a
    // round trip costs what the machine makes it cost, their number is the code's.
    await retireRole(adminUrl, { ...opts, role: `${base}_b` });
    const query = pg.Client.prototype.query;
    let roundTrips = 0;
    pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
      roundTrips++;
      return (query as (...a: unknown[]) => unknown).apply(this, args);
    } as typeof query;
    let result: Awaited<ReturnType<typeof rotateAppRole>>;
    try {
      result = await rotateAppRole(adminUrl, opts);
    } finally {
      pg.Client.prototype.query = query;
    }
    expect(result.verification.problems).toEqual([]);
    expect(result.verification.tablesCompared).toBeGreaterThan(20);
    // A fixed number for the catalogue and the role, and four a context: the settings and the counts, on each side.
    expect(roundTrips).toBeLessThanOrEqual(40 + 4 * result.verification.contextsCompared);
    // The next test counts the secret files of this role; this one was only for counting.
    unlinkSync(result.secretFile);
  });

  it('undoes the new login when it does not behave like the group, and says why', async () => {
    await retireRole(adminUrl, { ...opts, role: `${base}_b` });
    // A direct grant on a login role is exactly the drift the comparison exists to catch.
    await owner.query(`GRANT TRUNCATE ON hawa.task_events TO ${base}_b`);
    try {
      await expect(rotateAppRole(adminUrl, opts)).rejects.toThrow(/task_events/);
      const row = (await owner.query(`SELECT rolcanlogin, rolpassword FROM pg_authid WHERE rolname = $1`, [`${base}_b`])).rows[0];
      expect(row).toEqual({ rolcanlogin: false, rolpassword: null });
      expect(readdirSync(secretDir).filter((f) => f.includes(`${base}_b`)).length).toBe(1); // only the earlier, now retired, one
    } finally {
      await owner.query(`REVOKE TRUNCATE ON hawa.task_events FROM ${base}_b`);
    }
  });
});
