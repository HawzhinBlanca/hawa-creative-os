-- ADR-164: exact call costs can be attested by the verified shared office.
-- Original call evidence, expiry accounting and execution uncertainty remain unchanged.
BEGIN;
ALTER TABLE hawa.call_cost_attestations DROP CONSTRAINT call_cost_attestations_evidence_type_check;
ALTER TABLE hawa.call_cost_attestations ADD CONSTRAINT call_cost_attestations_evidence_type_check
  CHECK(evidence_type IN ('administrator_attestation','trusted_office_attestation','reservation_expiry'));

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
  ELSIF NEW.evidence_type='trusted_office_attestation' THEN
    IF NEW.conclusion='reservation_charged'
      OR current_setting('hawa.call_cost_auth',true) IS DISTINCT FROM 'trusted_office'
      OR NEW.actor_user_id<>'00000000-0000-4000-b000-000000000002'::uuid
      OR NOT hawa.has_tenant_role(NEW.tenant_id,ARRAY['administrator']::hawa.membership_role[]) THEN
      RAISE EXCEPTION 'CALL_COST_OFFICE_ADMINISTRATOR_REQUIRED' USING ERRCODE='42501';
    END IF;
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
    'evidenceReference',a.evidence_reference,'evidenceSha256',a.evidence_sha256,
    'evidenceType',a.evidence_type,'actorLabel',CASE WHEN a.evidence_type='trusted_office_attestation' THEN 'Office team'
      WHEN a.evidence_type='reservation_expiry' THEN 'System Automation' ELSE NULL END) ORDER BY a.revision),'[]'::jsonb),
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


COMMIT;
