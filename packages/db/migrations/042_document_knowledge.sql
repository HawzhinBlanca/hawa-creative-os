-- ADR-072: immutable, explicitly admitted projection of retained PDF text.
BEGIN;
ALTER TABLE hawa.client_documents ADD CONSTRAINT client_documents_scope_identity UNIQUE(tenant_id,client_id,id);

CREATE FUNCTION hawa.knowledge_search_text(input text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path=pg_catalog AS $$
  SELECT btrim(regexp_replace(regexp_replace(translate(lower(normalize(input,NFC)),
    'كي٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹،؛؟', 'کی01234567890123456789   '),
    '[ؐ-ًؚ-ٰٟۖ-ۭ]', '', 'g'), '[‌‍‎‏‪-‮⁦-⁩]', ' ', 'g'))
$$;

CREATE TABLE hawa.client_document_knowledge_events (
  action_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL, client_id uuid NOT NULL, document_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0), approved boolean NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES hawa.users(id),
  actor_display_name text NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,client_id,document_id) REFERENCES hawa.client_documents(tenant_id,client_id,id),
  UNIQUE(document_id,version)
);
CREATE INDEX client_document_knowledge_latest ON hawa.client_document_knowledge_events(tenant_id,client_id,document_id,version DESC);

CREATE TABLE hawa.client_document_knowledge_chunks (
  tenant_id uuid NOT NULL, client_id uuid NOT NULL, document_id uuid NOT NULL,
  chunk_index integer NOT NULL CHECK(chunk_index>=0), chunk_id uuid NOT NULL,
  content_original text NOT NULL CHECK(length(content_original)>0),
  content_search text GENERATED ALWAYS AS(hawa.knowledge_search_text(content_original)) STORED,
  search_vector tsvector GENERATED ALWAYS AS(to_tsvector('simple',hawa.knowledge_search_text(content_original))) STORED,
  chunk_sha256 text NOT NULL CHECK(chunk_sha256=encode(digest(content_original,'sha256'),'hex')),
  page_number integer CHECK(page_number>0), provenance jsonb NOT NULL,
  FOREIGN KEY(tenant_id,client_id,document_id) REFERENCES hawa.client_documents(tenant_id,client_id,id),
  PRIMARY KEY(document_id,chunk_index), UNIQUE(document_id,chunk_id)
);
CREATE INDEX client_document_knowledge_chunk_scope ON hawa.client_document_knowledge_chunks(tenant_id,client_id,document_id);
CREATE INDEX client_document_knowledge_fts ON hawa.client_document_knowledge_chunks USING gin(search_vector);
CREATE INDEX client_document_knowledge_trgm ON hawa.client_document_knowledge_chunks USING gin(content_search gin_trgm_ops);

ALTER TABLE hawa.client_document_knowledge_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.client_document_knowledge_events FORCE ROW LEVEL SECURITY;
ALTER TABLE hawa.client_document_knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE hawa.client_document_knowledge_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY document_knowledge_events_read ON hawa.client_document_knowledge_events FOR SELECT
  USING (tenant_id=hawa.current_tenant_id() AND EXISTS(SELECT 1 FROM hawa.clients c
    WHERE c.tenant_id=client_document_knowledge_events.tenant_id AND c.id=client_document_knowledge_events.client_id));
CREATE POLICY document_knowledge_chunks_read ON hawa.client_document_knowledge_chunks FOR SELECT
  USING (tenant_id=hawa.current_tenant_id() AND EXISTS(SELECT 1 FROM hawa.clients c
    WHERE c.tenant_id=client_document_knowledge_chunks.tenant_id AND c.id=client_document_knowledge_chunks.client_id));
CREATE TRIGGER document_knowledge_events_immutable BEFORE UPDATE OR DELETE ON hawa.client_document_knowledge_events
  FOR EACH ROW EXECUTE FUNCTION hawa.forbid_update_delete();
CREATE TRIGGER document_knowledge_chunks_immutable BEFORE UPDATE OR DELETE ON hawa.client_document_knowledge_chunks
  FOR EACH ROW EXECUTE FUNCTION hawa.forbid_update_delete();
REVOKE ALL ON hawa.client_document_knowledge_events,hawa.client_document_knowledge_chunks FROM PUBLIC,hawa_app;
GRANT SELECT ON hawa.client_document_knowledge_events,hawa.client_document_knowledge_chunks TO hawa_app;

CREATE FUNCTION hawa.lock_named_knowledge_manager(p_tenant uuid,p_client uuid,p_user uuid,p_session text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=hawa,pg_temp AS $$
BEGIN
  IF p_tenant IS DISTINCT FROM hawa.current_tenant_id() OR p_user IS DISTINCT FROM hawa.current_user_id()
    OR p_session IS NULL THEN RETURN false; END IF;
  PERFORM u.id FROM hawa.users u JOIN hawa.desk_sessions s ON s.user_id=u.id
    WHERE u.id=p_user AND u.disabled_at IS NULL AND u.external_subject IS NOT NULL
      AND s.tenant_id=p_tenant AND s.token_hash=p_session AND s.auth_method='google_oidc'
      AND s.revoked_at IS NULL AND s.expires_at>now() FOR SHARE OF u,s;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM hawa.tenant_memberships WHERE tenant_id=p_tenant AND user_id=p_user
    AND active AND role='administrator' FOR SHARE;
  IF FOUND THEN RETURN true; END IF;
  PERFORM 1 FROM hawa.tenant_memberships WHERE tenant_id=p_tenant AND user_id=p_user
    AND active AND role='client_dna_manager' FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM hawa.client_memberships WHERE tenant_id=p_tenant AND client_id=p_client
    AND user_id=p_user AND active AND role='client_dna_manager' FOR SHARE;
  RETURN FOUND;
END $$;

CREATE FUNCTION hawa.admit_document_knowledge(p_tenant uuid,p_client uuid,p_document uuid,p_user uuid,p_session text,
  p_action uuid,p_expected integer,p_approved boolean,p_source text,p_extraction text,p_reviewed boolean,p_reason text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=hawa,pg_temp AS $$
DECLARE source hawa.client_documents%ROWTYPE; prior hawa.client_document_knowledge_events%ROWTYPE;
  latest integer; fingerprint text; client_status text; result jsonb;
BEGIN
  IF NOT hawa.lock_named_knowledge_manager(p_tenant,p_client,p_user,p_session) THEN
    RAISE EXCEPTION 'Named client knowledge manager required' USING ERRCODE='42501'; END IF;
  IF p_action IS NULL OR p_expected IS NULL OR p_expected<0 OR p_approved IS NULL OR p_reviewed IS NULL
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000
    OR p_source IS NULL OR p_source !~ '^[a-f0-9]{64}$' OR p_extraction IS NULL OR p_extraction !~ '^[a-f0-9]{64}$'
    OR (p_approved AND NOT p_reviewed) THEN
    RAISE EXCEPTION 'Review the original, extraction limits and reason' USING ERRCODE='22023'; END IF;
  -- Lock action identity across documents as well as the immutable source across revisions.
  PERFORM pg_advisory_xact_lock(hashtextextended('knowledge-action:'||p_action::text,0));
  SELECT status INTO client_status FROM hawa.clients WHERE tenant_id=p_tenant AND id=p_client FOR SHARE;
  SELECT * INTO source FROM hawa.client_documents WHERE tenant_id=p_tenant AND client_id=p_client AND id=p_document FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document unavailable' USING ERRCODE='P0002'; END IF;
  IF source.source_sha256<>p_source OR source.extraction_sha256<>p_extraction THEN
    RAISE EXCEPTION 'Source evidence changed' USING ERRCODE='40001'; END IF;
  fingerprint:=encode(public.digest(jsonb_build_array(p_tenant,p_client,p_document,p_user,p_expected,p_approved,
    p_source,p_extraction,p_reviewed,p_reason)::text,'sha256'),'hex');
  SELECT * INTO prior FROM hawa.client_document_knowledge_events WHERE action_id=p_action;
  IF FOUND THEN
    IF prior.request_hash<>fingerprint THEN RAISE EXCEPTION 'Action identity already used' USING ERRCODE='40001'; END IF;
    RETURN jsonb_build_object('replayed',true,'action',to_jsonb(prior));
  END IF;
  SELECT coalesce(max(version),0) INTO latest FROM hawa.client_document_knowledge_events WHERE document_id=p_document;
  IF latest<>p_expected THEN RAISE EXCEPTION 'Knowledge version changed; refresh before deciding' USING ERRCODE='40001'; END IF;
  IF p_approved AND client_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Client is inactive' USING ERRCODE='40001'; END IF;
  IF p_approved THEN
    IF coalesce(jsonb_typeof(source.extraction_json::jsonb->'chunks'),'')<>'array'
      OR jsonb_array_length(source.extraction_json::jsonb->'chunks') NOT BETWEEN 1 AND 10000 THEN
      RAISE EXCEPTION 'Source has no bounded extractable text' USING ERRCODE='22023'; END IF;
    INSERT INTO hawa.client_document_knowledge_chunks(tenant_id,client_id,document_id,chunk_index,chunk_id,
      content_original,chunk_sha256,page_number,provenance)
      SELECT p_tenant,p_client,p_document,(n-1)::integer,(chunk->>'chunkId')::uuid,chunk->>'text',
        chunk->>'sha256',(chunk->>'pageNumber')::integer,chunk->'metadata'
      FROM jsonb_array_elements(source.extraction_json::jsonb->'chunks') WITH ORDINALITY AS items(chunk,n)
      ON CONFLICT(document_id,chunk_index) DO NOTHING;
  END IF;
  INSERT INTO hawa.client_document_knowledge_events(action_id,tenant_id,client_id,document_id,version,approved,actor_user_id,actor_display_name,request_hash,reason)
    VALUES(p_action,p_tenant,p_client,p_document,latest+1,p_approved,p_user,
      (SELECT display_name FROM hawa.users WHERE id=p_user),fingerprint,p_reason) RETURNING * INTO prior;
  result:=jsonb_build_object('replayed',false,'action',to_jsonb(prior));
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION hawa.lock_named_knowledge_manager(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.lock_named_knowledge_manager(uuid,uuid,uuid,text) TO hawa_app;
REVOKE ALL ON FUNCTION hawa.admit_document_knowledge(uuid,uuid,uuid,uuid,text,uuid,integer,boolean,text,text,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hawa.admit_document_knowledge(uuid,uuid,uuid,uuid,text,uuid,integer,boolean,text,text,boolean,text) TO hawa_app;
COMMIT;
