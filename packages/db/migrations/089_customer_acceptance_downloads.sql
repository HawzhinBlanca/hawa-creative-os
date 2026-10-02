-- ADR266: independent customer acceptance; never a staff approval or office delivery.
BEGIN;
ALTER TABLE hawa.customer_web_actions DROP CONSTRAINT customer_web_actions_kind_check;
ALTER TABLE hawa.customer_web_actions ADD CHECK(kind IN ('revise','answer','seen','cancel','accept'));
CREATE TABLE hawa.customer_acceptances (
 tenant_id uuid NOT NULL,action_id uuid NOT NULL,request_id uuid NOT NULL,account_id uuid NOT NULL,
 subject uuid NOT NULL,user_id uuid NOT NULL,task_id uuid NOT NULL,accepted_rev bigint NOT NULL CHECK(accepted_rev>1),
 basis jsonb NOT NULL,basis_hash text NOT NULL CHECK(basis_hash ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,action_id),UNIQUE(tenant_id,request_id,accepted_rev),
 FOREIGN KEY(tenant_id,action_id) REFERENCES hawa.customer_web_actions(tenant_id,id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES hawa.customer_web_requests(tenant_id,request_id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES hawa.customer_accounts(tenant_id,id)
);
ALTER TABLE hawa.customer_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.customer_acceptances FORCE ROW LEVEL SECURITY;
CREATE TRIGGER customer_acceptance_immutable BEFORE UPDATE OR DELETE ON hawa.customer_acceptances
 FOR EACH ROW EXECUTE FUNCTION hawa.forbid_update_delete();
CREATE POLICY customer_acceptance_read ON hawa.customer_acceptances FOR SELECT TO hawa_app USING(
 tenant_id=hawa.current_tenant_id() AND ((hawa.current_customer_id() IS NULL AND
 (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator']::hawa.membership_role[]))) OR
 (account_id=hawa.current_customer_id() AND hawa.customer_owns_web_request(request_id))));
CREATE POLICY customer_acceptance_record ON hawa.customer_acceptances FOR INSERT TO hawa_app WITH CHECK(
 tenant_id=hawa.current_tenant_id() AND hawa.current_customer_id() IS NULL AND
 (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator']::hawa.membership_role[])) AND
 EXISTS(SELECT 1 FROM hawa.customer_web_actions a JOIN hawa.requests r ON r.tenant_id=a.tenant_id AND r.request_id=a.request_id
 WHERE a.tenant_id=customer_acceptances.tenant_id AND a.id=action_id AND a.kind='accept' AND a.request_id=customer_acceptances.request_id
 AND a.account_id=customer_acceptances.account_id AND a.subject=customer_acceptances.subject AND a.user_id=customer_acceptances.user_id
 AND a.task_id=customer_acceptances.task_id AND a.expected_rev+1=accepted_rev AND r.rev=accepted_rev
 AND r.owner='restate' AND r.stage='in_review' AND r.current_task_id=a.task_id
 AND basis->>'requestVersion'=a.expected_rev::text AND basis->>'taskId'=a.task_id::text AND basis_hash=a.body->>'basisSha256'));
GRANT SELECT,INSERT ON hawa.customer_acceptances TO hawa_app;
CREATE FUNCTION hawa.customer_native_review_for_action(rid uuid, capture uuid, wanted_rev bigint, expected_hash text, with_bytes boolean, allowed_action uuid)
RETURNS TABLE(basis jsonb, png bytea, pptx bytea, source bytea)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p record; w hawa.customer_web_requests%ROWTYPE; r hawa.requests%ROWTYPE;
 t hawa.tasks%ROWTYPE; b hawa.canva_bindings%ROWTYPE; x record; s record; q record; dna record; creation jsonb;
BEGIN
 -- Reuse the preview boundary's live subject, account, grant and current-row locks.
 SELECT * INTO p FROM hawa.customer_current_preview(rid,NULL,NULL,NULL);
 IF NOT FOUND OR p.id IS DISTINCT FROM capture OR p.request_rev IS DISTINCT FROM wanted_rev OR p.sha256 IS DISTINCT FROM expected_hash THEN RETURN; END IF;
 SELECT * INTO w FROM hawa.customer_web_requests a WHERE a.tenant_id=hawa.current_tenant_id()
 AND a.request_id=rid AND a.account_id=hawa.current_customer_id();
 SELECT * INTO r FROM hawa.requests a WHERE a.tenant_id=w.tenant_id AND a.request_id=rid;
 SELECT * INTO t FROM hawa.tasks a WHERE a.tenant_id=w.tenant_id AND a.id=r.current_task_id;
 IF allowed_action IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hawa.customer_web_actions a
 WHERE a.tenant_id=w.tenant_id AND a.id=allowed_action AND a.request_id=rid AND a.account_id=w.account_id
 AND a.subject=NULLIF(current_setting('hawa.customer_subject',true),'')::uuid AND a.user_id=hawa.current_user_id()
 AND a.task_id=t.id AND a.expected_rev=r.rev AND a.kind='accept' AND a.body->>'previewId'=capture::text
 AND a.body->>'previewSha256'=expected_hash AND (a.body->>'expectedVersion')::bigint=wanted_rev) THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM hawa.customer_web_actions a WHERE a.tenant_id=w.tenant_id AND a.request_id=rid
 AND (allowed_action IS NULL OR a.id<>allowed_action)
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
REVOKE ALL ON FUNCTION hawa.customer_native_review_for_action(uuid,uuid,bigint,text,boolean,uuid) FROM PUBLIC,hawa_worker;
GRANT EXECUTE ON FUNCTION hawa.customer_native_review_for_action(uuid,uuid,bigint,text,boolean,uuid) TO hawa_app;
CREATE OR REPLACE FUNCTION hawa.customer_native_review(rid uuid,capture uuid,expected_rev bigint,expected_hash text,with_bytes boolean)
RETURNS TABLE(basis jsonb,png bytea,pptx bytea,source bytea)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT * FROM hawa.customer_native_review_for_action(rid,capture,expected_rev,expected_hash,with_bytes,NULL);
$$;
CREATE FUNCTION hawa.customer_current_acceptance(rid uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a hawa.customer_acceptances%ROWTYPE; b jsonb;
BEGIN
 IF NOT hawa.customer_owns_web_request(rid) THEN RETURN NULL; END IF;
 SELECT x.* INTO a FROM hawa.customer_acceptances x JOIN hawa.requests r ON r.tenant_id=x.tenant_id AND r.request_id=x.request_id
 WHERE x.tenant_id=hawa.current_tenant_id() AND x.request_id=rid AND x.account_id=hawa.current_customer_id()
 AND r.rev=x.accepted_rev AND r.current_task_id=x.task_id AND r.stage='in_review'
 AND EXISTS(SELECT 1 FROM hawa.customer_web_action_events e WHERE e.tenant_id=x.tenant_id AND e.action_id=x.action_id AND e.phase='applied');
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT n.basis INTO b FROM hawa.customer_native_review(rid,(a.basis->'preview'->>'id')::uuid,a.accepted_rev,a.basis->'preview'->>'sha256',false) n;
 IF NOT FOUND OR (b-'requestVersion') IS DISTINCT FROM (a.basis-'requestVersion') THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('id',a.action_id,'requestVersion',a.accepted_rev,'acceptedAt',a.created_at,
 'previewId',a.basis->'preview'->>'id','previewSha256',a.basis->'preview'->>'sha256','basisSha256',a.basis_hash,
 'files',jsonb_build_array(a.basis->'preview'||jsonb_build_object('format','png'),
 jsonb_build_object('id',a.basis->'export'->>'id','sha256',a.basis->'export'->>'sha256','size',a.basis->'export'->'size','format','pptx')));
END $$;
REVOKE ALL ON FUNCTION hawa.customer_current_acceptance(uuid) FROM PUBLIC,hawa_worker;
GRANT EXECUTE ON FUNCTION hawa.customer_current_acceptance(uuid) TO hawa_app;
CREATE OR REPLACE FUNCTION hawa.customer_job_counts() RETURNS TABLE(daily integer,concurrent integer)
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF hawa.current_customer_id() IS DISTINCT FROM hawa.customer_account_for_subject() OR hawa.current_customer_id() IS NULL THEN
  RAISE EXCEPTION 'Customer access denied' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT count(*) FILTER(WHERE w.created_at>=now()-interval '24 hours')::integer,
 count(*) FILTER(WHERE (r.stage IS NULL OR r.stage NOT IN ('cancelled','delivered','rejected','expired'))
 AND hawa.customer_current_acceptance(w.request_id) IS NULL)::integer
 FROM hawa.customer_web_requests w LEFT JOIN hawa.requests r ON r.tenant_id=w.tenant_id AND r.request_id=w.request_id
 WHERE w.tenant_id=hawa.current_tenant_id() AND w.account_id=hawa.current_customer_id();
END $$;
COMMIT;
