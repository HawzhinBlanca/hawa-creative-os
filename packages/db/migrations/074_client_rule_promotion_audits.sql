-- ADR192: client-wide instructions need no invented task to retain promotion lineage.
BEGIN;
CREATE POLICY audit_events_rule_promotion_read ON hawa.audit_events FOR SELECT USING (
  action='client_rule.promoted' AND resource_type='candidate_rule' AND task_id IS NULL
  AND tenant_id=hawa.current_tenant_id() AND client_id IS NOT NULL
  AND hawa.can_access_client(tenant_id,client_id)
);
-- Existing task audit policies have a tenant-only INSERT check. Do not let it
-- authorize a new client-wide promotion outside the current writer's scope.
CREATE POLICY audit_events_rule_promotion_insert ON hawa.audit_events AS RESTRICTIVE FOR INSERT WITH CHECK (
  action<>'client_rule.promoted' OR (
    resource_type='candidate_rule' AND task_id IS NULL AND client_id IS NOT NULL
    AND tenant_id=hawa.current_tenant_id() AND hawa.can_write_client(tenant_id,client_id)
    AND actor_type='user' AND actor_id=hawa.current_user_id()::text
  )
);
CREATE INDEX audit_events_rule_promotion_lookup ON hawa.audit_events(tenant_id,client_id,resource_id,occurred_at DESC)
  WHERE action='client_rule.promoted' AND resource_type='candidate_rule' AND task_id IS NULL;
COMMIT;
