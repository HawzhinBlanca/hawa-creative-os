BEGIN;

-- Admission evidence is frozen even as a remote operation advances through its states.
CREATE OR REPLACE FUNCTION hawa.preserve_canva_export_policy() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.metadata->'checkingPolicy') IS DISTINCT FROM (OLD.metadata->'checkingPolicy') THEN
    RAISE EXCEPTION 'Canva export checking policy is immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS preserve_canva_export_policy ON hawa.canva_remote_operations;
CREATE TRIGGER preserve_canva_export_policy BEFORE UPDATE ON hawa.canva_remote_operations
FOR EACH ROW EXECUTE FUNCTION hawa.preserve_canva_export_policy();

-- Invoker scope/RLS applies. A replay may retain historical bytes, but fresh review,
-- approval and publication must still use active client policy.
CREATE OR REPLACE FUNCTION hawa.canva_export_policy_current(
  p_tenant uuid, p_client uuid, p_metadata jsonb
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE policy jsonb := p_metadata->'checkingPolicy'; current_row record;
BEGIN
  IF policy IS NULL OR policy->>'kind' IS DISTINCT FROM 'manual_client_dna' THEN RETURN true; END IF;
  IF policy->>'clientId' IS DISTINCT FROM p_client::text THEN RETURN false; END IF;
  SELECT version,content_hash,created_by INTO current_row FROM hawa.client_dna_versions
    WHERE tenant_id=p_tenant AND client_id=p_client AND status='active'
    ORDER BY version DESC LIMIT 1 FOR SHARE;
  RETURN FOUND AND current_row.created_by IS NOT NULL
    AND current_row.created_by NOT IN ('00000000-0000-4000-b000-000000000010'::uuid,'00000000-0000-4000-b000-000000000011'::uuid)
    AND current_row.version::text IS NOT DISTINCT FROM policy->>'dnaVersion'
    AND current_row.content_hash IS NOT DISTINCT FROM policy->>'dnaContentHash';
END;
$$;

COMMIT;
