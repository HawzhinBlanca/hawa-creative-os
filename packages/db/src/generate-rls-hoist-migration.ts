/**
 * Generates packages/db/migrations/016_rls_hoisted_membership_checks.sql (ADR-033).
 *
 * The row-level-security helpers (is_tenant_member, has_tenant_role, can_access_client,
 * can_write_client) are SECURITY DEFINER functions with a fixed search_path, which PostgreSQL cannot
 * inline, and every policy calls them with the row's own columns, so they run once per row. Each of
 * them first requires the row's tenant to be the current tenant; past that, the answer depends only
 * on the current user. This rewrites every policy that calls them so the per-user part is a scalar
 * subquery (an InitPlan, run once per statement) and the per-row part is a column comparison. The
 * cast on the client list matters: `= ANY ((SELECT …))` still parses as a set subquery comparing the
 * column with the whole array; `(SELECT …)::uuid[]` is a scalar subquery used as an array.
 *
 *   is_tenant_member(t)         -> (t = current_tenant_id() AND (SELECT is_tenant_member(current_tenant_id())))
 *   has_tenant_role(t, R)       -> (t = current_tenant_id() AND (SELECT has_tenant_role(current_tenant_id(), R)))
 *   can_access_client(t, c)     -> (t = current_tenant_id() AND ((SELECT has_tenant_role(current_tenant_id(), {administrator,auditor,operator}))
 *                                     OR c = ANY ((SELECT member_client_ids(false))::uuid[])))
 *   can_write_client(t, c)      -> (t = current_tenant_id() AND ((SELECT has_tenant_role(current_tenant_id(), {administrator,operator}))
 *                                     OR c = ANY ((SELECT member_client_ids(true))::uuid[])))
 *
 * The policies are read from a database built exactly as production is (schema, rls, seed and every
 * versioned migration), fully qualified (search_path ''), so the output does not depend on a search
 * path. The migration refuses to run unless each policy it replaces still has the definition it was
 * generated from, by hash, so a database whose policies differ is left alone and says so.
 *
 *   npx tsx packages/db/src/generate-rls-hoist-migration.ts <owner connection string to a freshly built test database>
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = path.join(root, 'packages/db/migrations/016_rls_hoisted_membership_checks.sql');

const ACCESS_ROLES = "ARRAY['administrator'::hawa.membership_role, 'auditor'::hawa.membership_role, 'operator'::hawa.membership_role]";
const WRITE_ROLES = "ARRAY['administrator'::hawa.membership_role, 'operator'::hawa.membership_role]";
const COLUMN = '([a-z_][a-z0-9_]*(?:\\.[a-z_][a-z0-9_]*)?)';

/** A helper called with something other than current_tenant_id() as its tenant: a per-row call. */
export const PER_ROW_CALL = /hawa\.(is_tenant_member|has_tenant_role|can_access_client|can_write_client)\((?!hawa\.current_tenant_id\(\))/;

/** The four substitutions; each returns the rewritten expression text. */
export function hoist(expr: string): string {
  let out = expr
    .replace(new RegExp(`hawa\\.is_tenant_member\\(${COLUMN}\\)`, 'g'), (_m, t) => `((${t} = hawa.current_tenant_id()) AND (SELECT hawa.is_tenant_member(hawa.current_tenant_id())))`)
    .replace(new RegExp(`hawa\\.has_tenant_role\\(${COLUMN}, (ARRAY\\[[^\\]]*\\])\\)`, 'g'), (_m, t, roles) => `((${t} = hawa.current_tenant_id()) AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(), ${roles})))`)
    .replace(
      new RegExp(`hawa\\.can_access_client\\(${COLUMN}, ${COLUMN}\\)`, 'g'),
      (_m, t, c) => `((${t} = hawa.current_tenant_id()) AND ((SELECT hawa.has_tenant_role(hawa.current_tenant_id(), ${ACCESS_ROLES})) OR (${c} = ANY ((SELECT hawa.member_client_ids(false))::uuid[]))))`
    )
    .replace(
      new RegExp(`hawa\\.can_write_client\\(${COLUMN}, ${COLUMN}\\)`, 'g'),
      (_m, t, c) => `((${t} = hawa.current_tenant_id()) AND ((SELECT hawa.has_tenant_role(hawa.current_tenant_id(), ${WRITE_ROLES})) OR (${c} = ANY ((SELECT hawa.member_client_ids(true))::uuid[]))))`
    );
  // Every call left must be one of the hoisted forms, with current_tenant_id() as its tenant.
  const left = out.match(/hawa\.(is_tenant_member|has_tenant_role|can_access_client|can_write_client)\((?!hawa\.current_tenant_id\(\))/g);
  if (left) throw new Error(`A helper call in an unexpected form was left in: ${left.join(', ')} in ${expr}`);
  return out;
}

const md5 = (text: string | null) => (text === null ? null : createHash('md5').update(text).digest('hex'));
const CMD: Record<string, string> = { r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE', '*': 'ALL' };
const literal = (text: string) => `'${text.replace(/'/g, "''")}'`;

async function main() {
  const url = process.argv[2];
  if (!url || !/127\.0\.0\.1:55432\//.test(url)) throw new Error('Pass the owner URL of a test database on the test server (127.0.0.1:55432).');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(`SET search_path = ''`);
  const { rows } = await client.query<{
    table: string; name: string; cmd: string; permissive: boolean; roles: string[]; qual: string | null; check: string | null;
  }>(`SELECT c.relname AS table, p.polname AS name, p.polcmd AS cmd, p.polpermissive AS permissive,
            COALESCE((SELECT array_agg(CASE WHEN r = 0 THEN 'public' ELSE quote_ident(pg_catalog.pg_get_userbyid(r)) END ORDER BY r) FROM unnest(p.polroles) r), ARRAY['public']) AS roles,
            pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS qual, pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check
       FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'hawa' ORDER BY c.relname, p.polname`);
  await client.end();

  // A policy needs rewriting when a helper is called with anything but current_tenant_id() as its
  // tenant; one already rewritten is left out, and a database with none left stops the generator.
  const changed = rows.filter((r) => PER_ROW_CALL.test(`${r.qual ?? ''} ${r.check ?? ''}`));
  if (!changed.length) throw new Error('No policy calls a helper per row: this database already has the rewrite (016 applied?). Nothing generated.');
  const lines: string[] = [];
  lines.push(
    `-- ADR-033: row-level-security membership checks run once per statement, not once per row.`,
    `-- Generated by packages/db/src/generate-rls-hoist-migration.ts from a database built as production is`,
    `-- (schema, rls, seed, migrations 001-015). Do not edit by hand: change the generator and regenerate.`,
    `-- ${changed.length} of ${rows.length} policies in schema hawa are rewritten; each rewrite is checked`,
    `-- against the definition it was generated from before it is replaced.`,
    ``,
    `-- The clients the current user is an active member of in the current tenant; with for_write, only`,
    `-- memberships that may write (designer, client DNA manager), as can_write_client counts them.`,
    `CREATE OR REPLACE FUNCTION hawa.member_client_ids(for_write boolean) RETURNS uuid[]`,
    `LANGUAGE sql STABLE SECURITY DEFINER SET search_path = hawa, public AS $$`,
    `  SELECT COALESCE(array_agg(cm.client_id), '{}'::uuid[])`,
    `  FROM hawa.client_memberships cm`,
    `  WHERE cm.tenant_id = hawa.current_tenant_id() AND cm.user_id = hawa.current_user_id() AND cm.active`,
    `    AND (NOT for_write OR cm.role = ANY (ARRAY['designer', 'client_dna_manager']::hawa.membership_role[]))`,
    `$$;`,
    ``,
    `-- Each policy must still read as it did when this was generated (md5 of its fully qualified text).`,
    `DO $$`,
    `DECLARE`,
    `  expected text[][] := ARRAY[`
  );
  lines.push(
    changed
      .map((r) => `    ARRAY[${literal(r.table)}, ${literal(r.name)}, ${literal(md5(r.qual) ?? '')}, ${literal(md5(r.check) ?? '')}]`)
      .join(',\n') + `];`,
    `  row text[];`,
    `  found_qual text;`,
    `  found_check text;`,
    `  saved_path text := current_setting('search_path');`,
    `BEGIN`,
    `  PERFORM set_config('search_path', '', true);`,
    `  FOREACH row SLICE 1 IN ARRAY expected LOOP`,
    `    SELECT COALESCE(md5(pg_catalog.pg_get_expr(p.polqual, p.polrelid)), ''), COALESCE(md5(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)), '')`,
    `      INTO found_qual, found_check`,
    `      FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace`,
    `     WHERE n.nspname = 'hawa' AND c.relname = row[1] AND p.polname = row[2];`,
    `    IF NOT FOUND OR found_qual <> row[3] OR found_check <> row[4] THEN`,
    `      RAISE EXCEPTION 'ADR-033: policy % on hawa.% is not the one this migration was generated from; nothing was changed', row[2], row[1];`,
    `    END IF;`,
    `  END LOOP;`,
    `  PERFORM set_config('search_path', saved_path, true);`,
    `END $$;`,
    ``
  );
  for (const r of changed) {
    const using = r.qual === null ? '' : ` USING (${hoist(r.qual)})`;
    const check = r.check === null ? '' : ` WITH CHECK (${hoist(r.check)})`;
    lines.push(
      `DROP POLICY ${r.name} ON hawa.${r.table};`,
      `CREATE POLICY ${r.name} ON hawa.${r.table} AS ${r.permissive ? 'PERMISSIVE' : 'RESTRICTIVE'} FOR ${CMD[r.cmd]} TO ${r.roles.join(', ')}${using}${check};`
    );
  }
  writeFileSync(OUT, lines.join('\n') + '\n');
  console.log(`wrote ${path.relative(root, OUT)}: ${changed.length} of ${rows.length} policies rewritten`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
