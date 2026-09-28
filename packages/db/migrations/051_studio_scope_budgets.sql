-- ADR-092: Studio-only office/client/role daily admission, from the original ledger.
BEGIN;

CREATE TABLE hawa.studio_spending_policies (
  tenant_id uuid NOT NULL REFERENCES hawa.tenants(id),
  version integer NOT NULL CHECK (version > 0),
  action_id uuid NOT NULL DEFAULT gen_random_uuid(),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  limits jsonb NOT NULL,
  limits_sha256 text NOT NULL CHECK (limits_sha256 ~ '^[a-f0-9]{64}$'),
  recorded_by text NOT NULL DEFAULT session_user,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,version), UNIQUE(tenant_id,action_id)
);
ALTER TABLE hawa.studio_spending_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.studio_spending_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY studio_spending_policy_read ON hawa.studio_spending_policies FOR SELECT USING
  (tenant_id=hawa.current_tenant_id() AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),
    ARRAY['administrator','operator','auditor']::hawa.membership_role[])));
GRANT SELECT ON hawa.studio_spending_policies TO hawa_app;
REVOKE INSERT,UPDATE,DELETE ON hawa.studio_spending_policies FROM hawa_app;

CREATE FUNCTION hawa.protect_studio_spending_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record; cap jsonb; latest integer;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Studio spending policy revisions are immutable'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('studio-spending:'||NEW.tenant_id::text,0));
  SELECT coalesce(max(version),0) INTO latest FROM hawa.studio_spending_policies WHERE tenant_id=NEW.tenant_id;
  IF NEW.version<>latest+1 THEN RAISE EXCEPTION 'Studio spending policy version conflict'; END IF;
  IF jsonb_typeof(NEW.limits) IS DISTINCT FROM 'object' OR
    NOT (NEW.limits ?& ARRAY['officeUsd','clientUsd','roleUsd','clients','roles']) OR
    (SELECT count(*) FROM jsonb_object_keys(NEW.limits))<>5 OR
    jsonb_typeof(NEW.limits->'clients') IS DISTINCT FROM 'object' OR
    jsonb_typeof(NEW.limits->'roles') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid Studio spending policy';
  END IF;
  FOR item IN SELECT * FROM jsonb_each(NEW.limits->'clients') LOOP
    IF item.key !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR
      NOT EXISTS(SELECT 1 FROM hawa.clients WHERE tenant_id=NEW.tenant_id AND id=item.key::uuid) THEN
      RAISE EXCEPTION 'Studio policy client must belong to its tenant';
    END IF;
  END LOOP;
  FOR item IN SELECT * FROM jsonb_each(NEW.limits->'roles') LOOP
    IF item.key NOT IN ('creative_director','visual_judge','asset_photoreal') THEN
      RAISE EXCEPTION 'Unknown Studio budget role';
    END IF;
  END LOOP;
  FOR cap IN SELECT NEW.limits->'officeUsd' UNION ALL SELECT NEW.limits->'clientUsd'
    UNION ALL SELECT NEW.limits->'roleUsd' UNION ALL SELECT value FROM jsonb_each(NEW.limits->'clients')
    UNION ALL SELECT value FROM jsonb_each(NEW.limits->'roles') LOOP
    IF jsonb_typeof(cap) IS DISTINCT FROM 'number' OR (cap::text)::numeric NOT BETWEEN 0 AND 1000000 OR
      (cap::text)::numeric*1000000<>trunc((cap::text)::numeric*1000000) THEN
      RAISE EXCEPTION 'Studio policy caps require nonnegative whole micro-dollars';
    END IF;
  END LOOP;
  NEW.recorded_at=clock_timestamp();
  NEW.recorded_by=session_user;
  NEW.limits_sha256=encode(sha256(convert_to(NEW.limits::text,'UTF8')),'hex');
  RETURN NEW;
END $$;
CREATE TRIGGER protect_studio_spending_policy BEFORE INSERT OR UPDATE OR DELETE ON hawa.studio_spending_policies
  FOR EACH ROW EXECUTE FUNCTION hawa.protect_studio_spending_policy();

CREATE FUNCTION hawa.bootstrap_studio_spending_policy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hawa AS $$
BEGIN
  INSERT INTO hawa.studio_spending_policies(tenant_id,version,reason,limits)
    VALUES(NEW.id,1,'Initial Studio daily ceiling; review before live rollout',
      '{"officeUsd":30,"clientUsd":30,"roleUsd":30,"clients":{},"roles":{}}');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION hawa.bootstrap_studio_spending_policy() FROM PUBLIC;
CREATE TRIGGER bootstrap_studio_spending_policy AFTER INSERT ON hawa.tenants
  FOR EACH ROW EXECUTE FUNCTION hawa.bootstrap_studio_spending_policy();
INSERT INTO hawa.studio_spending_policies(tenant_id,version,reason,limits)
  SELECT id,1,'Initial Studio daily ceiling; review before live rollout',
    '{"officeUsd":30,"clientUsd":30,"roleUsd":30,"clients":{},"roles":{}}'::jsonb FROM hawa.tenants;

CREATE FUNCTION hawa.studio_budget_role(stage text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN stage='art' THEN 'asset_photoreal'
    WHEN stage IN ('critiquing','judging','parity') THEN 'visual_judge'
    ELSE 'creative_director' END
$$;

ALTER TABLE hawa.design_studio_calls ADD COLUMN spending_policy_version integer;
ALTER TABLE hawa.design_studio_calls ADD COLUMN budget_role text
  CHECK (budget_role IN ('creative_director','visual_judge','asset_photoreal'));
ALTER TABLE hawa.design_studio_calls ADD CONSTRAINT studio_recorded_cost_finite
  CHECK (usd_estimate BETWEEN 0 AND 9007199254);
ALTER TABLE hawa.design_studio_calls ADD CONSTRAINT studio_call_spending_policy_fk
  FOREIGN KEY(tenant_id,spending_policy_version) REFERENCES hawa.studio_spending_policies(tenant_id,version);
CREATE INDEX studio_calls_spending_scope ON hawa.design_studio_calls(tenant_id,started_at);

-- Private aggregate: no caller-controlled day, no prompts, no cross-client identifiers returned.
CREATE FUNCTION hawa.studio_scope_budget_internal(tid uuid,cid uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hawa AS $$
DECLARE policy hawa.studio_spending_policies%ROWTYPE; today date; buckets jsonb;
BEGIN
  SELECT * INTO policy FROM hawa.studio_spending_policies WHERE tenant_id=tid ORDER BY version DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'STUDIO_BUDGET_INVALID: Studio daily policy missing'; END IF;
  today=(clock_timestamp() AT TIME ZONE 'Asia/Baghdad')::date;
  WITH receipts AS (
    SELECT c.run_id,r.client_id,coalesce(c.budget_role,hawa.studio_budget_role(c.stage)) AS role,
      (c.started_at AT TIME ZONE 'Asia/Baghdad')::date AS day,
      greatest(c.usd_estimate,coalesce(s.cost,0)) AS known,
      (c.reservation->>'usd')::numeric AS reserved,
      s.cost IS NOT NULL OR (c.status<>'uncertain' AND
        (c.cost_basis IN ('usage','not_accepted') OR c.reservation IS NULL)) AS final
    FROM hawa.design_studio_calls c JOIN hawa.design_studio_runs r ON r.id=c.run_id AND r.tenant_id=c.tenant_id
    LEFT JOIN LATERAL (
      SELECT max((e->>'reportedCostUsd')::numeric) AS cost
      FROM hawa.studio_run_settlements st CROSS JOIN LATERAL jsonb_array_elements(st.calls) e
      WHERE st.tenant_id=c.tenant_id AND st.run_id=c.run_id AND e->>'callId'=c.id::text
    ) s ON true WHERE c.tenant_id=tid
  ), run_totals AS (
    SELECT run_id,sum(known) AS known,count(*) AS calls FROM receipts GROUP BY run_id
  ), all_receipts AS (
    SELECT client_id,role,day,known,reserved,final FROM receipts
    UNION ALL
    -- A new run must not erase spend/calls that the saved run says existed but its ledger lacks.
    -- Round the JS snapshot to micro-USD to avoid treating floating addition noise as lost history.
    SELECT r.client_id,'creative_director',(r.created_at AT TIME ZONE 'Asia/Baghdad')::date,
      greatest(0,coalesce((r.budget->>'spentUsd')::numeric,0)-coalesce(t.known,0)),NULL::numeric,false
    FROM hawa.design_studio_runs r LEFT JOIN run_totals t ON t.run_id=r.id
    WHERE r.tenant_id=tid AND (
      CASE WHEN jsonb_typeof(r.budget->'spentUsd')='number' THEN
        round((r.budget->>'spentUsd')::numeric*1000000)>ceil(coalesce(t.known,0)*1000000) ELSE false END
      OR CASE WHEN jsonb_typeof(r.budget->'calls')='number' THEN
        (r.budget->>'calls')::numeric>coalesce(t.calls,0) ELSE false END)
  ), obligations AS (
    SELECT *,CASE WHEN day=today THEN known ELSE 0 END AS spent,
      CASE WHEN final IS NOT TRUE THEN
        CASE WHEN day=today THEN greatest(0,coalesce(reserved,0)-known)
          ELSE greatest(known,coalesce(reserved,0)) END ELSE 0 END AS held,
      final IS NOT TRUE AND reserved IS NULL AS unknown
    FROM all_receipts WHERE day=today OR final IS NOT TRUE
  ), scopes(scope,subject,cap) AS (
    VALUES ('office','office',(policy.limits->>'officeUsd')::numeric),
      ('client','client',coalesce((policy.limits->'clients'->>cid::text)::numeric,(policy.limits->>'clientUsd')::numeric)),
      ('role','creative_director',coalesce((policy.limits->'roles'->>'creative_director')::numeric,(policy.limits->>'roleUsd')::numeric)),
      ('role','visual_judge',coalesce((policy.limits->'roles'->>'visual_judge')::numeric,(policy.limits->>'roleUsd')::numeric)),
      ('role','asset_photoreal',coalesce((policy.limits->'roles'->>'asset_photoreal')::numeric,(policy.limits->>'roleUsd')::numeric))
  ), totals AS (
    SELECT scope,subject,cap,coalesce(sum(o.spent),0) AS spent,coalesce(sum(o.held),0) AS held,
      coalesce(bool_or(o.unknown),false) AS unknown
    FROM scopes LEFT JOIN obligations o ON scope='office' OR (scope='client' AND o.client_id=cid)
      OR (scope='role' AND o.role=subject) GROUP BY scope,subject,cap
  ) SELECT jsonb_agg(jsonb_build_object('scope',scope,'subject',subject,'maxUsd',cap,'spentUsd',spent,
    'heldUsd',held,'remainingUsd',greatest(0,cap-spent-held),'historyIncomplete',unknown) ORDER BY scope,subject) INTO buckets FROM totals;
  RETURN jsonb_build_object('day',today,'timezone','Asia/Baghdad','policyVersion',policy.version,'scopes',buckets);
END $$;
REVOKE ALL ON FUNCTION hawa.studio_scope_budget_internal(uuid,uuid) FROM PUBLIC,hawa_app;

CREATE FUNCTION hawa.studio_scope_budget(cid uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hawa AS $$
BEGIN
  IF NOT hawa.can_access_client(hawa.current_tenant_id(),cid) OR
    NOT EXISTS(SELECT 1 FROM hawa.clients WHERE tenant_id=hawa.current_tenant_id() AND id=cid) THEN RETURN NULL; END IF;
  RETURN hawa.studio_scope_budget_internal(hawa.current_tenant_id(),cid);
END $$;
REVOKE ALL ON FUNCTION hawa.studio_scope_budget(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.studio_scope_budget(uuid) TO hawa_app;

CREATE FUNCTION hawa.enforce_studio_scope_budget() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hawa AS $$
DECLARE cid uuid; usage jsonb; bucket jsonb; role text; amount numeric;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (NEW.spending_policy_version,NEW.budget_role) IS DISTINCT FROM (OLD.spending_policy_version,OLD.budget_role) THEN
      RAISE EXCEPTION 'Studio spending policy identity is immutable';
    END IF;
    -- Final costs, including overruns, must always be saved.
    PERFORM pg_advisory_xact_lock(hashtextextended('studio-spending:'||NEW.tenant_id::text,0));
    RETURN NEW;
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'STUDIO_BUDGET_INVALID: Studio spending admission requires READ COMMITTED';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM hawa.current_tenant_id() THEN
    RAISE EXCEPTION 'Studio spending tenant mismatch' USING ERRCODE='42501';
  END IF;
  SELECT r.client_id INTO cid FROM hawa.design_studio_runs r JOIN hawa.tasks t
    ON t.id=r.task_id AND t.tenant_id=r.tenant_id AND t.client_id=r.client_id
    WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.run_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Studio spending run scope mismatch'; END IF;
  IF NEW.reservation IS NULL THEN RAISE EXCEPTION 'STUDIO_BUDGET_INVALID: New Studio calls require a reservation'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('studio-spending:'||NEW.tenant_id::text,0));
  usage=hawa.studio_scope_budget_internal(NEW.tenant_id,cid);
  role=hawa.studio_budget_role(NEW.stage);
  amount=(NEW.reservation->>'usd')::numeric;
  FOR bucket IN SELECT value FROM jsonb_array_elements(usage->'scopes') LOOP
    IF bucket->>'scope'<>'role' OR bucket->>'subject'=role THEN
      IF (bucket->>'historyIncomplete')::boolean THEN
        RAISE EXCEPTION 'STUDIO_BUDGET_HISTORY_INCOMPLETE: Unresolved historical Studio spending has no quote';
      END IF;
      IF amount>(bucket->>'remainingUsd')::numeric THEN
        RAISE EXCEPTION 'STUDIO_SCOPE_BUDGET_EXHAUSTED: % needs $%; $% available for the office day',
          bucket->>'subject',amount,bucket->>'remainingUsd';
      END IF;
    END IF;
  END LOOP;
  NEW.started_at=clock_timestamp();
  NEW.spending_policy_version=(usage->>'policyVersion')::integer;
  NEW.budget_role=role;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION hawa.enforce_studio_scope_budget() FROM PUBLIC;
CREATE TRIGGER enforce_studio_scope_budget BEFORE INSERT OR UPDATE ON hawa.design_studio_calls
  FOR EACH ROW EXECUTE FUNCTION hawa.enforce_studio_scope_budget();

CREATE FUNCTION hawa.lock_studio_settlement_spending() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('studio-spending:'||NEW.tenant_id::text,0));
  RETURN NEW;
END $$;
-- AFTER runs only after the existing task/call authority locks; admission never locks another task.
CREATE TRIGGER lock_studio_settlement_spending AFTER INSERT ON hawa.studio_run_settlements
  FOR EACH ROW EXECUTE FUNCTION hawa.lock_studio_settlement_spending();
COMMIT;
