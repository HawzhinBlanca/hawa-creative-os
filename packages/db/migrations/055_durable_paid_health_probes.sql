-- ADR-100: original paid health calls join the shared office ledger.
BEGIN;
CREATE TABLE hawa.paid_model_probe_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES hawa.tenants(id),
  config_sha256 text NOT NULL CHECK(config_sha256 ~ '^[a-f0-9]{64}$'),
  model text NOT NULL CHECK(length(model) BETWEEN 1 AND 160),
  protocol text NOT NULL DEFAULT 'paid-health-v2' CHECK(protocol='paid-health-v2'),
  interval_ms integer NOT NULL CHECK(interval_ms BETWEEN 300000 AND 86400000),
  reservation jsonb NOT NULL,
  spending_policy_version integer NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL DEFAULT 'started' CHECK(status IN ('started','completed')),
  finished_at timestamptz,
  probe_status text CHECK(probe_status IN ('connected','unauthorized','billing_exhausted','rate_limited','unreachable','http_error')),
  acceptance text CHECK(acceptance IN ('response_received','not_accepted','unknown')),
  cost_basis text CHECK(cost_basis IN ('usage','not_accepted','unavailable')),
  cost_usd numeric CHECK(cost_usd BETWEEN 0 AND 9007199254),
  reconciliation_required boolean NOT NULL DEFAULT true,
  input_tokens bigint CHECK(input_tokens BETWEEN 0 AND 9007199254740991),
  output_tokens bigint CHECK(output_tokens BETWEEN 0 AND 9007199254740991),
  provider_request_id text CHECK(provider_request_id ~ '^[a-zA-Z0-9_.:-]{1,200}$'),
  response_id text CHECK(response_id ~ '^[a-zA-Z0-9_.:-]{1,200}$'),
  served_model text CHECK(served_model ~ '^[a-zA-Z0-9_.:-]{1,160}$'),
  response_sha256 text CHECK(response_sha256 ~ '^[a-f0-9]{64}$'),
  latency_ms integer CHECK(latency_ms>=0),
  FOREIGN KEY(tenant_id,spending_policy_version) REFERENCES hawa.studio_spending_policies(tenant_id,version)
);
CREATE INDEX paid_probe_scope ON hawa.paid_model_probe_calls(tenant_id,started_at DESC);
ALTER TABLE hawa.paid_model_probe_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.paid_model_probe_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY paid_probe_read ON hawa.paid_model_probe_calls FOR SELECT USING
  (tenant_id=hawa.current_tenant_id() AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator','auditor']::hawa.membership_role[])));
CREATE POLICY paid_probe_write ON hawa.paid_model_probe_calls FOR ALL USING
  (tenant_id=hawa.current_tenant_id() AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator']::hawa.membership_role[]))) WITH CHECK
  (tenant_id=hawa.current_tenant_id() AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator']::hawa.membership_role[])));
GRANT SELECT,INSERT,UPDATE ON hawa.paid_model_probe_calls TO hawa_app;
REVOKE DELETE ON hawa.paid_model_probe_calls FROM PUBLIC,hawa_app;
ALTER TABLE hawa.call_cost_attestations DROP CONSTRAINT call_cost_attestations_call_kind_check;
ALTER TABLE hawa.call_cost_attestations ADD CONSTRAINT call_cost_attestations_call_kind_check CHECK(call_kind IN ('studio','evaluation','voice','health_probe'));
ALTER TABLE hawa.call_cost_attestations ADD COLUMN health_probe_call_id uuid GENERATED ALWAYS AS
  (CASE WHEN call_kind='health_probe' THEN call_id END) STORED REFERENCES hawa.paid_model_probe_calls(id);

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
    IF item.key NOT IN ('creative_director','visual_judge','asset_photoreal','intake_router','brief_builder','feedback_classifier','rule_miner','embedding_multimodal','reranker_multimodal','voice_transcriber','health_probe') THEN
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

CREATE OR REPLACE FUNCTION hawa.office_call_cost_evidence(kind text, call_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hawa AS $$
DECLARE tid uuid=hawa.current_tenant_id(); src jsonb; extra jsonb; meta jsonb;
  settled numeric; original numeric; reserved numeric; accepted boolean=false; final boolean=false;
  receipts jsonb; attested numeric; revision integer; result jsonb;
BEGIN
  IF NOT hawa.has_tenant_role(tid,ARRAY['administrator','operator','auditor']::hawa.membership_role[]) THEN
    RAISE EXCEPTION 'CALL_COST_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF kind='studio' THEN
    SELECT to_jsonb(c),jsonb_build_object('clientId',r.client_id,'taskId',r.task_id,'runId',r.id,
      'provider',c.provider,'model',c.model,'status',c.status,'startedAt',c.started_at,
      'providerRequestId',c.provider_request_id,'responseId',c.response_id,'costBasis',c.cost_basis)
      INTO src,meta FROM hawa.design_studio_calls c JOIN hawa.design_studio_runs r ON r.id=c.run_id AND r.tenant_id=c.tenant_id
      WHERE c.tenant_id=tid AND c.id=call_id;
    SELECT jsonb_agg(e ORDER BY st.id),max(hawa.office_known_usd(e->'reportedCostUsd')) INTO extra,settled
      FROM hawa.studio_run_settlements st CROSS JOIN LATERAL jsonb_array_elements(st.calls) e
      WHERE st.tenant_id=tid AND st.run_id=(src->>'run_id')::uuid AND e->>'callId'=call_id::text;
    original=hawa.office_known_usd(src->'usd_estimate'); reserved=hawa.office_known_usd(src#>'{reservation,usd}');
    IF original=0 AND (src->>'status'='uncertain' OR src->>'cost_basis'='unavailable') THEN original=NULL; END IF;
    accepted=src->>'status'='ok' OR src->>'response_id' IS NOT NULL;
    final=src->>'status'<>'uncertain' AND (src->>'cost_basis' IN ('usage','not_accepted') OR src->>'reservation' IS NULL);
  ELSIF kind='evaluation' THEN
    SELECT to_jsonb(c),jsonb_build_object('clientId',NULL,'taskId',NULL,'runId',c.run_id,
      'provider',coalesce(c.outcome#>>'{value,deployment,provider}',c.outcome#>>'{error,detail,provider}',c.deployment->>'provider'),
      'model',coalesce(c.outcome#>>'{value,deployment,exactModelId}',c.outcome#>>'{error,detail,model}',c.deployment->>'exactModelId'),
      'status',c.status,'startedAt',c.started_at,'providerRequestId',coalesce(c.outcome#>>'{value,provenance,providerRequestId}',c.outcome#>>'{error,detail,providerRequestId}'),
      'costBasis',coalesce(c.outcome#>>'{value,usage,costBasis}',c.outcome#>>'{error,detail,costBasis}'))
      INTO src,meta FROM hawa.eval_model_calls c WHERE c.tenant_id=tid AND c.id=call_id;
    SELECT jsonb_agg(e ORDER BY st.id),max(hawa.office_known_usd(e->'reportedCostUsd')) INTO extra,settled
      FROM hawa.eval_run_settlements st CROSS JOIN LATERAL jsonb_array_elements(st.calls) e
      WHERE st.tenant_id=tid AND st.run_id=(src->>'run_id')::uuid AND e->>'callId'=call_id::text;
    original=hawa.office_known_usd(CASE WHEN src#>>'{outcome,ok}'='true' THEN src#>'{outcome,value,usage,estimatedCostUsd}' ELSE src#>'{outcome,error,detail,estimatedCostUsd}' END);
    reserved=hawa.office_known_usd(src#>'{budget_reservation,usd}');
    accepted=src#>>'{outcome,ok}'='true' OR src#>>'{outcome,error,detail,acceptance}'='response_received';
    final=src->>'status'='completed' AND ((src#>>'{outcome,ok}'='true' AND meta->>'costBasis' IN ('usage','local') AND original IS NOT NULL)
      OR (src#>>'{outcome,ok}'='false' AND src#>>'{outcome,error,detail,acceptance}' IN ('not_dispatched','not_accepted')
        AND src#>>'{outcome,error,detail,requiresReconciliation}'='false' AND original=0));
  ELSIF kind='health_probe' THEN
    SELECT to_jsonb(c),jsonb_build_object('clientId',NULL,'taskId',NULL,'runId',NULL,
      'provider','openai','model',coalesce(c.served_model,c.model),'status',coalesce(c.probe_status,c.status),
      'startedAt',c.started_at,'providerRequestId',c.provider_request_id,'responseId',c.response_id,'costBasis',c.cost_basis)
      INTO src,meta FROM hawa.paid_model_probe_calls c WHERE c.tenant_id=tid AND c.id=call_id;
    original=hawa.office_known_usd(src->'cost_usd'); reserved=hawa.office_known_usd(src#>'{reservation,usd}');
    accepted=src->>'acceptance'='response_received'; final=src->>'reconciliation_required'='false';
  ELSIF kind='voice' THEN
    SELECT to_jsonb(v),to_jsonb(o),jsonb_build_object('clientId',coalesce(v.voice_budget_client_id::text,v.payload->>'clientId'),
      'taskId',NULL,'runId',NULL,'provider','openai','model',v.payload->>'model',
      'status',coalesce(o.payload#>>'{result,providerOutcome}','uncertain'),'startedAt',v.received_at,
      'providerRequestId',o.payload#>>'{result,providerRequestId}','costBasis','unavailable')
      INTO src,extra,meta FROM hawa.inbox_events v LEFT JOIN hawa.inbox_events o ON o.tenant_id=v.tenant_id
        AND o.integration_id IS NULL AND o.source_account_id='lifecycle_voice_outcome' AND o.event_kind='lifecycle_voice_outcome' AND o.source_event_id=v.source_event_id
      WHERE v.tenant_id=tid AND v.id=call_id AND v.integration_id IS NULL
        AND v.source_account_id='lifecycle_voice_attempt' AND v.event_kind='lifecycle_voice_attempt';
    original=hawa.office_known_usd(extra#>'{payload,actualUsd}');
    reserved=coalesce(hawa.office_known_usd(src->'voice_reserved_usd'),hawa.office_known_usd(src#>'{payload,estimatedMicrousd}')/1000000);
    accepted=meta->>'status'='received'; final=meta->>'status' IN ('not_sent','rejected') AND coalesce(original,0)=0;
  ELSE RAISE EXCEPTION 'CALL_COST_INVALID';
  END IF;
  IF src IS NULL THEN RETURN NULL; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'revision',a.revision,'actorUserId',a.actor_user_id,
    'recordedAt',a.recorded_at,'reason',a.reason,'conclusion',a.conclusion,'reportedCostUsd',a.reported_cost_usd,
    'evidenceReference',a.evidence_reference,'evidenceSha256',a.evidence_sha256) ORDER BY a.revision),'[]'::jsonb),
    max(a.reported_cost_usd),coalesce(max(a.revision),0) INTO receipts,attested,revision
    FROM hawa.call_cost_attestations a WHERE a.tenant_id=tid AND a.call_kind=kind AND a.call_id=office_call_cost_evidence.call_id;
  result=meta||jsonb_build_object('kind',kind,'id',call_id,'originalCostUsd',original,'reservedUsd',reserved,
    'settledCostUsd',settled,'attestedCostUsd',attested,'accountedCostUsd',greatest(coalesce(original,0),coalesce(settled,0),coalesce(attested,0)),
    'originalAccepted',coalesce(accepted,false),'requiresCostEvidence',NOT(coalesce(final,false) OR settled IS NOT NULL OR attested IS NOT NULL),
    'revision',revision,'attestations',receipts,
    'evidenceConflict',coalesce((accepted AND receipts->-1->>'conclusion'='provider_not_accepted') OR
      greatest(coalesce(original,0),coalesce(settled,0),coalesce(attested,0))>(receipts->-1->>'reportedCostUsd')::numeric,false));
  RETURN result||jsonb_build_object('snapshotHash',encode(sha256(convert_to(jsonb_build_array(src,extra,receipts)::text,'UTF8')),'hex'));
END $$;
REVOKE ALL ON FUNCTION hawa.office_call_cost_evidence(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.office_call_cost_evidence(text,uuid) TO hawa_app;

CREATE OR REPLACE FUNCTION hawa.protect_call_cost_attestation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hawa AS $$
DECLARE source jsonb; parent_id uuid; source_key text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Call cost attestations are immutable'; END IF;
  IF NEW.tenant_id IS DISTINCT FROM hawa.current_tenant_id() OR NEW.actor_user_id IS DISTINCT FROM hawa.current_user_id()
    OR NOT EXISTS(SELECT 1 FROM hawa.lock_named_office_administrator(NEW.tenant_id,
      current_setting('hawa.call_cost_session_hash',true),NEW.actor_user_id)) THEN
    RAISE EXCEPTION 'CALL_COST_NAMED_ADMINISTRATOR_REQUIRED' USING ERRCODE='42501';
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CALL_COST_INVALID'; END IF;
  IF NEW.call_kind='studio' THEN
    SELECT r.task_id INTO parent_id FROM hawa.design_studio_calls c JOIN hawa.design_studio_runs r ON r.id=c.run_id AND r.tenant_id=c.tenant_id
      WHERE c.tenant_id=NEW.tenant_id AND c.id=NEW.call_id;
    PERFORM 1 FROM hawa.tasks WHERE tenant_id=NEW.tenant_id AND id=parent_id FOR UPDATE;
    PERFORM 1 FROM hawa.design_studio_calls WHERE tenant_id=NEW.tenant_id AND id=NEW.call_id FOR UPDATE;
  ELSIF NEW.call_kind='evaluation' THEN
    SELECT run_id INTO parent_id FROM hawa.eval_model_calls WHERE tenant_id=NEW.tenant_id AND id=NEW.call_id;
    PERFORM 1 FROM hawa.eval_runs WHERE tenant_id=NEW.tenant_id AND id=parent_id FOR UPDATE;
    PERFORM 1 FROM hawa.eval_model_calls WHERE tenant_id=NEW.tenant_id AND id=NEW.call_id FOR UPDATE;
  ELSIF NEW.call_kind='health_probe' THEN
    PERFORM 1 FROM hawa.paid_model_probe_calls WHERE tenant_id=NEW.tenant_id AND id=NEW.call_id FOR UPDATE;
  ELSIF NEW.call_kind='voice' THEN
    SELECT source_event_id INTO source_key FROM hawa.inbox_events WHERE tenant_id=NEW.tenant_id AND id=NEW.call_id
      AND source_account_id='lifecycle_voice_attempt' AND event_kind='lifecycle_voice_attempt' AND integration_id IS NULL;
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':voice:'||source_key,0));
  END IF;
  -- This is the same lock used by all admissions, original outcomes and run settlements.
  PERFORM pg_advisory_xact_lock(hashtextextended('studio-spending:'||NEW.tenant_id::text,0));
  source=hawa.office_call_cost_evidence(NEW.call_kind,NEW.call_id);
  IF source IS NULL THEN RAISE EXCEPTION 'CALL_COST_NOT_FOUND'; END IF;
  IF NEW.snapshot_hash IS DISTINCT FROM source->>'snapshotHash' OR NEW.revision<>(source->>'revision')::integer+1 THEN
    RAISE EXCEPTION 'CALL_COST_SNAPSHOT_CHANGED';
  END IF;
  IF NEW.conclusion='provider_not_accepted' AND ((source->>'originalAccepted')::boolean OR (source->>'accountedCostUsd')::numeric>0) THEN
    RAISE EXCEPTION 'CALL_COST_CONTRADICTORY_EVIDENCE';
  END IF;
  NEW.recorded_at=clock_timestamp();
  RETURN NEW;
END $$;


CREATE OR REPLACE FUNCTION hawa.office_call_cost_page(before_time timestamptz,before_kind text,before_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hawa AS $$
DECLARE tid uuid=hawa.current_tenant_id(); result jsonb;
BEGIN
  IF NOT hawa.has_tenant_role(tid,ARRAY['administrator','operator','auditor']::hawa.membership_role[]) THEN
    RAISE EXCEPTION 'CALL_COST_FORBIDDEN' USING ERRCODE='42501'; END IF;
  WITH calls AS (
    SELECT 'studio' AS kind,id,started_at FROM hawa.design_studio_calls WHERE tenant_id=tid
    UNION ALL SELECT 'health_probe',id,started_at FROM hawa.paid_model_probe_calls WHERE tenant_id=tid
    UNION ALL SELECT 'evaluation',id,started_at FROM hawa.eval_model_calls WHERE tenant_id=tid
    UNION ALL SELECT 'voice',id,received_at FROM hawa.inbox_events WHERE tenant_id=tid AND integration_id IS NULL
      AND source_account_id='lifecycle_voice_attempt' AND event_kind='lifecycle_voice_attempt'
  ), page AS (
    SELECT * FROM calls WHERE before_time IS NULL OR (started_at,kind,id)<(before_time,before_kind,before_id)
    ORDER BY started_at DESC,kind DESC,id DESC LIMIT 51
  ) SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind,'id',id,'startedAt',started_at)
    ORDER BY started_at DESC,kind DESC,id DESC),'[]'::jsonb) INTO result FROM page;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION hawa.office_call_cost_page(timestamptz,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.office_call_cost_page(timestamptz,text,uuid) TO hawa_app;

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
      SELECT max(cost) AS cost FROM (SELECT max((e->>'reportedCostUsd')::numeric) AS cost
      FROM hawa.studio_run_settlements st CROSS JOIN LATERAL jsonb_array_elements(st.calls) e
      WHERE st.tenant_id=c.tenant_id AND st.run_id=c.run_id AND e->>'callId'=c.id::text
      UNION ALL SELECT max(a.reported_cost_usd) FROM hawa.call_cost_attestations a
        WHERE a.tenant_id=c.tenant_id AND a.call_kind='studio' AND a.call_id=c.id) evidence
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
      a.cost IS NOT NULL OR coalesce(o.payload#>>'{result,providerOutcome}' IN ('not_sent','rejected'),false) AND coalesce(hawa.office_known_usd(o.payload->'actualUsd'),0)=0
    FROM hawa.inbox_events v LEFT JOIN hawa.inbox_events o ON o.tenant_id=v.tenant_id
      AND o.source_account_id='lifecycle_voice_outcome' AND o.event_kind='lifecycle_voice_outcome'
      AND o.integration_id IS NULL AND o.source_event_id=v.source_event_id
    LEFT JOIN LATERAL (SELECT max(a.reported_cost_usd) AS cost FROM hawa.call_cost_attestations a
      WHERE a.tenant_id=v.tenant_id AND a.call_kind='voice' AND a.call_id=v.id) a ON true
    WHERE v.tenant_id=tid AND v.source_account_id='lifecycle_voice_attempt' AND v.event_kind='lifecycle_voice_attempt'

    UNION ALL
    SELECT NULL::uuid,'health_probe',(c.started_at AT TIME ZONE 'Asia/Baghdad')::date,
      greatest(coalesce(c.cost_usd,0),coalesce(a.cost,0)),(c.reservation->>'usd')::numeric,
      NOT c.reconciliation_required OR a.cost IS NOT NULL
    FROM hawa.paid_model_probe_calls c
    LEFT JOIN LATERAL (SELECT max(a.reported_cost_usd) AS cost FROM hawa.call_cost_attestations a
      WHERE a.tenant_id=c.tenant_id AND a.call_kind='health_probe' AND a.call_id=c.id) a ON true
    WHERE c.tenant_id=tid
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

CREATE FUNCTION hawa.enforce_paid_probe() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hawa AS $$
DECLARE usage jsonb; prior hawa.paid_model_probe_calls%ROWTYPE; amount numeric;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Paid probe calls are immutable'; END IF;
  IF current_setting('transaction_isolation')<>'read committed' OR NEW.tenant_id IS DISTINCT FROM hawa.current_tenant_id() THEN
    RAISE EXCEPTION 'PAID_PROBE_INVALID'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('studio-spending:'||NEW.tenant_id::text,0));
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'started' OR NEW.finished_at IS NOT NULL OR NOT NEW.reconciliation_required
      OR NEW.probe_status IS NOT NULL OR NEW.acceptance IS NOT NULL OR NEW.cost_usd IS NOT NULL
      OR NEW.cost_basis IS NOT NULL OR NEW.response_id IS NOT NULL OR NEW.served_model IS NOT NULL
      OR NEW.provider_request_id IS NOT NULL OR NEW.response_sha256 IS NOT NULL OR NEW.latency_ms IS NOT NULL
      OR NEW.input_tokens IS NOT NULL OR NEW.output_tokens IS NOT NULL THEN RAISE EXCEPTION 'PAID_PROBE_INVALID'; END IF;
    amount=hawa.office_known_usd(NEW.reservation->'usd');
    IF jsonb_typeof(NEW.reservation) IS DISTINCT FROM 'object' OR amount IS NULL OR amount<=0
      OR NEW.reservation->>'requestSha256' IS NULL OR NEW.reservation->>'requestSha256' !~ '^[a-f0-9]{64}$'
      OR NEW.reservation->>'version' IS DISTINCT FROM '1' OR NEW.reservation->>'policy' IS NULL
      OR hawa.office_known_usd(NEW.reservation->'inputTokens') IS NULL
      OR NEW.reservation->>'outputTokens' IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'PAID_PROBE_INVALID'; END IF;
    IF EXISTS(SELECT 1 FROM hawa.paid_model_probe_calls c WHERE c.tenant_id=NEW.tenant_id AND c.reconciliation_required
      AND NOT EXISTS(SELECT 1 FROM hawa.call_cost_attestations a WHERE a.tenant_id=c.tenant_id AND a.call_kind='health_probe' AND a.call_id=c.id)) THEN
      RAISE EXCEPTION 'PAID_PROBE_RECONCILIATION_REQUIRED'; END IF;
    SELECT * INTO prior FROM hawa.paid_model_probe_calls WHERE tenant_id=NEW.tenant_id ORDER BY started_at DESC,id DESC LIMIT 1;
    IF FOUND AND clock_timestamp()<prior.started_at+make_interval(secs=>greatest(prior.interval_ms,NEW.interval_ms)/1000.0) THEN
      RAISE EXCEPTION 'PAID_PROBE_NOT_DUE'; END IF;
    usage=hawa.admit_office_spending(NEW.tenant_id,NULL,'health_probe',amount);
    NEW.spending_policy_version=(usage->>'policyVersion')::integer;
    NEW.started_at=clock_timestamp();
  ELSE
    IF OLD.status<>'started' OR NEW.status<>'completed' OR NEW.probe_status IS NULL OR NEW.acceptance IS NULL
      OR NEW.cost_basis IS NULL OR NEW.latency_ms IS NULL OR
      (to_jsonb(NEW)-ARRAY['status','finished_at','probe_status','acceptance','cost_basis','cost_usd','reconciliation_required','input_tokens','output_tokens','provider_request_id','response_id','served_model','response_sha256','latency_ms']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['status','finished_at','probe_status','acceptance','cost_basis','cost_usd','reconciliation_required','input_tokens','output_tokens','provider_request_id','response_id','served_model','response_sha256','latency_ms']) THEN
      RAISE EXCEPTION 'Paid probe identity and completed outcomes are immutable'; END IF;
    IF NEW.cost_basis='usage' AND (NEW.acceptance<>'response_received' OR NEW.input_tokens IS NULL OR NEW.output_tokens IS NULL OR NEW.cost_usd IS NULL) THEN
      RAISE EXCEPTION 'PAID_PROBE_INVALID'; END IF;
    IF NEW.cost_basis='not_accepted' AND (NEW.acceptance<>'not_accepted' OR NEW.cost_usd IS DISTINCT FROM 0) THEN
      RAISE EXCEPTION 'PAID_PROBE_INVALID'; END IF;
    IF NOT NEW.reconciliation_required AND NEW.cost_basis NOT IN ('usage','not_accepted') THEN RAISE EXCEPTION 'PAID_PROBE_INVALID'; END IF;
    IF NEW.probe_status='connected' AND (NEW.acceptance<>'response_received' OR NEW.cost_basis<>'usage'
      OR NEW.reconciliation_required OR NEW.response_id IS NULL OR NEW.served_model IS NULL
      OR NEW.input_tokens+NEW.output_tokens<=0) THEN RAISE EXCEPTION 'PAID_PROBE_INVALID'; END IF;
    IF NEW.acceptance='unknown' AND NOT NEW.reconciliation_required THEN RAISE EXCEPTION 'PAID_PROBE_INVALID'; END IF;
    NEW.finished_at=clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enforce_paid_probe BEFORE INSERT OR UPDATE OR DELETE ON hawa.paid_model_probe_calls
  FOR EACH ROW EXECUTE FUNCTION hawa.enforce_paid_probe();
COMMIT;
