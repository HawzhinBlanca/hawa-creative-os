-- ADR224: enabled office admission governs both direct and hoisted client authority.
-- Forward-only helper replacement preserves policy InitPlans, owner and existing ACLs.
CREATE OR REPLACE FUNCTION hawa.is_tenant_member(tid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = hawa, public AS $$
  SELECT tid = hawa.current_tenant_id()
     AND EXISTS (
       SELECT 1 FROM hawa.tenant_memberships m JOIN hawa.users u ON u.id=m.user_id
       WHERE m.tenant_id=tid AND m.user_id=hawa.current_user_id() AND m.active
         AND u.disabled_at IS NULL
     )
$$;

CREATE OR REPLACE FUNCTION hawa.has_tenant_role(tid uuid, roles hawa.membership_role[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = hawa, public AS $$
  SELECT tid = hawa.current_tenant_id()
     AND EXISTS (
       SELECT 1 FROM hawa.tenant_memberships m JOIN hawa.users u ON u.id=m.user_id
       WHERE m.tenant_id=tid AND m.user_id=hawa.current_user_id() AND m.active
         AND u.disabled_at IS NULL AND m.role=ANY(roles)
     )
$$;

CREATE OR REPLACE FUNCTION hawa.can_access_client(tid uuid, cid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = hawa, public AS $$
  SELECT tid = hawa.current_tenant_id() AND hawa.is_tenant_member(tid)
     AND (
       hawa.has_tenant_role(tid, ARRAY['administrator','auditor','operator']::hawa.membership_role[])
       OR EXISTS (
         SELECT 1 FROM hawa.client_memberships cm
         WHERE cm.tenant_id=tid AND cm.client_id=cid AND cm.user_id=hawa.current_user_id() AND cm.active
       )
     )
$$;

CREATE OR REPLACE FUNCTION hawa.can_write_client(tid uuid, cid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = hawa, public AS $$
  SELECT tid = hawa.current_tenant_id() AND hawa.is_tenant_member(tid)
     AND (
       hawa.has_tenant_role(tid, ARRAY['administrator','operator']::hawa.membership_role[])
       OR EXISTS (
         SELECT 1 FROM hawa.client_memberships cm
         WHERE cm.tenant_id=tid AND cm.client_id=cid AND cm.user_id=hawa.current_user_id() AND cm.active
           AND cm.role=ANY(ARRAY['designer','client_dna_manager']::hawa.membership_role[])
       )
     )
$$;

CREATE OR REPLACE FUNCTION hawa.member_client_ids(for_write boolean) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = hawa, public AS $$
  SELECT COALESCE(array_agg(cm.client_id), '{}'::uuid[])
  FROM hawa.client_memberships cm
  WHERE (SELECT hawa.is_tenant_member(hawa.current_tenant_id()))
    AND cm.tenant_id=hawa.current_tenant_id() AND cm.user_id=hawa.current_user_id() AND cm.active
    AND (NOT for_write OR cm.role=ANY(ARRAY['designer','client_dna_manager']::hawa.membership_role[]))
$$;
