# ADR-057: Rehearse a Paired Restate Archive on an Isolated Volume

**Date:** 2026-09-26
**Status:** Accepted for local implementation; clean-host journal replay and production recovery remain unqualified.
**Requirements:** FR-070, NFR-003, NFR-013.
**Sources:** `adrs/053_guarded_single_node_restate_backup.md`, `adrs/055_bind_restate_archive_to_nightly_snapshot.md`, `adrs/056_restate_recovery_set_retention.md`, `infra/backup/restate_nightly.py`, `infra/docker/docker-compose.prod.yml`, `output/plans/2026-09-24-architecture-programme/PHASE2_DESIGN.md` §2.6, and Restate's [Snapshots & Backups](https://docs.restate.dev/server/snapshots) guidance, inspected 2026-09-26.

## Context

The monthly drill decrypts and checks the selected Restate archive but does not start a node from it. Restate's single-node recovery instructions require the complete base directory, a compatible server release, equivalent node/cluster configuration and exclusive access to the restored data. A container that boots on a fresh empty volume does not prove an archived volume boots. The paired archive records the source image ID, node name and Compose-file digest, which can constrain a local rehearsal.

## Decision

Add an operator-invoked rehearsal with an explicit signed pair, key file and matching Compose file. Its default plan verifies the pair and refuses an unavailable or mismatched immutable Restate image. `--apply` copies the authenticated ciphertext while holding the archive's shared lock, decrypts and rechecks the tar, creates a random disposable Docker volume, extracts only the already-inspected full volume into it, and boots exactly the recorded image and node name with **no network and no published ports**. It waits for Restate's admin SQL to become ready, records the observed invocation count and removes the container and volume even after a failed drill. It never mounts the production Restate volume or connects the restored node to live workers/providers.

The rehearsal returns a receipt labeled `isolated_boot_verified`, not a clean-host recovery pass. A representative invocation must still resume under isolated fixture services and reconcile PostgreSQL, requester-send, Drive and Sheet marks across the two capture clocks. Only a separate clean-host drill with those assertions can satisfy R10 and Gate H. The source image and Compose hash checks prevent a locally available but different server/configuration from silently standing in for the archived version. No image is pulled automatically.

## Limits

The pair records a Compose digest rather than a complete effective Restate configuration snapshot. Matching that file plus the recorded node/image is a necessary local check, not full proof of environment equivalence. The first rehearsal may use synthetic archived data; it cannot establish production archive durability, live journal replay, side-effect safety or RPO/RTO. Keep unattended backup and new design flags off until their separate gates pass.
