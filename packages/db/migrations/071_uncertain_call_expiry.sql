-- ADR-159: Studio and planner calls with no provider outcome stop blocking their task and holding
-- their reservation on every later office day. Three kinds of evidence may now settle a Studio run:
-- a named administrator's (unchanged), the trusted office team's (ADR-146: the shared office
-- administrator, no individual sign-in) and System Automation's charge of the whole reservation once
-- a call has had no outcome for hours. Planner calls get the same automatic charge as an attestation.
-- Price-list costs are final; estimates are final once their run has stopped.
BEGIN;
ALTER TABLE hawa.design_studio_calls DROP CONSTRAINT design_studio_calls_cost_basis_check;
ALTER TABLE hawa.design_studio_calls ADD CONSTRAINT design_studio_calls_cost_basis_check
  CHECK (cost_basis IN ('usage','estimate','unavailable','not_accepted','price_list'));

ALTER TABLE hawa.studio_run_settlements ADD COLUMN evidence_type text NOT NULL DEFAULT 'administrator_attestation'
  CHECK(evidence_type IN ('administrator_attestation','trusted_office_attestation','reservation_expiry'));
CREATE POLICY studio_settlements_expiry_insert ON hawa.studio_run_settlements FOR INSERT WITH CHECK
  (tenant_id=hawa.current_tenant_id() AND evidence_type='reservation_expiry' AND actor_user_id=hawa.current_user_id()
   AND actor_user_id='00000000-0000-4000-b000-000000000011'::uuid);

ALTER TABLE hawa.call_cost_attestations ADD COLUMN evidence_type text NOT NULL DEFAULT 'administrator_attestation'
  CHECK(evidence_type IN ('administrator_attestation','reservation_expiry'));
ALTER TABLE hawa.call_cost_attestations DROP CONSTRAINT call_cost_attestations_conclusion_check;
ALTER TABLE hawa.call_cost_attestations ADD CONSTRAINT call_cost_attestations_conclusion_check
  CHECK(conclusion IN ('provider_finished','provider_not_accepted','reservation_charged'));
CREATE POLICY call_cost_expiry_insert ON hawa.call_cost_attestations FOR INSERT WITH CHECK
  (tenant_id=hawa.current_tenant_id() AND evidence_type='reservation_expiry' AND actor_user_id=hawa.current_user_id()
   AND actor_user_id='00000000-0000-4000-b000-000000000011'::uuid);

CREATE OR REPLACE FUNCTION hawa.protect_studio_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry jsonb; unresolved_count integer; run_row hawa.design_studio_runs%ROWTYPE; call_row hawa.design_studio_calls%ROWTYPE;
  charged text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Studio settlements are immutable'; END IF;
  IF NEW.evidence_type='administrator_attestation' THEN
    IF NOT EXISTS (SELECT 1 FROM hawa.lock_named_office_administrator(NEW.tenant_id,
      current_setting('hawa.studio_settlement_session_hash',true),NEW.actor_user_id)) THEN
      RAISE EXCEPTION 'Named administrator session required for Studio settlement';
    END IF;
  ELSIF NEW.evidence_type='trusted_office_attestation' THEN
    -- The office team acts as the office administrator without signing in (ADR-146). Core sets the
    -- marker only for a request its trusted-office policy admitted; the actor is the shared account.
    IF current_setting('hawa.studio_settlement_auth',true) IS DISTINCT FROM 'trusted_office'
      OR NEW.actor_user_id IS DISTINCT FROM hawa.current_user_id()
      OR NOT hawa.has_tenant_role(NEW.tenant_id,ARRAY['administrator']::hawa.membership_role[]) THEN
      RAISE EXCEPTION 'Trusted office administrator required for Studio settlement';
    END IF;
  ELSIF NEW.evidence_type='reservation_expiry' THEN
    IF NEW.actor_user_id IS DISTINCT FROM hawa.current_user_id()
      OR NEW.actor_user_id<>'00000000-0000-4000-b000-000000000011'::uuid THEN
      RAISE EXCEPTION 'Only System Automation charges an expired reservation';
    END IF;
  ELSE RAISE EXCEPTION 'Unknown Studio settlement evidence';
  END IF;
  charged=CASE WHEN NEW.evidence_type='reservation_expiry' THEN 'reservation_charged' END;
  PERFORM 1 FROM hawa.tasks WHERE tenant_id=NEW.tenant_id AND id=NEW.task_id AND client_id=NEW.client_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Studio settlement task scope mismatch'; END IF;
  SELECT * INTO run_row FROM hawa.design_studio_runs WHERE tenant_id=NEW.tenant_id AND id=NEW.run_id FOR UPDATE;
  IF NOT FOUND OR run_row.task_id<>NEW.task_id OR run_row.client_id<>NEW.client_id THEN
    RAISE EXCEPTION 'Studio settlement run scope mismatch';
  END IF;
  IF run_row.status NOT IN ('abandoned','failed','degraded','transferred') THEN
    RAISE EXCEPTION 'Stop the Studio run through its owner before settlement';
  END IF;
  PERFORM 1 FROM hawa.design_studio_calls WHERE tenant_id=NEW.tenant_id AND run_id=NEW.run_id FOR UPDATE;
  SELECT count(*) INTO unresolved_count FROM hawa.design_studio_calls c
    WHERE c.tenant_id=NEW.tenant_id AND c.run_id=NEW.run_id AND c.status='uncertain'
      AND NOT EXISTS(SELECT 1 FROM hawa.studio_run_settlements s WHERE s.tenant_id=c.tenant_id AND s.run_id=c.run_id
        AND s.calls @> jsonb_build_array(jsonb_build_object('callId',c.id::text)));
  IF unresolved_count=0 OR jsonb_array_length(NEW.calls)<>unresolved_count OR
    (SELECT count(DISTINCT e->>'callId') FROM jsonb_array_elements(NEW.calls) e)<>unresolved_count THEN
    RAISE EXCEPTION 'Settlement must cover every unresolved Studio call exactly once';
  END IF;
  FOR entry IN SELECT * FROM jsonb_array_elements(NEW.calls) LOOP
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR
      NOT (entry ?& ARRAY['callId','conclusion','reportedCostUsd','evidenceReference','evidenceSha256']) OR
      jsonb_typeof(entry->'conclusion') IS DISTINCT FROM 'string' OR
      (charged IS NULL AND entry->>'conclusion' NOT IN ('provider_not_accepted','provider_finished')) OR
      (charged IS NOT NULL AND entry->>'conclusion' IS DISTINCT FROM charged) OR
      jsonb_typeof(entry->'reportedCostUsd') IS DISTINCT FROM 'number' OR
      (entry->>'reportedCostUsd')::numeric NOT BETWEEN 0 AND 1000000 OR
      (entry->>'conclusion'='provider_not_accepted' AND (entry->>'reportedCostUsd')::numeric<>0) OR
      jsonb_typeof(entry->'evidenceReference') IS DISTINCT FROM 'string' OR
      NOT (entry->>'evidenceReference' ~ '^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$') OR
      jsonb_typeof(entry->'evidenceSha256') IS DISTINCT FROM 'string' OR
      NOT (entry->>'evidenceSha256' ~ '^[a-f0-9]{64}$') OR
      NOT EXISTS(SELECT 1 FROM hawa.design_studio_calls c WHERE c.tenant_id=NEW.tenant_id AND c.run_id=NEW.run_id
        AND c.id::text=entry->>'callId' AND c.status='uncertain' AND NOT EXISTS(
          SELECT 1 FROM hawa.studio_run_settlements s WHERE s.tenant_id=c.tenant_id AND s.run_id=c.run_id
            AND s.calls @> jsonb_build_array(jsonb_build_object('callId',c.id::text)))) THEN
      RAISE EXCEPTION 'Terminal provider evidence and known cost required for unresolved Studio calls';
    END IF;
    IF charged IS NOT NULL THEN
      -- Charged no less than its whole reservation, and only after an hour without an outcome.
      SELECT * INTO call_row FROM hawa.design_studio_calls WHERE tenant_id=NEW.tenant_id AND id=(entry->>'callId')::uuid;
      IF call_row.reservation IS NULL OR call_row.started_at>clock_timestamp()-interval '1 hour' OR
        (entry->>'reportedCostUsd')::numeric<greatest(call_row.usd_estimate,(call_row.reservation->>'usd')::numeric) THEN
        RAISE EXCEPTION 'An expired reservation is charged in full, and only after an hour';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION hawa.protect_call_cost_attestation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hawa AS $$
DECLARE source jsonb; parent_id uuid; source_key text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Call cost attestations are immutable'; END IF;
  IF NEW.tenant_id IS DISTINCT FROM hawa.current_tenant_id() OR NEW.actor_user_id IS DISTINCT FROM hawa.current_user_id() THEN
    RAISE EXCEPTION 'CALL_COST_NAMED_ADMINISTRATOR_REQUIRED' USING ERRCODE='42501';
  END IF;
  -- ADR-159: a planner call with no outcome is charged its whole reservation by System Automation
  -- once it is old enough; every other attestation is a named administrator's.
  IF NEW.evidence_type='reservation_expiry' THEN
    IF NEW.actor_user_id<>'00000000-0000-4000-b000-000000000011'::uuid OR NEW.conclusion<>'reservation_charged'
      OR NEW.call_kind<>'canva_planner' THEN RAISE EXCEPTION 'CALL_COST_EXPIRY_INVALID'; END IF;
  ELSIF NEW.conclusion='reservation_charged' OR NOT EXISTS(SELECT 1 FROM hawa.lock_named_office_administrator(NEW.tenant_id,
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
  ELSIF NEW.call_kind='canva_planner' THEN
    SELECT task_id INTO parent_id FROM hawa.canva_design_plans WHERE tenant_id=NEW.tenant_id AND id=NEW.call_id;
    PERFORM 1 FROM hawa.tasks WHERE tenant_id=NEW.tenant_id AND id=parent_id FOR UPDATE;
    PERFORM 1 FROM hawa.canva_design_plans WHERE tenant_id=NEW.tenant_id AND id=NEW.call_id FOR UPDATE;
    PERFORM 1 FROM hawa.canva_planner_calls WHERE tenant_id=NEW.tenant_id AND id=NEW.call_id FOR UPDATE;
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
  IF NEW.evidence_type='reservation_expiry' AND (NOT (source->>'requiresCostEvidence')::boolean
    OR (source->>'reservedUsd') IS NULL
    OR NEW.reported_cost_usd<greatest((source->>'reservedUsd')::numeric,(source->>'accountedCostUsd')::numeric)
    OR (source->>'startedAt')::timestamptz>clock_timestamp()-interval '1 hour') THEN
    RAISE EXCEPTION 'CALL_COST_EXPIRY_INVALID';
  END IF;
  IF NEW.conclusion='provider_not_accepted' AND ((source->>'originalAccepted')::boolean OR (source->>'accountedCostUsd')::numeric>0) THEN
    RAISE EXCEPTION 'CALL_COST_CONTRADICTORY_EVIDENCE';
  END IF;
  NEW.recorded_at=clock_timestamp();
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
    final=src->>'status'<>'uncertain' AND (src->>'cost_basis' IN ('usage','not_accepted','price_list') OR src->>'reservation' IS NULL
      OR (src->>'cost_basis'='estimate' AND EXISTS(SELECT 1 FROM hawa.design_studio_runs r WHERE r.tenant_id=tid
        AND r.id=(src->>'run_id')::uuid AND r.status IN ('transferred','degraded','failed','abandoned'))));
    -- ADR-159: the office day charges a closed zero estimate its whole reservation; show the same.
    IF final AND src->>'cost_basis'='estimate' AND original=0 THEN original=reserved; END IF;
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
  ELSIF kind='canva_planner' THEN
    SELECT coalesce(to_jsonb(c),jsonb_build_object('legacyPlanId',p.id,'legacyStatus',p.status)),
      jsonb_build_object('clientId',p.client_id,'taskId',p.task_id,'runId',NULL,
        'provider','openai','model',coalesce(c.served_model,c.model,p.request->>'model'),
        'status',coalesce(c.status,'history_incomplete'),'startedAt',coalesce(c.started_at,p.created_at),
        'providerRequestId',c.provider_request_id,'responseId',c.response_id,'costBasis',c.cost_basis)
      INTO src,meta FROM hawa.canva_design_plans p LEFT JOIN hawa.canva_planner_calls c ON c.id=p.id AND c.tenant_id=p.tenant_id
      WHERE p.tenant_id=tid AND p.id=call_id AND (c.id IS NOT NULL OR p.paid_protocol IS NULL);
    original=hawa.office_known_usd(src->'cost_usd'); reserved=hawa.office_known_usd(src#>'{reservation,usd}');
    accepted=src->>'acceptance'='response_received' OR EXISTS(SELECT 1 FROM hawa.canva_design_plans p
      WHERE p.tenant_id=tid AND p.id=call_id AND p.result#>>'{receipt,responseId}' IS NOT NULL);
    final=src->>'reconciliation_required'='false';
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
      -- ADR-159: an estimate is final once its run has stopped, at the estimate (or at the whole
      -- reservation when the estimate is zero), so it no longer holds its reservation on later days.
      greatest(CASE WHEN c.cost_basis='estimate' AND c.status<>'uncertain' AND c.usd_estimate=0
          AND c.reservation IS NOT NULL AND r.status IN ('transferred','degraded','failed','abandoned') THEN (c.reservation->>'usd')::numeric
        ELSE c.usd_estimate END,coalesce(s.cost,0)) AS known,
      (c.reservation->>'usd')::numeric AS reserved,
      -- A published per-image price (Gemini images) is the charge itself, as final as usage.
      s.cost IS NOT NULL OR (c.status<>'uncertain' AND
        (c.cost_basis IN ('usage','not_accepted','price_list') OR c.reservation IS NULL OR
          (c.cost_basis='estimate' AND r.status IN ('transferred','degraded','failed','abandoned')))) AS final,
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
