# ADR-079: Continuous PostgreSQL recovery with an encrypted pgBackRest repository

Date: 2026-09-27
Status: Accepted for isolated qualification; production activation pending
Requirements: FR-070, NFR-003, NFR-013, NFR-020

## Evidence

The active nightly script creates logical dumps. The production PostgreSQL command
does not enable continuous WAL archiving. A restored nightly dump cannot prove the
specified database RPO of at most 15 minutes. Historical same-host dump drills and
their static evidence assertions do not prove current PITR, off-host durability,
pending Restate replay, or a clean-machine recovery.

## Decision

Implement the pgBackRest foundation already selected in docs/20_DEPLOYMENT_BACKUP_DR.md.
Extend the exact cached PostgreSQL 17.11/pgvector image with pgBackRest 2.59.1 at an
explicit package version. Preserve the current PostgreSQL major and pgvector source;
this is not authorization to upgrade or restart production. Record the actual built
image ID and tool/database versions in each drill.

Use encrypted base backups plus synchronous WAL archive-push, archive_mode=on,
wal_level=replica, and a 60-second PostgreSQL archive_timeout. Archive failures must
retain WAL and become operational failures; a configured timeout is not measured RPO.
Keep repository keys outside Git, image layers, command arguments and receipts.
Existing nightly logical dumps and file packs remain available during qualification.

The reproducible drill reads only the isolated hawa-chaos database, loads its schema
and synthetic application data into a new source volume, then performs a physical
backup. A committed business marker after that backup must be recovered from WAL.
A later committed marker must be absent at the selected recovery time. Restore into
a fresh volume with no network, published port, original PGDATA mount, or application
worker. Check migration/schema/data and RLS parity, archive receipts, encryption,
wrong-key refusal and missing-WAL failure before reporting success.

Measure archive visibility lag and restore time for that fixture. Label the result
as same-host isolated PITR; never call it a separate-machine, off-host, end-to-end,
or production recovery. Restate journals, blob capture windows and external effects
still require their own coordinated restoration/reconciliation. A PostgreSQL restore
alone must not start request delivery or qualify full-system recovery.

## Rollout

An optional Compose override and configuration example provide a reviewable deployment
path. Production stays on its present image and settings until repository placement,
key recovery, monitoring, rollback and the complete recovery drill are qualified.
No unattended installation, flag activation, production backup marker or production
volume mutation is part of this implementation.

## Sources

Checked 2026-09-27: [PostgreSQL 17 continuous archiving](https://www.postgresql.org/docs/17/continuous-archiving.html)
and [pgBackRest user guide](https://pgbackrest.org/user-guide.html). The local cached
base reports PostgreSQL 17.11; the official PGDG Bookworm repository provides
pgBackRest package 2.59.1-1.pgdg12+1. Actual execution evidence is recorded separately.
