-- ADR-064/NFR-015: assignment changes are append-only evidence and are attributable to a
-- named administrator session (or a trusted database bootstrap role outside the application).
BEGIN;
CREATE TABLE hawa.office_review_assignment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES hawa.tenants(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL,
  action_id uuid,
  request_sha256 text CHECK (request_sha256 IS NULL OR request_sha256 ~ '^[a-f0-9]{64}$'),
  actor_user_id uuid REFERENCES hawa.users(id),
  actor_database_role text NOT NULL,
  action text NOT NULL CHECK (action IN ('granted','reactivated','revoked','renewed')),
  assignment_version bigint NOT NULL CHECK (assignment_version > 0),
  client_id uuid NOT NULL,
  project_id uuid,
  reviewer_user_id uuid NOT NULL,
  reason text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, action_id)
);
CREATE INDEX office_review_assignment_events_scope ON hawa.office_review_assignment_events(tenant_id,assignment_id,assignment_version);
ALTER TABLE hawa.office_review_assignment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.office_review_assignment_events FORCE ROW LEVEL SECURITY;
CREATE POLICY office_review_assignment_events_read ON hawa.office_review_assignment_events
  FOR SELECT USING (tenant_id = hawa.current_tenant_id() AND
    (SELECT hawa.has_tenant_role(hawa.current_tenant_id(), ARRAY['administrator','auditor']::hawa.membership_role[])));
GRANT SELECT ON hawa.office_review_assignment_events TO hawa_app;

CREATE FUNCTION hawa.audit_office_review_assignment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = hawa, pg_temp AS $$
DECLARE
  v_action_id text := NULLIF(current_setting('hawa.office_review_action_id', true), '');
  v_request_sha256 text := NULLIF(current_setting('hawa.office_review_request_sha256', true), '');
  v_reason text := NULLIF(current_setting('hawa.office_review_reason', true), '');
  v_action text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Review assignments must be revoked, not deleted';
  END IF;
  IF session_user <> current_user AND
      (hawa.current_user_id() IS NULL OR v_action_id IS NULL OR v_request_sha256 IS NULL OR v_reason IS NULL) THEN
    RAISE EXCEPTION 'Named administrator action metadata is required';
  END IF;
  IF TG_OP = 'INSERT' THEN
    v_action := 'granted';
  ELSIF NOT OLD.active AND NEW.active THEN
    v_action := 'reactivated';
  ELSIF OLD.active AND NOT NEW.active THEN
    v_action := 'revoked';
  ELSE
    v_action := 'renewed';
  END IF;
  INSERT INTO hawa.office_review_assignment_events(
    tenant_id,assignment_id,action_id,request_sha256,actor_user_id,actor_database_role,
    action,assignment_version,client_id,project_id,reviewer_user_id,reason)
  VALUES (NEW.tenant_id,NEW.id,v_action_id::uuid,v_request_sha256,hawa.current_user_id(),session_user,
    v_action,NEW.version,NEW.client_id,NEW.project_id,NEW.user_id,v_reason);
  RETURN NEW;
END $$;
CREATE TRIGGER office_review_assignment_audit AFTER INSERT OR UPDATE OR DELETE ON hawa.office_review_assignments
  FOR EACH ROW EXECUTE FUNCTION hawa.audit_office_review_assignment();
REVOKE ALL ON FUNCTION hawa.audit_office_review_assignment() FROM PUBLIC;

-- The app can only use this through a transaction scoped to the same named administrator.
CREATE FUNCTION hawa.lock_named_office_administrator(
  p_tenant_id uuid, p_session_hash text, p_user_id uuid)
RETURNS TABLE(administrator_user_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = hawa, pg_temp AS $$
  SELECT u.id
  FROM hawa.desk_sessions s
  JOIN hawa.users u ON u.id = s.user_id
  JOIN hawa.tenant_memberships tm ON tm.tenant_id = s.tenant_id AND tm.user_id = s.user_id
    AND tm.role = 'administrator' AND tm.active
  WHERE p_tenant_id = hawa.current_tenant_id() AND p_user_id = hawa.current_user_id()
    AND s.tenant_id = p_tenant_id AND s.user_id = p_user_id
    AND s.token_hash = p_session_hash AND s.auth_method = 'google_oidc'
    AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL
  LIMIT 1 FOR SHARE OF s,u,tm
$$;
REVOKE ALL ON FUNCTION hawa.lock_named_office_administrator(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.lock_named_office_administrator(uuid,text,uuid) TO hawa_app;

-- A normal RLS SELECT ... FOR SHARE on users/memberships may be filtered by their UPDATE
-- policies. This narrow definer locks the candidate rows after the caller's named admin check.
CREATE FUNCTION hawa.lock_office_review_candidate(
  p_tenant_id uuid, p_user_id uuid, p_client_id uuid, p_project_id uuid)
RETURNS TABLE(candidate_user_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = hawa, pg_temp AS $$
  SELECT u.id
  FROM hawa.users u
  JOIN hawa.tenant_memberships tm ON tm.user_id = u.id AND tm.tenant_id = p_tenant_id
    AND tm.role = 'approver' AND tm.active
  JOIN hawa.client_memberships cm ON cm.user_id = u.id AND cm.tenant_id = tm.tenant_id
    AND cm.client_id = p_client_id AND cm.role = 'approver' AND cm.active
  JOIN hawa.clients cl ON cl.tenant_id = cm.tenant_id AND cl.id = cm.client_id AND cl.status = 'active'
  WHERE p_tenant_id = hawa.current_tenant_id()
    AND hawa.has_tenant_role(p_tenant_id, ARRAY['administrator']::hawa.membership_role[])
    AND u.id = p_user_id AND u.disabled_at IS NULL AND u.external_subject IS NOT NULL
    AND (p_project_id IS NULL OR EXISTS (SELECT 1 FROM hawa.projects p
      WHERE p.tenant_id = p_tenant_id AND p.id = p_project_id
        AND p.client_id = p_client_id AND p.status = 'active'))
  LIMIT 1 FOR SHARE OF u,tm,cm,cl
$$;
REVOKE ALL ON FUNCTION hawa.lock_office_review_candidate(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.lock_office_review_candidate(uuid,uuid,uuid,uuid) TO hawa_app;

-- A client archived after the assignment was granted also loses decision authority. The
-- locked client row makes that revocation serialize with an in-flight office decision.
CREATE OR REPLACE FUNCTION hawa.lock_named_office_reviewer(
  p_tenant_id uuid, p_session_hash text, p_user_id uuid, p_client_id uuid, p_project_id uuid)
RETURNS TABLE(assignment_id uuid, assignment_version bigint)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = hawa, pg_temp AS $$
  SELECT a.id, a.version
  FROM hawa.desk_sessions s
  JOIN hawa.users u ON u.id = s.user_id
  JOIN hawa.tenant_memberships tm ON tm.tenant_id = s.tenant_id AND tm.user_id = s.user_id
    AND tm.role = 'approver' AND tm.active
  JOIN hawa.client_memberships cm ON cm.tenant_id = s.tenant_id AND cm.user_id = s.user_id
    AND cm.client_id = p_client_id AND cm.role = 'approver' AND cm.active
  JOIN hawa.clients cl ON cl.tenant_id = cm.tenant_id AND cl.id = cm.client_id AND cl.status = 'active'
  JOIN hawa.office_review_assignments a ON a.tenant_id = s.tenant_id
    AND a.client_id = cm.client_id AND a.user_id = s.user_id AND a.active
    AND (a.project_id IS NULL OR a.project_id = p_project_id)
  WHERE p_tenant_id = hawa.current_tenant_id()
    AND hawa.current_user_id() IN (
      '00000000-0000-4000-b000-000000000010'::uuid,
      '00000000-0000-4000-b000-000000000011'::uuid)
    AND s.tenant_id = p_tenant_id AND s.user_id = p_user_id
    AND s.token_hash = p_session_hash AND s.auth_method = 'google_oidc'
    AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL
    AND (p_project_id IS NULL OR EXISTS (SELECT 1 FROM hawa.projects p
      WHERE p.tenant_id = p_tenant_id AND p.id = p_project_id AND p.client_id = p_client_id
        AND p.status = 'active'))
  ORDER BY (a.project_id IS NOT NULL) DESC
  LIMIT 1
  FOR SHARE OF s,u,tm,cm,cl,a
$$;
COMMIT;
