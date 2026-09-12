# CV-16: Keep Verified Drive, Sheets, and Channel Delivery

## Objective & Requirements
Fulfill task **CV-16** and all associated requirements:
- **FR-046 (Deterministic Drive Destination)**: Destination Google Shared Drive and folder IDs are derived strictly from Client DNA. Models and callers cannot search for, choose, or invent destination folders. Unauthorized or nonexistent folders are denied with `INVALID_DESTINATION`.
- **FR-047 (Idempotent Drive Upload)**: Retrying a publication reuses and verifies existing remote files by task ID, revision, and content hash rather than creating duplicate files.
- **FR-048 (Publication Verification & Hash Equality)**: The publisher reads back file IDs, observed byte sizes, and verifies exact SHA-256 hash equality matching approved local files before marking completion.
- **FR-049 (Sheets Upsert by Immutable Task ID)**: The office reporting sheet is updated by immutable task ID and stored row identity, never blind-appended on retries.
- **FR-050 (Publication Reconciliation)**: Reconciles PostgreSQL, Google Drive, and Google Sheets, detecting and repairing asset and status drift.
- **FR-051 (Thread Notification & Delivery Isolation)**: Thread notifications (Telegram, WhatsApp) receive delivery status and links, but notification failures never undo or roll back valid Google Drive or Sheet publications.

## Verified Evidence Packets

1. **`AUTHORIZED_ISOLATED_DELIVERY_TRACES.json`**:
   - Traces omnichannel publication for KAAE, Drustee, and Aster.
   - Proves destination isolation: each client publishes to their designated Client DNA production folder without brand bleed or cross-tenant delivery.

2. **`LOST_SUCCESS_AND_RETRY_REPORT.json`**:
   - Proves lost-success replay: network timeouts replayed with identical payload reuse existing receipt (0 duplicate uploads, 0 duplicate sheet rows).
   - Proves differing payload under identical publication key is rejected with `IDEMPOTENCY_CONFLICT`.
   - Proves subsequent revision update for same task uses `PUT` to update the existing row rather than blind-appending.

3. **`HASH_EQUALITY_READBACK_VERIFICATION.json`**:
   - Validates SHA-256 hash equality between approved local deliverable bytes and remote readback.
   - Proves tampered SHA-256 hash is rejected with `PUBLICATION_VERIFICATION_FAILED`.
   - Proves nonexistent physical deliverable is rejected with `PUBLICATION_VERIFICATION_FAILED`.

4. **`NOTIFICATION_DELIVERY_ISOLATION_REPORT.json`**:
   - Documents wrong-folder denials (`audit-invented-destination`, `unauthorized_folder`, empty string).
   - Documents thread notification failure decoupling (failed notification does not roll back publication).
   - Documents publication reconciliation audit ensuring PostgreSQL, Drive, and Sheets convergence.

## Verification Matrix
- Automated test suite: `apps/core/test/verified-delivery-drive-sheets.test.ts` (10/10 passing).
- Database integrity: Pristine row count (1,449 tasks, 1,449 outbox commands on schema `hawa`).
- Blueprint validator: `PASS=464, WARN=0, FAIL=0`.
