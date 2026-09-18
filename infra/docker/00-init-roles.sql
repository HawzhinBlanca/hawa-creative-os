-- 00-init-roles.sql
-- Creates the runtime role hawa_app before the schema, RLS and grant files (01-04) that name it.
-- The postgres entrypoint runs this with psql, only when it initialises an empty data directory.
--
-- No password is committed here. It comes from HAWA_APP_DATABASE_URL, which compose fills from
-- DATABASE_URL in infra/docker/.env: the URL core and worker connect with. So a fresh data directory
-- accepts the application's credential, and a rotation stays one edit plus ALTER ROLE.
--
-- This stays SQL (psql \getenv) rather than a .sh script so that it needs no executable bit: Docker
-- Desktop reports a mounted 0644 script as executable, the entrypoint tries to run it, and
-- initialisation stops half done.
\set app_url ''
\getenv app_url HAWA_APP_DATABASE_URL
-- \gset keeps the value out of the entrypoint's output (docker logs).
SELECT set_config('hawa_init.app_url', :'app_url', false) AS app_url_set \gset
\unset app_url
\unset app_url_set

DO $$
DECLARE
  url text := current_setting('hawa_init.app_url');
  userinfo text[] := regexp_match(url, '^[A-Za-z][A-Za-z0-9+.-]*://([^:@/]*):(.*)@[^@]*$');
  app_password text;
BEGIN
  IF url = '' THEN
    RAISE EXCEPTION '00-init-roles: HAWA_APP_DATABASE_URL is not set (compose passes DATABASE_URL from infra/docker/.env)';
  END IF;
  IF userinfo IS NULL THEN
    RAISE EXCEPTION '00-init-roles: HAWA_APP_DATABASE_URL has no user:password@ part';
  END IF;
  -- rls.sql and the migrations grant to hawa_app by name; any other role would be granted nothing.
  IF userinfo[1] <> 'hawa_app' THEN
    RAISE EXCEPTION '00-init-roles: DATABASE_URL connects as %, but the schema grants to hawa_app', quote_literal(userinfo[1]);
  END IF;
  IF userinfo[2] = '' OR userinfo[2] LIKE 'REPLACE\_WITH%' THEN
    RAISE EXCEPTION '00-init-roles: DATABASE_URL carries no real hawa_app password';
  END IF;
  -- Undo URL percent-encoding, as node-postgres does when it reads DATABASE_URL.
  SELECT convert_from(string_agg(CASE WHEN piece[1] ~ '^%[0-9A-Fa-f]{2}$' THEN decode(substr(piece[1], 2), 'hex')
                                      ELSE convert_to(piece[1], 'UTF8') END, ''::bytea ORDER BY n), 'UTF8')
    INTO app_password
    FROM regexp_matches(userinfo[2], '%[0-9A-Fa-f]{2}|[^%]+|%', 'g') WITH ORDINALITY AS pieces(piece, n);
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hawa_app') THEN
    EXECUTE format('CREATE ROLE hawa_app LOGIN PASSWORD %L', app_password);
  END IF;
END
$$;
