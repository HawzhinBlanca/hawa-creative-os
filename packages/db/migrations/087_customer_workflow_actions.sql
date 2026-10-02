BEGIN;
CREATE TABLE hawa.customer_web_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,request_id uuid NOT NULL,
 account_id uuid NOT NULL,subject uuid NOT NULL,user_id uuid NOT NULL REFERENCES hawa.users(id),
 client_id uuid NOT NULL,task_id uuid NOT NULL,expected_rev bigint NOT NULL CHECK(expected_rev>0),
 action_key text NOT NULL,kind text NOT NULL CHECK(kind IN ('revise','answer','seen','cancel')),
 body jsonb NOT NULL,body_hash text NOT NULL CHECK(body_hash ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(account_id,action_key),UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES hawa.customer_web_requests(tenant_id,request_id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES hawa.customer_accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,task_id,client_id) REFERENCES hawa.tasks(tenant_id,id,client_id)
);
CREATE INDEX customer_action_history ON hawa.customer_web_actions(tenant_id,request_id,created_at DESC,id DESC);
CREATE TABLE hawa.customer_web_action_events (
 tenant_id uuid NOT NULL,action_id uuid NOT NULL,phase text NOT NULL CHECK(phase IN ('projected','refused','applied')),
 result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,action_id,phase),
 FOREIGN KEY(tenant_id,action_id) REFERENCES hawa.customer_web_actions(tenant_id,id)
);
ALTER TABLE hawa.customer_web_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.customer_web_actions FORCE ROW LEVEL SECURITY;
ALTER TABLE hawa.customer_web_action_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.customer_web_action_events FORCE ROW LEVEL SECURITY;
CREATE TRIGGER customer_action_immutable BEFORE UPDATE OR DELETE ON hawa.customer_web_actions FOR EACH ROW EXECUTE FUNCTION hawa.forbid_update_delete();
CREATE TRIGGER customer_action_event_immutable BEFORE UPDATE OR DELETE ON hawa.customer_web_action_events FOR EACH ROW EXECUTE FUNCTION hawa.forbid_update_delete();
CREATE POLICY customer_action_read ON hawa.customer_web_actions FOR SELECT USING(tenant_id=hawa.current_tenant_id() AND
 ((hawa.current_customer_id() IS NULL AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator']::hawa.membership_role[])))
 OR (account_id=hawa.current_customer_id() AND hawa.customer_owns_web_request(request_id))));
CREATE POLICY customer_action_create ON hawa.customer_web_actions FOR INSERT WITH CHECK(tenant_id=hawa.current_tenant_id()
 AND account_id=hawa.current_customer_id() AND account_id=hawa.customer_account_for_subject() AND user_id=hawa.current_user_id()
 AND subject=NULLIF(current_setting('hawa.customer_subject',true),'')::uuid AND hawa.customer_owns_web_request(request_id)
 AND EXISTS(SELECT 1 FROM hawa.customer_web_requests w WHERE w.tenant_id=customer_web_actions.tenant_id
 AND w.request_id=customer_web_actions.request_id AND w.client_id=customer_web_actions.client_id AND w.account_id=customer_web_actions.account_id));
CREATE POLICY customer_action_event_read ON hawa.customer_web_action_events FOR SELECT USING(tenant_id=hawa.current_tenant_id()
 AND EXISTS(SELECT 1 FROM hawa.customer_web_actions a WHERE a.tenant_id=customer_web_action_events.tenant_id AND a.id=action_id));
CREATE POLICY customer_action_event_create ON hawa.customer_web_action_events FOR INSERT WITH CHECK(tenant_id=hawa.current_tenant_id()
 AND hawa.current_customer_id() IS NULL AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator']::hawa.membership_role[]))
 AND EXISTS(SELECT 1 FROM hawa.customer_web_actions a WHERE a.tenant_id=customer_web_action_events.tenant_id AND a.id=action_id));
GRANT SELECT,INSERT ON hawa.customer_web_actions,hawa.customer_web_action_events TO hawa_app;
CREATE POLICY customer_action_outbox_create ON hawa.outbox_commands FOR INSERT WITH CHECK(tenant_id=hawa.current_tenant_id()
 AND command_type='customer.request.action' AND aggregate_type='request' AND state='pending'
 AND EXISTS(SELECT 1 FROM hawa.customer_web_actions a WHERE a.tenant_id=outbox_commands.tenant_id AND a.request_id=aggregate_id
 AND a.account_id=hawa.current_customer_id() AND payload=jsonb_build_object('v',1,'requestId',a.request_id::text,'accountId',a.account_id::text,'actionId',a.id::text)));
CREATE FUNCTION hawa.customer_action_basis(rid uuid) RETURNS TABLE(task_id uuid,request_rev bigint,stage text,automatic boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w hawa.customer_web_requests%ROWTYPE;r hawa.requests%ROWTYPE;
BEGIN
 IF hawa.current_customer_id() IS NULL OR hawa.current_customer_id() IS DISTINCT FROM hawa.customer_account_for_subject() THEN
 RAISE EXCEPTION 'Customer access denied' USING ERRCODE='42501';END IF;
 SELECT * INTO w FROM hawa.customer_web_requests x WHERE x.tenant_id=hawa.current_tenant_id() AND x.request_id=rid
 AND x.account_id=hawa.current_customer_id();IF NOT FOUND THEN RETURN;END IF;
 PERFORM hawa.lock_customer_request_access(w.client_id);
 SELECT * INTO r FROM hawa.requests x WHERE x.tenant_id=w.tenant_id AND x.request_id=w.request_id AND x.owner='restate' FOR SHARE;
 IF NOT FOUND THEN RETURN;END IF;
 PERFORM 1 FROM hawa.tasks t WHERE t.tenant_id=w.tenant_id AND t.id=r.current_task_id AND t.request_id=w.request_id
 AND t.customer_account_id=w.account_id AND t.requested_by=hawa.current_user_id() AND t.client_id=w.client_id FOR SHARE;
 IF NOT FOUND THEN RETURN;END IF;
 RETURN QUERY SELECT r.current_task_id,r.rev,r.stage,COALESCE((SELECT (p.result->>'autoGenerate')::boolean
 FROM hawa.lifecycle_projections p WHERE p.tenant_id=r.tenant_id AND p.request_id=r.request_id AND p.rev=1),false);
END $$;
REVOKE ALL ON FUNCTION hawa.customer_action_basis(uuid) FROM PUBLIC,hawa_worker;
GRANT EXECUTE ON FUNCTION hawa.customer_action_basis(uuid) TO hawa_app;
COMMIT;
