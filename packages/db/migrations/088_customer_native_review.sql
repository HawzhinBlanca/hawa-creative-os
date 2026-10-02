-- ADR265: server-only evidence for one owned, exactly reviewed native capture.
BEGIN;
CREATE FUNCTION hawa.customer_native_review(rid uuid, capture uuid, expected_rev bigint, expected_hash text, with_bytes boolean)
RETURNS TABLE(basis jsonb, png bytea, pptx bytea, source bytea)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p record; w hawa.customer_web_requests%ROWTYPE; r hawa.requests%ROWTYPE;
 t hawa.tasks%ROWTYPE; b hawa.canva_bindings%ROWTYPE; x record; s record; q record; dna record; creation jsonb;
BEGIN
 -- Reuse the preview boundary's live subject, account, grant and current-row locks.
 SELECT * INTO p FROM hawa.customer_current_preview(rid,NULL,NULL,NULL);
 IF NOT FOUND OR p.id IS DISTINCT FROM capture OR p.request_rev IS DISTINCT FROM expected_rev OR p.sha256 IS DISTINCT FROM expected_hash THEN RETURN; END IF;
 SELECT * INTO w FROM hawa.customer_web_requests a WHERE a.tenant_id=hawa.current_tenant_id()
 AND a.request_id=rid AND a.account_id=hawa.current_customer_id();
 SELECT * INTO r FROM hawa.requests a WHERE a.tenant_id=w.tenant_id AND a.request_id=rid;
 SELECT * INTO t FROM hawa.tasks a WHERE a.tenant_id=w.tenant_id AND a.id=r.current_task_id;
 IF EXISTS(SELECT 1 FROM hawa.customer_web_actions a WHERE a.tenant_id=w.tenant_id AND a.request_id=rid
 AND NOT EXISTS(SELECT 1 FROM hawa.customer_web_action_events e WHERE e.tenant_id=a.tenant_id AND e.action_id=a.id AND e.phase IN ('applied','refused'))) THEN RETURN; END IF;
 IF r.stage<>'in_review' OR t.state<>'human_review' OR t.current_design_revision_id IS NULL THEN RETURN; END IF;
 SELECT * INTO b FROM hawa.canva_bindings a WHERE a.tenant_id=w.tenant_id AND a.task_id=t.id
 AND a.client_id=w.client_id AND a.direction_name='primary' AND a.status='bound';
 SELECT e.id,e.sha256,e.content_check,octet_length(e.content) AS size,
   CASE WHEN with_bytes THEN e.content ELSE NULL::bytea END AS bytes,
   o.actor_id,o.metadata->>'designUpdatedAt' AS native_version,o.metadata->'checkingPolicy' AS policy,
   hawa.canva_export_policy_current(o.tenant_id,o.client_id,COALESCE(o.metadata,'{}'::jsonb)||jsonb_build_object('taskId',o.task_id)) AS policy_current
 INTO x FROM hawa.canva_export_bytes e JOIN hawa.canva_remote_operations o
 ON o.tenant_id=e.tenant_id AND o.id=e.operation_id AND o.task_id=e.task_id AND o.client_id=e.client_id
 JOIN hawa.canva_export_bytes pe ON pe.id=p.id AND pe.tenant_id=e.tenant_id
 JOIN hawa.canva_remote_operations po ON po.id=pe.operation_id AND po.tenant_id=pe.tenant_id
 WHERE e.tenant_id=w.tenant_id AND e.task_id=t.id AND e.client_id=w.client_id AND e.format='pptx'
 AND o.kind='export' AND o.status='retrieved' AND o.design_id=b.canva_design_id AND o.binding_version=b.version
 AND o.metadata->>'designUpdatedAt'=po.metadata->>'designUpdatedAt'
 ORDER BY e.created_at DESC,e.id DESC LIMIT 1 FOR SHARE OF o;
 IF NOT FOUND OR x.size>26214400 OR p.byte_size>26214400 THEN RETURN; END IF;
 SELECT e.id,e.sha256,e.manifest,octet_length(e.content) AS size,
   CASE WHEN with_bytes THEN e.content ELSE NULL::bytea END AS bytes
 INTO s FROM hawa.canva_editable_sources e JOIN hawa.canva_remote_operations o
 ON o.tenant_id=e.tenant_id AND o.id=e.operation_id AND o.task_id=e.task_id AND o.client_id=e.client_id
 WHERE e.tenant_id=w.tenant_id AND e.task_id=t.id AND e.client_id=w.client_id
 AND o.kind='create' AND o.design_id=b.canva_design_id
 ORDER BY e.created_at DESC,e.id DESC LIMIT 1;
 IF NOT FOUND OR s.size>26214400 THEN RETURN; END IF;
 SELECT a.id,a.status,a.critical_pass,a.report INTO q FROM hawa.qc_runs a
 WHERE a.tenant_id=w.tenant_id AND a.task_id=t.id AND a.design_revision_id=t.current_design_revision_id
 ORDER BY a.started_at DESC,a.id DESC LIMIT 1;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT a.data INTO creation FROM hawa.task_events a WHERE a.tenant_id=w.tenant_id AND a.task_id=t.id
 AND a.event_type='task.created' ORDER BY a.aggregate_version,a.id LIMIT 1;
 SELECT a.version,a.content_hash INTO dna FROM hawa.client_dna_versions a WHERE a.tenant_id=w.tenant_id
 AND a.client_id=w.client_id AND a.status='active' ORDER BY a.version DESC LIMIT 1 FOR SHARE;
 IF NOT FOUND THEN RETURN; END IF;
 RETURN QUERY SELECT jsonb_build_object('taskId',t.id,'requestVersion',r.rev,'revisionId',t.current_design_revision_id,
 'bindingId',b.id,'bindingVersion',b.version,'designId',b.canva_design_id,'actorId',x.actor_id,'nativeVersion',x.native_version,
 'preview',jsonb_build_object('id',p.id,'sha256',p.sha256,'size',p.byte_size),
 'export',jsonb_build_object('id',x.id,'sha256',x.sha256,'size',x.size,'contentCheck',x.content_check),
 'source',jsonb_build_object('id',s.id,'sha256',s.sha256,'size',s.size,'manifest',s.manifest),
 'qc',jsonb_build_object('id',q.id,'status',q.status,'criticalPass',q.critical_pass,'report',q.report),
 'dimensions',CASE w.body->>'variant' WHEN 'square' THEN jsonb_build_object('width',1080,'height',1080) WHEN 'portrait' THEN jsonb_build_object('width',1080,'height',1350) WHEN 'story' THEN jsonb_build_object('width',1080,'height',1920) END,
 'activeDna',jsonb_build_object('version',dna.version,'sha256',dna.content_hash),
 'policy',x.policy,'policyCurrent',x.policy_current,'creation',creation),
 CASE WHEN with_bytes THEN (SELECT e.content FROM hawa.canva_export_bytes e WHERE e.tenant_id=w.tenant_id AND e.id=p.id) ELSE NULL::bytea END,x.bytes,s.bytes;
END $$;
REVOKE ALL ON FUNCTION hawa.customer_native_review(uuid,uuid,bigint,text,boolean) FROM PUBLIC,hawa_worker;
GRANT EXECUTE ON FUNCTION hawa.customer_native_review(uuid,uuid,bigint,text,boolean) TO hawa_app;
COMMIT;
