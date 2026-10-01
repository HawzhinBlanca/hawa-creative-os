# ADR218 — Retain uploaded asset bytes and source provenance

Date: 2026-10-01. Status: connected and seven-stage engineering verified; production-dump/native/human/product admission pending.
Requirements: FR-018, FR-011, FR-077, NFR-012.
Sources: docs/08_MEMORY_RAG_CLIENT_DNA.md, docs/09_MESSAGING_AND_OFFICE_INBOX.md,
docs/14_SECURITY_THREAT_MODEL.md, docs/17_UI_UX.md, MASTER_SPEC.md, ADR035.

## Evidence and reason

Three actual Core/PostgreSQL controls fail on e47bb474. A metadata-only upload
returns 201, supplied SVG has no stored bytes, and supplied binary base64 hashes
filename/MIME/claimed size instead of the payload. A stored catalogue row is not
a recoverable source. Existing task-owned photo/document ingestion is separate.

## Decision

Use the existing content-addressed store and scoped asset catalogue. Require a
real UTF-8 SVG or canonical binary base64 payload, measure actual size, verify
media and bounded decoding, and refuse empty/malformed/mismatched inputs. Retain
original bytes separately from sanitized SVG derivatives. Extend the pinned
store's media contract to SVG and the already-allowed font formats; do not add a
storage provider or dependency. One bounded upload per Core prevents a queue of
buffered parses. Verify write authority before retention and again in the receipt
transaction. Database/store failures cannot return an admitted asset.

The asset's admitted blob reference and original-source receipts use foreign keys
and garbage-collection/backup roots. Historical metadata-only rows remain visibly
unavailable until genuine bytes are supplied; no byte hash is fabricated or
backfilled from metadata. Client plus admitted hash is the existing idempotency
identity. Different originals sanitizing to the same asset receive distinct,
append-only source receipts. Retries preserve identity and original metadata.

Serve only authorized asset/source receipts; a caller's hash or path grants no access. Downloads
verify stored bytes before any cache/redirect response, use private no-store and
attachment/sandbox headers, and refuse missing/corrupt or unretained sources.
Upload creates no Client DNA activation, learned label, human approval or external
provider call. Keep factual copy and client scope unchanged.

## Qualification

Preserve original failures. Verify cold restart/download, actual binary hash/size,
SVG original/derivative identity, duplicate and concurrent receipts, same bytes in
different clients, unknown/unauthorized/read-only/foreign-tenant access, malformed
and decompression-limited inputs, unavailable storage, transaction failure/retry,
corrupted sources even on conditional reads, legacy metadata behavior, append-only
provenance and real garbage-collection retention. Run connected source/asset/search/
blob/contract tests, strict build/lint, migration replay and the exact release gate.
Production-data transfer/native/human/product admission remain independent and open.

The first build assumed a Sharp dependency that this repository does not have.
It failed before qualification. Reuse the already-installed ffmpeg/rsvg/fontkit
decoders with bounded input, pixel/allocation/output limits and a process timeout.
No new package is introduced. The initial connected run passed 74 controls and
failed the existing FK inventory assertion because the two new retention roots
were absent from its expected list. Preserve that failure and extend the actual
view-coverage check; both references must also survive a real garbage-collection run.

Connected actual Core/PostgreSQL, source/asset/search/security/blob/migration checks:14 files /154 passed /0 failed /0 skipped;19 new Core controls;698 strict test roots, build and lint PASS.14 backup checks pass with actual archives/crypto and explicitly simulated Docker/SQL. Disposable font parsing checks both declared and transformed table expansion and an outline; child environments omit office credentials. Actual local OTF decoder check passes separately; no portable OTF-upload/native glyph proof is claimed. Original build, FK inventory, CSP overwrite, loader/migration-list, encoder and legacy fixture failures remain in the evidence archive. W6_ASSET_SOURCE_RETENTION_PROOF.json. Exact gate and production-dump/native/human/product admission remain open.

First exact clean82c5f157 retained:6915 passed /4 failed /67 skipped. Route/startup/media-type expected inventories updated. The new source policies had introduced actual per-row membership calls, violating ADR033; use its existing scalar membership subqueries/client arrays while preserving tenant and asset receipt scope. Isolated synthetic databases on55432 rebuilt for the not-yet-published/deployed078 checksum. Expanded18files/195passed/0failed/0skipped and698 strict roots PASS. Corrected exact gate pending; no deployment or product admission.

Exact clean seal 92a0703f passes seven engineering stages: 6919 passed / 0 failed / 67 skipped across 691 passed files / 6 skipped; 698 strict roots and 1786 package checks. Mandatory negative-flag refusal passes. Raw production-dump Stage 3 remains skipped: previous automatic approval review requires explicit transfer authorization, still pending. No all-eight qualification, deployment or native/human/product admission claim. W6_ASSET_SOURCE_RETENTION_GATE_EVIDENCE.json retains actual receipts.

## Current deployed encrypted recovery qualification — pending

Requirements: FR-018, FR-070, NFR-003, NFR-024, NFR-025. Sources: docs/14_SECURITY_THREAT_MODEL.md, MASTER_SPEC.md, docs/20_DEPLOYMENT_BACKUP_DR.md, runbooks/10_backup_restore.md.

Extend the existing isolated candidate source/delivery scenario with actual deployed
SVG original/derivative, PNG, WebP, TTF and WOFF2 upload/download verification. Two
distinct SVG originals reconcile one sanitized asset. Verify exact bytes, immutable
source identity/actors/timestamps, scoped unknown-hash denial, worker denial and
private sandbox headers before and after each authenticated encrypted restore.
Retain the existing pending Drive/Telegram no-resend checks. All client data, actors
and provider responses are synthetic; native quality, human judgments, offsite
recovery and production-dump transfer remain independent and unadmitted.

Permanent scenario helper typecheck, 698 strict roots and lint pass. Actual Docker
qualification has not run yet. Evidence: output/qualification/2026-10-01/current-asset-recovery/.

Initial clean Docker candidate afb3de31 retained: the new qualification helper queried
nonexistent dna_hash instead of content_hash and stopped before upload/restore.
Running nginx, persisted Desk session, image/source equality and restricted worker
checks passed. Correct the test query and explicitly count six source receipts;
production behavior unchanged. Actual corrected run pending.

Corrected clean f72d8222 retained:110 named controls passed, both encrypted stores
restored105 tables/176 policies/10 blobs/zero missing references with exact private
cleanup. The first download after the second nginx restart failed with a closed
socket before any byte/header result. The driver had restarted nginx without
waiting for health and retained proof HTTP keepalive connections across restarts.
Wait for nginx health and close readonly verification connections; no retry or
weaker assertions, no production behavior change. Whole corrected scenario pending.

Clean6fc1e437 retained: all original/admitted bytes and private headers survive
both restores; no unknown-hash/worker access or repeated external send. The full
parent scenario later fails its named Studio settlement assertion (192 earlier
controls passed). Add bounded response status/problem/actor-match/cost diagnostics
to that existing synthetic check; preserve failed receipts. Full scenario remains
unqualified until the late settlement failure is explained and corrected.
