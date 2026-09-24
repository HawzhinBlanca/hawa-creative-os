-- 022: who delivers a publication, Core or the Restate Delivery workflow (architecture programme
-- Phase 2, slice 2.2; PHASE2_DESIGN.md section 3, ADR-034).
--
-- A task whose Telegram chat is on HAWA_LIFECYCLE_CHATS when Deliver is pressed is delivered by the
-- Delivery workflow (apps/worker/src/lifecycle/delivery.ts), not by Core's own delivery. The publish
-- route writes executor = 'restate' on the publication before it starts the workflow, and from then on
-- the old path refuses it: Core's delivery answers 409 DELIVERY_OWNED_BY_WORKFLOW, the interrupted
-- delivery check leaves it alone, and the outbox's notify.published handler dead-letters a command for
-- it. Every row written before this has executor = 'core', which is today's behaviour.
--
-- executor_run counts the workflow runs started for the publication: run n is the workflow keyed
-- dl-<task>-<approval> (n = 1) or dl-<task>-<approval>:archive:<n>, and a later run retries only the
-- Drive archive or the Sheets row (files and the notice are keyed per publication, not per run, and
-- are never sent twice). executor_finished_run is the last run that reported back through Core's
-- delivery-finished endpoint, so a run is in flight while executor_run > executor_finished_run. Both
-- are written by Core under the publication's advisory lock; Restate's workflow key makes a start
-- that is repeated after a lost answer start nothing twice.
--
-- Every statement can run twice (psql by hand after the runner).
BEGIN;

ALTER TABLE hawa.publications ADD COLUMN IF NOT EXISTS executor text NOT NULL DEFAULT 'core';
ALTER TABLE hawa.publications DROP CONSTRAINT IF EXISTS publications_executor_check;
ALTER TABLE hawa.publications ADD CONSTRAINT publications_executor_check CHECK (executor IN ('core', 'restate'));
ALTER TABLE hawa.publications ADD COLUMN IF NOT EXISTS executor_run integer NOT NULL DEFAULT 0;
ALTER TABLE hawa.publications ADD COLUMN IF NOT EXISTS executor_finished_run integer NOT NULL DEFAULT 0;
ALTER TABLE hawa.publications DROP CONSTRAINT IF EXISTS publications_executor_run_check;
ALTER TABLE hawa.publications ADD CONSTRAINT publications_executor_run_check
  CHECK (executor_run >= 0 AND executor_finished_run >= 0 AND executor_finished_run <= executor_run);

-- db/03-grants.sql revokes UPDATE on publications and grants back only the columns the code moves.
-- These three are moved by Core's publish route and its delivery-finished endpoint.
GRANT UPDATE (executor, executor_run, executor_finished_run) ON hawa.publications TO hawa_app;

COMMIT;
