-- ADR193: scope immutable dismissal/rollback receipts like promotion receipts.
BEGIN;
CREATE POLICY audit_events_rule_moderation_read ON hawa.audit_events FOR SELECT USING (
  action IN ('client_rule.dismissed','client_rule.rolled_back') AND resource_type='candidate_rule' AND task_id IS NULL
  AND tenant_id=hawa.current_tenant_id() AND client_id IS NOT NULL
  AND ((SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','auditor','operator']::hawa.membership_role[]))
    OR client_id=ANY((SELECT hawa.member_client_ids(false))::uuid[]))
);
CREATE POLICY audit_events_rule_moderation_insert ON hawa.audit_events AS RESTRICTIVE FOR INSERT WITH CHECK (
  action NOT IN ('client_rule.dismissed','client_rule.rolled_back') OR (
    resource_type='candidate_rule' AND task_id IS NULL AND client_id IS NOT NULL
    AND tenant_id=hawa.current_tenant_id()
    AND ((SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator']::hawa.membership_role[]))
      OR client_id=ANY((SELECT hawa.member_client_ids(true))::uuid[]))
    AND actor_type='user' AND actor_id=hawa.current_user_id()::text
  )
);
CREATE INDEX audit_events_rule_moderation_lookup ON hawa.audit_events(tenant_id,client_id,resource_id,occurred_at DESC)
  WHERE action IN ('client_rule.dismissed','client_rule.rolled_back') AND resource_type='candidate_rule' AND task_id IS NULL;
COMMIT;
