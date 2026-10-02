-- ADR262. Narrow captured-native read; customer raw operational RLS stays closed.
BEGIN;
CREATE FUNCTION hawa.customer_current_preview(rid uuid, capture uuid, expected_rev bigint, expected_hash text)
RETURNS TABLE(id uuid, request_rev bigint, binding_version integer, sha256 text, byte_size integer, captured_at timestamptz, content bytea)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w hawa.customer_web_requests%ROWTYPE; r hawa.requests%ROWTYPE;
 b hawa.canva_bindings%ROWTYPE; a record;
BEGIN
 IF hawa.current_customer_id() IS NULL OR hawa.current_customer_id() IS DISTINCT FROM hawa.customer_account_for_subject() THEN
  RAISE EXCEPTION 'Customer access denied' USING ERRCODE='42501';
 END IF;
 SELECT * INTO w FROM hawa.customer_web_requests x WHERE x.tenant_id=hawa.current_tenant_id()
 AND x.request_id=rid AND x.account_id=hawa.current_customer_id()
 AND x.subject=NULLIF(current_setting('hawa.customer_subject',true),'')::uuid;
 IF NOT FOUND THEN RETURN; END IF;
 PERFORM hawa.lock_customer_request_access(w.client_id);
 SELECT * INTO r FROM hawa.requests x WHERE x.tenant_id=w.tenant_id AND x.request_id=w.request_id FOR SHARE;
 IF NOT FOUND THEN RETURN; END IF;
 PERFORM 1 FROM hawa.tasks t WHERE t.tenant_id=w.tenant_id AND t.id=r.current_task_id AND t.request_id=w.request_id
 AND t.client_id=w.client_id AND t.customer_account_id=w.account_id AND t.requested_by=hawa.current_user_id() FOR SHARE;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT * INTO b FROM hawa.canva_bindings x WHERE x.tenant_id=w.tenant_id AND x.task_id=r.current_task_id
 AND x.client_id=w.client_id AND x.direction_name='primary' AND x.status='bound' FOR SHARE;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT e.id,e.sha256,octet_length(e.content) AS byte_size,e.created_at,CASE WHEN capture IS NOT NULL THEN e.content ELSE NULL::bytea END AS bytes
 INTO a FROM hawa.canva_export_bytes e JOIN hawa.canva_remote_operations o
 ON o.id=e.operation_id AND o.tenant_id=e.tenant_id AND o.task_id=e.task_id AND o.client_id=e.client_id
 WHERE e.tenant_id=w.tenant_id AND e.task_id=r.current_task_id AND e.client_id=w.client_id AND e.format='png'
 AND o.kind='export' AND o.status='retrieved' AND o.design_id=b.canva_design_id AND o.binding_version=b.version
 AND length(COALESCE(o.metadata->>'designUpdatedAt',''))>0
 AND NOT EXISTS (SELECT 1 FROM hawa.canva_remote_operations newer
   WHERE newer.tenant_id=w.tenant_id AND newer.task_id=r.current_task_id AND newer.client_id=w.client_id
   AND newer.kind='export' AND newer.status='retrieved' AND newer.design_id=b.canva_design_id AND newer.binding_version=b.version
   AND newer.updated_at>o.updated_at AND newer.metadata->>'designUpdatedAt' IS DISTINCT FROM o.metadata->>'designUpdatedAt')
 ORDER BY e.created_at DESC,e.id DESC LIMIT 1 FOR SHARE OF o;
 IF NOT FOUND THEN RETURN; END IF;
 IF capture IS NOT NULL AND (capture<>a.id OR expected_rev IS DISTINCT FROM r.rev OR expected_hash IS DISTINCT FROM a.sha256) THEN RETURN; END IF;
 -- Metadata polls must not de-toast or return the image. Binary reads require all expected fields.
 RETURN QUERY SELECT a.id,r.rev,b.version,a.sha256,a.byte_size,a.created_at,
 CASE WHEN capture IS NOT NULL THEN a.bytes ELSE NULL::bytea END;
END $$;
REVOKE ALL ON FUNCTION hawa.customer_current_preview(uuid,uuid,bigint,text) FROM PUBLIC,hawa_worker;
GRANT EXECUTE ON FUNCTION hawa.customer_current_preview(uuid,uuid,bigint,text) TO hawa_app;
COMMIT;
