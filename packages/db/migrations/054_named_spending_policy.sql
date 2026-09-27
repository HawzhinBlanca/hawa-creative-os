-- ADR-098: extend immutable owner policies with narrowly authorized named revisions.
BEGIN;
ALTER TABLE hawa.studio_spending_policies ADD COLUMN actor_user_id uuid REFERENCES hawa.users(id);
ALTER TABLE hawa.studio_spending_policies ADD COLUMN request_sha256 text CHECK(request_sha256 ~ '^[a-f0-9]{64}$');
ALTER TABLE hawa.studio_spending_policies ADD CONSTRAINT spending_policy_actor_request
  CHECK((actor_user_id IS NULL) = (request_sha256 IS NULL));

CREATE FUNCTION hawa.spending_policy_view(p hawa.studio_spending_policies) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('version',p.version,'limits',p.limits,'limitsSha256',p.limits_sha256,
    'reason',p.reason,'actionId',p.action_id,'actorUserId',p.actor_user_id,
    'recordedBy',p.recorded_by,'recordedAt',p.recorded_at)
$$;
REVOKE ALL ON FUNCTION hawa.spending_policy_view(hawa.studio_spending_policies) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.spending_policy_view(hawa.studio_spending_policies) TO hawa_app;

CREATE FUNCTION hawa.record_spending_policy(p_action uuid,p_user uuid,p_session text,p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hawa AS $$
DECLARE tid uuid=hawa.current_tenant_id(); previous hawa.studio_spending_policies%ROWTYPE;
  result hawa.studio_spending_policies%ROWTYPE; digest text; body jsonb;
BEGIN
  IF tid IS NULL OR p_user IS DISTINCT FROM hawa.current_user_id() OR
    NOT EXISTS(SELECT 1 FROM hawa.lock_named_office_administrator(tid,p_session,p_user)) THEN
    RAISE EXCEPTION 'SPENDING_POLICY_NAMED_ADMINISTRATOR_REQUIRED' USING ERRCODE='42501';
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' OR p_action IS NULL OR
    jsonb_typeof(p_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'SPENDING_POLICY_INVALID'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_body))<>4 OR
    NOT(p_body ?& ARRAY['expectedVersion','expectedLimitsSha256','reason','limits']) OR
    jsonb_typeof(p_body->'expectedVersion') IS DISTINCT FROM 'number' OR
    jsonb_typeof(p_body->'expectedLimitsSha256') IS DISTINCT FROM 'string' OR
    jsonb_typeof(p_body->'reason') IS DISTINCT FROM 'string' OR
    jsonb_typeof(p_body->'limits') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'SPENDING_POLICY_INVALID'; END IF;
  IF (p_body->>'expectedVersion')::numeric NOT BETWEEN 1 AND 2147483646 OR
    (p_body->>'expectedVersion')::numeric<>trunc((p_body->>'expectedVersion')::numeric) OR
    p_body->>'expectedLimitsSha256' !~ '^[a-f0-9]{64}$' OR
    length(trim(p_body->>'reason')) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'SPENDING_POLICY_INVALID'; END IF;
  IF jsonb_typeof(p_body#>'{limits,clients}') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'SPENDING_POLICY_INVALID'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_body#>'{limits,clients}'))>1000 THEN RAISE EXCEPTION 'SPENDING_POLICY_INVALID'; END IF;
  body=jsonb_set(p_body,'{reason}',to_jsonb(trim(p_body->>'reason')));
  digest=encode(sha256(convert_to(jsonb_build_array(p_user,body)::text,'UTF8')),'hex');
  -- Use the same lock as new paid admissions; never hold it during provider transport.
  PERFORM pg_advisory_xact_lock(hashtextextended('studio-spending:'||tid::text,0));
  SELECT * INTO result FROM hawa.studio_spending_policies WHERE tenant_id=tid AND action_id=p_action;
  IF FOUND THEN
    IF result.request_sha256 IS DISTINCT FROM digest THEN RAISE EXCEPTION 'SPENDING_POLICY_ACTION_CONFLICT'; END IF;
    RETURN jsonb_build_object('replayed',true,'receipt',hawa.spending_policy_view(result));
  END IF;
  SELECT * INTO previous FROM hawa.studio_spending_policies WHERE tenant_id=tid ORDER BY version DESC LIMIT 1;
  IF NOT FOUND OR previous.version<>(body->>'expectedVersion')::integer OR
    previous.limits_sha256 IS DISTINCT FROM body->>'expectedLimitsSha256' THEN RAISE EXCEPTION 'SPENDING_POLICY_CHANGED'; END IF;
  -- Existing trigger independently validates limits, office/client ownership, sequential
  -- revisions and role allowlist; it stamps time, connection identity and limits hash.
  INSERT INTO hawa.studio_spending_policies(tenant_id,version,action_id,reason,limits,actor_user_id,request_sha256)
    VALUES(tid,previous.version+1,p_action,body->>'reason',body->'limits',p_user,digest) RETURNING * INTO result;
  RETURN jsonb_build_object('replayed',false,'receipt',hawa.spending_policy_view(result));
END $$;
REVOKE ALL ON FUNCTION hawa.record_spending_policy(uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.record_spending_policy(uuid,uuid,text,jsonb) TO hawa_app;
-- Keep table mutation rights unavailable; the named SQL entry point is the only runtime writer.
REVOKE INSERT,UPDATE,DELETE ON hawa.studio_spending_policies FROM hawa_app;
COMMIT;
