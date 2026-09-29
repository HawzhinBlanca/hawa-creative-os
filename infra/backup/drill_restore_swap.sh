#!/usr/bin/env bash
# Drill: restore an older dump over a migrated database, the way runbooks/10_backup_restore.md says
# (ADR-129, Phase 4 operations finding 26). Never against production.
#
#   HAWA_DRILL_DUMP=<pre-deploy or nightly dump> HAWA_DRILL_OWNER_URL=<owner URL of the TEST server> \
#     bash infra/backup/drill_restore_swap.sh > receipt.json
#
# 1. Restores the dump into a scratch database hawa_scratch_<stamp> (production before a deploy).
# 2. Applies this checkout's migrations to it (the deploy).
# 3. Red: on a copy, runs the restore step the runbook used to give (pg_restore --clean --if-exists
#    --exit-on-error into the migrated database), and the docs/25 variant without --exit-on-error.
# 4. Green: runs the block between the restore-swap markers of runbooks/10_backup_restore.md, read
#    from the file as it stands, with PG, DB and DUMP pointing at the scratch database.
# 5. Checks the swapped-in copy against the dump and the application role's view of it.
# Before step 4 the scratch database is given what production may carry outside the dump (Phase 4
# review of ADR-129): CONNECT revoked from PUBLIC and granted to a scratch login role that inherits
# hawa_app (as hawa_app_a does), a database setting and a per-database role setting. After the swap
# the drill logs in as that role, reads both settings, counts tasks with and without tenant context,
# and checks that hawa_app, which holds no CONNECT there, is refused.
# HAWA_DRILL_RUNBOOK=<file> runs another copy of the runbook (the red run of an older block).
# Every hawa_scratch_<stamp>* database and the scratch role are dropped on exit. The receipt holds
# counts only: no row of the dump is printed.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# The SHA-256 tool, chosen per host (ADR-141).
source "$ROOT/infra/ops/host_lib.sh"
PG="${HAWA_DRILL_CONTAINER:-hawa-test-postgres}"
DUMP="${HAWA_DRILL_DUMP:?set HAWA_DRILL_DUMP to a dump file}"
OWNER_URL="${HAWA_DRILL_OWNER_URL:?set HAWA_DRILL_OWNER_URL to the test server owner URL}"
TENANT='00000000-0000-4000-a000-000000000001'
AUTOMATION='00000000-0000-4000-b000-000000000011'

# Never production: not its container, not its port, not its database.
[[ "$PG" != hawa-production-* ]] || { echo "refusing: $PG is a production container" >&2; exit 2; }
url_part() { node -e 'const u=new URL(process.argv[1]);process.stdout.write(process.argv[2]==="port"?u.port:u.pathname.slice(1))' "$OWNER_URL" "$1"; }
[[ "$(url_part port)" != 54332 ]] || { echo "refusing: port 54332 is the production server" >&2; exit 2; }
[[ "$(url_part db)" != hawa ]] || { echo "refusing: the database hawa is production's name" >&2; exit 2; }
[[ -f "$DUMP" ]] || { echo "no dump at $DUMP" >&2; exit 2; }

RUNBOOK="${HAWA_DRILL_RUNBOOK:-$ROOT/runbooks/10_backup_restore.md}"
STAMP="$(date -u +%Y%m%dt%H%M%Sz)"
LIVE="hawa_scratch_${STAMP}"
LOGIN="hawa_scratch_${STAMP}_login"
[[ "$LIVE" =~ ^hawa_scratch_[0-9]{8}t[0-9]{6}z$ ]] || { echo "unexpected scratch name $LIVE" >&2; exit 2; }
psql_owner() { docker exec "$PG" psql -X -qAt -U hawa_owner -v ON_ERROR_STOP=1 "$@"; }
cleanup() {
  local db
  for db in $(psql_owner -d postgres -c "SELECT datname FROM pg_database WHERE datname LIKE 'hawa_scratch_${STAMP}%'" 2>/dev/null || true); do
    [[ "$db" == hawa_scratch_"${STAMP}"* ]] && docker exec "$PG" dropdb -U hawa_owner --force "$db" >/dev/null 2>&1 || true
  done
  local left; left="$(psql_owner -d postgres -c "SELECT count(*) FROM pg_database WHERE datname LIKE 'hawa_scratch_${STAMP}%'" 2>/dev/null || echo unknown)"
  echo "scratch databases left after cleanup: ${left}" >&2
  psql_owner -d postgres -c "DROP ROLE IF EXISTS \"${LOGIN}\"" >/dev/null 2>&1 || true
  left="$(psql_owner -d postgres -c "SELECT count(*) FROM pg_roles WHERE rolname = '${LOGIN}'" 2>/dev/null || echo unknown)"
  echo "scratch roles left after cleanup: ${left}" >&2
}
trap cleanup EXIT

# policies, foreign keys, triggers, FORCE RLS tables, the newest applied upgrade, and what the
# application role sees in hawa.tasks with and without its tenant context.
counts() {
  psql_owner -d "$1" -c "SELECT json_build_object(
    'policies', (SELECT count(*) FROM pg_policy),
    'foreign_keys', (SELECT count(*) FROM pg_constraint WHERE contype='f'),
    'triggers', (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal),
    'tables', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hawa' AND c.relkind='r'),
    'force_rls_tables', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hawa' AND c.relkind='r' AND c.relforcerowsecurity))" | sed 's/}$//'
  # A failed --clean restore can leave hawa.schema_upgrades dropped.
  psql_owner -d "$1" -c "SELECT json_build_object('last_upgrade', max(name), 'upgrades', count(*)) FROM hawa.schema_upgrades" 2>/dev/null | sed 's/^{/, /' \
    || echo ', "last_upgrade" : null, "upgrades" : null}'
}
app_view() {
  psql_owner -d "$1" -c "BEGIN" -c "SET LOCAL ROLE hawa_app" \
    -c "SELECT set_config('app.tenant_id','${TENANT}',true), set_config('hawa.current_tenant_id','${TENANT}',true), set_config('app.user_id','${AUTOMATION}',true), set_config('hawa.current_user_id','${AUTOMATION}',true), set_config('app.role','operator',true), set_config('hawa.current_role','operator',true)" \
    -c "SELECT count(*) FROM hawa.tasks" -c "COMMIT" 2>/dev/null | tail -1 || echo error
}
app_view_without_context() {
  psql_owner -d "$1" -c "BEGIN" -c "SET LOCAL ROLE hawa_app" -c "SELECT count(*) FROM hawa.tasks" -c "COMMIT" 2>/dev/null | tail -1 || echo error
}
toc_counts() {
  local toc; toc="$(docker exec -i "$PG" pg_restore --list < "$DUMP")"
  printf '{"policies":%s,"foreign_keys":%s,"triggers":%s}' \
    "$(grep -cE '^[0-9]+; [0-9]+ [0-9]+ POLICY ' <<< "$toc")" "$(grep -cE '^[0-9]+; [0-9]+ [0-9]+ FK CONSTRAINT ' <<< "$toc")" "$(grep -cE '^[0-9]+; [0-9]+ [0-9]+ TRIGGER ' <<< "$toc")"
}
# The database's own owner/grants/settings line (infra/backup/restore_props.sql).
props() { docker exec -i "$PG" psql -X -qAt -U hawa_owner -d postgres -v ON_ERROR_STOP=1 -v name="$1" < "$ROOT/infra/backup/restore_props.sql"; }
# As the scratch login role, through its own connection: its settings there, and what it sees.
login_view() {
  docker exec "$PG" psql -X -qAt -U "$LOGIN" -d "$1" -v ON_ERROR_STOP=1 -c "BEGIN" \
    -c "SELECT set_config('app.tenant_id','${TENANT}',true), set_config('hawa.current_tenant_id','${TENANT}',true), set_config('app.user_id','${AUTOMATION}',true), set_config('hawa.current_user_id','${AUTOMATION}',true), set_config('app.role','operator',true), set_config('hawa.current_role','operator',true)" \
    -c "SELECT json_build_object('connected', true, 'statement_timeout', current_setting('statement_timeout'), 'work_mem', current_setting('work_mem'), 'app_rows_with_context', (SELECT count(*) FROM hawa.tasks))" -c "COMMIT" 2>/dev/null | grep '^{' \
    || echo '{"connected":false}'
}
# hawa_app holds no CONNECT on the scratch database once PUBLIC's is revoked.
refused_without_connect() {
  local err; err="$(docker exec "$PG" psql -X -qAt -U hawa_app -d "$1" -c "SELECT 1" 2>&1 >/dev/null)" && { echo false; return 0; }
  if grep -q 'permission denied for database' <<< "$err"; then echo true; else echo "unexpected"; fi
}
db_url() { node -e 'const u=new URL(process.argv[1]);u.pathname="/"+process.argv[2];process.stdout.write(u.toString())' "$OWNER_URL" "$1"; }

DUMP_SHA="$("${HAWA_SHA256[@]}" "$DUMP" | cut -d' ' -f1)"
if [[ -f "$DUMP.sha256" ]]; then [[ "$DUMP_SHA" == "$(tr -d '[:space:]' < "$DUMP.sha256")" ]] || { echo "dump checksum mismatch" >&2; exit 1; }; fi
echo "drill ${STAMP}: container ${PG}, scratch ${LIVE}" >&2

# 1. Production before the deploy.
docker exec "$PG" createdb -U hawa_owner -T template0 "$LIVE"
docker exec -i "$PG" pg_restore -U hawa_owner -d "$LIVE" --exit-on-error --single-transaction < "$DUMP"
BEFORE="$(counts "$LIVE")"; BEFORE_APP="$(app_view "$LIVE")"

# 2. The deploy: this checkout's migrations.
UPGRADE_OUT="$(cd "$ROOT" && DATABASE_URL="$(db_url "$LIVE")" npx tsx packages/db/src/upgrade.ts)"
APPLIED="$(node -e 'const r=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify({applied:r.applied.length,first:r.applied[0]??null,last:r.applied.at(-1)??null,verified:r.verified.length}))' "$UPGRADE_OUT")"
MIGRATED="$(counts "$LIVE")"; MIGRATED_APP="$(app_view "$LIVE")"

# 3. Red: the old documented step on a copy of the migrated database, and the docs/25 variant.
red_run() { # name, pg_restore options...
  local db="${LIVE}_$1" rc=0 err; shift
  psql_owner -d postgres -c "CREATE DATABASE \"${db}\" TEMPLATE \"${LIVE}\"" >/dev/null
  err="$(docker exec -i "$PG" pg_restore -U hawa_owner -d "$db" "$@" < "$DUMP" 2>&1 >/dev/null)" || rc=$?
  local first; first="$(grep -m1 -oE 'cannot drop .{1,200} because other objects depend on it' <<< "$err" || true)"
  printf '{"options":"%s","exit":%s,"errors":%s,"first_dependency_error":%s,"after":%s,"app_rows_with_context":"%s"}' \
    "$*" "$rc" "$(grep -c '^pg_restore: error' <<< "$err" || true)" "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]||null))' "$first")" "$(counts "$db")" "$(app_view "$db")"
  docker exec "$PG" dropdb -U hawa_owner --force "$db" >/dev/null
}
RED_RUNBOOK="$(red_run red_runbook --clean --if-exists --exit-on-error)"
RED_DOCS25="$(red_run red_docs25 --clean --if-exists)"

# What production may carry outside the dump: database grants and settings (see the header).
psql_owner -d postgres -c "CREATE ROLE \"${LOGIN}\" LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS" \
  -c "GRANT hawa_app TO \"${LOGIN}\" WITH INHERIT TRUE" \
  -c "REVOKE CONNECT, TEMPORARY ON DATABASE \"${LIVE}\" FROM PUBLIC" -c "GRANT CONNECT ON DATABASE \"${LIVE}\" TO \"${LOGIN}\"" \
  -c "ALTER DATABASE \"${LIVE}\" SET statement_timeout TO '47s'" -c "ALTER ROLE \"${LOGIN}\" IN DATABASE \"${LIVE}\" SET work_mem TO '7MB'" >/dev/null
PROPS_BEFORE="$(props "$LIVE")"; LOGIN_BEFORE="$(login_view "$LIVE")"; REFUSED_BEFORE="$(refused_without_connect "$LIVE")"

# 4. Green: the runbook's own block, as the file has it, from the repository root.
BLOCK="$(awk '/<!-- restore-swap:begin -->/{on=1;next} /<!-- restore-swap:end -->/{on=0} on' "$RUNBOOK" | sed -e 's/^   //' | grep -v '^```')"
[[ -n "$BLOCK" ]] || { echo "${RUNBOOK} has no restore-swap block" >&2; exit 1; }
BLOCK_SHA="$(printf '%s' "$BLOCK" | "${HAWA_SHA256[@]}" | cut -d' ' -f1)"
GREEN_OUT="$(cd "$ROOT" && PG="$PG" DB="$LIVE" DUMP="$DUMP" bash -Eeuo pipefail -c "$BLOCK")"
grep -q '^restore-check=ok' <<< "$GREEN_OUT" || { echo "$GREEN_OUT" >&2; echo "the runbook block did not swap" >&2; exit 1; }
REPLACED="$(sed -n 's/.*kept as \(hawa_scratch_[0-9a-z_]*\)$/\1/p' <<< "$GREEN_OUT")"
AFTER="$(counts "$LIVE")"; AFTER_APP="$(app_view "$LIVE")"; AFTER_APP_NO_CONTEXT="$(app_view_without_context "$LIVE")"
PROPS_AFTER="$(props "$LIVE")"; LOGIN_AFTER="$(login_view "$LIVE")"; REFUSED_AFTER="$(refused_without_connect "$LIVE")"
REPLACED_COUNTS="$(counts "$REPLACED")"
WANT="$(toc_counts)"

node -e '
const [stamp, sha, toc, before, beforeApp, applied, migrated, migratedApp, redRunbook, redDocs25, blockSha, green, after, afterApp, afterNoCtx, replaced, replacedCounts,
  runbook, propsBefore, propsAfter, loginBefore, loginAfter, refusedBefore, refusedAfter] = process.argv.slice(1);
const j = JSON.parse;
const a = j(after), b = j(before), t = j(toc);
const restored = a.policies === b.policies && a.foreign_keys === b.foreign_keys && a.triggers === b.triggers && a.force_rls_tables === b.force_rls_tables && a.last_upgrade === b.last_upgrade && a.upgrades === b.upgrades;
const matchesDump = a.policies === t.policies && a.foreign_keys === t.foreign_keys && a.triggers === t.triggers;
const appSees = Number(afterApp) === Number(beforeApp) && Number(afterApp) > 0 && Number(afterNoCtx) === 0;
const la = j(loginAfter), lb = j(loginBefore);
// Printed without the hash: owner, encoding and counts only.
const shown = (p) => p.replace(/ hash=[0-9a-f]+$/, "");
const propsKept = propsAfter === propsBefore && propsAfter.startsWith("owner=");
const loginWorks = la.connected === true && la.statement_timeout === "47s" && la.work_mem === "7MB" && la.app_rows_with_context === Number(afterApp);
const connectKept = refusedBefore === "true" && refusedAfter === "true";
process.stdout.write(JSON.stringify({
  drill: "restore an older dump over a migrated database (runbooks/10_backup_restore.md, restore-swap block)",
  stamp, runbook, dump_sha256: sha, dump_toc: t,
  before_deploy: { ...b, app_rows_with_context: Number(beforeApp) },
  deploy: j(applied), after_deploy: { ...j(migrated), app_rows_with_context: Number(migratedApp) },
  red_runbook_step: j(redRunbook), red_docs25_step: j(redDocs25),
  green: { block_sha256: blockSha, output: green.split("\n"),
    after_swap: { ...a, app_rows_with_context: Number(afterApp), app_rows_without_context: Number(afterNoCtx) },
    replaced_database: { name: replaced, ...j(replacedCounts) } },
  database_properties: {
    set_before_swap: "CONNECT, TEMPORARY revoked from PUBLIC; CONNECT granted to the scratch login role; ALTER DATABASE SET statement_timeout 47s; ALTER ROLE <login> IN DATABASE SET work_mem 7MB",
    before_swap: shown(propsBefore), after_swap: shown(propsAfter), same_hash: propsAfter === propsBefore,
    login_before_swap: lb, login_after_swap: la,
    hawa_app_refused_connect: { before_swap: refusedBefore, after_swap: refusedAfter } },
  verdict: { restored_to_pre_deploy_schema: restored, matches_dump_toc: matchesDump, app_role_sees_rows_only_with_context: appSees,
    database_properties_kept: propsKept, login_role_connects_with_its_settings: loginWorks, connect_still_refused_to_others: connectKept,
    passed: restored && matchesDump && appSees && propsKept && loginWorks && connectKept },
}, null, 2) + "\n");
if (!(restored && matchesDump && appSees && propsKept && loginWorks && connectKept)) process.exitCode = 1;
' "$STAMP" "$DUMP_SHA" "$WANT" "$BEFORE" "$BEFORE_APP" "$APPLIED" "$MIGRATED" "$MIGRATED_APP" "$RED_RUNBOOK" "$RED_DOCS25" "$BLOCK_SHA" "$GREEN_OUT" "$AFTER" "$AFTER_APP" "$AFTER_APP_NO_CONTEXT" "$REPLACED" "$REPLACED_COUNTS" \
  "${RUNBOOK#"$ROOT"/}" "$PROPS_BEFORE" "$PROPS_AFTER" "$LOGIN_BEFORE" "$LOGIN_AFTER" "$REFUSED_BEFORE" "$REFUSED_AFTER"
