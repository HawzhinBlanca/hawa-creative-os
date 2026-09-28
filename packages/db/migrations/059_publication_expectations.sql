-- ADR-106: original publication inputs and Sheet write identity survive Core restarts.
BEGIN;
ALTER TABLE hawa.publications ADD COLUMN input_protocol smallint NOT NULL DEFAULT 0 CHECK(input_protocol IN (0,1));
ALTER TABLE hawa.publications ALTER COLUMN input_protocol SET DEFAULT 1;

CREATE TABLE hawa.publication_expectations (
  tenant_id uuid NOT NULL REFERENCES hawa.tenants(id),
  publication_id uuid NOT NULL,
  task_id uuid NOT NULL,
  client_id uuid NOT NULL,
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=262144),
  payload_sha256 text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,publication_id),
  FOREIGN KEY(tenant_id,publication_id) REFERENCES hawa.publications(tenant_id,id)
);
CREATE INDEX publication_expectations_client ON hawa.publication_expectations(tenant_id,client_id,publication_id);
CREATE TABLE hawa.publication_sheet_expectations (
  tenant_id uuid NOT NULL,
  publication_id uuid NOT NULL,
  task_id uuid NOT NULL,
  client_id uuid NOT NULL,
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=65536),
  payload_sha256 text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,publication_id),
  FOREIGN KEY(tenant_id,publication_id) REFERENCES hawa.publication_expectations(tenant_id,publication_id)
);
CREATE INDEX publication_sheet_expectations_client ON hawa.publication_sheet_expectations(tenant_id,client_id,publication_id);

DO $$ DECLARE t text; access_check text := '(tenant_id=hawa.current_tenant_id() AND
  ((SELECT hawa.has_tenant_role(hawa.current_tenant_id(), ARRAY[''administrator'',''auditor'',''operator'']::hawa.membership_role[]))
    OR client_id=ANY((SELECT hawa.member_client_ids(false))::uuid[])))'; BEGIN
  FOREACH t IN ARRAY ARRAY['publication_expectations','publication_sheet_expectations'] LOOP
    EXECUTE format('ALTER TABLE hawa.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hawa.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY %I_read ON hawa.%I FOR SELECT USING (%s)',t,t,access_check);
    EXECUTE format('CREATE POLICY %I_write ON hawa.%I FOR INSERT WITH CHECK (hawa.current_user_id()=''00000000-0000-4000-b000-000000000011''::uuid AND %s)',t,t,access_check);
    EXECUTE format('REVOKE ALL ON hawa.%I FROM PUBLIC,hawa_app',t);
    EXECUTE format('GRANT SELECT,INSERT ON hawa.%I TO hawa_app',t);
  END LOOP;
END $$;

CREATE FUNCTION hawa.protect_publication_expectation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p hawa.publications%ROWTYPE; task hawa.tasks%ROWTYPE; e jsonb; f jsonb; expected_files jsonb; actual_files jsonb; v jsonb; metadata_value text; metadata_id bigint; first_file_id text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Publication expectations are immutable'; END IF;
  IF NEW.tenant_id IS DISTINCT FROM hawa.current_tenant_id() OR
    hawa.current_user_id() IS DISTINCT FROM '00000000-0000-4000-b000-000000000011'::uuid THEN
    RAISE EXCEPTION 'PUBLICATION_EXPECTATION_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  SELECT * INTO p FROM hawa.publications WHERE tenant_id=NEW.tenant_id AND id=NEW.publication_id FOR UPDATE;
  SELECT * INTO task FROM hawa.tasks WHERE tenant_id=NEW.tenant_id AND id=NEW.task_id FOR UPDATE;
  IF p.id IS NULL OR task.id IS NULL OR p.input_protocol<>1 OR p.task_id<>NEW.task_id OR
    task.client_id IS DISTINCT FROM NEW.client_id OR p.state IN ('complete','cancelled') OR task.state<>'publishing' THEN
    RAISE EXCEPTION 'PUBLICATION_EXPECTATION_CONFLICT';
  END IF;
  v=NEW.payload;
  IF v->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR v->>'tenantId' IS DISTINCT FROM NEW.tenant_id::text OR
    v->>'publicationId' IS DISTINCT FROM NEW.publication_id::text OR v->>'taskId' IS DISTINCT FROM NEW.task_id::text OR
    v->>'clientId' IS DISTINCT FROM NEW.client_id::text THEN RAISE EXCEPTION 'PUBLICATION_EXPECTATION_CONFLICT'; END IF;
  IF TG_TABLE_NAME='publication_expectations' THEN
    IF v->>'approvalId' IS DISTINCT FROM p.approval_id::text OR v->>'designRevisionId' IS DISTINCT FROM p.design_revision_id::text OR
      v->>'packageHash' IS DISTINCT FROM p.package_sha256 OR v->>'publicationKey' IS DISTINCT FROM p.publication_key OR
      v->'projectId' IS DISTINCT FROM coalesce(to_jsonb(task.project_id),'null'::jsonb) OR
      jsonb_typeof(v->'destination') IS DISTINCT FROM 'object' OR coalesce(v->'destination'->>'productionRootFolderId','')='' OR
      jsonb_typeof(v->'destination'->'sheetId') IS DISTINCT FROM 'number' OR (v->'destination'->>'sheetId')::integer<0 OR
      jsonb_typeof(v->'files') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'files') NOT BETWEEN 1 AND 100 OR
      v->>'publishedAt' IS NULL OR (v->>'publishedAt')::timestamptz>now()+interval '1 minute' THEN
      RAISE EXCEPTION 'PUBLICATION_EXPECTATION_INVALID';
    END IF;
    FOR f IN SELECT value FROM jsonb_array_elements(v->'files') LOOP
      IF f ? 'content' OR coalesce(f->>'artifactId','') !~ '^[a-f0-9-]{36}$' OR coalesce(f->>'filename','')='' OR
        coalesce(f->>'mimeType','')='' OR coalesce(f->>'sha256','') !~ '^[a-f0-9]{64}$' OR
        jsonb_typeof(f->'byteSize') IS DISTINCT FROM 'number' OR (f->>'byteSize')::bigint<=0 THEN
        RAISE EXCEPTION 'PUBLICATION_EXPECTATION_INVALID';
      END IF;
    END LOOP;
    IF (SELECT count(DISTINCT value->>'artifactId') FROM jsonb_array_elements(v->'files'))<>jsonb_array_length(v->'files') THEN
      RAISE EXCEPTION 'PUBLICATION_EXPECTATION_INVALID';
    END IF;
    SELECT jsonb_agg(jsonb_build_array(value->>'sha256',(value->>'size')::bigint) ORDER BY value->>'sha256',(value->>'size')::bigint)
      INTO expected_files FROM jsonb_array_elements(p.package_manifest->'files');
    SELECT jsonb_agg(jsonb_build_array(value->>'sha256',(value->>'byteSize')::bigint) ORDER BY value->>'sha256',(value->>'byteSize')::bigint)
      INTO actual_files FROM jsonb_array_elements(v->'files');
    IF expected_files IS DISTINCT FROM actual_files THEN RAISE EXCEPTION 'PUBLICATION_EXPECTATION_BYTES_CHANGED'; END IF;
  ELSE
    SELECT payload INTO e FROM hawa.publication_expectations WHERE tenant_id=NEW.tenant_id AND publication_id=NEW.publication_id;
    SELECT drive_file_id INTO first_file_id FROM hawa.drive_upload_reservations
      WHERE tenant_id=NEW.tenant_id AND publication_id=NEW.publication_id
      AND artifact_id=(e->'files'->0->>'artifactId')::uuid;
    IF e IS NULL OR jsonb_typeof(v->'expectedValues') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'expectedValues')<>7 OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(v->'expectedValues') x WHERE jsonb_typeof(x)<>'string') OR
      coalesce(v->>'spreadsheetId','')='' OR jsonb_typeof(v->'sheetId') IS DISTINCT FROM 'number' OR (v->>'sheetId')::integer<0 OR
      (coalesce(e->'destination'->>'spreadsheetId','')<>'' AND
        (v->>'spreadsheetId' IS DISTINCT FROM e->'destination'->>'spreadsheetId' OR v->'sheetId' IS DISTINCT FROM e->'destination'->'sheetId')) OR
      v->'expectedValues'->>0 IS DISTINCT FROM NEW.task_id::text OR v->'expectedValues'->>1 IS DISTINCT FROM NEW.client_id::text OR
      v->'expectedValues'->>2 IS DISTINCT FROM e->'destination'->>'productionRootFolderId' OR
      v->'expectedValues'->>3 IS DISTINCT FROM e->>'publishedAt' OR v->'expectedValues'->>4 IS DISTINCT FROM 'COMPLETE' OR
      first_file_id IS NULL OR v->'expectedValues'->>5 IS DISTINCT FROM 'https://drive.google.com/file/d/'||first_file_id||'/view' OR
      v->'expectedValues'->>6 IS DISTINCT FROM e->>'packageHash' THEN RAISE EXCEPTION 'SHEET_EXPECTATION_CONFLICT'; END IF;
    metadata_value=format('["hawa.sheet-row.v1",%s,%s,%s,%s]',to_json(NEW.tenant_id::text),to_json(v->>'spreadsheetId'),v->>'sheetId',to_json(NEW.task_id::text));
    metadata_id=(('x'||substr(encode(sha256(convert_to(metadata_value,'UTF8')),'hex'),1,8))::bit(32)::bigint & 2147483647);
    IF metadata_id=0 THEN metadata_id=1; END IF;
    IF v->>'metadataValue' IS DISTINCT FROM metadata_value OR (v->>'metadataId')::bigint IS DISTINCT FROM metadata_id THEN
      RAISE EXCEPTION 'SHEET_EXPECTATION_IDENTITY_INVALID';
    END IF;
  END IF;
  NEW.payload_sha256=encode(sha256(convert_to(v::text,'UTF8')),'hex');
  RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['publication_expectations','publication_sheet_expectations'] LOOP
    EXECUTE format('CREATE TRIGGER %I_immutable BEFORE INSERT OR UPDATE OR DELETE ON hawa.%I FOR EACH ROW EXECUTE FUNCTION hawa.protect_publication_expectation()',t,t);
    EXECUTE format('CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON hawa.%I FOR EACH STATEMENT EXECUTE FUNCTION hawa.protect_publication_expectation()',t,t);
  END LOOP;
END $$;
CREATE FUNCTION hawa.protect_publication_protocol() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.input_protocol IS DISTINCT FROM NEW.input_protocol THEN RAISE EXCEPTION 'Publication input protocol is immutable'; END IF;
  IF EXISTS(SELECT 1 FROM hawa.publication_expectations WHERE tenant_id=OLD.tenant_id AND publication_id=OLD.id) AND
    ROW(OLD.tenant_id,OLD.task_id,OLD.approval_id,OLD.design_revision_id,OLD.publication_key,OLD.package_sha256,OLD.package_manifest)
      IS DISTINCT FROM ROW(NEW.tenant_id,NEW.task_id,NEW.approval_id,NEW.design_revision_id,NEW.publication_key,NEW.package_sha256,NEW.package_manifest) THEN
    RAISE EXCEPTION 'Publication identity is frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER publications_input_protocol BEFORE UPDATE ON hawa.publications FOR EACH ROW EXECUTE FUNCTION hawa.protect_publication_protocol();

ALTER TABLE hawa.sheet_syncs ADD COLUMN metadata_id integer;
ALTER TABLE hawa.sheet_syncs ADD COLUMN expected_values jsonb;
ALTER TABLE hawa.sheet_syncs ADD COLUMN expected_row_hash text;
ALTER TABLE hawa.sheet_syncs ADD COLUMN observed_row_hash text;
-- Canva export IDs are not IDs in the older artifacts table. Preserve the old FK separately.
ALTER TABLE hawa.drive_refs ADD COLUMN publication_artifact_id uuid;
CREATE FUNCTION hawa.validate_expected_drive_ref() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e jsonb; BEGIN
  SELECT payload INTO e FROM hawa.publication_expectations WHERE tenant_id=NEW.tenant_id AND publication_id=NEW.publication_id;
  IF e IS NOT NULL AND (NEW.folder_id IS DISTINCT FROM e->'destination'->>'productionRootFolderId' OR
    NEW.shared_drive_id IS DISTINCT FROM e->'destination'->>'sharedDriveId' OR NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(e->'files') f WHERE f->>'artifactId'=NEW.publication_artifact_id::text AND
        f->>'filename'=NEW.file_name AND f->>'mimeType'=NEW.mime_type AND f->>'sha256'=NEW.expected_sha256 AND
        (f->>'byteSize')::bigint=NEW.observed_size)) THEN RAISE EXCEPTION 'DRIVE_EXPECTATION_CONFLICT'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER drive_refs_expected BEFORE INSERT OR UPDATE ON hawa.drive_refs FOR EACH ROW EXECUTE FUNCTION hawa.validate_expected_drive_ref();
CREATE FUNCTION hawa.validate_expected_sheet_sync() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e jsonb; row_json text; row_hash text; BEGIN
  SELECT payload INTO e FROM hawa.publication_sheet_expectations WHERE tenant_id=NEW.tenant_id AND publication_id=NEW.publication_id;
  IF e IS NULL THEN RETURN NEW; END IF;
  SELECT '['||string_agg(to_json(value)::text,',' ORDER BY ordinal)||']' INTO row_json
    FROM jsonb_array_elements_text(e->'expectedValues') WITH ORDINALITY AS cells(value,ordinal);
  row_hash=encode(sha256(convert_to(row_json,'UTF8')),'hex');
  IF NEW.task_id::text IS DISTINCT FROM e->>'taskId' OR NEW.row_key IS DISTINCT FROM e->>'taskId' OR
    NEW.spreadsheet_id IS DISTINCT FROM e->>'spreadsheetId' OR NEW.sheet_id IS DISTINCT FROM (e->>'sheetId')::integer OR
    NEW.expected_hash IS DISTINCT FROM e->'expectedValues'->>6 OR
    (NEW.metadata_id IS NOT NULL AND NEW.metadata_id IS DISTINCT FROM (e->>'metadataId')::integer) OR
    (NEW.expected_values IS NOT NULL AND NEW.expected_values IS DISTINCT FROM e->'expectedValues') OR
    (NEW.expected_row_hash IS NOT NULL AND NEW.expected_row_hash IS DISTINCT FROM row_hash) OR
    (NEW.status='synced' AND (NEW.metadata_id IS DISTINCT FROM (e->>'metadataId')::integer OR
      NEW.expected_values IS DISTINCT FROM e->'expectedValues' OR NEW.expected_row_hash IS DISTINCT FROM row_hash OR
      NEW.observed_row_hash IS DISTINCT FROM row_hash OR NEW.observed_hash IS DISTINCT FROM NEW.expected_hash OR
      NEW.row_number IS NULL OR NEW.row_number<2)) THEN RAISE EXCEPTION 'SHEET_RECEIPT_EXPECTATION_CONFLICT'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sheet_syncs_expected BEFORE INSERT OR UPDATE ON hawa.sheet_syncs FOR EACH ROW EXECUTE FUNCTION hawa.validate_expected_sheet_sync();
COMMIT;
