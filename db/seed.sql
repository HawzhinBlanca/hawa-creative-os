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
  ('00000000-0000-4000-b000-000000000002'::uuid, 'artdirector@hawa.office', 'Art Director'),
  -- Service identities (ADR-027): rows nobody pressed a button for are not attributed to a person.
  ('00000000-0000-4000-b000-000000000010'::uuid, 'ingress@hawa.office', 'Channel Ingress'),
  ('00000000-0000-4000-b000-000000000011'::uuid, 'automation@hawa.office', 'System Automation')
ON CONFLICT (id) DO NOTHING;

-- Tenant memberships
INSERT INTO tenant_memberships (tenant_id, user_id, role, active)
VALUES
  ('00000000-0000-4000-a000-000000000001'::uuid, '00000000-0000-4000-b000-000000000001'::uuid, 'operator', true),
  ('00000000-0000-4000-a000-000000000001'::uuid, '00000000-0000-4000-b000-000000000002'::uuid, 'administrator', true),
  ('00000000-0000-4000-a000-000000000001'::uuid, '00000000-0000-4000-b000-000000000010'::uuid, 'operator', true),
  ('00000000-0000-4000-a000-000000000001'::uuid, '00000000-0000-4000-b000-000000000011'::uuid, 'operator', true)
ON CONFLICT (tenant_id, user_id, role) DO NOTHING;

-- Test and multi-tenant isolation fixtures
INSERT INTO tenants (id, name, slug, timezone)
VALUES 
  ('00000000-0000-4000-a000-000000000005'::uuid, 'Test Tenant 5', 'test-tenant-5', 'Asia/Baghdad'),
  ('00000000-0000-4000-a000-000000000006'::uuid, 'Test Tenant 6', 'test-tenant-6', 'Asia/Baghdad'),
  ('00000000-0000-4000-a000-000000000007'::uuid, 'Test Tenant 7', 'test-tenant-7', 'Asia/Baghdad'),
  ('00000000-0000-4000-a000-000000000008'::uuid, 'Test Tenant 8', 'test-tenant-8', 'Asia/Baghdad')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tenant_memberships (tenant_id, user_id, role, active)
SELECT t.id, u.id, 'operator'::membership_role, true
FROM (
  VALUES 
    ('00000000-0000-4000-a000-000000000005'::uuid),
    ('00000000-0000-4000-a000-000000000006'::uuid),
    ('00000000-0000-4000-a000-000000000007'::uuid),
    ('00000000-0000-4000-a000-000000000008'::uuid)
) AS t(id)
CROSS JOIN (
  VALUES
    ('00000000-0000-4000-b000-000000000001'::uuid),
    ('00000000-0000-4000-b000-000000000010'::uuid),
    ('00000000-0000-4000-b000-000000000011'::uuid)
) AS u(id)
ON CONFLICT (tenant_id, user_id, role) DO NOTHING;

-- Canonical Clients
INSERT INTO clients (id, tenant_id, code, name, default_language, status)
VALUES
  ('c1000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-a000-000000000001'::uuid, 'hawa', 'Hawa Studio / Office', 'en', 'active'),
  ('c1000000-0000-4000-8000-000000000002'::uuid, '00000000-0000-4000-a000-000000000001'::uuid, 'kaae', 'Kurdistan Accrediting Association for Education', 'ckb', 'active'),
  ('c1000000-0000-4000-8000-000000000003'::uuid, '00000000-0000-4000-a000-000000000001'::uuid, 'drustee', 'Drustee Brand', 'ckb', 'active'),
  ('c1000000-0000-4000-8000-000000000004'::uuid, '00000000-0000-4000-a000-000000000001'::uuid, 'fastpay', 'FastPay FinTech', 'en', 'active'),
  -- Clients being set up (ADR-127, packages/creative/assets/clients). Core inserts the same rows at
  -- start-up where they are missing; these make a fresh database match from the first request.
  ('c1000000-0000-4000-8000-000000000011'::uuid, '00000000-0000-4000-a000-000000000001'::uuid, 'zar-podcast', 'ZAR Podcast', 'en', 'active'),
  ('c1000000-0000-4000-8000-000000000012'::uuid, '00000000-0000-4000-a000-000000000001'::uuid, 'halwest-news', 'Halwest News', 'en', 'active'),
  ('c1000000-0000-4000-8000-000000000013'::uuid, '00000000-0000-4000-a000-000000000001'::uuid, 'kawa-ba-hawlery', 'Kawa ba Hawlery', 'en', 'active'),
  ('c1000000-0000-4000-8000-000000000014'::uuid, '00000000-0000-4000-a000-000000000001'::uuid, 'erbil-edition', 'Erbil Edition', 'en', 'active'),
  -- The nightly live canary's test client (ADR-240, ADR-254; packages/creative/assets/clients/canary-test.json): never designed for
  -- automatically (an onboarding pack), no model consent, no Drive or Sheet.
  ('c1000000-0000-4000-8000-000000000099'::uuid, '00000000-0000-4000-a000-000000000001'::uuid, 'canary-test', 'Canary Test', 'en', 'active')
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
