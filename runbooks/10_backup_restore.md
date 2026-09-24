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

## The office's backups today (updated 2026-09-24, ADR-035)

What actually runs on the office Mac, and how to restore from it. The sections above describe the
target process for a clean host; this is the one in use.

### What is backed up, and where

- **Nightly, 03:30** (`infra/backup/nightly_backup.sh`, launch agent `design.hawa.nightly-backup`):
  1. `pg_dump` of the database, restored into a scratch database to prove it loads (task counts compared).
  2. From that restored copy, every file hash the dump references (`hawa.blob_references`) that has a
     `hawa.blobs` row. The run **fails** if any of them is not on disk in the file store (`~/.hawa/blobs`):
     the dump is kept, but a restore of it would miss those pictures or design sources. A referenced hash
     with no row is a picture whose bytes are still in the database itself (written before the backfill
     copied it out); it is counted as `refs_without_row` and does not fail the night. Once migration 020
     adds the foreign keys that count is always 0.
  3. A manifest of every file in the store right after the dump (`hawa_<stamp>.blobs`).
  4. The dump, encrypted, into the archive (`HAWA_BACKUP_ARCHIVE_DEST`, default `~/.hawa/snapshots_archive`).
  5. The files no earlier pack holds, as one encrypted pack `blobs/blobpack_<stamp>.tar.enc`, checked by
     decrypting it and hashing every file against its name; `blobs/index.tsv` says which pack holds each
     file. Files never change, so each is packed once.
  6. Retention: the archive keeps the 14 newest dumps (`HAWA_BACKUP_ARCHIVE_KEEP`) and their manifests; a
     pack is deleted once no kept manifest lists any file in it.
  7. Only then the file store's garbage collector (`blob-gc`, inside Core): files unreferenced for more
     than 15 days (`HAWA_BLOB_GRACE_DAYS`) are deleted. The script refuses to run when the retention is not
     shorter than the grace period, so every file a kept dump references is always on disk or in a pack.
     A collector failure is alerted but does not fail the backup.
  The log line in `infra/backup/snapshots/backup.log` reads
  `OK <stamp> bytes= tasks= events= sha256= dump_s= blobs= blob_bytes= new_blobs= refs_without_row= gc_deleted=`.
- **Pre-deploy dumps** (`infra/backup/snapshots/predeploy_*.dump`, written by `deploy.sh`) are rollback
  points for their own deploy only. They carry no file manifest and are not in the archive; restore from
  a nightly dump for anything else.
- The store's location is `~/.hawa/blobs` unless `HAWA_BLOBS_DIR` says otherwise. Compose and `deploy.sh`
  read it from the shell or `infra/docker/.env`; the nightly backup, `disk_cleanup.sh` and the watchdog
  read it only from their own environment. Moving the store means setting it in `.env` **and** in the
  launch agents' environment, or the backup checks a directory the containers do not use (and fails).
- `infra/ops/disk_cleanup.sh` never deletes from the file store, the packs, `index.tsv` or the
  manifests; it removes only half-written `*.part` files older than a day.

### Monthly restore drill (data and files)

`infra/backup/restore_drill.sh`, launch agent `design.hawa.restore-drill` (the 1st of each month, 05:00).
It needs `apps/core/dist` in the checkout it runs from (`pnpm build`).

1. Takes the newest archived `hawa_*.dump.enc` and its `hawa_*.blobs` manifest; checks the dump's sha256.
2. Decrypts it and restores it with `pg_restore --exit-on-error` into `hawa_drill_<stamp>` on the
   production server (a scratch database, dropped at the end).
3. Unpacks only the packs the manifest needs (from `blobs/index.tsv`) into `~/.hawa/drill/<stamp>/blobs`;
   fails if any listed file is in no pack.
4. Runs `blob-verify --db hawa_drill_<stamp> --dir …`: every `hawa.blobs` row must have its file, with
   sha256 equal to its name and size equal to the row. `missing` must be 0. References without a row
   (bytes not yet copied out of the database) are counted as `referencedWithoutRow`, not as missing.
5. Records the result in `hawa.backup_drills` (`evidence.drill_type = 'data_and_blobs'`, with the dump,
   `blobs_checked`, `missing`, `referenced_without_row`, `rto_seconds`), passed or failed, and alerts on
   failure.
6. Drops the scratch database and removes the scratch directory.

The older `infra/backup/backup_restore_drill.sh` (Sundays) only rebuilds the schema from the repository
and restores no data.

### Restoring for real

1. Stop Core and both worker colours (nothing may write while the store and the database disagree).
2. Pick the dump: the newest good `hawa_<stamp>.dump.enc` in the archive. Decrypt it with the passphrase
   in the owner's password manager:
   `openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in hawa_<stamp>.dump.enc -pass file:<passphrase file> > hawa.dump`
3. Restore the database from it (`pg_restore --clean --if-exists --exit-on-error`, as the owner, into the
   production database), as `docs/25_OPERATIONS_RUNBOOK.md` describes.
4. Restore the files: for each pack that `blobs/index.tsv` names for an entry of `hawa_<stamp>.blobs`,
   decrypt and unpack it into `~/.hawa/blobs` (`openssl enc -d … | tar -xkf - -C ~/.hawa/blobs`). Files
   already there are the same bytes, so `-k` keeps them. Then `chmod 0444` the files and `0755` the
   directories, and make sure `~/.hawa/blobs/.hawa-blob-store` exists (`deploy.sh` writes it).
5. Check before starting anything: `docker exec hawa-production-core-1 node /app/apps/core/dist/tools/blob-verify.js`
   once Core is up, or from the host with `DATABASE_URL=<owner URL> node apps/core/dist/tools/blob-verify.js --dir ~/.hawa/blobs`.
   `missing` must be 0.
6. Start the stack with `bash infra/docker/deploy.sh --apply`.
