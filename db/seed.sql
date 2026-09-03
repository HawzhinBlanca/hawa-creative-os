BEGIN;
SET search_path = hawa, public;

INSERT INTO model_roles(role,description,critical) VALUES
 ('intake_router','Resolve allowed client/project/task labels and abstain on ambiguity',true),
 ('brief_builder','Extract an exact, typed design brief without inventing facts',true),
 ('creative_director','Plan composition, topology, assets, and editable design operations',false),
 ('visual_judge','Evaluate rendered design against a fixed rubric; advisory only',false),
 ('feedback_classifier','Classify corrections into scoped structured events',false),
 ('rule_miner','Propose conservative Client DNA rules from evidence',false),
 ('image_general','Generate or edit general raster imagery',false),
 ('image_vector','Generate vector-first graphical assets',false),
 ('image_local','Generate/edit assets on office hardware',false),
 ('embedding_multimodal','Embed text/images/documents for client-scoped retrieval',true),
 ('reranker_multimodal','Rerank client-scoped multimodal retrieval candidates',true)
ON CONFLICT (role) DO NOTHING;

INSERT INTO qc_profiles(tenant_id,name,version,rules,content_hash,status)
VALUES (NULL,'office-critical','1.0.0',
  '{"critical":["editable_source","exact_copy","facts","client_scope","approved_assets","dimensions","rtl_glyphs","approval_binding"],"autoRepairMax":2}'::jsonb,
  encode(digest('{"profile":"office-critical","version":"1.0.0"}','sha256'),'hex'),
  'active')
ON CONFLICT (tenant_id,name,version) DO NOTHING;

COMMIT;
