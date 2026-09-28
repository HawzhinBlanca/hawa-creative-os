# ADR-055: Bind Restate Archive to Its Nightly Database and File Snapshot

**Date:** 2026-09-25
**Status:** Accepted for local implementation; clean-host restore and production schedule remain unqualified.
**Requirements:** FR-060, FR-070, NFR-003, NFR-013.
**Sources:** `adrs/053_guarded_single_node_restate_backup.md`, `adrs/054_fenced_intake_switch_release.md`, `infra/backup/nightly_backup.sh`, `infra/backup/restore_drill.sh`, `output/plans/2026-09-24-architecture-programme/PHASE2_DESIGN.md` §2.6, inspected 2026-09-25.

## Context

The nightly script gives its database dump and blob manifest one timestamp, while the Restate archive has a later independent timestamp. The monthly drill currently selects the newest Restate archive without checking that it belongs to the dump being restored. A missed Restate night or a manual archive could therefore produce a green integrity check for the wrong recovery set.

## Decision

When Restate backup is opted in, require the same-night encrypted dump and blob manifest before pausing intake. After Restate has restarted, its own archive is verified, and its manifest is published, publish `hawa_<dump timestamp>.restate.json` as an authenticated binding. It names and hashes the dump, blob manifest and Restate manifest, and records both capture times with `crossStoreAtomic: false`. The monthly drill locates the pair by the selected dump timestamp and verifies its authenticator and every named stored file before recording a Restate archive check. A missing, stale, changed or mismatched pair fails the drill; an unrelated newer Restate archive cannot substitute.

Archive retention runs after the opted-in pair publishes. If Restate capture fails, the previous archived database dump and blob packs remain available, while the new unpaired database/file copy is reported as an incomplete night.

The pair is an integrity record, not a distributed transaction. Restored PostgreSQL, blobs and Restate still need effect reconciliation across their capture-time gap. A successful pair check is not clean-host restore evidence.

## Consequences and limits

- An unpaired manual Restate archive remains individually verifiable but cannot satisfy the monthly paired drill.
- A failed pair publication fails the night; the valid Restate archive may remain as an unpaired forensic artifact.
- Restate archive retention and isolated clean-host replay are separate R10 work. Unattended production backup stays off until both are qualified.
