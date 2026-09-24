#!/usr/bin/env bash
# Rotates the runtime database credential (the role Core and the worker log in as) without downtime.
# Postgres has one password per role, so two login roles, hawa_app_a and hawa_app_b, take turns;
# both inherit hawa_app, which keeps every grant and policy and ends up NOLOGIN. Runbook and the full
# owner sequence: infra/ops/README.md. The work is done by packages/db/src/rotate-app-role.ts.
#
#   bash infra/ops/rotate_app_role.sh rotate      --url postgresql://hawa_owner@127.0.0.1:54332/hawa --production \
#                                                --password-env-file infra/docker/.env --password-key POSTGRES_PASSWORD
#   bash infra/ops/rotate_app_role.sh status      (same connection options)
#   bash infra/ops/rotate_app_role.sh retire      --role hawa_app (same connection options)
#   bash infra/ops/rotate_app_role.sh install-env --secret-file ~/.hawa/db-roles/<file>.env --env-file infra/docker/.env
#   bash infra/ops/rotate_app_role.sh check-login --url postgresql://127.0.0.1:54332/hawa --production \
#                                                --credentials-env-file <backup> --credentials-key DATABASE_URL
#
# No password is ever an argument (ps shows argv) or printed: the admin password is read from a key of
# an env file, new ones go to ~/.hawa/db-roles (0700 directory, 0600 files) and reach Postgres only as
# SCRAM verifiers. The production server is refused unless --production is given.
set -Eeuo pipefail; umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
[[ -d node_modules ]] || { echo "ERROR: run pnpm install --offline in $ROOT first" >&2; exit 1; }
exec npx --no-install tsx packages/db/src/rotate-app-role.ts "$@"
