/**
 * Read-only invariants for a database that has just been upgraded (ADR-137): what a deploy must
 * not break in production's own data, which the test and chaos databases do not contain.
 *
 * On 2026-09-28 a release passed its whole gate and still refused every paid call in production:
 * migrations 051/056 counted 79 historical records without a quote as "history incomplete"
 * (ADR-133). The suites never saw it because their databases hold no production-shaped history.
 * These checks run on a scratch restore of the newest production dump with the pending migrations
 * applied (predeploy-dump-check.ts), and would have failed that release:
 *
 *  - budget-history: for every tenant, the office and every client, no daily spending scope is
 *    historyIncomplete (hawa.studio_scope_budget_internal);
 *  - admission: a zero-dollar admission (hawa.admit_office_spending) for every tenant, client and
 *    spending role is not refused. Zero is never "exhausted", so only a refusal for history or an
 *    invalid policy can fail it;
 *  - app-role: the runtime role (hawa_app) can read the office's tasks and clients under RLS;
 *  - schema-parity: the upgraded schema has what a database built from this checkout has
 *    (tables, columns, functions, triggers, policies, RLS flags, constraints, indexes, enums and the
 *    runtime role's privileges), so the tests exercised the schema production will run;
 *  - constraints: every NOT VALID constraint would validate against the data.
 *
 * Everything runs in transactions that are rolled back. Results carry counts and schema object
 * names only, never row contents.
 */
import pg from 'pg';

export interface InvariantResult {
  name: string;
  ok: boolean;
  detail: string;
  /** Problems by schema-object name or error class; never row contents. */
  problems?: string[];
  /** schema-parity: every object or privilege production has beyond a fresh build (names only). */
  extra?: string[];
}

export interface InvariantReport {
  ok: boolean;
  counts: Record<string, number>;
  invariants: InvariantResult[];
}

/** Daily spending scopes of one budget answer (studio_scope_budget_internal). */
export interface BudgetScope { scope: string; subject: string; historyIncomplete: boolean }

/** The scopes of a budget answer that are historyIncomplete, as `scope:subject`. */
export function incompleteScopes(budget: { scopes?: BudgetScope[] | null } | null | undefined): string[] {
  return (budget?.scopes ?? []).filter((s) => s.historyIncomplete === true).map((s) => `${s.scope}:${s.subject}`);
}

/** The error class of a refused admission (OFFICE_BUDGET_HISTORY_INCOMPLETE, …), without its detail. */
export function refusalClass(message: string): string {
  const m = /\b([A-Z][A-Z_]{5,}):/.exec(message);
  return m ? m[1] : message.split('\n')[0].slice(0, 120);
}

/** A named snapshot of a schema: key -> fingerprint. */
export type SchemaShape = Record<string, string>;

/** Differences between two shapes: what the expected one has that the actual lacks, and what differs. */
export function diffShapes(expected: SchemaShape, actual: SchemaShape): { missing: string[]; differing: string[]; extra: string[] } {
  const missing: string[] = [];
  const differing: string[] = [];
  const extra: string[] = [];
  for (const [key, value] of Object.entries(expected)) {
    if (!(key in actual)) missing.push(key);
    else if (actual[key] !== value) differing.push(key);
  }
  for (const key of Object.keys(actual)) if (!(key in expected)) extra.push(key);
  return { missing: missing.sort(), differing: differing.sort(), extra: extra.sort() };
}

const SHAPE_QUERIES: Array<[string, string]> = [
  ['column', `SELECT table_name||'.'||column_name AS k, concat_ws('|',udt_name,is_nullable,column_default) AS v
    FROM information_schema.columns WHERE table_schema='hawa'`],
  ['function', `SELECT p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS k,
      md5(regexp_replace(pg_get_functiondef(p.oid),'\\s+',' ','g')) AS v
    FROM pg_proc p WHERE p.pronamespace='hawa'::regnamespace AND p.prokind IN ('f','p')`],
  ['trigger', `SELECT t.tgrelid::regclass::text||'.'||t.tgname AS k, t.tgenabled::text||'|'||md5(pg_get_triggerdef(t.oid)) AS v
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='hawa'::regnamespace AND NOT t.tgisinternal`],
  ['policy', `SELECT tablename||'.'||policyname AS k,
      concat_ws('|',permissive,cmd,array_to_string(roles,','),md5(coalesce(qual,'')),md5(coalesce(with_check,''))) AS v
    FROM pg_policies WHERE schemaname='hawa'`],
  ['rls', `SELECT relname AS k, relrowsecurity::text||'|'||relforcerowsecurity::text AS v
    FROM pg_class WHERE relnamespace='hawa'::regnamespace AND relkind IN ('r','p')`],
  ['constraint', `SELECT conrelid::regclass::text||'.'||conname AS k, md5(pg_get_constraintdef(oid)) AS v
    FROM pg_constraint WHERE connamespace='hawa'::regnamespace AND conrelid<>0`],
  ['index', `SELECT tablename||'.'||indexname AS k, md5(indexdef) AS v FROM pg_indexes WHERE schemaname='hawa'`],
  ['enum', `SELECT t.typname AS k, string_agg(e.enumlabel,',' ORDER BY e.enumsortorder) AS v
    FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid WHERE t.typnamespace='hawa'::regnamespace GROUP BY t.typname`],
  // Effective privileges of the runtime role (a table-level grant implies its column grants), keyed
  // only when held: missing = production would refuse what the tests were allowed.
  ['privilege', `SELECT c.relname||'.'||p.priv AS k, 'granted' AS v
    FROM pg_class c CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(priv)
    WHERE c.relnamespace='hawa'::regnamespace AND c.relkind IN ('r','p','v','m') AND has_table_privilege('hawa_app',c.oid,p.priv)`],
  ['column-privilege', `SELECT c.relname||'.'||a.attname||'.'||p.priv AS k, 'granted' AS v
    FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE']) p(priv)
    WHERE c.relnamespace='hawa'::regnamespace AND c.relkind IN ('r','p','v','m')
      AND has_column_privilege('hawa_app',c.oid,a.attnum,p.priv)`],
  ['execute', `SELECT p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS k,
      has_function_privilege('hawa_app',p.oid,'EXECUTE')::text AS v
    FROM pg_proc p WHERE p.pronamespace='hawa'::regnamespace AND p.prokind IN ('f','p')`],
];

/** The shape of the hawa schema of one database, for schema-parity. */
export async function schemaShape(client: pg.Client): Promise<SchemaShape> {
  const shape: SchemaShape = {};
  for (const [kind, query] of SHAPE_QUERIES) {
    for (const row of (await client.query<{ k: string; v: string | null }>(query)).rows) shape[`${kind} ${row.k}`] = row.v ?? '';
  }
  return shape;
}

async function rolledBack<T>(client: pg.Client, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  try {
    return await fn();
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
  }
}

async function attempt<T>(client: pg.Client, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  await client.query('SAVEPOINT invariant');
  try {
    const value = await fn();
    await client.query('RELEASE SAVEPOINT invariant');
    return { ok: true, value };
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT invariant');
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const limit = (items: string[], n = 20) => (items.length > n ? [...items.slice(0, n), `… ${items.length - n} more`] : items);

/**
 * Runs every invariant against `ownerUrl` (an owner's connection to the upgraded scratch database).
 * `expected`, when given, is the schema shape of a database built from this checkout.
 */
export async function checkPredeployInvariants(ownerUrl: string, options: { expected?: SchemaShape } = {}): Promise<InvariantReport> {
  const client = new pg.Client({ connectionString: ownerUrl, connectionTimeoutMillis: 10000 });
  await client.connect();
  const invariants: InvariantResult[] = [];
  const counts: Record<string, number> = {};
  try {
    await client.query("SET statement_timeout = '120s'");
    const tenants = (await client.query<{ id: string }>('SELECT id FROM hawa.tenants ORDER BY id')).rows.map((r) => r.id);
    const clients = (await client.query<{ tenant_id: string; id: string }>('SELECT tenant_id, id FROM hawa.clients ORDER BY tenant_id, id')).rows;
    counts.tenants = tenants.length;
    counts.clients = clients.length;
    for (const table of ['tasks', 'design_studio_calls', 'canva_design_plans', 'canva_planner_calls', 'eval_model_calls', 'paid_model_probe_calls', 'outbox_commands', 'client_dna_versions']) {
      const exists = (await client.query('SELECT to_regclass($1) IS NOT NULL AS e', [`hawa.${table}`])).rows[0].e;
      if (exists) counts[table] = Number((await client.query(`SELECT count(*)::int AS n FROM hawa.${table}`)).rows[0].n);
    }
    const scopes = [...tenants.map((t) => ({ tenant: t, client: null as string | null })), ...clients.map((c) => ({ tenant: c.tenant_id, client: c.id }))];

    // budget-history and admission, in one rolled-back transaction per tenant context.
    const incomplete: string[] = [];
    const refused: string[] = [];
    let admissions = 0;
    await rolledBack(client, async () => {
      for (const { tenant, client: cid } of scopes) {
        const label = cid ? `tenant#${tenants.indexOf(tenant) + 1}/client ${cid}` : `tenant#${tenants.indexOf(tenant) + 1}/office`;
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
        const budget = await attempt(client, async () => (await client.query('SELECT hawa.studio_scope_budget_internal($1::uuid, $2::uuid) AS b', [tenant, cid])).rows[0].b);
        if (!budget.ok) {
          refused.push(`${label}: budget ${refusalClass(budget.error)}`);
          continue;
        }
        for (const s of incompleteScopes(budget.value)) incomplete.push(`${label} ${s}`);
        const roles = ((budget.value?.scopes ?? []) as BudgetScope[]).filter((s) => s.scope === 'role').map((s) => s.subject);
        for (const role of roles) {
          admissions++;
          const admitted = await attempt(client, () => client.query('SELECT hawa.admit_office_spending($1::uuid, $2::uuid, $3, 0)', [tenant, cid, role]));
          if (!admitted.ok) refused.push(`${label} ${role}: ${refusalClass(admitted.error)}`);
        }
      }
    });
    counts.admissions = admissions;
    invariants.push({
      name: 'budget-history',
      ok: incomplete.length === 0,
      detail: incomplete.length ? `${incomplete.length} daily spending scope(s) are historyIncomplete: every paid call there is refused` : `no historyIncomplete scope in ${scopes.length} tenant/client budget(s)`,
      ...(incomplete.length ? { problems: limit(incomplete) } : {}),
    });
    invariants.push({
      name: 'admission',
      ok: refused.length === 0,
      detail: refused.length ? `${refused.length} zero-dollar admission(s) refused` : `${admissions} zero-dollar admission(s) accepted`,
      ...(refused.length ? { problems: limit(refused) } : {}),
    });

    // app-role: the runtime role reads under RLS (grants restored and upgraded as production's).
    const appProblems: string[] = [];
    await rolledBack(client, async () => {
      for (const tenant of tenants) {
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
        const read = await attempt(client, async () => {
          await client.query('SET LOCAL ROLE hawa_app');
          await client.query('SELECT count(*) FROM hawa.tasks');
          await client.query('SELECT count(*) FROM hawa.clients');
          await client.query('SELECT count(*) FROM hawa.outbox_commands');
          await client.query('RESET ROLE');
        });
        if (!read.ok) appProblems.push(`tenant#${tenants.indexOf(tenant) + 1}: ${refusalClass(read.error)}`);
      }
    });
    invariants.push({ name: 'app-role', ok: appProblems.length === 0, detail: appProblems.length ? 'the runtime role cannot read the office tables' : `hawa_app reads tasks, clients and outbox under RLS for ${tenants.length} tenant(s)`, ...(appProblems.length ? { problems: appProblems } : {}) });

    // constraints: NOT VALID constraints the data would break.
    const notValid = (await client.query<{ rel: string; con: string }>(
      "SELECT conrelid::regclass::text AS rel, conname AS con FROM pg_constraint WHERE connamespace='hawa'::regnamespace AND NOT convalidated AND contype IN ('c','f')")).rows;
    const violated: string[] = [];
    await rolledBack(client, async () => {
      for (const { rel, con } of notValid) {
        const r = await attempt(client, () => client.query(`ALTER TABLE ${rel} VALIDATE CONSTRAINT ${pg.escapeIdentifier(con)}`));
        if (!r.ok) violated.push(`${rel}.${con}`);
      }
    });
    counts.notValidConstraints = notValid.length;
    invariants.push({ name: 'constraints', ok: violated.length === 0, detail: violated.length ? `${violated.length} NOT VALID constraint(s) are broken by existing rows` : `${notValid.length} NOT VALID constraint(s), all hold on the data`, ...(violated.length ? { problems: violated } : {}) });

    if (options.expected) {
      const actual = await schemaShape(client);
      const d = diffShapes(options.expected, actual);
      counts.schemaObjects = Object.keys(actual).length;
      // Extra objects or privileges in production (left by an older schema or broader grants) are
      // reported by kind, not failed: the code never relies on what a fresh database lacks. Missing
      // or different ones fail: the tests ran against something production does not have.
      const extraByKind: Record<string, number> = {};
      for (const k of d.extra) extraByKind[k.split(' ')[0]] = (extraByKind[k.split(' ')[0]] || 0) + 1;
      const problems = [...d.missing.map((k) => `missing ${k}`), ...d.differing.map((k) => `differs ${k}`),
        ...Object.entries(extraByKind).map(([kind, n]) => `extra ${kind}: ${n}`)];
      for (const [kind, n] of Object.entries(extraByKind)) counts[`extra ${kind}`] = n;
      invariants.push({
        name: 'schema-parity',
        ok: d.missing.length === 0 && d.differing.length === 0,
        detail: `${d.missing.length} missing, ${d.differing.length} different, ${d.extra.length} extra of ${Object.keys(options.expected).length} object(s) a fresh build has`,
        ...(problems.length ? { problems: limit(problems, 60) } : {}),
        extra: d.extra,
      });
    }
  } finally {
    await client.end().catch(() => undefined);
  }
  return { ok: invariants.every((i) => i.ok), counts, invariants };
}
