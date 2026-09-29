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

## Continuous PostgreSQL recovery candidate (ADR-079, 2026-09-27)

The current nightly logical dump does not supply continuous WAL or prove the
15-minute database RPO. The pgBackRest candidate adds encrypted physical backups
and synchronous WAL archival using the current PostgreSQL 17.11/pgvector base and
pgBackRest 2.59.1. Production activation is pending; this section does not change
the existing schedule, image, flags or repository.

Build the pinned image explicitly:

```bash
docker build --pull=false -f infra/backup/Dockerfile.postgres-pgbackrest \
  -t hawa-postgres-pgbackrest:17.11-2.59.1 .
```

Record its immutable image ID. With the synthetic `hawa-chaos` candidate available,
run `python3 infra/backup/drill_postgres_pitr.py --image-id <sha256:image-id> --output <receipt.json>`.
The drill accepts only that candidate as an input fixture. It creates offline
database volumes, copies the synthetic schema/data, and takes an encrypted physical
backup. It commits a task after the base backup and waits for the actual 60-second
archive timeout, without forcing a WAL switch. Restoration must include that task
and exclude a later task at the chosen timestamp. The drill selects the observed
backup explicitly and waits for recovery to finish and the server to promote;
a readable hot standby alone is insufficient. Every application table's rows
and RLS policy definitions are compared, and the runtime role must see its tenant
while seeing zero rows for another tenant. Wrong-key and missing-WAL checks must
fail for their intended reasons. A wrong key must fail to decrypt or parse the
same backup metadata that the correct key just restored; an unrelated restore
error cannot satisfy that check. Privately labeled resources are removed on exit;
cleanup failure makes the drill fail. SIGKILL or a Docker outage may require cleanup
by the printed private run label.

This proves only the measured fixture on the same Docker host. Its archive lag and
restore duration are observations, not production RPO/RTO guarantees. It does not
restore blobs, pending Restate journals or external effects and starts no worker.

### Production activation prerequisites

- Qualify the immutable image, existing PostgreSQL data compatibility, rollback and
  backup first. Do not combine this with a PostgreSQL major upgrade.
- Place `pgbackrest.conf.example` as `pgbackrest.conf` in a private config directory.
  Match `pg1-path`, `pg1-user` and `pg1-database` to the deployment.
  Supply the repository key separately in `conf.d/repository-key.conf`, under
  `[global]` as `repo1-cipher-pass`. Restrict it to the PostgreSQL user/group. Keep
  the key outside Git, image layers, shell arguments and Compose environment.
- Supply `HAWA_PGBACKREST_IMAGE`, `HAWA_PGBACKREST_CONFIG_DIR` and
  `HAWA_PGBACKREST_REPOSITORY` before merging the optional
  `infra/backup/docker-compose.pgbackrest.yml` override with the production file.
  A local path alone does not establish off-host protection; verify the actual
  repository destination and recover the key independently on the recovery host.
- After an approved maintenance activation, run `pgbackrest --stanza=hawa
  stanza-create`, `check`, and `--type=full backup` as the container's PostgreSQL OS
  user. Schedule backups explicitly and observe encrypted WAL arrival. Confirm
  `pg_stat_archiver`, failed archive attempts, unarchived WAL growth, repository
  capacity and actual backup ages. An archive timeout setting is not proof that
  WAL reached durable off-host storage.
- Restore a selected timestamp on a clean machine with the matched file and
  Restate recovery set. Reconcile their different capture times before any worker
  or delivery process can resume. Preserve existing logical dumps and file packs
  during qualification; a database-only PITR pass cannot admit the whole app.

## Production backups today (updated 2026-09-29, ADR-035, ADR-141)

What actually runs on the production host, and how to restore from it. The production host is the
office Mac today (launch agents); on a Linux server the same scripts run as systemd timers
(`infra/ops/install_systemd_units.sh`; the jobs, their names and their settings side by side are in
`infra/ops/README.md`). The sections above describe the target process for a clean host; this is the
one in use.

### What is backed up, and where

- **Nightly, 03:30** (`infra/backup/nightly_backup.sh`, launch agent `design.hawa.nightly-backup`, on
  Linux `hawa-nightly-backup.timer`):
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
  jobs' environment (the launch agents on a Mac, `/etc/hawa/backup.env` on Linux), or the backup checks
  a directory the containers do not use (and fails).
- `infra/ops/disk_cleanup.sh` never deletes from the file store, the packs, `index.tsv` or the
  manifests; it removes only half-written `*.part` files older than a day.

### Monthly restore drill (data and files)

`infra/backup/restore_drill.sh`, launch agent `design.hawa.restore-drill` (on Linux `hawa-restore-drill.timer`;
the 1st of each month, 05:00).
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

### Off-site copy (ADR-141; off until configured)

The archive sits on the host it protects, and a synchronized folder (iCloud on the Mac) is not a
verified off-host copy. `infra/backup/offsite_copy.sh` (launch agent `design.hawa.offsite-copy`, on Linux
`hawa-offsite-copy.timer`; 05:30, two hours after the nightly) copies the newest **complete encrypted
recovery set** to a second place:

- A set is one night's `hawa_<stamp>.dump.enc` with its checksum, its `hawa_<stamp>.blobs` manifest and
  every pack that manifest needs, and, when the archive holds pairs, `hawa_<stamp>.restate.json` with
  the `restate_<UTC>.json` and `.tar.enc` it names. It is complete when every member is there and every
  hash agrees (the pair and the Restate manifest are authenticated with the archive key; nothing is
  decrypted). A newer night that is not complete is passed over and named in the log line. An
  unencrypted archive is refused.
- `HAWA_OFFSITE_DEST` is an absolute path (a mounted disk) or `[user@]host:path` for rsync over SSH,
  for example a Hetzner Storage Box (`HAWA_OFFSITE_RSH="ssh -p 23 -i ~/.ssh/<key> -o BatchMode=yes"`).
  With it empty the job copies nothing and writes nothing: that is the Mac today.
- It holds the archive lock in shared mode while it reads (a nightly still running is waited for, up
  to `HAWA_OFFSITE_LOCK_WAIT_SECONDS`, 1800), copies with temporary names, then verifies every file at
  the destination: read back and hashed with SHA-256 for a path, `rsync --checksum --dry-run` (which
  compares the content of every file on both sides) for SSH. Only then does it write
  `hawa_<stamp>.offsite.json`, the set's receipt, with every member's SHA-256. A rerun verifies again
  and copies only what differs.
- At the destination it keeps `HAWA_OFFSITE_KEEP` sets (14) and deletes a pack only when no kept
  receipt lists it. It deletes only names it writes.
- Each run appends `COPIED`, `CURRENT` or `FAILED` to `infra/backup/snapshots/offsite.log`; a failure is
  sent to the operator chat. Once that log exists the watchdog (through `backup_status.py`) reports a
  failed copy, a copied set older than 30 h, and a newer nightly not copied 6 h after it finished. To
  stop off-site copying for good, remove the setting **and** `offsite.log`.

To restore from the off-site copy, copy one set back into an empty archive directory, rename its
`hawa_<stamp>.index.tsv` to `blobs/index.tsv`, and follow "Restoring for real" and, for a paired set,
"Restoring Restate on a clean host". Check the copy first:
`sha256sum` (or `shasum -a 256`) of each member against `hawa_<stamp>.offsite.json`.

Proved on 2026-09-29 with local destinations on macOS and in an arm64 Debian container, through rsync
there too (`plans/hosting/LINUX_READINESS_PROOF.json`); an SSH destination has not been exercised yet.

### Restate single-node volume (R10, ADR-053; local implementation 2026-09-25)

The database and file archive above contains no Restate journal, timers or virtual-object state. Restate's [single-node backup guidance](https://docs.restate.dev/server/snapshots) requires a complete, consistent copy of the data directory plus compatible server and matching node configuration; its [Docker guidance](https://docs.restate.dev/server/deploy/docker) explains why the node name and persistent volume must stay the same. The production Compose file uses `hawa-production_restate_data` and `RESTATE_NODE_NAME=hawa-restate-prod-1`.

`infra/backup/restate_nightly.py` defaults to a read-only plan. Configure `HAWA_BACKUP_ARCHIVE_KEYFILE` and a **locally available helper image pinned with `@sha256`** in `HAWA_RESTATE_BACKUP_HELPER_IMAGE`, then run the plan and an isolated rehearsal. `HAWA_RESTATE_BACKUP_ENABLED` stays `off` in production until the owner enables it with the checklist in "Enabling the Restate backup in production" below; the clean-host restore it waited for passed on disposable stacks on 2026-09-28 (ADR-134). `--apply` takes an exclusive archive lock, corroborates the Telegram switch in Core and PostgreSQL, pauses Telegram intake and retains the returned switch revision, waits for running invocations, stops Restate, copies the full volume, verifies encrypted bytes, restarts Restate and conditionally releases its own pause only if that revision is still current (ADR-054). A newer operator decision returns conflict and the backup publishes no success manifest. Its `restate_<UTC>.json` manifest records the node, volume, Restate image ID, Compose digest, capture/recovery times, both archive hashes and a keyed authenticator over the metadata; `.tar.enc` holds encrypted state. A failed restart leaves intake paused and has no success manifest. No unpinned helper image is pulled automatically. Before each change `--apply` writes a run record (`HAWA_RESTATE_BACKUP_STATE`, default `~/.hawa/restate-backup.state`: whether it stopped Restate, whether it paused intake and with which revision). A run killed outright (SIGKILL, a reboot) runs no cleanup; the watchdog runs `restate_nightly.py --recover` every 5 minutes, which skips the pass while any backup holds the archive lock, and otherwise starts Restate, waits for health and releases only the recorded pause by its revision. A newer operator decision keeps the switch; a pause whose revision was never recorded is reported, never released, until the office releases intake itself. The next `--apply` performs the same recovery first (ADR-127). `--recovery-status` reports without changing anything.

The drain's Restate admin SQL request explicitly asks for a JSON response. A disposable Restate 1.7.10 probe on 2026-09-26 showed that omitting `Accept: application/json` returns binary data that the backup cannot parse; see `R10_EVIDENCE.md`. The Core switch requests carry the operator bearer on the status read as well as on the toggle: until ADR-134 (2026-09-28) the status read had none, Core answered 401, and every `--plan`, `--apply` and watchdog `--recover` was refused (found by the first run of the drill below; the command had never run against a live Core).

Every production name the command uses can be pointed at a rehearsal stack through the environment, and each defaults to today's production value (ADR-134): `HAWA_RESTATE_BACKUP_COMPOSE_FILES` (separated by `:`; the first is the file whose digest the manifest records), `_COMPOSE_ENV`, `_COMPOSE_PROJECT`, `_VOLUME`, `_CONTAINER`, `_CORE_CONTAINER`, `_POSTGRES_CONTAINER`, `_NODE_NAME`, `_DATABASE` and `_DRAIN_SECONDS` (default 300). Production sets none of them.

With the backup flag enabled, nightly backup supplies its dump timestamp to `restate_nightly.py --apply --pair-stamp <stamp>`. Before pausing intake, the command requires that night's encrypted dump, checksum and blob manifest. After its verified Restate archive is published, it writes an authenticated `hawa_<stamp>.restate.json` binding the exact dump, blob manifest and Restate manifest by name and SHA-256 (ADR-055). The monthly drill selects this pair from the restored dump's timestamp and re-reads the exact three stored files, including decryption of the Restate archive. It records `restate_check=verified_pair` only if every check passes; a newer unrelated Restate archive cannot substitute. A missing pair fails the drill. Manual unpaired Restate archives remain individually checkable with `--verify-archive` but cannot satisfy the paired drill.

Archive pruning runs after an opted-in pair publishes. ADR-056 counts the newest `HAWA_BACKUP_ARCHIVE_KEEP` **complete paired recovery sets**, so failed database-only nights cannot displace them. It keeps the newest unpaired dump for investigation and a 24-hour deletion grace for a drill already reading an older set. Once pair files exist, this rule continues even if the backup opt-in flag is later turned off. `python3 infra/backup/restate_retention.py --keep 14` shows the deletion plan without changing files; `--apply` uses the archive lock and deletes only expired, authenticated paired members and stale unpaired dumps. The ordinary file-store collector then removes blob packs no kept manifest needs. Invalid pair metadata or a damaged newest set stops pruning and fails the nightly job. A failed Restate capture leaves older sets in place and reports the new night incomplete.

Manual or otherwise unpaired Restate archives are deliberately kept for operator review. The retention receipt logs their count and bytes; investigate and dispose of them explicitly before storage fills. Locked cleanup may remove incomplete `.part` files older than 24 hours; no successful manifest references them. The monthly drill deliberately fails on an incomplete newest dump so the missed night is visible; operators can still recover from an older complete set.

The pair and the monthly check prove stored-byte integrity and matching archive identity. The clean-host restore below proves that one paired night brings a stack back with its in-flight work (ADR-134). PostgreSQL, blob and Restate archives have different capture times; treat their combined restore as a reconciliation exercise, never an atomic distributed snapshot. The local retention policy still needs real-archive observation and orphan capacity monitoring. Do not bring a restored copy online alongside the original node: `--restore-into` refuses while a running container carries the archived node name.

### Clean-host restore of one paired night (R10, ADR-134; proved on disposable stacks 2026-09-28)

`packages/testkit/chaos/r10-restore.ts` is the drill. It runs the real `nightly_backup.sh` with `HAWA_RESTATE_BACKUP_ENABLED=on` twice against a source compose project (`hawa-chaos-r10s`), then loses the source host and restores the second night onto a separate clean project (`hawa-chaos-r10d`: its own network, volumes and ports) with the procedure below. Telegram, Canva, Drive and the models are the chaos fakes; the source's fakes container is the outside world and survives, so every effect of both hosts is counted. Neither project is the shared `hawa-chaos`, and production is not touched. Evidence: `plans/lean-design-implementation-2026-09-28/R10_RESTATE_BACKUP_RESTORE_PROOF.json` (47/47 checks).

```bash
# the images the drill runs (tag r10, never the shared :local): packages/testkit/chaos/README.md, "R10 clean-host restore"
HAWA_R10_SCRATCH=<empty private directory outside the repository> npx tsx packages/testkit/chaos/r10-restore.ts
```

| In flight at the restored capture | After the restore |
|---|---|
| RequestLifecycle waiting for the office's decision (request `in_review`) | approved on the clean host; the Delivery workflow sent both files and the notice once |
| TelegramSender holding a requester notice Telegram refused (429), `backing-off` | sent once |
| RequestLifecycle `reminderTick` scheduled 24 h ahead | still scheduled: same invocation, same due time |
| ChatInbox `handleUpdate` running inside Core intake (the nightly stopped Restate with it running) | replayed; Core answered it as the duplicate it was; one task; its design reached review |

Measured on this Mac, with Restate health-checked at production's 10 s cadence:

- Nightly with nothing running: 26.5 s in all; intake paused 13.6 s; Restate unavailable (stopped until healthy) 11.6 s, most of it the 10 s health-check interval; dump to Restate capture 14.0 s.
- Nightly with one invocation still running: the drain waited its full `HAWA_RESTATE_BACKUP_DRAIN_SECONDS` (30 s in the drill), so intake was paused 42.4 s. With production's default of 300 s, a stuck invocation keeps intake paused about 5 min 15 s.
- A brief sent while Restate was stopped stayed in Telegram: a long poll already open returned it, the poller saw the switch off and handed nothing on; it was asked for again 3.4 s after the release and handed on once. The poller reads the switch at most every 5 s, so an update can also be handed on in the first seconds of a pause; the offset moves only after Restate accepts an update, so none is lost.
- Restore, from its start to one Core and one worker healthy: 34.5 s (pair check 0.5 s, database 6.1 s, files 7.7 s, Restate healthy 22.0 s); every in-flight invocation finished 12.2 s later. The data was small: 3 files, 59 Restate files, a 0.9 MB archive.
- Effects: the ledgers were identical at the capture and when the source was lost (the drill freezes the source worker before that capture, ADR-134); afterwards no message, file or notice reached any chat twice, no paid call ran twice, one Canva import per task, no office alert.

#### Restoring Restate on a clean host (with steps 2-5 of "Restoring for real")

1. Nothing may run the archived node: the original host is gone, or its Restate is stopped for good.
2. Check the pair on the new host: `HAWA_BACKUP_ARCHIVE_KEYFILE=<key> python3 infra/backup/restate_nightly.py --verify-pair <archive>/hawa_<stamp>.restate.json`, then `python3 infra/backup/restate_restore_rehearsal.py --pair <pair> --key-file <key> --compose-file infra/docker/docker-compose.prod.yml` (the Compose file of the release that wrote the night: its digest must match). The Restate image the manifest records must be local (`docker image inspect <restateImageId>`).
3. Restore the database (the restore-swap block) and the file store (steps 4 and 5) from the **same night's** dump and manifest that the pair names.
4. `docker volume create hawa-production_restate_data` (the external volume production's Compose file expects), then `python3 infra/backup/restate_restore_rehearsal.py --pair <pair> --key-file <key> --compose-file infra/docker/docker-compose.prod.yml --restore-into hawa-production_restate_data`. It refuses a volume that is mounted or not empty and a host where a running container already carries the node name, and checks every restored file against the archive.
5. Start Restate alone and wait for health. On its admin port, `SELECT id, target_service_name, status FROM sys_invocation WHERE status <> 'completed'` lists the work that will resume. Do not register the workers again: the restored node already knows the deployment its invocations are pinned to.
6. Start Core, then the worker colour the restored deployment names, then the rest with `deploy.sh --apply` from the matching commit.
7. Reconcile the recovery point: requests and decisions after the night are not in it. Telegram offers only unconfirmed updates again, so briefs handled after the backup are lost and their requesters must resend; a message whose send mark was written after the dump and journaled before the capture may be sent again. Tell the office which window was lost.

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

### Enabling the Restate backup in production (checklist, ADR-134)

The owner decides; the lead makes every production change. None of this was done on 2026-09-28.

1. Deploy a commit that carries ADR-134 (the status read's bearer): before it, every run is refused with HTTP 401.
2. Key: the office archive passphrase the nightly already uses (`HAWA_BACKUP_ARCHIVE_KEYFILE` in the `design.hawa.nightly-backup` agent: `~/.hawa/backup_passphrase`, mode 0600, owner only). Do not create another: the pair and retention verify the dump and the Restate archive with the same key. The owner keeps an off-host copy in the password manager; losing it makes every archive unreadable.
3. Helper image, local and pinned: `ghcr.io/restatedev/restate@sha256:5cef318c0fb6ae2763316ea628b395bb36d2ee0be7690897acd54a11c353a1c9` (the Restate 1.7.10 image production runs; it has GNU tar). `docker image inspect <that reference>` must answer; nothing is pulled at night.
4. Read-only plan from the main checkout, with the agent's settings: `HAWA_BACKUP_ARCHIVE_DEST=<the agent's value> HAWA_BACKUP_ARCHIVE_KEYFILE=~/.hawa/backup_passphrase HAWA_RESTATE_BACKUP_HELPER_IMAGE=<step 3> python3 infra/backup/restate_nightly.py` must print `{"status": "ready", …, "telegramEnabled": true}`. It reads Core's switch and PostgreSQL's copy of it and changes nothing.
5. Add `HAWA_RESTATE_BACKUP_ENABLED=on` and `HAWA_RESTATE_BACKUP_HELPER_IMAGE=<step 3>` to the `design.hawa.nightly-backup` agent's EnvironmentVariables and reload it (`bash infra/ops/install_launch_agents.sh` carries every `HAWA_*` setting over); on a Linux host, put both lines in `/etc/hawa/backup.env` instead (the timers read it at their next run). Leave every other `HAWA_RESTATE_BACKUP_*` name unset. The watchdog needs nothing new: `--recover` finds the archive in the run record.
6. Optionally, run one night by hand at a quiet hour (`bash infra/backup/nightly_backup.sh` from the main checkout with the agent's environment) and watch intake pause for about 15 s.
7. The first real night: `backup.log` ends `OK <stamp> … restate=paired_archive`; the archive holds `restate_<UTC>.json`, `restate_<UTC>.tar.enc` and `hawa_<stamp>.restate.json`; `python3 infra/backup/restate_nightly.py --verify-pair <archive>/hawa_<stamp>.restate.json` answers `verified_pair`; `~/.hawa/restate-backup.state` does not exist; intake is on. Restate's volume was 4.7 MB on 2026-09-28, so each night adds a few MB (fourteen nights are kept).
8. Roll back: remove `HAWA_RESTATE_BACKUP_ENABLED` (or set it `off`) and reload the agent. Paired sets already written stay under paired retention (ADR-056), which keeps needing the key, until they age out; the dump and file backup do not change.
9. The monthly `design.hawa.restore-drill` agent was not installed on 2026-09-28 (only the watchdog, the nightly and the weekly schema drill were); `install_launch_agents.sh` installs it, and it re-reads the pair every month.

### Restoring for real (rewritten 2026-09-28, ADR-129)

A dump is restored into a **new** database, checked, and then swapped in by renaming. It is never
restored over the database the stack uses. The earlier step, `pg_restore --clean --if-exists
--exit-on-error` into the production database, fails on any database a later migration has touched:
the dump does not hold the foreign keys, policies and triggers those migrations added, so dropping its
own tables fails partway (`cannot drop … because other objects depend on it`). By then pg_restore has
already dropped the dump's own policies, triggers and most foreign keys. The tables keep `FORCE ROW
LEVEL SECURITY` with no policies, so the application role sees no rows, and Core, the Desk and the
worker are down. This was reproduced on 2026-09-28 with a pre-deploy dump and this branch's migrations
022-064 (`plans/lean-design-implementation-2026-09-28/OPERATIONS_FIXES_PROOF.json`). Without
`--exit-on-error` the same command leaves a mix of old and new rows instead.

The same procedure is the **rollback of a deploy** with that deploy's `predeploy_<stamp>.dump`. A
rollback also puts back the code that matches the dump: check out the commit that was live before the
deploy and run `deploy.sh --apply` from it in step 6. First compare `WORKER_SERVICE_NAMES` in
`apps/worker/src/services.ts` at that commit with the current one. If the older build lacks a service
the current one hosts, do not deploy it: Restate would keep that service on the current colour and
every later deploy would stop at its drain check. The current `deploy.sh` refuses such a registration
(`infra/docker/README.md`), but an older commit's `deploy.sh` does not.

1. Stop what would write or reconnect. The watchdog restarts a stopped Core within five minutes, and
   the nightly backup and drills connect to the database, so their launch agents (on Linux, timers) go first:
   ```bash
   for a in design.hawa.watchdog design.hawa.nightly-backup design.hawa.backup-restore-drill design.hawa.restore-drill design.hawa.offsite-copy; do launchctl bootout "gui/$(id -u)/$a" 2>/dev/null || true; done
   docker stop hawa-production-core-1 hawa-production-worker-blue-1 hawa-production-worker-green-1 2>/dev/null || true
   ```
   On a Linux host, the first line is
   `sudo systemctl stop hawa-watchdog.timer hawa-nightly-backup.timer hawa-backup-restore-drill.timer hawa-restore-drill.timer hawa-offsite-copy.timer`.
   (A colour that is not running is simply skipped.)
2. Pick the dump. For a nightly one: the newest good `hawa_<stamp>.dump.enc` in the archive, decrypted
   with the passphrase in the owner's password manager:
   `openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in hawa_<stamp>.dump.enc -pass file:<passphrase file> > hawa.dump`.
   For a deploy rollback: `infra/backup/snapshots/predeploy_<stamp>.dump`, checked against the hash
   beside it: `[[ "$(shasum -a 256 <dump> | cut -d' ' -f1)" == "$(cat <dump>.sha256)" ]] && echo checksum-ok`
   (a Linux host without perl: `sha256sum <dump>` prints the same first field).
3. Restore it into a new database, check it, and swap it in. Run this block as it stands, with `DUMP`
   set to the file from step 2 (from the repository root, in bash). It restores in one transaction, so
   an error leaves nothing half-restored and the live database untouched. It then copies what belongs
   to the database itself and not to the dump: its owner, its grants (`GRANT ... ON DATABASE`, such as
   a revoked `CONNECT`) and its settings (`ALTER DATABASE ... SET`, and `ALTER ROLE ... IN DATABASE ...
   SET` for the application's login roles). A rename leaves them with the old database, so without the
   copy the swapped-in database would accept connections the old one refused and drop those settings.
   `infra/backup/restore_copy_props.sql` does the copy and refuses a setting whose value is a list;
   `infra/backup/restore_props.sql` compares the two. The block swaps only when the new database holds
   every policy, foreign key and trigger the dump lists and has the old one's owner, encoding, grants
   and settings, and prints `restore-check=ok`; anything else prints `restore-check=MISMATCH`, changes
   nothing, and leaves the new database for inspection (drop it with `dropdb`). `infra/backup/drill_restore_swap.sh` runs this same block,
   read from this file, against the test server.

   <!-- restore-swap:begin -->
   ```bash
   PG="${PG:-hawa-production-postgres-1}"; DB="${DB:-hawa}"; DUMP="${DUMP:?set DUMP to the dump file}"
   STAMP="$(date -u +%Y%m%dt%H%M%Sz)"; NEW="${DB}_restore_${STAMP}"; OLD="${DB}_before_${STAMP}"
   docker exec "$PG" createdb -U hawa_owner -T template0 "$NEW"
   docker exec -i "$PG" pg_restore -U hawa_owner -d "$NEW" --exit-on-error --single-transaction < "$DUMP"
   TOC="$(docker exec -i "$PG" pg_restore --list < "$DUMP")"
   toc_count() { grep -cE "^[0-9]+; [0-9]+ [0-9]+ $1 " <<< "$TOC" || true; }   # grep -c exits 1 on 0
   WANT="policies=$(toc_count POLICY) foreign_keys=$(toc_count 'FK CONSTRAINT') triggers=$(toc_count TRIGGER)"
   HAVE="$(docker exec "$PG" psql -X -qAt -U hawa_owner -d "$NEW" -v ON_ERROR_STOP=1 -c "SELECT 'policies='||(SELECT count(*) FROM pg_policy)||' foreign_keys='||(SELECT count(*) FROM pg_constraint WHERE contype='f')||' triggers='||(SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal)")"
   echo "dump: ${WANT}"; echo "new database ${NEW}: ${HAVE}"
   # The owner, encoding, grants (GRANT ... ON DATABASE) and settings (ALTER DATABASE ... SET, ALTER ROLE
   # ... IN DATABASE ... SET) belong to the database, not to what pg_dump -Fc writes, and a rename does
   # not move them: they are copied from DB to NEW and compared (grants and settings only as a hash).
   props() { docker exec -i "$PG" psql -X -qAt -U hawa_owner -d postgres -v ON_ERROR_STOP=1 -v name="$1" < infra/backup/restore_props.sql; }
   copy_props() { docker exec -i "$PG" psql -X -q -U hawa_owner -d postgres -v ON_ERROR_STOP=1 -v src="$DB" -v dst="$NEW" < infra/backup/restore_copy_props.sql; }
   if [[ "$HAVE" != "$WANT" ]]; then
     echo "restore-check=MISMATCH: nothing was swapped; ${DB} is unchanged and ${NEW} is left for inspection"
   elif ! copy_props; then
     echo "restore-check=MISMATCH: the owner, grants or settings of ${DB} could not be copied (the reason is above); nothing was swapped, and ${NEW} is left for inspection"
   elif P_DB="$(props "$DB")"; P_NEW="$(props "$NEW")"; [[ "$P_DB" != owner=* || "$P_NEW" != "$P_DB" ]]; then
     echo "database ${DB}: ${P_DB}"; echo "database ${NEW}: ${P_NEW}"
     echo "restore-check=MISMATCH: ${NEW} does not have the owner, encoding, grants and settings of ${DB}; nothing was swapped, and ${NEW} is left for inspection"
   elif echo "database ${NEW}: ${P_NEW} (as ${DB})" && docker exec "$PG" psql -X -qAt -U hawa_owner -d postgres -v ON_ERROR_STOP=1 \
       -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname IN ('${DB}', '${NEW}') AND pid <> pg_backend_pid()" \
       -c "ALTER DATABASE \"${DB}\" RENAME TO \"${OLD}\"; ALTER DATABASE \"${NEW}\" RENAME TO \"${DB}\"" >/dev/null; then
     echo "restore-check=ok: ${DB} is the restored copy; the database it replaced is kept as ${OLD}"
   else
     echo "restore-check=SWAP_FAILED: the two renames run in one transaction, so ${DB} is unchanged; ${NEW} is left for inspection"
   fi
   ```
   <!-- restore-swap:end -->

   To undo the swap before anything was started: rename the two back
   (`ALTER DATABASE "<DB>" RENAME TO "<NEW>"`, then `ALTER DATABASE "<OLD>" RENAME TO "<DB>"`, connected
   to `postgres`). Roles and their passwords belong to the server, not the database, and the block
   copied the database's own grants and settings, so Core and the workers connect to the restored copy
   with the same `DATABASE_URL` and the same per-database settings.
4. Restore the files: for each pack that `blobs/index.tsv` names for an entry of `hawa_<stamp>.blobs`,
   decrypt and unpack it into `~/.hawa/blobs` (`openssl enc -d … | tar -xkf - -C ~/.hawa/blobs`). Files
   already there are the same bytes, so `-k` keeps them. Then `chmod 0444` the files and `0755` the
   directories, and make sure `~/.hawa/blobs/.hawa-blob-store` exists (`deploy.sh` writes it). A
   pre-deploy dump has no manifest. Within 15 days of its deploy the store still holds every file it
   references (the collector deletes only files unreferenced for longer, `HAWA_BLOB_GRACE_DAYS`); step 5
   says whether that is so.
5. Check before starting anything: from the host,
   `DATABASE_URL=<owner URL> node apps/core/dist/tools/blob-verify.js --dir ~/.hawa/blobs`. `missing` must be 0.
6. Start the stack with `bash infra/docker/deploy.sh --apply` (from the commit that matches the dump,
   for a rollback), then load the launch agents again: `bash infra/ops/install_launch_agents.sh`
   (on Linux: `sudo systemctl start hawa-watchdog.timer hawa-nightly-backup.timer hawa-backup-restore-drill.timer hawa-restore-drill.timer hawa-offsite-copy.timer`,
   or `sudo bash infra/ops/install_systemd_units.sh --user <user>`).
7. Once the restored stack is confirmed, drop the database it replaced:
   `docker exec hawa-production-postgres-1 dropdb -U hawa_owner <OLD>`. Until then it takes its own
   disk space; it is also the way back if the restore itself was the mistake.

### Moving production to another host (ADR-141)

The move is the paired nightly backup followed by "Restoring Restate on a clean host" and "Restoring
for real" on the new host (the hosting plan, `plans/hosting/PRODUCTION_HOSTING_PLAN.md`, sections 7 and
8, has the whole sequence and the owner's decisions). What the repository adds for it:

1. **New host, before the rehearsal:** `mkdir -p ~/.hawa && echo standby > ~/.hawa/host-role`. Its
   watchdog and jobs then start nothing, `deploy.sh` runs pre-flight only and records no volume stamp,
   and `--apply` refuses. Install its jobs (`sudo bash infra/ops/install_systemd_units.sh --user hawa`, or
   the launch agents on a Mac mini) so they are proved to run, harmlessly.
2. **Old host, at the cutover, before the final backup:** stop its watchdog and jobs (step 1 of
   "Restoring for real") so it cannot restart its stack within five minutes, run the final paired
   backup by hand with the nightly job's settings, stop its worker colours, Core and Restate, then
   `echo retired > ~/.hawa/host-role`. Even if a launch agent is loaded again by mistake, its watchdog
   now starts nothing and alerts if production containers run there, `deploy.sh --apply` refuses, and
   the nightly backup, drills and off-site copy skip. Keep its volumes untouched: they are the rollback.
3. **New host, after the restore:** `rm ~/.hawa/host-role` (and any `HAWA_HOST_ROLE` in
   `/etc/hawa/backup.env`), remove any stamps the rehearsal left (`rm -f ~/.hawa/volume-stamps/*`),
   then `bash infra/docker/deploy.sh --apply`: the first deploy records this host's volume stamps.
   Then `bash infra/ops/watchdog.sh --announce` and `--status`.
4. **Rollback before the new host handled real work:** mark the new host `retired`, stop its stack and
   timers; on the old host `rm ~/.hawa/host-role` and reload its launch agents. After real work, take a
   paired backup on the new host first and restore it onto the old one the same way.

Never let both hosts be `production` with their stacks running: both would poll the same Telegram bot.
