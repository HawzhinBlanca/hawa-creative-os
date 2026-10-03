-- number-reservation: migration 090 reserved 2026-10-03 (scripts/next_number.ts).
-- It refuses to run, so a deploy that reaches it stops before recording a checksum. Replace this file
-- with the migration before merging.
DO $$ BEGIN RAISE EXCEPTION 'migration 090 is a reservation stub, not a migration'; END $$;
