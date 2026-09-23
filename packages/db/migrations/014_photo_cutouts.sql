-- Person cut-outs made from client photos (ADR-032). One row per photo and model, so the same photo
-- is never cut twice, and every cut-out keeps where it came from: the source's hash, the model and
-- its hash, and the checks it passed or failed. A failed cut-out is kept too, so it is not retried
-- on every stage of a run and the requester can be told why their photo stayed framed.
CREATE TABLE IF NOT EXISTS hawa.photo_cutouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  model text NOT NULL,
  model_sha256 text NOT NULL CHECK (model_sha256 ~ '^[0-9a-f]{64}$'),
  passed boolean NOT NULL,
  png bytea NOT NULL,
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  shadow_png bytea,
  shadow jsonb,
  report jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_sha256, model_sha256)
);

ALTER TABLE hawa.photo_cutouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.photo_cutouts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS photo_cutouts_tenant_scope ON hawa.photo_cutouts;
CREATE POLICY photo_cutouts_tenant_scope ON hawa.photo_cutouts
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT ON hawa.photo_cutouts TO hawa_app;
