-- ADR-096: one authoritative daily allowance across original paid-call ledgers.
BEGIN;
ALTER TABLE hawa.eval_model_calls ADD COLUMN budget_reservation jsonb;
ALTER TABLE hawa.eval_model_calls ADD COLUMN spending_policy_version integer;
ALTER TABLE hawa.eval_model_calls ADD CONSTRAINT eval_spending_policy_fk FOREIGN KEY(tenant_id,spending_policy_version)
  REFERENCES hawa.studio_spending_policies(tenant_id,version);
ALTER TABLE hawa.inbox_events ADD COLUMN voice_reserved_usd numeric;
ALTER TABLE hawa.inbox_events ADD COLUMN voice_budget_client_id uuid;
ALTER TABLE hawa.inbox_events ADD COLUMN voice_spending_policy_version integer;
ALTER TABLE hawa.inbox_events ADD CONSTRAINT voice_spending_client_fk FOREIGN KEY(tenant_id,voice_budget_client_id)
  REFERENCES hawa.clients(tenant_id,id);
ALTER TABLE hawa.inbox_events ADD CONSTRAINT voice_spending_policy_fk FOREIGN KEY(tenant_id,voice_spending_policy_version)
  REFERENCES hawa.studio_spending_policies(tenant_id,version);
CREATE INDEX eval_calls_spending_scope ON hawa.eval_model_calls(tenant_id,started_at);
CREATE INDEX voice_calls_spending_scope ON hawa.inbox_events(tenant_id,received_at)
  WHERE source_account_id='lifecycle_voice_attempt';

CREATE FUNCTION hawa.office_known_usd(value jsonb) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(value)='number' THEN
    CASE WHEN (value::text)::numeric BETWEEN 0 AND 9007199254 THEN (value::text)::numeric ELSE NULL END ELSE NULL END
$$;
CREATE OR REPLACE FUNCTION hawa.protect_studio_spending_policy() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF item.key NOT IN ('creative_director','visual_judge','asset_photoreal','intake_router','brief_builder','feedback_classifier','rule_miner','embedding_multimodal','reranker_multimodal','voice_transcriber') THEN
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

CREATE OR REPLACE FUNCTION hawa.studio_scope_budget_internal(tid uuid,cid uuid) RETURNS jsonb
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
    SELECT NULL::uuid,c.role,(c.started_at AT TIME ZONE 'Asia/Baghdad')::date,
      greatest(coalesce(k.cost,0),coalesce(s.cost,0)),
      hawa.office_known_usd(c.budget_reservation->'usd'),
      s.cost IS NOT NULL OR (c.status='completed' AND (
        (c.outcome->>'ok'='true' AND c.outcome#>>'{value,usage,costBasis}' IN ('usage','local') AND k.cost IS NOT NULL)
        OR (c.outcome->>'ok'='false' AND c.outcome#>>'{error,detail,acceptance}' IN ('not_dispatched','not_accepted')
          AND c.outcome#>>'{error,detail,requiresReconciliation}'='false' AND k.cost=0)))
    FROM hawa.eval_model_calls c
    CROSS JOIN LATERAL (SELECT hawa.office_known_usd(CASE WHEN c.outcome->>'ok'='true'
      THEN c.outcome#>'{value,usage,estimatedCostUsd}' ELSE c.outcome#>'{error,detail,estimatedCostUsd}' END) AS cost) k
    LEFT JOIN LATERAL (SELECT max(hawa.office_known_usd(e->'reportedCostUsd')) AS cost
      FROM hawa.eval_run_settlements st CROSS JOIN LATERAL jsonb_array_elements(st.calls) e
      WHERE st.tenant_id=c.tenant_id AND st.run_id=c.run_id AND e->>'callId'=c.id::text) s ON true
    WHERE c.tenant_id=tid
    UNION ALL
    SELECT coalesce(v.voice_budget_client_id,CASE WHEN v.payload->>'clientId' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
        THEN (v.payload->>'clientId')::uuid ELSE NULL END),'voice_transcriber',
      (v.received_at AT TIME ZONE 'Asia/Baghdad')::date,coalesce(hawa.office_known_usd(o.payload->'actualUsd'),0),
      coalesce(v.voice_reserved_usd,hawa.office_known_usd(v.payload->'estimatedMicrousd')/1000000),
      coalesce(o.payload#>>'{result,providerOutcome}' IN ('not_sent','rejected'),false) AND coalesce(hawa.office_known_usd(o.payload->'actualUsd'),0)=0
    FROM hawa.inbox_events v LEFT JOIN hawa.inbox_events o ON o.tenant_id=v.tenant_id
      AND o.source_account_id='lifecycle_voice_outcome' AND o.event_kind='lifecycle_voice_outcome'
      AND o.integration_id IS NULL AND o.source_event_id=v.source_event_id
    WHERE v.tenant_id=tid AND v.source_account_id='lifecycle_voice_attempt' AND v.event_kind='lifecycle_voice_attempt'

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
    SELECT 'office','office',(policy.limits->>'officeUsd')::numeric
    UNION ALL SELECT 'client','client',coalesce((policy.limits->'clients'->>cid::text)::numeric,(policy.limits->>'clientUsd')::numeric) WHERE cid IS NOT NULL
    UNION ALL SELECT 'role',role,coalesce((policy.limits->'roles'->>role)::numeric,(policy.limits->>'roleUsd')::numeric)
      FROM unnest(ARRAY['creative_director','visual_judge','asset_photoreal','intake_router','brief_builder','feedback_classifier','rule_miner','embedding_multimodal','reranker_multimodal','voice_transcriber']) AS roles(role)
  ), totals AS (
    SELECT scope,subject,cap,coalesce(sum(o.spent),0) AS spent,coalesce(sum(o.held),0) AS held,
      coalesce(bool_or(o.unknown),false) AS unknown
    FROM scopes LEFT JOIN obligations o ON scope='office' OR (scope='client' AND o.client_id=cid)
      OR (scope='role' AND o.role=subject) GROUP BY scope,subject,cap
  ) SELECT jsonb_agg(jsonb_build_object('scope',scope,'subject',subject,'maxUsd',cap,'spentUsd',spent,
    'heldUsd',held,'remainingUsd',greatest(0,cap-spent-held),'historyIncomplete',unknown) ORDER BY scope,subject) INTO buckets FROM totals;
  RETURN jsonb_build_object('day',today,'timezone','Asia/Baghdad','policyVersion',policy.version,'scopes',buckets);
END $$;

CREATE FUNCTION hawa.office_scope_budget() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hawa AS $$
BEGIN
  IF NOT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator','auditor']::hawa.membership_role[]) THEN
    RAISE EXCEPTION 'Office spending requires an authorized office role' USING ERRCODE='42501';
  END IF;
  RETURN hawa.studio_scope_budget_internal(hawa.current_tenant_id(),NULL);
END $$;
REVOKE ALL ON FUNCTION hawa.office_scope_budget() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.office_scope_budget() TO hawa_app;

CREATE FUNCTION hawa.admit_office_spending(tid uuid,cid uuid,role text,amount numeric) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hawa AS $$
DECLARE usage jsonb; bucket jsonb;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' OR tid IS DISTINCT FROM hawa.current_tenant_id()
    OR amount IS NULL OR amount NOT BETWEEN 0 AND 9007199254 OR amount*1000000<>trunc(amount*1000000) THEN
    RAISE EXCEPTION 'OFFICE_BUDGET_INVALID: invalid shared spending admission';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('studio-spending:'||tid::text,0));
  usage=hawa.studio_scope_budget_internal(tid,cid);
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(usage->'scopes') b WHERE b->>'scope'='role' AND b->>'subject'=role) THEN
    RAISE EXCEPTION 'OFFICE_BUDGET_INVALID: unknown spending role';
  END IF;
  FOR bucket IN SELECT value FROM jsonb_array_elements(usage->'scopes') LOOP
    IF bucket->>'scope'<>'role' OR bucket->>'subject'=role THEN
      IF (bucket->>'historyIncomplete')::boolean THEN RAISE EXCEPTION 'OFFICE_BUDGET_HISTORY_INCOMPLETE: unresolved historical spending'; END IF;
      IF amount>(bucket->>'remainingUsd')::numeric THEN RAISE EXCEPTION 'OFFICE_BUDGET_EXHAUSTED: shared daily allowance exhausted'; END IF;
    END IF;
  END LOOP;
  RETURN usage;
END $$;
REVOKE ALL ON FUNCTION hawa.admit_office_spending(uuid,uuid,text,numeric) FROM PUBLIC,hawa_app;

CREATE FUNCTION hawa.enforce_evaluation_spending() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hawa AS $$
DECLARE amount numeric; usage jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (NEW.budget_reservation,NEW.spending_policy_version) IS DISTINCT FROM (OLD.budget_reservation,OLD.spending_policy_version) THEN
      RAISE EXCEPTION 'Evaluation spending identity is immutable';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('studio-spending:'||NEW.tenant_id::text,0));
    RETURN NEW;
  END IF;
  amount=hawa.office_known_usd(NEW.budget_reservation->'usd');
  IF jsonb_typeof(NEW.budget_reservation) IS DISTINCT FROM 'object' OR amount IS NULL OR
    NEW.budget_reservation->>'policy' IS DISTINCT FROM 'gateway-request-budget-v1' OR
    NEW.budget_reservation->>'requestSha256' IS DISTINCT FROM NEW.request_hash OR
    (SELECT count(*) FROM jsonb_object_keys(NEW.budget_reservation))<>3 OR
    NEW.status<>'pending' OR NEW.outcome IS NOT NULL OR NEW.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'OFFICE_BUDGET_INVALID: new evaluation calls require their frozen request allowance';
  END IF;
  usage=hawa.admit_office_spending(NEW.tenant_id,NULL,NEW.role,amount);
  NEW.spending_policy_version=(usage->>'policyVersion')::integer;
  NEW.started_at=clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION hawa.enforce_evaluation_spending() FROM PUBLIC;
-- The existing fence first locks the evaluation parent; shared spending always comes last.
CREATE TRIGGER zz_enforce_evaluation_spending BEFORE INSERT OR UPDATE ON hawa.eval_model_calls
  FOR EACH ROW EXECUTE FUNCTION hawa.enforce_evaluation_spending();
CREATE TRIGGER lock_evaluation_settlement_spending AFTER INSERT ON hawa.eval_run_settlements
  FOR EACH ROW EXECUTE FUNCTION hawa.lock_studio_settlement_spending();

CREATE FUNCTION hawa.enforce_voice_spending() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hawa AS $$
DECLARE prior hawa.inbox_events%ROWTYPE; amount numeric; cid uuid; usage jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN
    IF OLD.source_account_id IN ('lifecycle_voice_attempt','lifecycle_voice_outcome','lifecycle_voice_decision') OR
      (TG_OP='UPDATE' AND NEW.source_account_id IN ('lifecycle_voice_attempt','lifecycle_voice_outcome','lifecycle_voice_decision')) THEN
      RAISE EXCEPTION 'Voice paid-call evidence is immutable';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    IF (NEW.voice_reserved_usd,NEW.voice_budget_client_id,NEW.voice_spending_policy_version) IS DISTINCT FROM
      (OLD.voice_reserved_usd,OLD.voice_budget_client_id,OLD.voice_spending_policy_version) THEN RAISE EXCEPTION 'Voice spending identity is immutable'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.source_account_id NOT IN ('lifecycle_voice_attempt','lifecycle_voice_outcome','lifecycle_voice_decision') THEN
    IF NEW.voice_reserved_usd IS NOT NULL OR NEW.voice_budget_client_id IS NOT NULL OR NEW.voice_spending_policy_version IS NOT NULL THEN
      RAISE EXCEPTION 'Voice spending identity is reserved for paid attempts'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.source_account_id<>NEW.event_kind OR NEW.integration_id IS NOT NULL OR NEW.tenant_id IS DISTINCT FROM hawa.current_tenant_id() THEN
    RAISE EXCEPTION 'OFFICE_BUDGET_INVALID: voice ledger identity mismatch';
  END IF;
  IF NEW.source_account_id<>'lifecycle_voice_attempt' AND (NEW.voice_reserved_usd IS NOT NULL OR NEW.voice_budget_client_id IS NOT NULL OR NEW.voice_spending_policy_version IS NOT NULL) THEN
    RAISE EXCEPTION 'Voice spending identity is reserved for paid attempts'; END IF;
  -- Serialize duplicate identities before checking the shared allowance. A replay spends nothing.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':voice:'||
    CASE WHEN NEW.source_account_id='lifecycle_voice_decision' THEN NEW.source_account_id||':'||NEW.source_event_id ELSE NEW.source_event_id END,0));
  SELECT * INTO prior FROM hawa.inbox_events WHERE tenant_id=NEW.tenant_id AND integration_id IS NULL
    AND source_account_id=NEW.source_account_id AND source_event_id=NEW.source_event_id;
  IF FOUND THEN
    IF prior.payload IS DISTINCT FROM NEW.payload OR prior.payload_hash IS DISTINCT FROM NEW.payload_hash THEN
      RAISE EXCEPTION 'Voice paid-call identity conflict'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.source_account_id='lifecycle_voice_attempt' THEN
    amount=hawa.office_known_usd(NEW.payload->'estimatedMicrousd');
    IF amount IS NULL OR amount NOT BETWEEN 1 AND 100000 OR amount<>trunc(amount) OR
      coalesce(NEW.payload->>'clientId','') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR
      coalesce(NEW.payload->>'sourceSha256','') !~ '^[a-f0-9]{64}$' OR
      NEW.payload->>'key' IS DISTINCT FROM NEW.source_event_id OR
      NEW.source_event_id<>encode(sha256(convert_to('voice-v1:'||(NEW.payload->>'clientId')||':'||(NEW.payload->>'sourceSha256'),'UTF8')),'hex') THEN
      RAISE EXCEPTION 'OFFICE_BUDGET_INVALID: invalid voice allowance or source identity'; END IF;
    cid=(NEW.payload->>'clientId')::uuid;
    IF NOT hawa.can_access_client(NEW.tenant_id,cid) OR NOT EXISTS(SELECT 1 FROM hawa.clients c
      WHERE c.tenant_id=NEW.tenant_id AND c.id=cid) OR NOT EXISTS(SELECT 1 FROM hawa.inbox_events u
      WHERE u.tenant_id=NEW.tenant_id AND u.source_account_id='lifecycle_source_upload' AND u.event_kind='lifecycle_source_upload'
        AND u.source_event_id=NEW.payload->>'sourceUpdateId' AND u.payload->>'clientId'=cid::text
        AND u.payload#>>'{blob,sha256}'=NEW.payload->>'sourceSha256') THEN
      RAISE EXCEPTION 'OFFICE_BUDGET_INVALID: voice allowance requires its retained client source'; END IF;
    usage=hawa.admit_office_spending(NEW.tenant_id,cid,'voice_transcriber',amount/1000000);
    NEW.voice_reserved_usd=amount/1000000; NEW.voice_budget_client_id=cid;
    NEW.voice_spending_policy_version=(usage->>'policyVersion')::integer;
  ELSIF NEW.source_account_id='lifecycle_voice_outcome' THEN
    SELECT * INTO prior FROM hawa.inbox_events WHERE tenant_id=NEW.tenant_id AND integration_id IS NULL
      AND source_account_id='lifecycle_voice_attempt' AND source_event_id=NEW.source_event_id;
    IF NOT FOUND OR NEW.payload->>'key' IS DISTINCT FROM NEW.source_event_id OR
      NEW.payload->>'sourceSha256' IS DISTINCT FROM prior.payload->>'sourceSha256' THEN
      RAISE EXCEPTION 'Voice outcome requires its original attempt'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('studio-spending:'||NEW.tenant_id::text,0));
  END IF;
  NEW.received_at=clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION hawa.enforce_voice_spending() FROM PUBLIC;
CREATE TRIGGER enforce_voice_spending BEFORE INSERT OR UPDATE OR DELETE ON hawa.inbox_events
  FOR EACH ROW EXECUTE FUNCTION hawa.enforce_voice_spending();
COMMIT;
