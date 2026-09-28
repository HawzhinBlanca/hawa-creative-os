# ADR-053: Guarded Single-Node Restate Backup

**Date:** 2026-09-25
**Status:** Accepted for local implementation; deployed backup and clean-host restore remain unqualified.
**Requirements:** FR-060, FR-070, NFR-003, NFR-013.
**Sources:** `output/plans/2026-09-24-architecture-programme/PHASE2_DESIGN.md` §2.6, `runbooks/10_backup_restore.md`, `docs/10_WORKFLOW_RELIABILITY.md`, Restate's [Snapshots & Backups](https://docs.restate.dev/server/snapshots) and [Docker](https://docs.restate.dev/server/deploy/docker) guidance, inspected 2026-09-25.

## Context

Hawa's nightly office backup currently verifies and archives PostgreSQL and the content-addressed file store. Restate runs as one node with its own named Docker volume. Its journal, invocation state, virtual-object state and timers are not in those archives. Recreating the database and files alone cannot recover in-flight Restate work. Restate's single-node guidance calls for a complete, consistent copy of its data directory, a compatible binary and matching node configuration, with exclusive access on restore.

## Decision

Add a separate, explicit `--apply` backup command for the fixed production Compose service and volume. An exclusive local archive lock refuses overlapping backup commands. It reads the Telegram intake switch from Core and PostgreSQL, refusing disagreement, and throws it if necessary; waits up to a bounded interval for running Restate invocations; stops the Restate service; and archives the complete volume through a locally available helper image identified by immutable digest. It verifies that the archive includes the named node and contains no unsafe paths, encrypts the copy with the existing office backup key, verifies decryption and hashes, then publishes a manifest after recovery. It restarts the same service and releases the kill switch only if the command threw it and Restate is healthy. Failure before a healthy restart leaves intake paused and no success manifest.

The backup records the Restate image ID, node name, volume, Compose-file digest and archive digest. A domain-separated key derived from the office archive passphrase authenticates the manifest and ciphertext hash; the key is not copied into evidence. Its archive is separate from the PostgreSQL/blob set; a restore must reconcile effects that occurred between their timestamps. A full clean-host drill must start only an isolated restored node with matching configuration and verify an invocation, its journal and external-effect marks before this control can count toward R10 acceptance.

## Consequences and limits

- `--plan` performs read-only preflight; `--apply` is necessary to stop a live service. The command refuses an unpinned helper image or missing encryption key.
- This single-node volume method must not be reused for a multi-node Restate cluster.
- Local archive and failure-path tests prove the command's safeguards, not a production backup schedule, off-host durability, compatible-version restore or complete R10 cutover.
- The existing kill-switch API has no expected-revision compare-and-set. A concurrent operator toggle during backup could be overwritten by this command's release. Do not enable unattended production runs until the switch has a fenced maintenance lease or equivalent conditional release.

**2026-09-25 amendment:** ADR-054 adds an atomic `changeTag` conditional release and the backup now uses it. The risk above describes this decision's first local checkpoint, not the amended source. Production rehearsal and clean-host qualification remain open.
