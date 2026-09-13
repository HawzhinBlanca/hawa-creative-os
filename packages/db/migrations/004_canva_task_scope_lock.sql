BEGIN;
-- A bound native document makes the task's client scope immutable.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='canva_task_client_scope' AND conrelid='hawa.tasks'::regclass) THEN
    ALTER TABLE hawa.tasks ADD CONSTRAINT canva_task_client_scope UNIQUE (tenant_id,id,client_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='canva_binding_task_client_fk' AND conrelid='hawa.canva_bindings'::regclass) THEN
    ALTER TABLE hawa.canva_bindings ADD CONSTRAINT canva_binding_task_client_fk FOREIGN KEY (tenant_id,task_id,client_id) REFERENCES hawa.tasks(tenant_id,id,client_id);
  END IF;
END $$;
COMMIT;
