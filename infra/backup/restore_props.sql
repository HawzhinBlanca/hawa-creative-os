-- What a database carries outside pg_dump -Fc: owner, encoding and locale, grants (GRANT ... ON
-- DATABASE) and settings (ALTER DATABASE ... SET, ALTER ROLE ... IN DATABASE ... SET). One line with
-- the owner, encoding and counts, and the grants and settings only as a hash. Used by the restore-swap
-- block of runbooks/10_backup_restore.md (ADR-129):
--   psql -X -qAt -d postgres -v ON_ERROR_STOP=1 -v name=<database> < infra/backup/restore_props.sql
SELECT format('owner=%s encoding=%s grants=%s settings=%s hash=%s', o, e, g, n, md5(concat_ws('|', o, e, gs, ss)))
FROM pg_database d,
  LATERAL (SELECT pg_get_userbyid(d.datdba) AS o,
    pg_encoding_to_char(d.encoding) || '/' || d.datcollate || '/' || d.datctype || '/' || d.datconnlimit AS e) b,
  -- A database whose grants were never changed has no ACL of its own; acldefault is what it means.
  LATERAL (SELECT count(*) AS g, string_agg(x, ',' ORDER BY x) AS gs
    FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
      || ':' || a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END AS x
      FROM aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a) t) acl,
  LATERAL (SELECT count(*) AS n, string_agg(x, ',' ORDER BY x) AS ss
    FROM (SELECT CASE WHEN s.setrole = 0 THEN '(database)' ELSE pg_get_userbyid(s.setrole) END || ':' || c AS x
      FROM pg_db_role_setting s, unnest(s.setconfig) c WHERE s.setdatabase = d.oid) t) st
WHERE d.datname = :'name';
