-- ADR-064: a verified OIDC subject must resolve to a provisioned member. RLS deliberately
-- prevents the service operator from reading another person's user row, so this narrow function
-- performs the lookup without allowing email-based auto-provisioning or role grants.
BEGIN;
CREATE FUNCTION hawa.lookup_office_oidc_user(p_tenant_id uuid, p_subject text)
RETURNS TABLE(id uuid, display_name text, disabled_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = hawa, pg_temp AS $$
  SELECT u.id, u.display_name, u.disabled_at
  FROM hawa.users u
  WHERE u.external_subject = p_subject
    AND p_tenant_id = hawa.current_tenant_id()
    AND hawa.current_user_id() = '00000000-0000-4000-b000-000000000011'::uuid
    AND EXISTS (
      SELECT 1 FROM hawa.tenant_memberships m
      WHERE m.tenant_id = p_tenant_id AND m.user_id = u.id AND m.active
    )
$$;
REVOKE ALL ON FUNCTION hawa.lookup_office_oidc_user(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.lookup_office_oidc_user(uuid,text) TO hawa_app;
COMMIT;
