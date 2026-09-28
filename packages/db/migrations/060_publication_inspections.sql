-- ADR-107: hourly claims and independent external observations survive process restarts.
BEGIN;
CREATE TABLE hawa.publication_inspections (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  publication_id uuid NOT NULL,
  task_id uuid NOT NULL,
  client_id uuid NOT NULL,
  slot timestamptz NOT NULL,
  attempt smallint NOT NULL CHECK(attempt BETWEEN 1 AND 3),
  state text NOT NULL CHECK(state IN ('running','finished','interrupted','superseded')),
  started_at timestamptz NOT NULL,
  lease_until timestamptz NOT NULL,
  finished_at timestamptz,
  inputs jsonb NOT NULL CHECK(jsonb_typeof(inputs)='object' AND octet_length(inputs::text)<=1048576),
  inputs_sha256 text NOT NULL DEFAULT '',
  observation jsonb CHECK(observation IS NULL OR jsonb_typeof(observation)='object' AND octet_length(observation::text)<=1048576),
  report jsonb CHECK(report IS NULL OR jsonb_typeof(report)='object' AND octet_length(report::text)<=262144),
  result_sha256 text,
  UNIQUE(tenant_id,publication_id,slot,attempt),
  FOREIGN KEY(tenant_id,publication_id) REFERENCES hawa.publications(tenant_id,id)
);
CREATE INDEX publication_inspections_latest ON hawa.publication_inspections(tenant_id,publication_id,started_at DESC,id);
CREATE INDEX publication_inspections_expired ON hawa.publication_inspections(tenant_id,lease_until) WHERE state='running';
ALTER TABLE hawa.publication_inspections ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.publication_inspections FORCE ROW LEVEL SECURITY;
CREATE POLICY publication_inspections_read ON hawa.publication_inspections FOR SELECT USING (
  tenant_id=hawa.current_tenant_id() AND ((SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator','auditor']::hawa.membership_role[]))
    OR client_id=ANY((SELECT hawa.member_client_ids(false))::uuid[]))
);
CREATE POLICY publication_inspections_insert ON hawa.publication_inspections FOR INSERT WITH CHECK (
  tenant_id=hawa.current_tenant_id() AND hawa.current_user_id()='00000000-0000-4000-b000-000000000011'::uuid
  AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['operator']::hawa.membership_role[]))
);
CREATE POLICY publication_inspections_update ON hawa.publication_inspections FOR UPDATE USING (
  tenant_id=hawa.current_tenant_id() AND hawa.current_user_id()='00000000-0000-4000-b000-000000000011'::uuid
  AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['operator']::hawa.membership_role[]))
) WITH CHECK (tenant_id=hawa.current_tenant_id() AND hawa.current_user_id()='00000000-0000-4000-b000-000000000011'::uuid);
REVOKE ALL ON hawa.publication_inspections FROM PUBLIC,hawa_app;
GRANT SELECT,INSERT ON hawa.publication_inspections TO hawa_app;
GRANT UPDATE(state,finished_at,observation,report,result_sha256) ON hawa.publication_inspections TO hawa_app;

CREATE FUNCTION hawa.publication_inspection_input(pub_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE p hawa.publications%ROWTYPE; t hawa.tasks%ROWTYPE; original jsonb; sheet jsonb; files jsonb; previous jsonb;
  row_json text; row_hash text; prior_permissions jsonb='{}'::jsonb; item jsonb; observations jsonb;
BEGIN
  SELECT * INTO p FROM hawa.publications WHERE tenant_id=hawa.current_tenant_id() AND id=pub_id;
  SELECT * INTO t FROM hawa.tasks WHERE tenant_id=p.tenant_id AND id=p.task_id;
  IF p.id IS NULL OR t.id IS NULL THEN RETURN NULL; END IF;
  SELECT payload INTO original FROM hawa.publication_expectations WHERE tenant_id=p.tenant_id AND publication_id=p.id;
  SELECT payload INTO sheet FROM hawa.publication_sheet_expectations WHERE tenant_id=p.tenant_id AND publication_id=p.id;
  SELECT jsonb_agg(jsonb_build_object('artifactId',f.value->>'artifactId','fileId',r.drive_file_id,'permissionSha256',NULL) ORDER BY f.ordinal)
    INTO files FROM jsonb_array_elements(coalesce(original->'files','[]'::jsonb)) WITH ORDINALITY f(value,ordinal)
    LEFT JOIN hawa.drive_upload_reservations r ON r.tenant_id=p.tenant_id AND r.publication_id=p.id AND r.artifact_id=(f.value->>'artifactId')::uuid;
  IF sheet IS NOT NULL THEN
    SELECT '['||string_agg(to_json(value)::text,',' ORDER BY ordinal)||']' INTO row_json
      FROM jsonb_array_elements_text(sheet->'expectedValues') WITH ORDINALITY cells(value,ordinal);
    row_hash=encode(sha256(convert_to(row_json,'UTF8')),'hex');
  END IF;
  SELECT observation INTO previous FROM hawa.publication_inspections WHERE tenant_id=p.tenant_id AND publication_id=p.id
    AND state='finished' ORDER BY started_at DESC,id DESC LIMIT 1;
  observations=coalesce(previous->'files','[]'::jsonb)||jsonb_build_array(previous->'folder');
  FOR item IN SELECT value FROM jsonb_array_elements(observations) LOOP
    IF item->'permissions'->>'status'='observed' AND item->'permissions'->>'sha256' ~ '^[a-f0-9]{64}$' AND item->>'resourceId' IS NOT NULL THEN
      prior_permissions=prior_permissions||jsonb_build_object(item->>'resourceId',item->'permissions'->>'sha256');
    END IF;
  END LOOP;
  IF sheet IS NOT NULL AND previous->'sheet'->'permissions'->>'status'='observed' AND previous->'sheet'->'permissions'->>'sha256' ~ '^[a-f0-9]{64}$' THEN
    prior_permissions=prior_permissions||jsonb_build_object(sheet->>'spreadsheetId',previous->'sheet'->'permissions'->>'sha256');
  END IF;
  -- A prior read detects changes. It is never promoted into a trusted permission policy.
  RETURN jsonb_build_object('schemaVersion',1,'tenantId',p.tenant_id,'publicationId',p.id,'taskId',p.task_id,
    'clientId',coalesce(original->>'clientId',t.client_id::text),'original',original,'sheet',sheet,'sheetRowSha256',row_hash,
    'files',coalesce(files,'[]'::jsonb),'folderPermissionSha256',NULL,'sheetPermissionSha256',NULL,'priorPermissionSha256',prior_permissions);
END $$;
REVOKE ALL ON FUNCTION hawa.publication_inspection_input(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.publication_inspection_input(uuid) TO hawa_app;

CREATE FUNCTION hawa.protect_publication_inspection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p hawa.publications%ROWTYPE; t hawa.tasks%ROWTYPE; previous hawa.publication_inspections%ROWTYPE; source jsonb; active boolean; stamp timestamptz;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Publication inspections cannot be removed'; END IF;
  IF NEW.tenant_id IS DISTINCT FROM hawa.current_tenant_id() OR hawa.current_user_id() IS DISTINCT FROM '00000000-0000-4000-b000-000000000011'::uuid THEN
    RAISE EXCEPTION 'PUBLICATION_INSPECTION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO p FROM hawa.publications WHERE tenant_id=NEW.tenant_id AND id=NEW.publication_id FOR UPDATE;
  SELECT * INTO t FROM hawa.tasks WHERE tenant_id=NEW.tenant_id AND id=p.task_id FOR UPDATE;
  stamp=date_trunc('milliseconds',transaction_timestamp());
  active=p.id IS NOT NULL AND t.id IS NOT NULL AND t.current_design_revision_id=p.design_revision_id
    AND p.state<>'cancelled' AND t.state<>'cancelled' AND NOT EXISTS(SELECT 1 FROM hawa.publications newer
      WHERE newer.tenant_id=p.tenant_id AND newer.task_id=p.task_id AND newer.design_revision_id=p.design_revision_id
      AND (newer.created_at,newer.id)>(p.created_at,p.id));
  IF TG_OP='INSERT' THEN
    source=hawa.publication_inspection_input(NEW.publication_id);
    SELECT * INTO previous FROM hawa.publication_inspections WHERE tenant_id=NEW.tenant_id AND publication_id=NEW.publication_id
      AND slot=NEW.slot ORDER BY attempt DESC LIMIT 1;
    IF NOT coalesce(active,false) OR source IS NULL OR NEW.inputs IS DISTINCT FROM source OR NEW.task_id<>p.task_id OR
      NEW.client_id::text IS DISTINCT FROM source->>'clientId' OR NEW.slot IS DISTINCT FROM date_trunc('hour',stamp) OR
      NEW.attempt<>coalesce(previous.attempt,0)+1 OR previous.state IN ('running','finished','superseded') OR
      NEW.state<>'running' OR NEW.started_at IS DISTINCT FROM stamp OR NEW.lease_until IS DISTINCT FROM stamp+interval '2 minutes' OR
      NEW.finished_at IS NOT NULL OR NEW.observation IS NOT NULL OR NEW.report IS NOT NULL THEN RAISE EXCEPTION 'PUBLICATION_INSPECTION_CLAIM_CONFLICT'; END IF;
    NEW.inputs_sha256=encode(sha256(convert_to(NEW.inputs::text,'UTF8')),'hex'); NEW.result_sha256=NULL;
  ELSE
    IF OLD.state<>'running' OR NEW.state NOT IN ('finished','interrupted','superseded') OR
      ROW(NEW.id,NEW.tenant_id,NEW.publication_id,NEW.task_id,NEW.client_id,NEW.slot,NEW.attempt,NEW.started_at,NEW.lease_until,NEW.inputs,NEW.inputs_sha256)
      IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.publication_id,OLD.task_id,OLD.client_id,OLD.slot,OLD.attempt,OLD.started_at,OLD.lease_until,OLD.inputs,OLD.inputs_sha256) OR
      NEW.finished_at IS DISTINCT FROM stamp THEN RAISE EXCEPTION 'PUBLICATION_INSPECTION_IMMUTABLE'; END IF;
    IF NEW.state='interrupted' THEN
      IF stamp<OLD.lease_until OR NEW.observation IS NOT NULL OR NEW.report IS DISTINCT FROM
        '{"status":"unverified","findings":[],"checkedFiles":0}'::jsonb THEN RAISE EXCEPTION 'PUBLICATION_INSPECTION_NOT_EXPIRED'; END IF;
    ELSE
      IF stamp>OLD.lease_until OR (NEW.state='finished') IS DISTINCT FROM coalesce(active,false) OR
        jsonb_typeof(NEW.observation) IS DISTINCT FROM 'object' OR NEW.observation->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR
        jsonb_typeof(NEW.report) IS DISTINCT FROM 'object' OR coalesce(NEW.report->>'status','') NOT IN ('consistent','divergent','unverified') OR
        jsonb_typeof(NEW.report->'findings') IS DISTINCT FROM 'array' OR jsonb_typeof(NEW.report->'checkedFiles') IS DISTINCT FROM 'number' OR
        NEW.observation->>'startedAt' IS NULL OR NEW.observation->>'finishedAt' IS NULL OR
        (NEW.observation->>'startedAt')::timestamptz<OLD.started_at OR
        (NEW.observation->>'finishedAt')::timestamptz<(NEW.observation->>'startedAt')::timestamptz OR
        (NEW.observation->>'finishedAt')::timestamptz>stamp+interval '1 second' THEN RAISE EXCEPTION 'PUBLICATION_INSPECTION_RESULT_CONFLICT'; END IF;
    END IF;
    NEW.result_sha256=encode(sha256(convert_to(jsonb_build_object('observation',NEW.observation,'report',NEW.report)::text,'UTF8')),'hex');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER publication_inspections_protected BEFORE INSERT OR UPDATE OR DELETE ON hawa.publication_inspections FOR EACH ROW EXECUTE FUNCTION hawa.protect_publication_inspection();
CREATE TRIGGER publication_inspections_no_truncate BEFORE TRUNCATE ON hawa.publication_inspections FOR EACH STATEMENT EXECUTE FUNCTION hawa.protect_publication_inspection();
COMMIT;
