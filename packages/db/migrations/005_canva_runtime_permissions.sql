BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hawa_app') THEN
    GRANT USAGE ON SCHEMA hawa TO hawa_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON hawa.canva_connections,hawa.canva_oauth_states TO hawa_app;
    GRANT SELECT,INSERT,UPDATE ON hawa.canva_remote_operations,hawa.canva_bindings TO hawa_app;
    GRANT SELECT,INSERT ON hawa.canva_export_bytes,hawa.canva_capture_sets TO hawa_app;
  END IF;
END $$;
COMMIT;
