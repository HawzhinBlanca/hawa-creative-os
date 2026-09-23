BEGIN;
-- Blinded comparison of Hawa with the office's designer (output/plans/2026-09-23-designer-grade-revisions,
-- "Blinded comparison with the office designer: protocol"). People who cannot tell which design is
-- which decide the claim, never a model. A study is written down (its pre-registration) and locked
-- before any pair is judged; after the lock its plan and its pairs cannot change, and judgements
-- are append-only. Judges have no account: each has a link whose token is stored only as a SHA-256.

-- 1. Studies. The pre-registration is the written plan: sample, judges, analysis and the threshold.
CREATE TABLE IF NOT EXISTS hawa.comparison_studies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'judging', 'closed')),
  preregistration jsonb NOT NULL CHECK (jsonb_typeof(preregistration) = 'object'),
  locked_at timestamptz,
  closed_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK ((status = 'draft') = (locked_at IS NULL)),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

-- 2. Pairs: the two finished designs for one request, stored as re-encoded PNGs (no metadata), with
-- a neutral label that only the office sees. Both images of a pair have the same size.
CREATE TABLE IF NOT EXISTS hawa.comparison_pairs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  task_id uuid,
  label text NOT NULL CHECK (label ~ '^[A-Za-z0-9-]{1,12}$'),
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  hawa_png bytea NOT NULL CHECK (octet_length(hawa_png) BETWEEN 8 AND 15728640),
  designer_png bytea NOT NULL CHECK (octet_length(designer_png) BETWEEN 8 AND 15728640),
  hawa_sha256 text NOT NULL,
  designer_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (study_id, id),
  UNIQUE (study_id, label),
  CHECK (hawa_sha256 = encode(sha256(hawa_png), 'hex')),
  CHECK (designer_sha256 = encode(sha256(designer_png), 'hex')),
  -- The same file twice is a mistake, not a pair.
  CHECK (hawa_sha256 <> designer_sha256),
  FOREIGN KEY (tenant_id, study_id) REFERENCES hawa.comparison_studies(tenant_id, id)
);

-- 3. Judges: the requesters who sent the briefs and designers from outside the office.
CREATE TABLE IF NOT EXISTS hawa.comparison_judges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  kind text NOT NULL CHECK (kind IN ('requester', 'designer')),
  token_sha256 text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (study_id, id),
  FOREIGN KEY (tenant_id, study_id) REFERENCES hawa.comparison_studies(tenant_id, id)
);

-- 4. Judgements: one per judge and pair. Which arm was shown on the left is recorded by the server,
-- and the preferred arm is derived from it here, so it can never disagree with the choice.
CREATE TABLE IF NOT EXISTS hawa.comparison_judgments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL,
  pair_id uuid NOT NULL,
  judge_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  shown_left text NOT NULL CHECK (shown_left IN ('hawa', 'designer')),
  choice text NOT NULL CHECK (choice IN ('left', 'right', 'none')),
  preferred text GENERATED ALWAYS AS (
    CASE
      WHEN choice = 'none' THEN NULL
      WHEN choice = 'left' THEN shown_left
      WHEN shown_left = 'hawa' THEN 'designer'
      ELSE 'hawa'
    END
  ) STORED,
  seen_before boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pair_id, judge_id),
  FOREIGN KEY (tenant_id, study_id) REFERENCES hawa.comparison_studies(tenant_id, id),
  FOREIGN KEY (study_id, pair_id) REFERENCES hawa.comparison_pairs(study_id, id),
  FOREIGN KEY (study_id, judge_id) REFERENCES hawa.comparison_judges(study_id, id)
);
CREATE INDEX IF NOT EXISTS comparison_judgments_study ON hawa.comparison_judgments(study_id);

-- Row-level security: every table is scoped to the tenant the transaction names. The judges table
-- is not FORCEd, like the membership tables in db/rls.sql: the token lookup below is a SECURITY
-- DEFINER function owned by the migration owner, and it must read the table before any tenant is
-- known. hawa_app does not own the table and stays subject to the policy.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['comparison_studies', 'comparison_pairs', 'comparison_judges', 'comparison_judgments'] LOOP
    EXECUTE format('ALTER TABLE hawa.%I ENABLE ROW LEVEL SECURITY', t);
    IF t <> 'comparison_judges' THEN
      EXECUTE format('ALTER TABLE hawa.%I FORCE ROW LEVEL SECURITY', t);
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS %I ON hawa.%I', t || '_tenant_scope', t);
    EXECUTE format('CREATE POLICY %I ON hawa.%I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', t || '_tenant_scope', t);
  END LOOP;
END $$;

-- A study's plan is fixed once judging starts, and its status only moves forward:
-- draft -> judging -> closed. Nothing is ever deleted once it has been locked.
CREATE OR REPLACE FUNCTION hawa.protect_comparison_study() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'A comparison study that has been locked cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'A comparison study''s identity is immutable';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.name, NEW.preregistration, NEW.locked_at) IS DISTINCT FROM (OLD.name, OLD.preregistration, OLD.locked_at) THEN
    RAISE EXCEPTION 'The pre-registration of a locked comparison study cannot change';
  END IF;
  IF NOT ((OLD.status = NEW.status) OR (OLD.status = 'draft' AND NEW.status = 'judging') OR (OLD.status = 'judging' AND NEW.status = 'closed')) THEN
    RAISE EXCEPTION 'A comparison study cannot move from % to %', OLD.status, NEW.status;
  END IF;
  IF OLD.status = 'closed' AND NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
    RAISE EXCEPTION 'A closed comparison study is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_comparison_study ON hawa.comparison_studies;
CREATE TRIGGER protect_comparison_study BEFORE UPDATE OR DELETE ON hawa.comparison_studies
  FOR EACH ROW EXECUTE FUNCTION hawa.protect_comparison_study();

-- Pairs can be added, changed or removed only while the study is a draft. The service refuses first,
-- with a plain message; this is the backstop for anything that reaches the table another way.
CREATE OR REPLACE FUNCTION hawa.protect_comparison_pair() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE study_status text;
BEGIN
  SELECT s.status INTO study_status FROM hawa.comparison_studies s
    WHERE s.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.study_id ELSE NEW.study_id END;
  IF study_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Pairs of a comparison study cannot change once judging has started (status: %)', coalesce(study_status, 'unknown');
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.study_id IS DISTINCT FROM OLD.study_id THEN
    RAISE EXCEPTION 'A pair cannot move to another study';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS protect_comparison_pair ON hawa.comparison_pairs;
CREATE TRIGGER protect_comparison_pair BEFORE INSERT OR UPDATE OR DELETE ON hawa.comparison_pairs
  FOR EACH ROW EXECUTE FUNCTION hawa.protect_comparison_pair();

-- A judge's link can only be revoked: the name, kind and token hash never change afterwards.
CREATE OR REPLACE FUNCTION hawa.protect_comparison_judge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Comparison judges are never deleted; revoke the link instead';
  END IF;
  IF (NEW.id, NEW.study_id, NEW.tenant_id, NEW.name, NEW.kind, NEW.token_sha256, NEW.created_at)
    IS DISTINCT FROM (OLD.id, OLD.study_id, OLD.tenant_id, OLD.name, OLD.kind, OLD.token_sha256, OLD.created_at) THEN
    RAISE EXCEPTION 'Only a comparison judge''s revocation can be recorded';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'A revoked judge link stays revoked';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_comparison_judge ON hawa.comparison_judges;
CREATE TRIGGER protect_comparison_judge BEFORE UPDATE OR DELETE ON hawa.comparison_judges
  FOR EACH ROW EXECUTE FUNCTION hawa.protect_comparison_judge();

-- Judgements are append-only, and only accepted while the study is judging and the judge's link is live.
CREATE OR REPLACE FUNCTION hawa.protect_comparison_judgment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE study_status text; judge_revoked timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Comparison judgements are append-only';
  END IF;
  SELECT s.status INTO study_status FROM hawa.comparison_studies s WHERE s.id = NEW.study_id;
  IF study_status IS DISTINCT FROM 'judging' THEN
    RAISE EXCEPTION 'The comparison study is not judging (status: %)', coalesce(study_status, 'unknown');
  END IF;
  SELECT j.revoked_at INTO judge_revoked FROM hawa.comparison_judges j WHERE j.id = NEW.judge_id;
  IF judge_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'This judge link has been revoked';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_comparison_judgment ON hawa.comparison_judgments;
CREATE TRIGGER protect_comparison_judgment BEFORE INSERT OR UPDATE OR DELETE ON hawa.comparison_judgments
  FOR EACH ROW EXECUTE FUNCTION hawa.protect_comparison_judgment();

-- A judge's link carries only its token. This resolves the token's hash to the judge's tenant, study
-- and id, for a link that has not been revoked, and nothing else: every later read runs under that
-- tenant with row-level security, like any other request.
CREATE OR REPLACE FUNCTION hawa.comparison_judge_by_token(p_token_sha256 text)
RETURNS TABLE (tenant_id uuid, study_id uuid, judge_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = hawa, public AS $$
  SELECT j.tenant_id, j.study_id, j.id FROM hawa.comparison_judges j
  WHERE j.token_sha256 = p_token_sha256 AND j.revoked_at IS NULL
$$;
REVOKE ALL ON FUNCTION hawa.comparison_judge_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.comparison_judge_by_token(text) TO hawa_app;

GRANT SELECT, INSERT, UPDATE ON hawa.comparison_studies TO hawa_app;
GRANT SELECT, INSERT ON hawa.comparison_pairs TO hawa_app;
GRANT SELECT, INSERT, UPDATE ON hawa.comparison_judges TO hawa_app;
GRANT SELECT, INSERT ON hawa.comparison_judgments TO hawa_app;
COMMIT;
