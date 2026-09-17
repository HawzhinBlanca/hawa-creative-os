-- 00-init-roles.sql
-- Initializes application database roles for Hawa Creative OS prior to schema creation
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hawa_app') THEN
    CREATE ROLE hawa_app WITH LOGIN PASSWORD '***REMOVED***';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hawa_test_app') THEN
    CREATE ROLE hawa_test_app WITH LOGIN PASSWORD '***REMOVED***';
  END IF;
END $$;
