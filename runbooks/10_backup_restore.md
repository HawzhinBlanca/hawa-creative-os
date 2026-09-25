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

### Restate single-node volume (R10, ADR-053; local implementation 2026-09-25)

The database and file archive above contains no Restate journal, timers or virtual-object state. Restate's [single-node backup guidance](https://docs.restate.dev/server/snapshots) requires a complete, consistent copy of the data directory plus compatible server and matching node configuration; its [Docker guidance](https://docs.restate.dev/server/deploy/docker) explains why the node name and persistent volume must stay the same. The production Compose file uses `hawa-production_restate_data` and `RESTATE_NODE_NAME=hawa-restate-prod-1`.

`infra/backup/restate_nightly.py` defaults to a read-only plan. Configure `HAWA_BACKUP_ARCHIVE_KEYFILE` and a **locally available helper image pinned with `@sha256`** in `HAWA_RESTATE_BACKUP_HELPER_IMAGE`, then run the plan and an isolated rehearsal. Keep `HAWA_RESTATE_BACKUP_ENABLED=off` for unattended production runs until a real isolated restore proves journal replay and side-effect reconciliation. `--apply` takes an exclusive archive lock, corroborates the Telegram switch in Core and PostgreSQL, pauses Telegram intake and retains the returned switch revision, waits for running invocations, stops Restate, copies the full volume, verifies encrypted bytes, restarts Restate and conditionally releases its own pause only if that revision is still current (ADR-054). A newer operator decision returns conflict and the backup publishes no success manifest. Its `restate_<UTC>.json` manifest records the node, volume, Restate image ID, Compose digest, capture/recovery times, both archive hashes and a keyed authenticator over the metadata; `.tar.enc` holds encrypted state. A failed restart leaves intake paused and has no success manifest. No unpinned helper image is pulled automatically.

The drain's Restate admin SQL request explicitly asks for a JSON response. A disposable Restate 1.7.10 probe on 2026-09-26 showed that omitting `Accept: application/json` returns binary data that the backup cannot parse; see `R10_EVIDENCE.md`. The backup still needs a real archive and isolated restore before unattended enablement.

With the backup flag enabled, nightly backup supplies its dump timestamp to `restate_nightly.py --apply --pair-stamp <stamp>`. Before pausing intake, the command requires that night's encrypted dump, checksum and blob manifest. After its verified Restate archive is published, it writes an authenticated `hawa_<stamp>.restate.json` binding the exact dump, blob manifest and Restate manifest by name and SHA-256 (ADR-055). The monthly drill selects this pair from the restored dump's timestamp and re-reads the exact three stored files, including decryption of the Restate archive. It records `restate_check=verified_pair` only if every check passes; a newer unrelated Restate archive cannot substitute. A missing pair fails the drill. Manual unpaired Restate archives remain individually checkable with `--verify-archive` but cannot satisfy the paired drill.

Archive pruning runs after an opted-in pair publishes. ADR-056 counts the newest `HAWA_BACKUP_ARCHIVE_KEEP` **complete paired recovery sets**, so failed database-only nights cannot displace them. It keeps the newest unpaired dump for investigation and a 24-hour deletion grace for a drill already reading an older set. Once pair files exist, this rule continues even if the backup opt-in flag is later turned off. `python3 infra/backup/restate_retention.py --keep 14` shows the deletion plan without changing files; `--apply` uses the archive lock and deletes only expired, authenticated paired members and stale unpaired dumps. The ordinary file-store collector then removes blob packs no kept manifest needs. Invalid pair metadata or a damaged newest set stops pruning and fails the nightly job. A failed Restate capture leaves older sets in place and reports the new night incomplete.

Manual or otherwise unpaired Restate archives are deliberately kept for operator review. The retention receipt logs their count and bytes; investigate and dispose of them explicitly before storage fills. Locked cleanup may remove incomplete `.part` files older than 24 hours; no successful manifest references them. The monthly drill deliberately fails on an incomplete newest dump so the missed night is visible; operators can still recover from an older complete set.

This proves stored-byte integrity and matching archive identity only. **R10 stays open** until an isolated clean host restores the matching version/configuration, starts exactly one node, resumes a representative invocation and reconciles its external-effect marks without duplicate sends. PostgreSQL, blob and Restate archives have different capture times; treat their combined restore as a reconciliation exercise, never an atomic distributed snapshot. The local retention policy still needs real-archive observation and orphan capacity monitoring. Do not bring a restored copy online alongside the original node.

### Offline archive boot rehearsal (ADR-057)

Select an explicit complete signed pair, its archive key file, and the source Compose file. The server image recorded in the archive must already be locally available by immutable image ID.

```bash
python3 infra/backup/restate_restore_rehearsal.py \
  --pair /path/to/hawa_YYYYMMDDTHHMMSSZ.restate.json \
  --key-file /path/to/archive-key \
  --compose-file infra/docker/docker-compose.prod.yml
```

The default verifies the files without creating Docker resources. Add `--apply` to copy/decrypt the authenticated archive, extract it into a random disposable volume and boot its exact image/node name without networking or published ports. The receipt is `isolated_boot_verified`, with the observed invocation count; it never claims external-effect replay. Cleanup uses a private label, including after a command timeout or interruption. If cleanup fails, the command fails and identifies the remaining run label or volume for staffed cleanup. An uncatchable process kill or Docker outage may still require that cleanup.

`infra/backup/drill_restate_restore.py --image-id <immutable Restate image ID> --worker-image-id <immutable cached worker image ID> --compose-file infra/docker/docker-compose.prod.yml` reproduces a separate fully synthetic cold-copy, encrypted-pair and saved-state comparison without reading a production volume. On 2026-09-26 it restored 51 files and matched one saved state row. This is not a substitute for the clean-host journal/effect drill above.

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
