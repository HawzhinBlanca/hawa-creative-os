-- FR-011 / FR-029 / NFR-020: shared cloud documents must not cross task scope.
-- Fails on pre-existing collisions; inspect and resolve those without deleting designs.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS canva_bindings_global_design_unique
  ON hawa.canva_bindings (canva_design_id);
CREATE UNIQUE INDEX IF NOT EXISTS canva_capture_binding_version_unique
  ON hawa.canva_capture_sets (binding_id, version);

-- Repository reads are scoped, and RLS is a second independent boundary.
ALTER TABLE hawa.canva_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.canva_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE hawa.canva_capture_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.canva_capture_sets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS canva_binding_tenant_scope ON hawa.canva_bindings;
CREATE POLICY canva_binding_tenant_scope ON hawa.canva_bindings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS canva_capture_tenant_scope ON hawa.canva_capture_sets;
CREATE POLICY canva_capture_tenant_scope ON hawa.canva_capture_sets
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP TRIGGER IF EXISTS canva_capture_immutable ON hawa.canva_capture_sets;
CREATE TRIGGER canva_capture_immutable BEFORE UPDATE OR DELETE ON hawa.canva_capture_sets
  FOR EACH ROW EXECUTE FUNCTION hawa.forbid_update_delete();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'canva_binding_capture_scope_unique' AND conrelid = 'hawa.canva_bindings'::regclass) THEN
    ALTER TABLE hawa.canva_bindings ADD CONSTRAINT canva_binding_capture_scope_unique UNIQUE (tenant_id, task_id, client_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'canva_capture_bound_scope_fk' AND conrelid = 'hawa.canva_capture_sets'::regclass) THEN
    ALTER TABLE hawa.canva_capture_sets ADD CONSTRAINT canva_capture_bound_scope_fk
      FOREIGN KEY (tenant_id, task_id, client_id, binding_id) REFERENCES hawa.canva_bindings(tenant_id, task_id, client_id, id);
  END IF;
END $$;
COMMIT;
