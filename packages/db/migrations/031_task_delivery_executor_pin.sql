-- ADR-052: a chat flag may enrol only tasks created after it is set.
BEGIN;

ALTER TABLE hawa.tasks
  ADD COLUMN delivery_executor_pin text NOT NULL DEFAULT 'core'
    CHECK (delivery_executor_pin IN ('core', 'restate'));

CREATE OR REPLACE FUNCTION hawa.protect_task_delivery_executor_pin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.delivery_executor_pin IS DISTINCT FROM OLD.delivery_executor_pin THEN
    RAISE EXCEPTION 'Task delivery executor pin is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER immutable_task_delivery_executor_pin
  BEFORE UPDATE OF delivery_executor_pin ON hawa.tasks
  FOR EACH ROW EXECUTE FUNCTION hawa.protect_task_delivery_executor_pin();

COMMIT;
