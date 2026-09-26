# ADR-061: Admit a lifecycle photo through Core-owned durable storage

Date: 2026-09-26
Status: accepted for implementation
Requirements: FR-011, FR-060, NFR-001, NFR-006
Sources: `MASTER_SPEC.md` §§2, 5, 6; `docs/09_MESSAGING_AND_OFFICE_INBOX.md` §§5, 8; `docs/10_WORKFLOW_RELIABILITY.md`; `output/plans/2026-09-24-architecture-programme/PHASE2_DESIGN.md` §§2.1–2.3; ADR-059 and ADR-060.

## Context

RequestLifecycle cannot use a Telegram photo today. A captioned image is deliberately
parked because the open draft contains only text, while legacy intake can create a
task with inline image bytes. The worker journal must not retain those bytes. A
Telegram file ID alone is not durable enough for a request that may resume after a
long outage. Studio must use only media proven to belong to the owned task.

## Decision

- Core downloads a supported single photo and checks its size and byte signature before committing the
  hash-bound new-brief decision. It writes the bytes to the content-addressed blob
  store, then puts only a typed blob reference in the decision and Restate open
  event. A retry reads the committed decision before downloading again.
- The blob garbage collector treats a pending new-brief decision as a reference.
  Projection inserts a `task_files(reference_image)` row in the same transaction as
  the task, request owner and revision receipt. Studio reads that row and verifies
  the file hash before using the photo.
- Core verifies that a worker-supplied image reference matches the exact stored
  Telegram decision. A missing store, unsupported initial bytes, changed update or
  mismatched reference stops admission. If the file is lost later, Studio refuses
  to use the image instead of silently dropping it.
- This first admission applies to a captioned, single-message photo that resolves
  unambiguously to a new brief. Albums, captionless images, requester revisions,
  voice, PDFs and other media continue through the explicit hold path until their
  request binding and use are proved separately.

## Consequences

Restate carries a small reference and never image bytes. A completed Core decision
survives a worker/Core restart without requiring Telegram to serve the file again.
The task's foreign-keyed file row keeps its image available for later DesignRun and
backup. The pending decision also retains its blob until projection; retention of
these source decisions follows the existing inbox evidence policy. This does not
qualify broad media cutover or live Telegram delivery on its own.
