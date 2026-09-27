# ADR-107 — Scheduled external publication inspection

Date: 2026-09-27
Status: Accepted for implementation; qualification pending
Requirements: FR-047, FR-048, FR-049, FR-050, FR-064, NFR-006
Normative sources: docs/13_GOOGLE_DRIVE_SHEETS.md; docs/10_WORKFLOW_RELIABILITY.md

## Decision and reason

Use the existing Core process to schedule bounded, read-only Google inspections.
PostgreSQL owns each hourly publication claim, the frozen input snapshot, lease,
attempt and terminal observation. A new Core instance continues from these rows;
an expired claim becomes an interrupted observation before another bounded attempt.
Concurrent schedulers must claim under the publication lock. No provider request
occurs inside a database transaction. Missed hours are not fabricated as successful
observations. This introduces no workflow framework or additional deployable.

Inputs come from ADR-106 immutable expectations and reserved Drive identities,
never current Client DNA or a publisher process cache. The Google adapter independently
reads the configured folder, exact files, complete permission pages, duplicates in
the scoped destination, and ADR-105 stable Sheet metadata/values. It uses bounded
requests, response sizes, pagination and an overall deadline. Network failures,
inaccessible/missing objects and absent checksums retain explicit uncertainty.

Domain comparison is independent of HTTP, Google credentials and storage. It
distinguishes matched content, proven differences and unverified checks. Permissions
without a previously trusted digest remain unverified; a first observation cannot
silently create an authorization baseline. Historical publications without original
expectations are flagged for supervised reconciliation, with no invented metadata.

Inspection never republishes files, writes a Sheet, changes permissions, completes
a task or sends a requester message. FR-050 allows flagging divergence. A scoped
Operations view will expose the stored result and safe next action. Current membership
is checked when reading. A result for a superseded publication remains historical
and cannot qualify the current design. Read failures must clear previously displayed
current success. Existing receipt audits remain explicitly local evidence.

## Verification and limits

Exercise changed contents, wrong links/parents/shared drive, duplicate files,
permission changes/absent baseline, missing checksum, 403/404, malformed or truncated
pagination, bounded stalled responses and read-only transport. Prove concurrent
claims, expired lease recovery, stale result refusal, immutable SQL hashes, current
client RLS, fresh Core reads, scheduler entrypoint wiring and staff-visible results.
Retain initial failures. Actual process-kill, deployed browser, full release and live
Google qualification are distinct gates; no synthetic run substitutes for them.

The complete reporting columns, supervised legacy migration, independent review of
permission policy, and real provider/human admission remain required for whole-app
completion. The configured folder ID is authority; unrelated similarly named folders
are not inferred as an archive destination.

## Provider references checked 2026-09-27

- [Drive files.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get)
- [Drive file resource](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)
- [Drive permissions.list](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/list)
  requires following every next-page token before treating the list as complete.
