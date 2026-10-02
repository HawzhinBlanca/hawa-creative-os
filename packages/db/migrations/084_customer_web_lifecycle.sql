-- ADR260. A durable, immutable web brief exists before its canonical task projection.
BEGIN;
CREATE TABLE hawa.customer_web_requests (
 request_id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
 account_id uuid NOT NULL, client_id uuid NOT NULL, subject uuid NOT NULL,
 action_key text NOT NULL, body_hash text NOT NULL CHECK(body_hash ~ '^[a-f0-9]{64}$'),
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
 dna_version integer NOT NULL CHECK(dna_version>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,request_id), UNIQUE(account_id,action_key),
 FOREIGN KEY(tenant_id,account_id) REFERENCES hawa.customer_accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,client_id) REFERENCES hawa.clients(tenant_id,id)
);
CREATE INDEX customer_web_history ON hawa.customer_web_requests(tenant_id,account_id,created_at DESC,request_id DESC);
ALTER TABLE hawa.customer_web_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.customer_web_requests FORCE ROW LEVEL SECURITY;
CREATE TRIGGER customer_web_request_immutable BEFORE UPDATE OR DELETE ON hawa.customer_web_requests
 FOR EACH ROW EXECUTE FUNCTION hawa.forbid_update_delete();
CREATE POLICY customer_web_read ON hawa.customer_web_requests FOR SELECT USING (
 tenant_id=hawa.current_tenant_id() AND
 ((hawa.current_customer_id() IS NULL AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator']::hawa.membership_role[])))
 OR (account_id=hawa.current_customer_id() AND subject=NULLIF(current_setting('hawa.customer_subject',true),'')::uuid
 AND client_id=ANY((SELECT hawa.customer_request_client_ids())::uuid[]))));
CREATE POLICY customer_web_create ON hawa.customer_web_requests FOR INSERT WITH CHECK (
 tenant_id=hawa.current_tenant_id() AND account_id=hawa.current_customer_id()
 AND subject=NULLIF(current_setting('hawa.customer_subject',true),'')::uuid
 AND client_id=ANY((SELECT hawa.customer_request_client_ids())::uuid[]));
GRANT SELECT,INSERT ON hawa.customer_web_requests TO hawa_app;

-- A policy used by the restricted worker must not require raw customer-table SELECT.
CREATE FUNCTION hawa.customer_owns_web_request(rid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM hawa.customer_web_requests w WHERE w.request_id=rid
 AND w.tenant_id=hawa.current_tenant_id() AND w.account_id=hawa.current_customer_id()
 AND w.subject=NULLIF(current_setting('hawa.customer_subject',true),'')::uuid
 AND w.client_id=ANY(hawa.customer_request_client_ids()))
$$;
REVOKE ALL ON FUNCTION hawa.customer_owns_web_request(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.customer_owns_web_request(uuid) TO hawa_app,hawa_worker;

-- A customer's command is admitted only alongside its owned immutable receipt.
DROP POLICY customer_outbox_create ON hawa.outbox_commands;
CREATE POLICY customer_outbox_create ON hawa.outbox_commands FOR INSERT WITH CHECK (
 tenant_id=hawa.current_tenant_id() AND state='pending' AND
 ((command_type='task.created' AND aggregate_type='task' AND EXISTS(SELECT 1 FROM hawa.tasks t
 WHERE t.id=aggregate_id AND t.tenant_id=outbox_commands.tenant_id AND t.customer_account_id=hawa.current_customer_id()))
 OR (command_type='customer.request.open' AND aggregate_type='request' AND hawa.customer_owns_web_request(aggregate_id))));
DROP POLICY customer_outbox_scope ON hawa.outbox_commands;
CREATE POLICY customer_outbox_scope ON hawa.outbox_commands AS RESTRICTIVE FOR SELECT USING (
 hawa.current_customer_id() IS NULL OR
 (aggregate_type='task' AND EXISTS(SELECT 1 FROM hawa.tasks t WHERE t.id=aggregate_id
 AND t.tenant_id=outbox_commands.tenant_id AND t.customer_account_id=hawa.current_customer_id())) OR
 (aggregate_type='request' AND hawa.customer_owns_web_request(aggregate_id)));

-- Requests become readable only through the original web receipt; office policies remain intact.
DROP POLICY customer_no_read ON hawa.requests;
CREATE POLICY customer_request_scope ON hawa.requests AS RESTRICTIVE FOR SELECT USING (
 hawa.current_customer_id() IS NULL OR EXISTS(SELECT 1 FROM hawa.customer_web_requests w
 WHERE w.request_id=requests.request_id AND w.tenant_id=requests.tenant_id AND w.account_id=hawa.current_customer_id()));
CREATE POLICY customer_request_read ON hawa.requests FOR SELECT USING (
 tenant_id=hawa.current_tenant_id() AND EXISTS(SELECT 1 FROM hawa.customer_web_requests w
 WHERE w.request_id=requests.request_id AND w.tenant_id=requests.tenant_id AND w.account_id=hawa.current_customer_id()));

CREATE OR REPLACE FUNCTION hawa.customer_job_counts() RETURNS TABLE(daily integer,concurrent integer)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF hawa.current_customer_id() IS DISTINCT FROM hawa.customer_account_for_subject() OR hawa.current_customer_id() IS NULL THEN
  RAISE EXCEPTION 'Customer access denied' USING ERRCODE='42501';
 END IF;
 RETURN QUERY SELECT count(*) FILTER(WHERE w.created_at>=now()-interval '24 hours')::integer,
 count(*) FILTER(WHERE r.stage IS NULL OR r.stage NOT IN ('cancelled','delivered','rejected','expired'))::integer
 FROM hawa.customer_web_requests w LEFT JOIN hawa.requests r ON r.tenant_id=w.tenant_id AND r.request_id=w.request_id
 WHERE w.tenant_id=hawa.current_tenant_id() AND w.account_id=hawa.current_customer_id();
END $$;

CREATE TABLE hawa.customer_web_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, request_id uuid NOT NULL,
 account_id uuid NOT NULL, message_key text NOT NULL, payload jsonb NOT NULL,
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,message_key),
 FOREIGN KEY(tenant_id,request_id) REFERENCES hawa.customer_web_requests(tenant_id,request_id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES hawa.customer_accounts(tenant_id,id)
);
CREATE INDEX customer_web_message_history ON hawa.customer_web_messages(tenant_id,request_id,created_at,id);
ALTER TABLE hawa.customer_web_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.customer_web_messages FORCE ROW LEVEL SECURITY;
CREATE TRIGGER customer_web_message_immutable BEFORE UPDATE OR DELETE ON hawa.customer_web_messages
 FOR EACH ROW EXECUTE FUNCTION hawa.forbid_update_delete();
CREATE POLICY customer_web_message_read ON hawa.customer_web_messages FOR SELECT USING (
 tenant_id=hawa.current_tenant_id() AND
 ((hawa.current_customer_id() IS NULL AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator']::hawa.membership_role[])))
 OR (account_id=hawa.current_customer_id() AND EXISTS(SELECT 1 FROM hawa.customer_web_requests w
 WHERE w.request_id=customer_web_messages.request_id AND w.tenant_id=customer_web_messages.tenant_id AND w.account_id=customer_web_messages.account_id))));
CREATE POLICY customer_web_message_record ON hawa.customer_web_messages FOR INSERT WITH CHECK (
 tenant_id=hawa.current_tenant_id() AND hawa.current_customer_id() IS NULL
 AND (SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator']::hawa.membership_role[]))
 AND EXISTS(SELECT 1 FROM hawa.customer_web_requests w WHERE w.request_id=customer_web_messages.request_id
 AND w.tenant_id=customer_web_messages.tenant_id AND w.account_id=customer_web_messages.account_id));
GRANT SELECT,INSERT ON hawa.customer_web_messages TO hawa_app;
-- Web admission reserves one global automatic slot before projection. The customer
-- role can neither enumerate other accounts nor reset this count through revocation.
CREATE FUNCTION hawa.customer_global_job_count() RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n bigint;
BEGIN
 IF hawa.current_customer_id() IS NULL OR hawa.current_customer_id() IS DISTINCT FROM hawa.customer_account_for_subject() THEN
  RAISE EXCEPTION 'Customer access denied' USING ERRCODE='42501';
 END IF;
 SELECT (SELECT count(*) FROM hawa.customer_web_requests w WHERE w.tenant_id=hawa.current_tenant_id()
   AND w.created_at>now()-interval '1 day') +
 (SELECT count(*) FROM hawa.outbox_commands o WHERE o.tenant_id=hawa.current_tenant_id() AND o.command_type='task.created'
   AND o.created_at>now()-interval '1 day' AND o.payload->>'autoGenerate'='true'
   AND COALESCE(o.payload->>'sourcePlatform','')<>'hawzhin_web') INTO n;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION hawa.customer_global_job_count() FROM PUBLIC,hawa_worker;
GRANT EXECUTE ON FUNCTION hawa.customer_global_job_count() TO hawa_app;

-- New paid reservations recheck the retained customer's live admission under locks.
-- Already paid responses are still finalized; this guard is not used by settlement/retrieval.
CREATE FUNCTION hawa.lock_customer_task_generation(tid uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t hawa.tasks%ROWTYPE; a hawa.customer_accounts%ROWTYPE;
BEGIN
 SELECT * INTO t FROM hawa.tasks WHERE tenant_id=hawa.current_tenant_id() AND id=tid;
 IF NOT FOUND THEN RAISE EXCEPTION 'Task scope unavailable' USING ERRCODE='42501'; END IF;
 IF t.customer_account_id IS NULL THEN RETURN; END IF;
 SELECT * INTO a FROM hawa.customer_accounts WHERE tenant_id=t.tenant_id AND id=t.customer_account_id FOR SHARE;
 IF NOT FOUND OR NOT a.active OR t.requested_by<>a.user_id OR NOT EXISTS(SELECT 1 FROM hawa.customer_web_requests w
  WHERE w.tenant_id=t.tenant_id AND w.request_id=t.request_id AND w.account_id=a.id AND w.subject=a.subject AND w.client_id=t.client_id)
 THEN RAISE EXCEPTION 'Customer generation access revoked' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hawa.users WHERE id=a.user_id AND disabled_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Customer generation access revoked' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hawa.tenant_memberships WHERE tenant_id=t.tenant_id AND user_id=a.user_id AND active AND role='requester' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Customer generation access revoked' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hawa.customer_client_grants WHERE tenant_id=t.tenant_id AND account_id=a.id AND client_id=t.client_id AND active FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Customer generation access revoked' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hawa.clients WHERE id=t.client_id AND tenant_id=t.tenant_id AND status='active' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Customer generation access revoked' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hawa.client_memberships WHERE tenant_id=t.tenant_id AND client_id=t.client_id AND user_id=a.user_id AND active AND role='requester' FOR SHARE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM hawa.tenant_memberships WHERE user_id=a.user_id AND active AND role<>'requester')
  OR EXISTS(SELECT 1 FROM hawa.client_memberships WHERE user_id=a.user_id AND active AND role<>'requester')
 THEN RAISE EXCEPTION 'Customer generation access revoked' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION hawa.lock_customer_task_generation(uuid) FROM PUBLIC,hawa_worker;
GRANT EXECUTE ON FUNCTION hawa.lock_customer_task_generation(uuid) TO hawa_app;
COMMIT;
