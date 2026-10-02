# ADR221 — Retained photo handoff when a burst settles alone

Date: 2026-10-01. Status: locally implemented and qualified on bc25c8ca; production/product admission remains open.
Requirements: FR-004, FR-005, NFR-001, NFR-014.
Sources: docs/09_MESSAGING_AND_OFFICE_INBOX.md, MASTER_SPEC.md, ADR143,
ADR145, ADR160; current ordinary durable run on 90c87686.

## Observed defect

R1.S3.PHOTO and R1.S3.REVISION_PHOTO record two downloads of the same input.
A database-backed lone-photo regression reproduces two downloads of a captioned
photo even before a process crash. The burst collector saves a content-addressed
photo and a source-hash-bound inbox part. Its `alone` outcome drops the retained
reference, so ordinary caption/revision intake downloads the same file again.

## Decision and limits

An `alone` outcome carries the retained image only from the existing tenant-scoped,
source-hash-checked part. Missing or refused retained input is skipped. Captioned
intake uses that reference for brief/revision admission; if its words instead keep
the photo for a later brief, the held-photo service receives the same internal
reference. This argument is not exposed to the HTTP body. Captionless photo
collection, sender/topic binding, group intent, cut-caption holds, replay receipts,
blob validation and projection authorization retain their existing behavior.

Reusing bytes never skips the revision-photo decision. Persist the same request,
chat, source hash and image receipt before child-task projection, then expose the
existing crash boundary. A replay consumes that immutable receipt. The first
handoff implementation accidentally skipped it; a database-backed cold-instance
revision regression refused projection with409. Both partial broad qualification
runs were cancelled before correcting source; they are not pass evidence.

No provider cache, database migration, model call, global photo coverage rule,
credential or production deployment is added. Concurrent first-time download
deduplication is not claimed by this repair. Frozen source hashes and logical
decision/task identities remain authoritative across process replacement.

## Qualification

The original full durable failure and the focused red-before regression are retained
under output/qualification/2026-10-01/current-durable-suite. Connected media,
scope/source-conflict and process-replacement checks must pass before acceptance.

## Current qualification — 2026-10-01

Exact clean bc25c8ca passes 6,949 source tests (0 failures, 67 skips), 699 strict
roots, seven technical gate stages, mandatory flag refusal, and 54/54 ordinary
Docker durable scenarios (779/779 controls; zero uncovered model calls).
The same candidate also passes 202/202 deployed source/recovery controls
with real nginx, Desk, Core, worker and offline Docling, including both encrypted
fresh-volume co-restores. External adapters and staff actions are synthetic.
Original red/failed/cancelled receipts remain retained. Native/human/model/pilot
admission, offsite/PITR/RPO/RTO and authorized production-dump checks remain open.
No production deployment, native save or real provider call.
See plans/content-aware-design-2026-09-30/W6_DURABILITY_REPAIR_PROOF.json.
