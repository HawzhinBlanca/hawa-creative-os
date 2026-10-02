-- ADR195: native decision sources carry the actual immutable reviewed revision.
BEGIN;
CREATE OR REPLACE FUNCTION hawa.prevent_learning_source_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='design_feedback' THEN
    RAISE EXCEPTION 'Learning source events are append-only' USING ERRCODE='55000';
  ELSIF OLD.category IN ('design_refinement','design_rejection','client_rule_instruction')
      OR OLD.category LIKE 'decision.%' OR OLD.category LIKE 'rejection.%'
      OR (TG_OP='UPDATE' AND (NEW.category IN ('design_refinement','design_rejection','client_rule_instruction')
        OR NEW.category LIKE 'decision.%' OR NEW.category LIKE 'rejection.%')) THEN
    RAISE EXCEPTION 'Learning source events are append-only' USING ERRCODE='55000';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION hawa.prevent_learning_source_mutation() FROM PUBLIC;
CREATE INDEX feedback_revision_learning_client ON hawa.feedback_events(tenant_id,client_id,created_at,id)
  WHERE category LIKE 'decision.%' OR category LIKE 'rejection.%';
COMMIT;
