-- ADR-044: one durable Google Drive upload ID per publication artifact.
BEGIN;

CREATE TABLE IF NOT EXISTS hawa.drive_upload_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES hawa.tenants(id),
  publication_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  task_id uuid NOT NULL,
  package_sha256 text NOT NULL,
  folder_id text NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  expected_sha256 text NOT NULL,
  drive_file_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, publication_id) REFERENCES hawa.publications(tenant_id, id),
  UNIQUE (publication_id, artifact_id),
  UNIQUE (drive_file_id)
);

ALTER TABLE hawa.drive_upload_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.drive_upload_reservations FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'hawa' AND tablename = 'drive_upload_reservations' AND policyname = 'drive_upload_reservations_operator_select') THEN
    CREATE POLICY drive_upload_reservations_operator_select ON hawa.drive_upload_reservations
      FOR SELECT USING (tenant_id = hawa.current_tenant_id() AND
        (SELECT hawa.has_tenant_role(hawa.current_tenant_id(), ARRAY['administrator','operator']::hawa.membership_role[])));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'hawa' AND tablename = 'drive_upload_reservations' AND policyname = 'drive_upload_reservations_operator_insert') THEN
    CREATE POLICY drive_upload_reservations_operator_insert ON hawa.drive_upload_reservations
      FOR INSERT WITH CHECK (tenant_id = hawa.current_tenant_id() AND
        (SELECT hawa.has_tenant_role(hawa.current_tenant_id(), ARRAY['administrator','operator']::hawa.membership_role[])));
  END IF;
END $$;

REVOKE ALL ON hawa.drive_upload_reservations FROM PUBLIC;
REVOKE ALL ON hawa.drive_upload_reservations FROM hawa_app;
GRANT SELECT, INSERT ON hawa.drive_upload_reservations TO hawa_app;

COMMIT;
