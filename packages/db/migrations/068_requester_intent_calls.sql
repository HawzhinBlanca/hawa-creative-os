-- ADR-144: the intake router reads a requester's message the rules cannot place, at most once per
-- Telegram update, inside the office's shared daily allowance (role intake_router, ADR-096).
-- A row is written, and the allowance admitted, before the call is sent; a second attempt for the
-- same update finds the row and never calls again. The decision the call returned is kept on it.
BEGIN;
CREATE TABLE hawa.requester_intent_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES hawa.tenants(id),
  update_id bigint NOT NULL CHECK (update_id > 0),
  chat_id text NOT NULL CHECK (chat_id ~ '^-?[0-9]{1,20}$'),
  client_id uuid NOT NULL,
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 160),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  reservation jsonb NOT NULL,
  spending_policy_version integer,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL DEFAULT 'started' CHECK (status IN ('started','completed')),
  finished_at timestamptz,
  acceptance text CHECK (acceptance IN ('response_received','not_accepted','unknown')),
  cost_basis text CHECK (cost_basis IN ('usage','not_accepted','unavailable')),
  cost_usd numeric CHECK (cost_usd BETWEEN 0 AND 9007199254),
  input_tokens bigint CHECK (input_tokens BETWEEN 0 AND 9007199254740991),
  output_tokens bigint CHECK (output_tokens BETWEEN 0 AND 9007199254740991),
  provider_request_id text CHECK (provider_request_id ~ '^[a-zA-Z0-9_.:-]{1,200}$'),
  response_id text CHECK (response_id ~ '^[a-zA-Z0-9_.:-]{1,200}$'),
  served_model text CHECK (served_model ~ '^[a-zA-Z0-9_.:-]{1,160}$'),
  latency_ms integer CHECK (latency_ms >= 0),
  diagnostic text CHECK (diagnostic ~ '^[A-Z0-9_]{1,80}$'),
  decision jsonb CHECK (decision IS NULL OR jsonb_typeof(decision) = 'object'),
  UNIQUE (tenant_id, update_id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES hawa.clients(tenant_id, id),
  FOREIGN KEY (tenant_id, spending_policy_version) REFERENCES hawa.studio_spending_policies(tenant_id, version)
);
CREATE INDEX requester_intent_call_scope ON hawa.requester_intent_calls(tenant_id, started_at DESC);
ALTER TABLE hawa.requester_intent_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.requester_intent_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY requester_intent_call_read ON hawa.requester_intent_calls FOR SELECT USING
  (tenant_id=hawa.current_tenant_id() AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator','auditor']::hawa.membership_role[])));
CREATE POLICY requester_intent_call_write ON hawa.requester_intent_calls FOR ALL USING
  (tenant_id=hawa.current_tenant_id() AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator']::hawa.membership_role[]))) WITH CHECK
  (tenant_id=hawa.current_tenant_id() AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator']::hawa.membership_role[])));
GRANT SELECT,INSERT,UPDATE ON hawa.requester_intent_calls TO hawa_app;
REVOKE DELETE ON hawa.requester_intent_calls FROM PUBLIC,hawa_app;

-- Admission on insert (the shared allowance, role intake_router); the call's identity is immutable and
-- its outcome is written once.
CREATE FUNCTION hawa.enforce_requester_intent_call() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hawa AS $$
DECLARE usage jsonb; amount numeric;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Requester intent calls are immutable'; END IF;
  IF current_setting('transaction_isolation')<>'read committed' OR NEW.tenant_id IS DISTINCT FROM hawa.current_tenant_id() THEN
    RAISE EXCEPTION 'REQUESTER_INTENT_CALL_INVALID'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('studio-spending:'||NEW.tenant_id::text,0));
  IF TG_OP='INSERT' THEN
    amount=hawa.office_known_usd(NEW.reservation->'usd');
    IF NEW.status<>'started' OR NEW.finished_at IS NOT NULL OR NEW.acceptance IS NOT NULL OR NEW.cost_basis IS NOT NULL
      OR NEW.cost_usd IS NOT NULL OR NEW.decision IS NOT NULL OR NEW.response_id IS NOT NULL
      OR jsonb_typeof(NEW.reservation) IS DISTINCT FROM 'object' OR amount IS NULL OR amount<=0 OR amount>1
      OR NEW.reservation->>'requestSha256' IS DISTINCT FROM NEW.request_sha256 THEN
      RAISE EXCEPTION 'REQUESTER_INTENT_CALL_INVALID'; END IF;
    usage=hawa.admit_office_spending(NEW.tenant_id,NEW.client_id,'intake_router',amount);
    NEW.spending_policy_version=(usage->>'policyVersion')::integer;
    NEW.started_at=clock_timestamp();
  ELSE
    IF OLD.status<>'started' OR NEW.status<>'completed' OR NEW.acceptance IS NULL OR NEW.cost_basis IS NULL OR
      (to_jsonb(NEW)-ARRAY['status','finished_at','acceptance','cost_basis','cost_usd','input_tokens','output_tokens','provider_request_id','response_id','served_model','latency_ms','diagnostic','decision']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['status','finished_at','acceptance','cost_basis','cost_usd','input_tokens','output_tokens','provider_request_id','response_id','served_model','latency_ms','diagnostic','decision']) THEN
      RAISE EXCEPTION 'Requester intent call identity and completed outcomes are immutable'; END IF;
    IF NEW.cost_basis='usage' AND (NEW.acceptance<>'response_received' OR NEW.cost_usd IS NULL) THEN
      RAISE EXCEPTION 'REQUESTER_INTENT_CALL_INVALID'; END IF;
    IF NEW.cost_basis='not_accepted' AND (NEW.acceptance<>'not_accepted' OR NEW.cost_usd IS DISTINCT FROM 0) THEN
      RAISE EXCEPTION 'REQUESTER_INTENT_CALL_INVALID'; END IF;
    NEW.finished_at=clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION hawa.enforce_requester_intent_call() FROM PUBLIC;
CREATE TRIGGER enforce_requester_intent_call BEFORE INSERT OR UPDATE OR DELETE ON hawa.requester_intent_calls
  FOR EACH ROW EXECUTE FUNCTION hawa.enforce_requester_intent_call();

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
        (c.cost_basis IN ('usage','not_accepted') OR c.reservation IS NULL)) AS final,
      EXISTS(SELECT 1 FROM hawa.pre_admission_spending l WHERE l.tenant_id=c.tenant_id
        AND l.kind='studio_call' AND l.record_id=c.id) AS legacy
    FROM hawa.design_studio_calls c JOIN hawa.design_studio_runs r ON r.id=c.run_id AND r.tenant_id=c.tenant_id
    LEFT JOIN LATERAL (
      SELECT max(cost) AS cost FROM (SELECT max((e->>'reportedCostUsd')::numeric) AS cost
      FROM hawa.studio_run_settlements st CROSS JOIN LATERAL jsonb_array_elements(st.calls) e
      WHERE st.tenant_id=c.tenant_id AND st.run_id=c.run_id AND e->>'callId'=c.id::text
      UNION ALL SELECT max(a.reported_cost_usd) FROM hawa.call_cost_attestations a
        WHERE a.tenant_id=c.tenant_id AND a.call_kind='studio' AND a.call_id=c.id) evidence
    ) s ON true WHERE c.tenant_id=tid
  ), run_totals AS (
    SELECT run_id,sum(known) AS known,count(*) AS calls FROM receipts GROUP BY run_id
  ), all_receipts AS (
    SELECT client_id,role,day,known,reserved,final,legacy FROM receipts
    UNION ALL
    SELECT NULL::uuid,c.role,(c.started_at AT TIME ZONE 'Asia/Baghdad')::date,
      greatest(coalesce(k.cost,0),coalesce(s.cost,0)),
      hawa.office_known_usd(c.budget_reservation->'usd'),
      s.cost IS NOT NULL OR (c.status='completed' AND (
        (c.outcome->>'ok'='true' AND c.outcome#>>'{value,usage,costBasis}' IN ('usage','local') AND k.cost IS NOT NULL)
        OR (c.outcome->>'ok'='false' AND c.outcome#>>'{error,detail,acceptance}' IN ('not_dispatched','not_accepted')
          AND c.outcome#>>'{error,detail,requiresReconciliation}'='false' AND k.cost=0))),
      false
    FROM hawa.eval_model_calls c
    CROSS JOIN LATERAL (SELECT hawa.office_known_usd(CASE WHEN c.outcome->>'ok'='true'
      THEN c.outcome#>'{value,usage,estimatedCostUsd}' ELSE c.outcome#>'{error,detail,estimatedCostUsd}' END) AS cost) k
    LEFT JOIN LATERAL (SELECT max(cost) AS cost FROM (SELECT max(hawa.office_known_usd(e->'reportedCostUsd')) AS cost
      FROM hawa.eval_run_settlements st CROSS JOIN LATERAL jsonb_array_elements(st.calls) e
      WHERE st.tenant_id=c.tenant_id AND st.run_id=c.run_id AND e->>'callId'=c.id::text
      UNION ALL SELECT max(a.reported_cost_usd) FROM hawa.call_cost_attestations a
        WHERE a.tenant_id=c.tenant_id AND a.call_kind='evaluation' AND a.call_id=c.id) evidence) s ON true
    WHERE c.tenant_id=tid
    UNION ALL
    SELECT coalesce(v.voice_budget_client_id,CASE WHEN v.payload->>'clientId' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
        THEN (v.payload->>'clientId')::uuid ELSE NULL END),'voice_transcriber',
      (v.received_at AT TIME ZONE 'Asia/Baghdad')::date,greatest(coalesce(hawa.office_known_usd(o.payload->'actualUsd'),0),coalesce(a.cost,0)),
      coalesce(v.voice_reserved_usd,hawa.office_known_usd(v.payload->'estimatedMicrousd')/1000000),
      a.cost IS NOT NULL OR coalesce(o.payload#>>'{result,providerOutcome}' IN ('not_sent','rejected'),false) AND coalesce(hawa.office_known_usd(o.payload->'actualUsd'),0)=0,
      false
    FROM hawa.inbox_events v LEFT JOIN hawa.inbox_events o ON o.tenant_id=v.tenant_id
      AND o.source_account_id='lifecycle_voice_outcome' AND o.event_kind='lifecycle_voice_outcome'
      AND o.integration_id IS NULL AND o.source_event_id=v.source_event_id
    LEFT JOIN LATERAL (SELECT max(a.reported_cost_usd) AS cost FROM hawa.call_cost_attestations a
      WHERE a.tenant_id=v.tenant_id AND a.call_kind='voice' AND a.call_id=v.id) a ON true
    WHERE v.tenant_id=tid AND v.source_account_id='lifecycle_voice_attempt' AND v.event_kind='lifecycle_voice_attempt'

    UNION ALL
    SELECT NULL::uuid,'health_probe',(c.started_at AT TIME ZONE 'Asia/Baghdad')::date,
      greatest(coalesce(c.cost_usd,0),coalesce(a.cost,0)),(c.reservation->>'usd')::numeric,
      NOT c.reconciliation_required OR a.cost IS NOT NULL,
      false
    FROM hawa.paid_model_probe_calls c
    LEFT JOIN LATERAL (SELECT max(a.reported_cost_usd) AS cost FROM hawa.call_cost_attestations a
      WHERE a.tenant_id=c.tenant_id AND a.call_kind='health_probe' AND a.call_id=c.id) a ON true
    WHERE c.tenant_id=tid
    UNION ALL
    SELECT p.client_id,'creative_director',(coalesce(c.started_at,p.created_at) AT TIME ZONE 'Asia/Baghdad')::date,
      greatest(coalesce(c.cost_usd,0),coalesce(a.cost,0)),hawa.office_known_usd(c.reservation->'usd'),
      NOT c.reconciliation_required OR a.cost IS NOT NULL,
      EXISTS(SELECT 1 FROM hawa.pre_admission_spending l WHERE l.tenant_id=p.tenant_id
        AND l.kind='canva_plan' AND l.record_id=p.id)
    FROM hawa.canva_design_plans p LEFT JOIN hawa.canva_planner_calls c ON c.id=p.id AND c.tenant_id=p.tenant_id
    LEFT JOIN LATERAL (SELECT max(a.reported_cost_usd) AS cost FROM hawa.call_cost_attestations a
      WHERE a.tenant_id=p.tenant_id AND a.call_kind='canva_planner' AND a.call_id=p.id) a ON true
    WHERE p.tenant_id=tid AND (c.id IS NOT NULL OR p.paid_protocol IS NULL)
    UNION ALL
    -- ADR-144: one intake-router reading per Telegram update. Its reservation is a bound on what the
    -- call can cost, so an uncertain call is charged the whole reservation and never leaves the
    -- history incomplete; a call with usage is charged what it used.
    SELECT c.client_id,'intake_router',(c.started_at AT TIME ZONE 'Asia/Baghdad')::date,
      CASE WHEN c.cost_basis IN ('usage','not_accepted') AND c.cost_usd IS NOT NULL THEN c.cost_usd
        ELSE (c.reservation->>'usd')::numeric END,
      (c.reservation->>'usd')::numeric,true,false
    FROM hawa.requester_intent_calls c WHERE c.tenant_id=tid
    UNION ALL
    -- A new run must not erase spend/calls that the saved run says existed but its ledger lacks.
    -- Round the JS snapshot to micro-USD to avoid treating floating addition noise as lost history.
    SELECT r.client_id,'creative_director',(r.created_at AT TIME ZONE 'Asia/Baghdad')::date,
      greatest(0,coalesce((r.budget->>'spentUsd')::numeric,0)-coalesce(t.known,0)),NULL::numeric,false,false
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
    -- ADR-133: a frozen pre-admission record was billed on its own day, before any daily limit.
    FROM all_receipts WHERE (day=today OR final IS NOT TRUE) AND NOT legacy
  ), scopes(scope,subject,cap) AS (
    SELECT 'office','office',(policy.limits->>'officeUsd')::numeric
    UNION ALL SELECT 'client','client',coalesce((policy.limits->'clients'->>cid::text)::numeric,(policy.limits->>'clientUsd')::numeric) WHERE cid IS NOT NULL
    UNION ALL SELECT 'role',role,coalesce((policy.limits->'roles'->>role)::numeric,(policy.limits->>'roleUsd')::numeric)
      FROM unnest(ARRAY['creative_director','visual_judge','asset_photoreal','intake_router','brief_builder','feedback_classifier','rule_miner','embedding_multimodal','reranker_multimodal','voice_transcriber','health_probe']) AS roles(role)
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

COMMIT;
