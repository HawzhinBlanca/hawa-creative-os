-- ADR-064: explicit, versioned authority for named office review. A null project is an
-- intentional client-wide assignment; a non-null project must belong to that client.
BEGIN;
CREATE TABLE hawa.office_review_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES hawa.tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL,
  project_id uuid,
  user_id uuid NOT NULL REFERENCES hawa.users(id) ON DELETE CASCADE,
  active boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, client_id) REFERENCES hawa.clients(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, project_id) REFERENCES hawa.projects(tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX office_review_client_scope ON hawa.office_review_assignments(tenant_id,client_id,user_id)
  WHERE project_id IS NULL;
CREATE UNIQUE INDEX office_review_project_scope ON hawa.office_review_assignments(tenant_id,client_id,project_id,user_id)
  WHERE project_id IS NOT NULL;
CREATE FUNCTION hawa.bump_office_review_assignment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER office_review_assignment_version BEFORE UPDATE ON hawa.office_review_assignments
  FOR EACH ROW EXECUTE FUNCTION hawa.bump_office_review_assignment();
ALTER TABLE hawa.office_review_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.office_review_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY office_review_assignments_admin ON hawa.office_review_assignments
  USING (tenant_id = hawa.current_tenant_id() AND
    (SELECT hawa.has_tenant_role(hawa.current_tenant_id(), ARRAY['administrator']::hawa.membership_role[])))
  WITH CHECK (tenant_id = hawa.current_tenant_id() AND
    (SELECT hawa.has_tenant_role(hawa.current_tenant_id(), ARRAY['administrator']::hawa.membership_role[])));
GRANT SELECT,INSERT,UPDATE ON hawa.office_review_assignments TO hawa_app;

-- Called under the service's scoped transaction, first before gateway dispatch and then under
-- the request decision lock. FOR SHARE serializes a decision with user/session/membership or
-- assignment revocation: whichever commits first determines the decision's authority.
CREATE FUNCTION hawa.lock_named_office_reviewer(
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
  FOR SHARE OF s,u,tm,cm,a
$$;
REVOKE ALL ON FUNCTION hawa.lock_named_office_reviewer(uuid,text,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.lock_named_office_reviewer(uuid,text,uuid,uuid,uuid) TO hawa_app;
COMMIT;
