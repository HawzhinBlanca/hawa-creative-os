-- ADR194: preserve new verified reviewer roles without guessing historical ones.
BEGIN;
ALTER TABLE hawa.design_feedback ADD COLUMN actor_role text;
ALTER TABLE hawa.design_feedback ADD COLUMN client_id uuid;
ALTER TABLE hawa.design_feedback ADD CONSTRAINT design_feedback_recorded_client
  FOREIGN KEY (tenant_id,client_id) REFERENCES hawa.clients(tenant_id,id);
ALTER TABLE hawa.design_feedback ADD CONSTRAINT design_feedback_actor_role_known
  CHECK (actor_role IS NULL OR actor_role IN
    ('administrator','art_director','creative_director','operator','designer','requester','reviewer','auditor'));
COMMENT ON COLUMN hawa.design_feedback.actor_role IS
  'Verified role captured by Core when the source event was recorded; NULL means unknown historical attribution.';
COMMENT ON COLUMN hawa.design_feedback.client_id IS
  'Client scope captured when feedback was recorded; NULL is historical and requires an authorized task lookup.';
CREATE POLICY studio_feedback_client_read ON hawa.design_feedback AS RESTRICTIVE FOR SELECT
  USING (EXISTS (SELECT 1 FROM hawa.tasks t WHERE t.tenant_id=design_feedback.tenant_id
    AND t.id=design_feedback.task_id AND (design_feedback.client_id IS NULL OR design_feedback.client_id=t.client_id)
    AND t.tenant_id=hawa.current_tenant_id() AND
    ((SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','auditor','operator']::hawa.membership_role[]))
      OR t.client_id=ANY((SELECT hawa.member_client_ids(false))::uuid[]))));
CREATE POLICY studio_feedback_client_insert ON hawa.design_feedback AS RESTRICTIVE FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM hawa.tasks t WHERE t.tenant_id=design_feedback.tenant_id
    AND t.id=design_feedback.task_id AND (design_feedback.client_id IS NULL OR design_feedback.client_id=t.client_id)
    AND t.tenant_id=hawa.current_tenant_id() AND
    ((SELECT hawa.has_tenant_role(hawa.current_tenant_id(),ARRAY['administrator','operator']::hawa.membership_role[]))
      OR t.client_id=ANY((SELECT hawa.member_client_ids(true))::uuid[]))));
CREATE INDEX studio_feedback_learning_client ON hawa.design_feedback(tenant_id,client_id,created_at,id)
  WHERE client_id IS NOT NULL;
CREATE INDEX feedback_events_learning_client ON hawa.feedback_events(tenant_id,client_id,created_at,id)
  WHERE category IN ('design_refinement','design_rejection','client_rule_instruction');
CREATE INDEX audit_events_learning_moderation ON hawa.audit_events(tenant_id,client_id,resource_id,occurred_at DESC)
  WHERE resource_type='candidate_rule' AND task_id IS NULL
    AND action IN ('client_rule.promoted','client_rule.dismissed','client_rule.rolled_back');
CREATE FUNCTION hawa.prevent_learning_source_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='design_feedback' THEN
    RAISE EXCEPTION 'Learning source events are append-only' USING ERRCODE='55000';
  ELSIF OLD.category IN ('design_refinement','design_rejection','client_rule_instruction') THEN
    RAISE EXCEPTION 'Learning source events are append-only' USING ERRCODE='55000';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
-- PostgreSQL grants new functions to PUBLIC by default; trigger invocation needs no caller EXECUTE grant.
REVOKE ALL ON FUNCTION hawa.prevent_learning_source_mutation() FROM PUBLIC;
CREATE TRIGGER feedback_learning_sources_immutable BEFORE UPDATE OR DELETE ON hawa.feedback_events
  FOR EACH ROW EXECUTE FUNCTION hawa.prevent_learning_source_mutation();
CREATE TRIGGER studio_feedback_sources_immutable BEFORE UPDATE OR DELETE ON hawa.design_feedback
  FOR EACH ROW EXECUTE FUNCTION hawa.prevent_learning_source_mutation();
COMMIT;
