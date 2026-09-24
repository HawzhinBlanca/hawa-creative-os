-- Architecture programme 3.1 (ADR-035, 2026-09-24): the content-addressed file store.
--
-- Pictures and design sources move out of rows and JSON payloads into files named by the sha256 of
-- their bytes (packages/db/src/blobs/store.ts). This migration adds the table of stored files, the
-- referencing row for payload pictures, the new hash columns, and the garbage collector's functions.
-- Nothing here touches a column the running Core writes, so it is safe to apply before the container
-- swap (deploy.sh migrates first). The foreign keys on columns the old Core already writes
-- (preview_sha256, art_sha256, source_sha256, sha256, hawa_sha256, designer_sha256) come in the next
-- migration, one release later, once the copy backfill has run: a foreign key now would break the old
-- Core's inserts during the deploy window.
--
-- Every statement can run twice (psql by hand after the runner): IF NOT EXISTS, OR REPLACE, or a DROP
-- IF EXISTS just before.
BEGIN;

-- 1. One row per stored file. No tenant and no row-level security: a hash reveals nothing, and every
--    route authorises on the referencing row, which carries the tenant (ADR-035 section 2.4).
CREATE TABLE IF NOT EXISTS hawa.blobs (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size bigint NOT NULL CHECK (size BETWEEN 1 AND 104857600),
  media_type text NOT NULL CHECK (media_type IN ('image/png','image/jpeg','image/webp','image/gif','application/pdf',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation')),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Set by the garbage collector's mark phase when nothing references the file, cleared when something
  -- does again or the file is stored again. The grace period runs from here, not from created_at: a
  -- month-old picture that lost its last reference yesterday is still in yesterday's dump.
  unreferenced_since timestamptz
);
CREATE INDEX IF NOT EXISTS blobs_unreferenced_idx ON hawa.blobs(unreferenced_since) WHERE unreferenced_since IS NOT NULL;

CREATE OR REPLACE FUNCTION hawa.protect_blob() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.sha256, NEW.size, NEW.media_type, NEW.created_at) IS DISTINCT FROM (OLD.sha256, OLD.size, OLD.media_type, OLD.created_at) THEN
    RAISE EXCEPTION 'A blob row is immutable except unreferenced_since' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_blob ON hawa.blobs;
CREATE TRIGGER protect_blob BEFORE UPDATE ON hawa.blobs FOR EACH ROW EXECUTE FUNCTION hawa.protect_blob();

REVOKE ALL ON hawa.blobs FROM PUBLIC;
-- The template and 03-grants.sql grant every table in the schema; this table gets exactly these.
REVOKE ALL ON hawa.blobs FROM hawa_app;
GRANT SELECT, INSERT ON hawa.blobs TO hawa_app;
-- put() clears the mark of a file stored again. No DELETE: only the collector's functions delete.
GRANT UPDATE (unreferenced_since) ON hawa.blobs TO hawa_app;

-- 2. The referencing row for pictures in payloads: task_events is append-only JSON and cannot hold a
--    foreign key, so each reference photo of a task gets a row here that can.
CREATE TABLE IF NOT EXISTS hawa.task_files (
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  sha256 text NOT NULL REFERENCES hawa.blobs(sha256) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('reference_image')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, task_id, role, sha256),
  FOREIGN KEY (tenant_id, task_id) REFERENCES hawa.tasks(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS task_files_sha_idx ON hawa.task_files(sha256);
ALTER TABLE hawa.task_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.task_files FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS task_files_tenant_scope ON hawa.task_files;
CREATE POLICY task_files_tenant_scope ON hawa.task_files
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE ALL ON hawa.task_files FROM PUBLIC;
REVOKE ALL ON hawa.task_files FROM hawa_app;
GRANT SELECT, INSERT ON hawa.task_files TO hawa_app;

-- 3. New hash columns the old Core never writes, so their foreign keys are safe now.
ALTER TABLE hawa.design_studio_candidates ADD COLUMN IF NOT EXISTS composite_sha256 text
  REFERENCES hawa.blobs(sha256) ON DELETE RESTRICT CHECK (composite_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE hawa.photo_cutouts
  ADD COLUMN IF NOT EXISTS png_sha256 text REFERENCES hawa.blobs(sha256) ON DELETE RESTRICT CHECK (png_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS shadow_sha256 text REFERENCES hawa.blobs(sha256) ON DELETE RESTRICT CHECK (shadow_sha256 ~ '^[0-9a-f]{64}$');

-- Indexes for the RESTRICT checks and for the mark phase's lookups, one per referencing column.
CREATE INDEX IF NOT EXISTS dsc_preview_sha_idx ON hawa.design_studio_candidates(preview_sha256);
CREATE INDEX IF NOT EXISTS dsc_composite_sha_idx ON hawa.design_studio_candidates(composite_sha256);
CREATE INDEX IF NOT EXISTS dsc_art_sha_idx ON hawa.design_studio_candidates(art_sha256);
CREATE INDEX IF NOT EXISTS canva_plan_source_sha_idx ON hawa.canva_design_plans(source_sha256);
CREATE INDEX IF NOT EXISTS canva_editable_sha_idx ON hawa.canva_editable_sources(sha256);
CREATE INDEX IF NOT EXISTS photo_cutouts_png_sha_idx ON hawa.photo_cutouts(png_sha256);
CREATE INDEX IF NOT EXISTS photo_cutouts_shadow_sha_idx ON hawa.photo_cutouts(shadow_sha256);
CREATE INDEX IF NOT EXISTS comparison_pairs_hawa_sha_idx ON hawa.comparison_pairs(hawa_sha256);
CREATE INDEX IF NOT EXISTS comparison_pairs_designer_sha_idx ON hawa.comparison_pairs(designer_sha256);

-- 4. Let the new code stop writing inline bytes. The old code still writes them, which is harmless.
ALTER TABLE hawa.canva_editable_sources ALTER COLUMN content DROP NOT NULL;
ALTER TABLE hawa.comparison_pairs ALTER COLUMN hawa_png DROP NOT NULL, ALTER COLUMN designer_png DROP NOT NULL;
ALTER TABLE hawa.photo_cutouts ALTER COLUMN png DROP NOT NULL;
ALTER TABLE hawa.photo_cutouts DROP CONSTRAINT IF EXISTS photo_cutouts_png_somewhere;
ALTER TABLE hawa.photo_cutouts ADD CONSTRAINT photo_cutouts_png_somewhere CHECK (png IS NOT NULL OR png_sha256 IS NOT NULL);
-- 007's unnamed "a planned plan has its source bytes" CHECK becomes "a planned plan has its source hash".
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'hawa.canva_design_plans'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%planned%' AND pg_get_constraintdef(oid) LIKE '%source_content IS NOT NULL%'
  LOOP
    EXECUTE format('ALTER TABLE hawa.canva_design_plans DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE hawa.canva_design_plans DROP CONSTRAINT IF EXISTS canva_plan_planned_has_source;
ALTER TABLE hawa.canva_design_plans ADD CONSTRAINT canva_plan_planned_has_source
  CHECK (status <> 'planned' OR (result IS NOT NULL AND source_sha256 IS NOT NULL));

-- 5. Every reference to a stored file, in one place, for the garbage collector and the nightly
--    backup's check. A test (packages/db/test/blob-gc.test.ts) fails when a foreign key to hawa.blobs
--    exists that this view does not read. It is read as its owner, who bypasses row-level security,
--    so the application role gets no access to it: it would list every tenant's files.
CREATE OR REPLACE VIEW hawa.blob_references AS
  SELECT sha256 FROM hawa.task_files
  UNION ALL SELECT preview_sha256   FROM hawa.design_studio_candidates WHERE preview_sha256 IS NOT NULL
  UNION ALL SELECT composite_sha256 FROM hawa.design_studio_candidates WHERE composite_sha256 IS NOT NULL
  UNION ALL SELECT art_sha256       FROM hawa.design_studio_candidates WHERE art_sha256 IS NOT NULL
  UNION ALL SELECT source_sha256    FROM hawa.canva_design_plans WHERE source_sha256 IS NOT NULL
  UNION ALL SELECT sha256           FROM hawa.canva_editable_sources
  UNION ALL SELECT png_sha256       FROM hawa.photo_cutouts WHERE png_sha256 IS NOT NULL
  UNION ALL SELECT shadow_sha256    FROM hawa.photo_cutouts WHERE shadow_sha256 IS NOT NULL
  UNION ALL SELECT hawa_sha256      FROM hawa.comparison_pairs
  UNION ALL SELECT designer_sha256  FROM hawa.comparison_pairs;
REVOKE ALL ON hawa.blob_references FROM PUBLIC;
REVOKE ALL ON hawa.blob_references FROM hawa_app;

-- 6. The garbage collector: mark and sweep with a grace period (ADR-035 section 2.3), no reference
--    counts. The functions run as their owner (SECURITY DEFINER), so the application role can run the
--    collector (apps/core/src/tools/blob-gc.ts) without DELETE on hawa.blobs or access to the view.
--    Under FORCE ROW LEVEL SECURITY an owner that does not bypass it would see every referencing table
--    empty and mark every file unreferenced, so each function first refuses such an owner.
CREATE OR REPLACE FUNCTION hawa.blob_gc_assert_owner() RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, hawa AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'The blob collector must run as a role that bypasses row-level security (running as %)', current_user
      USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION hawa.blob_gc_assert_owner() FROM PUBLIC;

-- Mark: stamp unreferenced_since on files nothing references, and clear it on files referenced again.
CREATE OR REPLACE FUNCTION hawa.blob_gc_mark(OUT marked bigint, OUT cleared bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hawa AS $$
BEGIN
  PERFORM hawa.blob_gc_assert_owner();
  UPDATE hawa.blobs b SET unreferenced_since = now()
    WHERE b.unreferenced_since IS NULL AND NOT EXISTS (SELECT 1 FROM hawa.blob_references r WHERE r.sha256 = b.sha256);
  GET DIAGNOSTICS marked = ROW_COUNT;
  UPDATE hawa.blobs b SET unreferenced_since = NULL
    WHERE b.unreferenced_since IS NOT NULL AND EXISTS (SELECT 1 FROM hawa.blob_references r WHERE r.sha256 = b.sha256);
  GET DIAGNOSTICS cleared = ROW_COUNT;
END $$;

-- Sweep: delete up to p_limit rows unreferenced for longer than the grace period (and older than it),
-- and return them, so the caller unlinks their files after this commits. Anything referenced again
-- since the mark is skipped; the foreign keys are the safety net for a reference the view missed.
CREATE OR REPLACE FUNCTION hawa.blob_gc_sweep(p_grace interval, p_limit integer DEFAULT 500)
RETURNS TABLE(sha256 text, media_type text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hawa AS $$
#variable_conflict use_column
DECLARE r record;
BEGIN
  PERFORM hawa.blob_gc_assert_owner();
  IF p_grace IS NULL OR p_grace < interval '7 days' THEN
    RAISE EXCEPTION 'The blob grace period must be at least 7 days (got %)', p_grace USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'The blob sweep limit must be between 1 and 10000 (got %)', p_limit USING ERRCODE = '22023';
  END IF;
  FOR r IN
    SELECT b.sha256 AS h, b.media_type AS t FROM hawa.blobs b
    WHERE b.unreferenced_since < now() - p_grace AND b.created_at < now() - p_grace
    ORDER BY b.unreferenced_since LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM hawa.blob_references x WHERE x.sha256 = r.h);
    BEGIN
      DELETE FROM hawa.blobs b WHERE b.sha256 = r.h;
      sha256 := r.h;
      media_type := r.t;
      RETURN NEXT;
    EXCEPTION WHEN foreign_key_violation THEN
      NULL;
    END;
  END LOOP;
END $$;

-- Claim: before unlinking a file, the collector takes this lock and learns whether its row is still
-- gone, and unlinks inside the same transaction. put() holds the same lock shared while it inserts the
-- row and renames the file into place, so either the writer comes after the unlink and writes the file
-- again, or the collector sees the row the writer inserted and keeps the file.
CREATE OR REPLACE FUNCTION hawa.blob_gc_claim_unlink(p_sha256 text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hawa AS $$
BEGIN
  PERFORM hawa.blob_gc_assert_owner();
  IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Not a blob hash' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hawa.blob:' || p_sha256, 0));
  RETURN NOT EXISTS (SELECT 1 FROM hawa.blobs b WHERE b.sha256 = p_sha256);
END $$;

-- Every referenced hash, for the store check (blob-verify) run as the application role.
CREATE OR REPLACE FUNCTION hawa.blob_reference_hashes() RETURNS SETOF text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, hawa AS $$
BEGIN
  PERFORM hawa.blob_gc_assert_owner();
  RETURN QUERY SELECT DISTINCT r.sha256 FROM hawa.blob_references r;
END $$;

REVOKE ALL ON FUNCTION hawa.blob_gc_mark() FROM PUBLIC;
REVOKE ALL ON FUNCTION hawa.blob_gc_sweep(interval, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION hawa.blob_gc_claim_unlink(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hawa.blob_reference_hashes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.blob_gc_mark() TO hawa_app;
GRANT EXECUTE ON FUNCTION hawa.blob_gc_sweep(interval, integer) TO hawa_app;
GRANT EXECUTE ON FUNCTION hawa.blob_gc_claim_unlink(text) TO hawa_app;
GRANT EXECUTE ON FUNCTION hawa.blob_reference_hashes() TO hawa_app;
COMMIT;
