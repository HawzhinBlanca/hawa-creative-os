-- A judge who loses their link gets a new one on the same judge record (2026-09-24 review). The only
-- way was to revoke the link and add the judge again, which made a new judge id: every pair they had
-- judged came round again with fresh sides, and both of their answers counted. A new link now replaces
-- the token's hash on the judge's own row, so their judgements stay theirs, one per pair, and they
-- resume where they stopped. A revoked link still stays revoked, and nothing else about a judge changes.
ALTER TABLE hawa.comparison_judges ADD COLUMN IF NOT EXISTS link_reissued_at timestamptz;

CREATE OR REPLACE FUNCTION hawa.protect_comparison_judge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Comparison judges are never deleted; revoke the link instead';
  END IF;
  IF (NEW.id, NEW.study_id, NEW.tenant_id, NEW.name, NEW.kind, NEW.created_at)
    IS DISTINCT FROM (OLD.id, OLD.study_id, OLD.tenant_id, OLD.name, OLD.kind, OLD.created_at) THEN
    RAISE EXCEPTION 'Only a comparison judge''s link can be replaced or revoked';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.token_sha256 IS DISTINCT FROM OLD.token_sha256) THEN
    RAISE EXCEPTION 'A revoked judge link stays revoked';
  END IF;
  IF NEW.token_sha256 IS DISTINCT FROM OLD.token_sha256 AND NEW.link_reissued_at IS NOT DISTINCT FROM OLD.link_reissued_at THEN
    RAISE EXCEPTION 'A judge''s new link is recorded with the time it was issued';
  END IF;
  RETURN NEW;
END $$;
