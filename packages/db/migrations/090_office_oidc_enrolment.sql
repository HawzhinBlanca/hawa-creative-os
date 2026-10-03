-- ADR-294 addendum: office Google accounts enrolled from HAWA_GOOGLE_OIDC_ALLOWED_EMAILS.
--
-- hawa.users forces RLS and has no write policy, so the application role cannot create an office
-- member or record a Google subject on one, and 036 deliberately only looks members up. These two
-- narrow functions are the supported enrolment path. They run only in Core's system-automation
-- context, which Core enters only after openid-client has verified Google's token and Core has found
-- the verified email on the owner's list. The list (an environment setting) stays the authority:
--   * enrol: on a sign-in, create the member or bind the subject to an unbound member with that
--     email, and set its tenant roles to exactly the listed roles;
--   * reconcile: at start and before every sign-in, revoke every enrolled member whose email left
--     the list (memberships off, Desk sessions revoked) and re-sync changed roles.
-- The subject binding itself is never removed, so a removed email cannot come back under another
-- Google account, and a listed email already bound to a different subject is refused.
BEGIN;

CREATE TABLE hawa.office_oidc_enrolments (
  tenant_id uuid NOT NULL REFERENCES hawa.tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES hawa.users(id) ON DELETE CASCADE,
  subject text NOT NULL,
  email text NOT NULL CHECK (email = lower(email)),
  roles hawa.membership_role[] NOT NULL CHECK (cardinality(roles) > 0),
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, user_id),
  UNIQUE (tenant_id, subject)
);
-- Read and written only through the functions below; no policy, no grant.
ALTER TABLE hawa.office_oidc_enrolments ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.office_oidc_enrolments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON hawa.office_oidc_enrolments FROM PUBLIC, hawa_app, hawa_worker;

CREATE FUNCTION hawa.enrol_office_oidc_user(
  p_tenant_id uuid, p_subject text, p_email text, p_display_name text, p_roles hawa.membership_role[])
RETURNS TABLE(id uuid, display_name text, disabled_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = hawa, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name text := left(btrim(coalesce(p_display_name, '')), 200);
  v_roles hawa.membership_role[];
  v_user hawa.users%ROWTYPE;
  v_previous hawa.membership_role[];
  v_was_revoked boolean;
  v_action text;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id IS DISTINCT FROM hawa.current_tenant_id()
      OR hawa.current_user_id() IS DISTINCT FROM '00000000-0000-4000-b000-000000000011'::uuid THEN
    RAISE EXCEPTION 'Office sign-in enrolment runs only as system automation' USING ERRCODE = '42501';
  END IF;
  IF p_subject IS NULL OR p_subject !~ '^[\x21-\x7e]{1,255}$' OR p_subject LIKE 'customer:%' THEN
    RAISE EXCEPTION 'Invalid Google subject' USING ERRCODE = '22023';
  END IF;
  IF length(v_email) > 254 OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'Invalid office email' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(array_agg(DISTINCT r ORDER BY r), '{}') INTO v_roles FROM unnest(p_roles) r;
  IF p_roles IS NULL OR cardinality(v_roles) = 0 OR array_position(p_roles, NULL) IS NOT NULL
      OR 'requester' = ANY(v_roles) THEN
    RAISE EXCEPTION 'Office roles are required' USING ERRCODE = '22023';
  END IF;
  IF v_name = '' THEN v_name := v_email; END IF;

  -- Two first sign-ins of one account must not both create it.
  PERFORM pg_advisory_xact_lock(hashtextextended('hawa.office_oidc_enrolment:' || p_subject, 0));

  SELECT * INTO v_user FROM hawa.users u WHERE u.external_subject = p_subject FOR UPDATE;
  IF NOT FOUND THEN
    SELECT * INTO v_user FROM hawa.users u WHERE lower(u.email::text) = v_email FOR UPDATE;
    IF FOUND THEN
      IF v_user.external_subject IS NOT NULL THEN
        RAISE EXCEPTION 'This email belongs to another Google account' USING ERRCODE = '23505';
      END IF;
      IF v_user.id::text LIKE '00000000-0000-4000-b000-%' THEN
        RAISE EXCEPTION 'A built-in identity cannot be bound to a Google account' USING ERRCODE = '42501';
      END IF;
      UPDATE hawa.users u SET external_subject = p_subject, updated_at = now()
        WHERE u.id = v_user.id RETURNING * INTO v_user;
      v_action := 'office_oidc.bound';
    ELSE
      INSERT INTO hawa.users(email, display_name, external_subject)
        VALUES (v_email, v_name, p_subject) RETURNING * INTO v_user;
      v_action := 'office_oidc.enrolled';
    END IF;
  END IF;

  IF v_user.disabled_at IS NOT NULL THEN
    RETURN QUERY SELECT v_user.id, v_user.display_name, v_user.disabled_at;
    RETURN;
  END IF;

  SELECT coalesce(array_agg(m.role ORDER BY m.role), '{}') INTO v_previous
    FROM hawa.tenant_memberships m
    WHERE m.tenant_id = p_tenant_id AND m.user_id = v_user.id AND m.active;
  INSERT INTO hawa.tenant_memberships AS m (tenant_id, user_id, role, active)
    SELECT p_tenant_id, v_user.id, r, true FROM unnest(v_roles) r
    ON CONFLICT (tenant_id, user_id, role) DO UPDATE SET active = true;
  UPDATE hawa.tenant_memberships m SET active = false
    WHERE m.tenant_id = p_tenant_id AND m.user_id = v_user.id AND m.active AND NOT (m.role = ANY(v_roles));

  SELECT e.revoked_at IS NOT NULL INTO v_was_revoked FROM hawa.office_oidc_enrolments e
    WHERE e.tenant_id = p_tenant_id AND e.user_id = v_user.id FOR UPDATE;
  INSERT INTO hawa.office_oidc_enrolments AS e (tenant_id, user_id, subject, email, roles)
    VALUES (p_tenant_id, v_user.id, p_subject, v_email, v_roles)
    ON CONFLICT (tenant_id, user_id) DO UPDATE
      SET subject = EXCLUDED.subject, email = EXCLUDED.email, roles = EXCLUDED.roles,
          updated_at = now(), revoked_at = NULL;

  IF v_action IS NULL AND v_was_revoked THEN
    v_action := 'office_oidc.reinstated';
  ELSIF v_action IS NULL AND v_previous IS DISTINCT FROM v_roles THEN
    v_action := 'office_oidc.roles_changed';
  END IF;
  IF v_previous IS DISTINCT FROM v_roles AND cardinality(v_previous) > 0 THEN
    -- A Desk session carries the role it was issued with; a changed role starts from a new sign-in.
    UPDATE hawa.desk_sessions s SET revoked_at = now()
      WHERE s.tenant_id = p_tenant_id AND s.user_id = v_user.id AND s.revoked_at IS NULL;
  END IF;
  IF v_action IS NOT NULL THEN
    INSERT INTO hawa.audit_events(tenant_id, actor_type, actor_id, action, resource_type, resource_id, reason, data)
      VALUES (p_tenant_id, 'system', 'oidc:' || p_subject, v_action, 'user', v_user.id::text,
        'HAWA_GOOGLE_OIDC_ALLOWED_EMAILS',
        jsonb_build_object('email', v_email, 'roles', to_jsonb(v_roles), 'previous_roles', to_jsonb(v_previous)));
  END IF;
  RETURN QUERY SELECT v_user.id, v_user.display_name, v_user.disabled_at;
END $$;
REVOKE ALL ON FUNCTION hawa.enrol_office_oidc_user(uuid, text, text, text, hawa.membership_role[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.enrol_office_oidc_user(uuid, text, text, text, hawa.membership_role[]) TO hawa_app;

-- p_allowed is the whole current list: [{"email": "...", "roles": ["administrator", ...]}, ...].
CREATE FUNCTION hawa.reconcile_office_oidc_enrolments(p_tenant_id uuid, p_allowed jsonb)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = hawa, pg_temp AS $$
DECLARE
  v_entry record;
  v_roles hawa.membership_role[];
  v_changed integer := 0;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id IS DISTINCT FROM hawa.current_tenant_id()
      OR hawa.current_user_id() IS DISTINCT FROM '00000000-0000-4000-b000-000000000011'::uuid THEN
    RAISE EXCEPTION 'Office sign-in enrolment runs only as system automation' USING ERRCODE = '42501';
  END IF;
  IF p_allowed IS NULL OR jsonb_typeof(p_allowed) <> 'array' THEN
    RAISE EXCEPTION 'The allowed office emails must be a list' USING ERRCODE = '22023';
  END IF;
  FOR v_entry IN SELECT e.user_id, e.subject, e.email, e.roles FROM hawa.office_oidc_enrolments e
      WHERE e.tenant_id = p_tenant_id AND e.revoked_at IS NULL ORDER BY e.user_id FOR UPDATE LOOP
    v_roles := NULL;
    SELECT array_agg(DISTINCT r::hawa.membership_role ORDER BY r::hawa.membership_role) INTO v_roles
      FROM jsonb_array_elements(p_allowed) a, jsonb_array_elements_text(a->'roles') r
      WHERE lower(a->>'email') = v_entry.email;
    IF v_roles IS NOT NULL AND 'requester' = ANY(v_roles) THEN
      RAISE EXCEPTION 'Office roles are required' USING ERRCODE = '22023';
    END IF;
    IF v_roles IS NULL THEN
      UPDATE hawa.tenant_memberships m SET active = false
        WHERE m.tenant_id = p_tenant_id AND m.user_id = v_entry.user_id AND m.active;
      UPDATE hawa.office_oidc_enrolments e SET revoked_at = now(), updated_at = now()
        WHERE e.tenant_id = p_tenant_id AND e.user_id = v_entry.user_id;
    ELSIF v_roles IS DISTINCT FROM v_entry.roles THEN
      INSERT INTO hawa.tenant_memberships AS m (tenant_id, user_id, role, active)
        SELECT p_tenant_id, v_entry.user_id, r, true FROM unnest(v_roles) r
        ON CONFLICT (tenant_id, user_id, role) DO UPDATE SET active = true;
      UPDATE hawa.tenant_memberships m SET active = false
        WHERE m.tenant_id = p_tenant_id AND m.user_id = v_entry.user_id AND m.active AND NOT (m.role = ANY(v_roles));
      UPDATE hawa.office_oidc_enrolments e SET roles = v_roles, updated_at = now()
        WHERE e.tenant_id = p_tenant_id AND e.user_id = v_entry.user_id;
    ELSE
      CONTINUE;
    END IF;
    UPDATE hawa.desk_sessions s SET revoked_at = now()
      WHERE s.tenant_id = p_tenant_id AND s.user_id = v_entry.user_id AND s.revoked_at IS NULL;
    INSERT INTO hawa.audit_events(tenant_id, actor_type, actor_id, action, resource_type, resource_id, reason, data)
      VALUES (p_tenant_id, 'system', 'oidc:' || v_entry.subject,
        CASE WHEN v_roles IS NULL THEN 'office_oidc.revoked' ELSE 'office_oidc.roles_changed' END,
        'user', v_entry.user_id::text, 'HAWA_GOOGLE_OIDC_ALLOWED_EMAILS',
        jsonb_build_object('email', v_entry.email, 'roles', to_jsonb(coalesce(v_roles, '{}'::hawa.membership_role[])),
          'previous_roles', to_jsonb(v_entry.roles)));
    v_changed := v_changed + 1;
  END LOOP;
  RETURN v_changed;
END $$;
REVOKE ALL ON FUNCTION hawa.reconcile_office_oidc_enrolments(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.reconcile_office_oidc_enrolments(uuid, jsonb) TO hawa_app;

COMMIT;
