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

-- Default tenant
INSERT INTO tenants (id, name, slug, timezone)
VALUES ('00000000-0000-4000-a000-000000000001'::uuid, 'Hawa Office', 'hawa-office', 'Asia/Baghdad')
ON CONFLICT (id) DO NOTHING;

-- Default users
INSERT INTO users (id, email, display_name)
VALUES 
  ('00000000-0000-4000-b000-000000000001'::uuid, 'operator@hawa.office', 'Primary Operator'),
  ('00000000-0000-4000-b000-000000000002'::uuid, 'artdirector@hawa.office', 'Art Director')
ON CONFLICT (id) DO NOTHING;

-- Tenant memberships
INSERT INTO tenant_memberships (tenant_id, user_id, role, active)
VALUES
  ('00000000-0000-4000-a000-000000000001'::uuid, '00000000-0000-4000-b000-000000000001'::uuid, 'operator', true),
  ('00000000-0000-4000-a000-000000000001'::uuid, '00000000-0000-4000-b000-000000000002'::uuid, 'administrator', true)
ON CONFLICT (tenant_id, user_id, role) DO NOTHING;

-- Canonical Clients
INSERT INTO clients (id, tenant_id, code, name, default_language, status)
VALUES
  ('c1000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-a000-000000000001'::uuid, 'hawa', 'Hawa Studio / Office', 'en', 'active'),
  ('c1000000-0000-4000-8000-000000000002'::uuid, '00000000-0000-4000-a000-000000000001'::uuid, 'kaae', 'Kurdistan Arts & Architecture Enterprise', 'ckb', 'active'),
  ('c1000000-0000-4000-8000-000000000003'::uuid, '00000000-0000-4000-a000-000000000001'::uuid, 'drustee', 'Drustee Brand', 'ckb', 'active'),
  ('c1000000-0000-4000-8000-000000000004'::uuid, '00000000-0000-4000-a000-000000000001'::uuid, 'fastpay', 'FastPay FinTech', 'en', 'active')
ON CONFLICT (id) DO NOTHING;

-- Client memberships
INSERT INTO client_memberships (tenant_id, client_id, user_id, role, active)
VALUES
  ('00000000-0000-4000-a000-000000000001'::uuid, 'c1000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-b000-000000000001'::uuid, 'operator', true),
  ('00000000-0000-4000-a000-000000000001'::uuid, 'c1000000-0000-4000-8000-000000000002'::uuid, '00000000-0000-4000-b000-000000000001'::uuid, 'operator', true),
  ('00000000-0000-4000-a000-000000000001'::uuid, 'c1000000-0000-4000-8000-000000000003'::uuid, '00000000-0000-4000-b000-000000000001'::uuid, 'operator', true),
  ('00000000-0000-4000-a000-000000000001'::uuid, 'c1000000-0000-4000-8000-000000000004'::uuid, '00000000-0000-4000-b000-000000000001'::uuid, 'operator', true)
ON CONFLICT (client_id, user_id, role) DO NOTHING;

COMMIT;
