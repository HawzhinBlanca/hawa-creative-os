# Runbook: Backup and Clean-Host Restore

## Backup verification

- pgBackRest backup and archive checks pass;
- restic repository check passes;
- last backup age and off-site copy are within policy;
- secrets are not present in unencrypted config backup;
- evidence is recorded in Hawa Desk operations.

## Quarterly restore

1. Provision isolated clean host/VM.
2. Select a target timestamp and record start.
3. Restore PostgreSQL through the documented PITR process.
4. Restore application/staging/config assets through restic.
5. inject secrets through approved channel;
6. start exact pinned service versions;
7. verify schema/migrations and row counts;
8. authenticate test user and inspect clients/tasks/audit;
9. open/render representative English/Sorani/Arabic sources;
10. resume a paused workflow with side-effect protection;
11. reconcile Drive/Sheet read-only then repair test records;
12. record actual RPO/RTO and sign pass/fail.

A backup chain that has not been restored is unproven.
