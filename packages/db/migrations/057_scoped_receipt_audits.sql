-- ADR-103: an audit is an immutable snapshot for one current authorized actor/scope.
BEGIN;
CREATE FUNCTION hawa.receipt_audit_scope() RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH scope AS (
    SELECT jsonb_build_object('version',1,'tenantId',hawa.current_tenant_id(),
      'userId',hawa.current_user_id(),'includesUnassigned',true,
      'clientIds',coalesce((SELECT jsonb_agg(id ORDER BY id) FROM hawa.clients
        WHERE tenant_id=hawa.current_tenant_id()),'[]'::jsonb)) AS value
    WHERE hawa.is_tenant_member(hawa.current_tenant_id())
  ) SELECT (value-'version'-'tenantId'-'userId') ||
    jsonb_build_object('sha256',encode(sha256(convert_to(value::text,'UTF8')),'hex')) FROM scope
$$;
REVOKE ALL ON FUNCTION hawa.receipt_audit_scope() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.receipt_audit_scope() TO hawa_app;

CREATE TABLE hawa.receipt_audits (
  tenant_id uuid NOT NULL REFERENCES hawa.tenants(id),
  actor_user_id uuid NOT NULL REFERENCES hawa.users(id),
  id uuid NOT NULL,
  scope_sha256 text NOT NULL CHECK(scope_sha256 ~ '^[a-f0-9]{64}$'),
  revision integer NOT NULL CHECK(revision>0),
  previous_audit_id uuid,
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
  request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  scope jsonb NOT NULL CHECK(jsonb_typeof(scope)='object'),
  inputs jsonb NOT NULL CHECK(jsonb_typeof(inputs)='object'),
  inputs_sha256 text NOT NULL CHECK(inputs_sha256 ~ '^[a-f0-9]{64}$'),
  report jsonb NOT NULL CHECK(jsonb_typeof(report)='object'),
  report_sha256 text NOT NULL CHECK(report_sha256 ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,actor_user_id,id),
  UNIQUE(tenant_id,actor_user_id,scope_sha256,revision),
  FOREIGN KEY(tenant_id,actor_user_id,previous_audit_id) REFERENCES hawa.receipt_audits(tenant_id,actor_user_id,id)
);
ALTER TABLE hawa.receipt_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.receipt_audits FORCE ROW LEVEL SECURITY;
CREATE POLICY receipt_audits_read ON hawa.receipt_audits FOR SELECT USING (
  tenant_id=hawa.current_tenant_id() AND actor_user_id=hawa.current_user_id() AND
  scope_sha256=(SELECT hawa.receipt_audit_scope()->>'sha256')
);
CREATE POLICY receipt_audits_write ON hawa.receipt_audits FOR INSERT WITH CHECK (
  tenant_id=hawa.current_tenant_id() AND actor_user_id=hawa.current_user_id() AND
  scope_sha256=(SELECT hawa.receipt_audit_scope()->>'sha256')
);
GRANT SELECT,INSERT ON hawa.receipt_audits TO hawa_app;
REVOKE UPDATE,DELETE,TRUNCATE ON hawa.receipt_audits FROM PUBLIC,hawa_app;
CREATE FUNCTION hawa.protect_receipt_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_scope jsonb; previous hawa.receipt_audits%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Receipt audits are immutable'; END IF;
  IF current_setting('transaction_isolation')<>'serializable' OR
    NEW.tenant_id IS DISTINCT FROM hawa.current_tenant_id() OR NEW.actor_user_id IS DISTINCT FROM hawa.current_user_id() THEN
    RAISE EXCEPTION 'RECEIPT_AUDIT_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  current_scope=hawa.receipt_audit_scope();
  IF current_scope IS NULL OR NEW.scope IS DISTINCT FROM current_scope OR
    NEW.scope_sha256 IS DISTINCT FROM current_scope->>'sha256' THEN
    RAISE EXCEPTION 'RECEIPT_AUDIT_SCOPE_CHANGED';
  END IF;
  SELECT * INTO previous FROM hawa.receipt_audits WHERE tenant_id=NEW.tenant_id AND actor_user_id=NEW.actor_user_id
    AND scope_sha256=NEW.scope_sha256 ORDER BY revision DESC LIMIT 1;
  IF NEW.previous_audit_id IS DISTINCT FROM previous.id OR NEW.revision<>coalesce(previous.revision,0)+1 THEN
    RAISE EXCEPTION 'RECEIPT_AUDIT_CHANGED';
  END IF;
  IF NEW.request IS DISTINCT FROM jsonb_build_object('actionId',NEW.id,'expectedScopeSha256',NEW.scope_sha256,
      'expectedLatestAuditId',NEW.previous_audit_id,'reason',NEW.reason) OR
    NEW.recorded_at IS DISTINCT FROM date_trunc('milliseconds',transaction_timestamp()) OR
    NEW.report->>'auditId' IS DISTINCT FROM NEW.id::text OR
    (NEW.report->>'timestamp')::timestamptz IS DISTINCT FROM NEW.recorded_at OR
    NEW.report->'simulated' IS DISTINCT FROM 'false'::jsonb OR
    jsonb_typeof(NEW.inputs->'tasks') IS DISTINCT FROM 'array' OR
    jsonb_typeof(NEW.inputs->'driveFiles') IS DISTINCT FROM 'array' OR
    jsonb_typeof(NEW.inputs->'sheetRows') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'RECEIPT_AUDIT_INVALID';
  END IF;
  IF (NEW.report->>'totalTasksAudited')::integer IS DISTINCT FROM jsonb_array_length(NEW.inputs->'tasks') OR
    (NEW.report->>'totalDriveDeliverablesChecked')::integer IS DISTINCT FROM jsonb_array_length(NEW.inputs->'driveFiles') OR
    (NEW.report->>'totalSheetRowsAudited')::integer IS DISTINCT FROM jsonb_array_length(NEW.inputs->'sheetRows') OR
    (NEW.report->>'driftCount')::integer IS DISTINCT FROM jsonb_array_length(NEW.report->'anomalies') OR
    (NEW.report->>'inSyncCount')::integer<0 OR (NEW.report->>'pendingTaskCount')::integer<0 OR
    (NEW.report->>'inSyncCount')::integer+(NEW.report->>'pendingTaskCount')::integer>(NEW.report->>'totalTasksAudited')::integer OR
    (NEW.report->>'status'='clean') IS DISTINCT FROM ((NEW.report->>'driftCount')::integer=0) THEN
    RAISE EXCEPTION 'RECEIPT_AUDIT_INVALID';
  END IF;
  NEW.request_sha256=encode(sha256(convert_to(NEW.request::text,'UTF8')),'hex');
  NEW.inputs_sha256=encode(sha256(convert_to(NEW.inputs::text,'UTF8')),'hex');
  NEW.report_sha256=encode(sha256(convert_to(NEW.report::text,'UTF8')),'hex');
  RETURN NEW;
END $$;
CREATE TRIGGER receipt_audits_immutable BEFORE INSERT OR UPDATE OR DELETE ON hawa.receipt_audits
  FOR EACH ROW EXECUTE FUNCTION hawa.protect_receipt_audit();
CREATE TRIGGER receipt_audits_no_truncate BEFORE TRUNCATE ON hawa.receipt_audits
  FOR EACH STATEMENT EXECUTE FUNCTION hawa.protect_receipt_audit();
COMMIT;
