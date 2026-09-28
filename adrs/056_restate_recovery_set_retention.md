# ADR-056: Retain Complete Restate Recovery Sets Together

**Date:** 2026-09-26
**Status:** Accepted for local implementation; production retention remains unqualified until observed on real archives.
**Requirements:** FR-070, NFR-003, NFR-013.
**Sources:** `adrs/053_guarded_single_node_restate_backup.md`, `adrs/055_bind_restate_archive_to_nightly_snapshot.md`, `infra/backup/nightly_backup.sh`, `infra/backup/restate_nightly.py`, `infra/backup/restore_drill.sh`, and `runbooks/10_backup_restore.md`, inspected 2026-09-26.

## Context

The database archive retains a configured number of newest dumps. Restate ciphertext, its manifest and the authenticated pair record currently have no retention. An incomplete database-only night can consume a dump slot, while old Restate archives grow without bound. Pruning by file age alone could delete the only complete paired recovery set or a manual forensic archive.

## Decision

For the opted-in Restate path, retain the newest configured number of **complete paired** encrypted recovery sets. An authenticated pair, its dump and checksum, blob manifest, Restate manifest and ciphertext must all exist before the set counts. Incomplete database-only nights do not displace complete pairs. Keep the newest unpaired encrypted dump for investigation; while fewer than the configured number of paired sets have accumulated, keep up to the same number of historical unpaired dumps as a migration reserve. A 24-hour minimum age protects a drill that selected an older set just before a new nightly run.

Plan retention before deleting anything. Refuse the entire prune if any pair is malformed, unauthenticated, names unsafe files or shares a Restate archive with another pair. Hash-check the newest complete pair's dump, blob manifest, Restate manifest and encrypted Restate archive before removing an older set; the full decrypt remains the monthly drill. Under the same archive lock used by backup, compare each deletion target's file identity with the plan before deleting it. Remove only expired paired dump/checksum, pair, Restate manifest and ciphertext files. Incomplete `.part` files older than 24 hours may be removed under that lock because no successful manifest points to them. The existing blob-manifest and pack collector then drops packs referenced by no retained dump. A crash may leave extra files; the next plan reconciles them without declaring false success. Report every deletion.

Unpaired Restate archives, including manual backups and a Restate capture whose pair publication failed, are **never automatically deleted**. Report their count and bytes for operator review. This deliberate forensic exception means total archive size still needs monitoring and a staffed disposal decision; the scheduled paired set has bounded retention.

## Limits

Retention verifies signed metadata and the newest paired set's archived byte hashes, not a full decrypt/restore of every retained set. The monthly drill remains the full decrypt/hash check. The policy does not make PostgreSQL and Restate one atomic snapshot or prove a clean-host replay, production storage durability or the RPO/RTO target. Keep unattended Restate backup off until those separate gates pass.
