-- Copies the owner, grants and settings of database :src to database :dst, in one transaction: a
-- rename does not move them, and pg_dump -Fc does not carry them (ADR-129). Used by the restore-swap
-- block of runbooks/10_backup_restore.md, before the swap:
--   psql -X -q -d postgres -v ON_ERROR_STOP=1 -v src=<live> -v dst=<restored> < infra/backup/restore_copy_props.sql
-- A setting whose value is a list (a comma) is refused, as packages/db/src/rotate-app-role.ts refuses
-- it: quoted as one literal it would change meaning. Encoding and locale are compared, not copied.
SELECT set_config('restore.src', :'src', false) AS src, set_config('restore.dst', :'dst', false) AS dst \gset
DO $copy$
DECLARE
  src pg_database;
  dst text := current_setting('restore.dst');
  r record;
  kv text;
  k text;
  v text;
BEGIN
  SELECT * INTO STRICT src FROM pg_database WHERE datname = current_setting('restore.src');
  PERFORM 1 FROM pg_database WHERE datname = dst;
  IF NOT FOUND THEN RAISE EXCEPTION 'database % does not exist', dst; END IF;
  EXECUTE format('ALTER DATABASE %I OWNER TO %I', dst, pg_get_userbyid(src.datdba));
  IF src.datacl IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', dst);
    FOR r IN SELECT * FROM aclexplode(src.datacl) LOOP
      EXECUTE format('GRANT %s ON DATABASE %I TO %s%s', r.privilege_type, dst,
        CASE WHEN r.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(r.grantee)) END,
        CASE WHEN r.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
  END IF;
  FOR r IN SELECT setrole, setconfig FROM pg_db_role_setting WHERE setdatabase = src.oid LOOP
    FOREACH kv IN ARRAY r.setconfig LOOP
      k := split_part(kv, '=', 1);
      v := substr(kv, length(k) + 2);
      IF k !~ '^[A-Za-z_][A-Za-z0-9_.]*$' OR strpos(v, ',') > 0 THEN
        RAISE EXCEPTION 'the setting % holds a list, which is not copied: set it on % by hand, then run the block again', k, dst;
      END IF;
      IF r.setrole = 0 THEN
        EXECUTE format('ALTER DATABASE %I SET %s TO %L', dst, k, v);
      ELSE
        EXECUTE format('ALTER ROLE %I IN DATABASE %I SET %s TO %L', pg_get_userbyid(r.setrole), dst, k, v);
      END IF;
    END LOOP;
  END LOOP;
END
$copy$;
