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
# Every hawa_scratch_<stamp>* database is dropped on exit. The receipt holds counts only: no row of
# the dump is printed.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
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

STAMP="$(date -u +%Y%m%dt%H%M%Sz)"
LIVE="hawa_scratch_${STAMP}"
[[ "$LIVE" =~ ^hawa_scratch_[0-9]{8}t[0-9]{6}z$ ]] || { echo "unexpected scratch name $LIVE" >&2; exit 2; }
psql_owner() { docker exec "$PG" psql -X -qAt -U hawa_owner -v ON_ERROR_STOP=1 "$@"; }
cleanup() {
  local db
  for db in $(psql_owner -d postgres -c "SELECT datname FROM pg_database WHERE datname LIKE 'hawa_scratch_${STAMP}%'" 2>/dev/null || true); do
    [[ "$db" == hawa_scratch_"${STAMP}"* ]] && docker exec "$PG" dropdb -U hawa_owner --force "$db" >/dev/null 2>&1 || true
  done
  local left; left="$(psql_owner -d postgres -c "SELECT count(*) FROM pg_database WHERE datname LIKE 'hawa_scratch_${STAMP}%'" 2>/dev/null || echo unknown)"
  echo "scratch databases left after cleanup: ${left}" >&2
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
db_url() { node -e 'const u=new URL(process.argv[1]);u.pathname="/"+process.argv[2];process.stdout.write(u.toString())' "$OWNER_URL" "$1"; }

DUMP_SHA="$(shasum -a 256 "$DUMP" | cut -d' ' -f1)"
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

# 4. Green: the runbook's own block, as the file has it.
BLOCK="$(awk '/<!-- restore-swap:begin -->/{on=1;next} /<!-- restore-swap:end -->/{on=0} on' "$ROOT/runbooks/10_backup_restore.md" | sed -e 's/^   //' | grep -v '^```')"
[[ -n "$BLOCK" ]] || { echo "runbooks/10_backup_restore.md has no restore-swap block" >&2; exit 1; }
BLOCK_SHA="$(printf '%s' "$BLOCK" | shasum -a 256 | cut -d' ' -f1)"
GREEN_OUT="$(PG="$PG" DB="$LIVE" DUMP="$DUMP" bash -Eeuo pipefail -c "$BLOCK")"
grep -q '^restore-check=ok' <<< "$GREEN_OUT" || { echo "$GREEN_OUT" >&2; echo "the runbook block did not swap" >&2; exit 1; }
REPLACED="$(sed -n 's/.*kept as \(hawa_scratch_[0-9a-z_]*\)$/\1/p' <<< "$GREEN_OUT")"
AFTER="$(counts "$LIVE")"; AFTER_APP="$(app_view "$LIVE")"; AFTER_APP_NO_CONTEXT="$(app_view_without_context "$LIVE")"
REPLACED_COUNTS="$(counts "$REPLACED")"
WANT="$(toc_counts)"

node -e '
const [stamp, sha, toc, before, beforeApp, applied, migrated, migratedApp, redRunbook, redDocs25, blockSha, green, after, afterApp, afterNoCtx, replaced, replacedCounts] = process.argv.slice(1);
const j = JSON.parse;
const a = j(after), b = j(before), t = j(toc);
const restored = a.policies === b.policies && a.foreign_keys === b.foreign_keys && a.triggers === b.triggers && a.force_rls_tables === b.force_rls_tables && a.last_upgrade === b.last_upgrade && a.upgrades === b.upgrades;
const matchesDump = a.policies === t.policies && a.foreign_keys === t.foreign_keys && a.triggers === t.triggers;
const appSees = Number(afterApp) === Number(beforeApp) && Number(afterApp) > 0 && Number(afterNoCtx) === 0;
process.stdout.write(JSON.stringify({
  drill: "restore an older dump over a migrated database (runbooks/10_backup_restore.md, restore-swap block)",
  stamp, dump_sha256: sha, dump_toc: t,
  before_deploy: { ...b, app_rows_with_context: Number(beforeApp) },
  deploy: j(applied), after_deploy: { ...j(migrated), app_rows_with_context: Number(migratedApp) },
  red_runbook_step: j(redRunbook), red_docs25_step: j(redDocs25),
  green: { block_sha256: blockSha, output: green.split("\n"),
    after_swap: { ...a, app_rows_with_context: Number(afterApp), app_rows_without_context: Number(afterNoCtx) },
    replaced_database: { name: replaced, ...j(replacedCounts) } },
  verdict: { restored_to_pre_deploy_schema: restored, matches_dump_toc: matchesDump, app_role_sees_rows_only_with_context: appSees,
    passed: restored && matchesDump && appSees },
}, null, 2) + "\n");
if (!(restored && matchesDump && appSees)) process.exitCode = 1;
' "$STAMP" "$DUMP_SHA" "$WANT" "$BEFORE" "$BEFORE_APP" "$APPLIED" "$MIGRATED" "$MIGRATED_APP" "$RED_RUNBOOK" "$RED_DOCS25" "$BLOCK_SHA" "$GREEN_OUT" "$AFTER" "$AFTER_APP" "$AFTER_APP_NO_CONTEXT" "$REPLACED" "$REPLACED_COUNTS"
