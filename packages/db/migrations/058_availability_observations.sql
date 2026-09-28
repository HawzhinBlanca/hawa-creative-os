-- ADR-104: independent observations survive collector/Core/database restarts.
BEGIN;
CREATE TABLE hawa.availability_observations (
  tenant_id uuid NOT NULL REFERENCES hawa.tenants(id),
  id uuid NOT NULL,
  monitor_id uuid NOT NULL,
  scope_sha256 text NOT NULL CHECK(scope_sha256 ~ '^[a-f0-9]{64}$'),
  slot_start timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,monitor_id,scope_sha256,slot_start),
  CHECK(mod(extract(epoch FROM slot_start),60)=0),
  CHECK(observed_at>=slot_start AND observed_at<slot_start+interval '1 minute')
);
ALTER TABLE hawa.availability_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.availability_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY availability_observations_read ON hawa.availability_observations FOR SELECT USING (
  tenant_id=hawa.current_tenant_id() AND (SELECT hawa.is_tenant_member(hawa.current_tenant_id()))
);
CREATE POLICY availability_observations_write ON hawa.availability_observations FOR INSERT WITH CHECK (
  tenant_id=hawa.current_tenant_id() AND hawa.current_user_id()='00000000-0000-4000-b000-000000000011'::uuid
  AND (SELECT hawa.is_tenant_member(hawa.current_tenant_id()))
);
GRANT SELECT,INSERT ON hawa.availability_observations TO hawa_app;
REVOKE UPDATE,DELETE,TRUNCATE ON hawa.availability_observations FROM PUBLIC,hawa_app;

CREATE FUNCTION hawa.protect_availability_observation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Availability observations are immutable'; END IF;
  IF NEW.tenant_id IS DISTINCT FROM hawa.current_tenant_id() OR
    hawa.current_user_id() IS DISTINCT FROM '00000000-0000-4000-b000-000000000011'::uuid THEN
    RAISE EXCEPTION 'Availability collector identity required' USING ERRCODE='42501';
  END IF;
  IF NEW.payload->>'observationId' IS DISTINCT FROM NEW.id::text OR
    NEW.payload->>'monitorId' IS DISTINCT FROM NEW.monitor_id::text OR
    (NEW.payload->>'slotStart')::timestamptz IS DISTINCT FROM NEW.slot_start OR
    (NEW.payload->>'observedAt')::timestamptz IS DISTINCT FROM NEW.observed_at OR
    NEW.payload->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR
    NEW.observed_at>transaction_timestamp()+interval '10 seconds' OR
    NEW.observed_at<transaction_timestamp()-interval '400 days' THEN
    RAISE EXCEPTION 'Invalid availability observation';
  END IF;
  NEW.payload_sha256=encode(sha256(convert_to(NEW.payload::text,'UTF8')),'hex');
  NEW.received_at=transaction_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER availability_observations_immutable BEFORE INSERT OR UPDATE OR DELETE ON hawa.availability_observations
  FOR EACH ROW EXECUTE FUNCTION hawa.protect_availability_observation();
CREATE TRIGGER availability_observations_no_truncate BEFORE TRUNCATE ON hawa.availability_observations
  FOR EACH STATEMENT EXECUTE FUNCTION hawa.protect_availability_observation();

-- Only a rolled-back readiness transaction uses this table. It has no office side effects.
CREATE TABLE hawa.availability_probe_values (
  tenant_id uuid NOT NULL REFERENCES hawa.tenants(id),
  id uuid NOT NULL,
  phase integer NOT NULL CHECK(phase IN(1,2)),
  PRIMARY KEY(tenant_id,id)
);
ALTER TABLE hawa.availability_probe_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.availability_probe_values FORCE ROW LEVEL SECURITY;
CREATE POLICY availability_probe_values_automation ON hawa.availability_probe_values FOR ALL USING (
  tenant_id=hawa.current_tenant_id() AND hawa.current_user_id()='00000000-0000-4000-b000-000000000011'::uuid
  AND (SELECT hawa.is_tenant_member(hawa.current_tenant_id()))
) WITH CHECK (
  tenant_id=hawa.current_tenant_id() AND hawa.current_user_id()='00000000-0000-4000-b000-000000000011'::uuid
  AND (SELECT hawa.is_tenant_member(hawa.current_tenant_id()))
);
GRANT SELECT,INSERT,UPDATE ON hawa.availability_probe_values TO hawa_app;
REVOKE DELETE,TRUNCATE ON hawa.availability_probe_values FROM PUBLIC,hawa_app;
COMMIT;
