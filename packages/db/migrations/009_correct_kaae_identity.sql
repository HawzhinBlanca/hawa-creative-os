BEGIN;
-- Correct the seeded expansion using the client's original BRAND GUIDLINES.pdf.
-- Only the known erroneous value for the office's existing KAAE identity is changed.
UPDATE hawa.clients SET name='Kurdistan Accrediting Association for Education'
WHERE tenant_id='00000000-0000-4000-a000-000000000001'::uuid
  AND id='c1000000-0000-4000-8000-000000000002'::uuid
  AND code='kaae' AND name='Kurdistan Arts & Architecture Enterprise';
COMMIT;
