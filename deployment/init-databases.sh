#!/usr/bin/env bash
set -Eeuo pipefail

# Runs only on first initialization of the PostgreSQL data directory.
# Password values come from the protected Compose environment and are quoted
# through psql variables rather than interpolated into SQL source.
: "${HAWA_DB_USER:=hawa_app}"
: "${HAWA_DB_PASSWORD:?Set HAWA_DB_PASSWORD}"
: "${PHOENIX_DB_USER:=phoenix}"
: "${PHOENIX_DB_PASSWORD:?Set PHOENIX_DB_PASSWORD}"

psql --username "$POSTGRES_USER" --dbname postgres \
  --set=ON_ERROR_STOP=1 \
  --set=hawa_user="$HAWA_DB_USER" --set=hawa_password="$HAWA_DB_PASSWORD" \
  --set=phoenix_user="$PHOENIX_DB_USER" --set=phoenix_password="$PHOENIX_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'hawa_user', :'hawa_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'hawa_user') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'phoenix_user', :'phoenix_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'phoenix_user') \gexec

SELECT format('CREATE DATABASE hawa OWNER %I', :'hawa_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'hawa') \gexec
SELECT format('CREATE DATABASE phoenix OWNER %I', :'phoenix_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'phoenix') \gexec
SQL
