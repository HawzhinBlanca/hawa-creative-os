-- Rollback Migration 001: Canva Native Studio Bindings & Artifact Capture Sets
BEGIN;

DROP TABLE IF EXISTS hawa.canva_capture_sets CASCADE;
DROP TABLE IF EXISTS hawa.canva_bindings CASCADE;

COMMIT;
