-- 020: one inbox row per source event, enforced by the database (2026-09-24).
--
-- inbox_events carries UNIQUE (integration_id, source_account_id, source_event_id), but intake never
-- sets integration_id, and NULLs are distinct in a plain unique constraint, so it never fired
-- (PHASE2_DESIGN.md 1.2, finding 6). Every intake path deduplicates with a read first (WHERE NOT
-- EXISTS, or a select then an insert), which two processes can both pass: a Telegram update polled
-- twice, or a poller and a webhook racing, recorded twice.
--
-- The index below covers what intake actually looks rows up by: tenant, source account and source
-- event id (chat-intake.ts, polled-update-dispatch.ts, app.ts telegramUpdateHandled and
-- markTelegramUpdateHandled, ingress.repository.ts), plus integration_id, which ingress matches when
-- it has one. NULLS NOT DISTINCT (PostgreSQL 15+) makes the always-NULL integration_id count as equal.
--
-- The outbox's send marks ('telegram_delivery', apps/worker/src/delivery-notification.ts) are left
-- out on purpose: they append a row per outcome under one `<command id>:<step>` key (attempted, then
-- sent), and the latest one is the step's state.
--
-- Rows that already collide are not refused. A migration that fails on production data is a failed
-- deploy, and the only way out would be hand-written SQL against production; the duplicates are
-- repeated receipts of one event, which the read-first checks already treated as one. So, per event,
-- the newest row stays (received_at, then id), every other row moves to hawa.inbox_event_duplicates
-- with the id of the row that stayed, and message_events that pointed at a moved row point at the kept
-- one. Nothing is lost, and what was removed can be read back.
--
-- Also: Core checks at startup that every versioned upgrade has run (apps/core/src/schema-check.ts),
-- which needs to read hawa.schema_upgrades. The runner creates that table, and nothing granted it.

BEGIN;
-- inbox_events forces row-level security; the upgrade runs as the schema owner, which must see
-- every tenant's rows. A role that cannot bypass RLS fails here instead of deduplicating a subset.
SET LOCAL row_security = off;

CREATE TABLE IF NOT EXISTS hawa.inbox_event_duplicates (
  LIKE hawa.inbox_events,
  kept_id uuid NOT NULL,
  removed_at timestamptz NOT NULL DEFAULT now(),
  removed_by text NOT NULL DEFAULT '020_inbox_event_dedupe.sql',
  PRIMARY KEY (id)
);
REVOKE ALL ON hawa.inbox_event_duplicates FROM PUBLIC;
REVOKE ALL ON hawa.inbox_event_duplicates FROM hawa_app;

CREATE TEMP TABLE inbox_dedupe_020 ON COMMIT DROP AS
SELECT id, kept_id FROM (
  SELECT id,
         first_value(id) OVER w AS kept_id,
         row_number() OVER w AS n
  FROM hawa.inbox_events
  WHERE source_account_id <> 'telegram_delivery'
  WINDOW w AS (PARTITION BY tenant_id, integration_id, source_account_id, source_event_id
               ORDER BY received_at DESC, id DESC)
) ranked
WHERE n > 1;

UPDATE hawa.message_events m SET inbox_event_id = d.kept_id
FROM inbox_dedupe_020 d WHERE m.inbox_event_id = d.id;

WITH moved AS (
  DELETE FROM hawa.inbox_events e USING inbox_dedupe_020 d WHERE e.id = d.id
  RETURNING e.*, d.kept_id
)
INSERT INTO hawa.inbox_event_duplicates SELECT * FROM moved;

DO $$
DECLARE moved integer;
BEGIN
  SELECT count(*) INTO moved FROM inbox_dedupe_020;
  IF moved > 0 THEN
    RAISE NOTICE '020_inbox_event_dedupe: % duplicate inbox row(s) moved to hawa.inbox_event_duplicates', moved;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS inbox_events_source_event_uidx
  ON hawa.inbox_events (tenant_id, integration_id, source_account_id, source_event_id) NULLS NOT DISTINCT
  WHERE source_account_id <> 'telegram_delivery';

GRANT SELECT ON hawa.schema_upgrades TO hawa_app;
COMMIT;
