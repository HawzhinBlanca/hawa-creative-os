# Google Drive and Sheets Integration

## 1. Source-of-truth boundaries

- PostgreSQL: task, state, approval, revision, and synchronization truth.
- Editable studio/local staging: working creative source.
- Google Shared Drive: approved deliverable/source archive.
- Google Sheets: familiar reporting mirror.

The Sheet is never parsed to reconstruct workflow state.

## 2. Shared Drive mapping

Each project stores immutable IDs:

```text
shared_drive_id
knowledge_root_folder_id
production_root_folder_id
archive_root_folder_id
reporting_spreadsheet_id
reporting_sheet_id/tab
```

A model never searches for or invents a destination.

## 3. Folder layout

```text
/Clients/{client-code}/{project-code}/Production/{YYYY}/{MM}/{task-id}/
  00_Request/
  10_Preview/
  20_Final/
  30_Source/
  40_QA/
  50_Provenance/
```

Names are human-friendly; IDs are authoritative.

## 4. Publication workflow

1. Freeze approved revision and QC hash.
2. Build source package in content-addressed staging.
3. Calculate hashes and manifest.
4. Resolve configured folder IDs and verify permissions.
5. Create/reuse task folder using publication idempotency key.
6. Upload resumably where appropriate.
7. Read back file IDs, sizes, MIME, and relevant metadata.
8. Store Drive references in PostgreSQL.
9. Upsert Sheet row by immutable task ID.
10. Verify row values.
11. mark publication complete;
12. send source-channel notification separately.

A notification failure does not undo valid publication.

For a task with a Canva approval, Core reads the selected bytes before taking its per-task
publication lock, then rechecks that same approval after taking the lock and before changing task
state or calling Google. A completed Canva export takes the same lock while it commits its bytes and
retrieval status; if delivery holds the lock, the export stays submitted for retry. The capture
transaction also locks the task row and stamps the actual insertion time, so a capture committed
after approval is visible to the freshness check. The legacy Delivery workflow repeats this check
under the lock when claiming a run, and its preparation repeats it before provider effects. This
serializes **locally committed** captures with publication. An edit made only in Canva, without a
new capture, is not yet observable by this database guard; live provider-version checking and an
end-to-end race drill remain release work under R17.

## 5. Idempotency

File identity:

```text
sha256(task_id | design_revision | variant | artifact_kind | content_hash)
```

The app stores Drive file IDs. On an ambiguous network result, it queries by stored ID/app property or deterministic metadata before uploading again.

For a retry of the same task/artifact, the publisher reads every Drive result page and compares the stored package hash and SHA-256 before uploading. A file with missing package identity, a same-package checksum mismatch, duplicate same-package files, an incomplete search, or an unreadable result page stops publication for reconciliation. A different package hash identifies a later revision of the artifact. This lookup alone does not serialize simultaneous publishers or establish immediate search visibility after an upload.

ADR-044 adds a durable Drive file ID reservation for the default Core publisher. After the paged preflight, Core obtains a Google-generated binary-file ID and commits it in PostgreSQL under the publication/artifact key **before** upload. Concurrent Core processes reuse the committed ID. A retry after an uncertain upload uses that ID; Drive's 409 response is accepted only after independent readback confirms the task, artifact, package, parent folder, size, MIME type and SHA-256. A failed reservation or conflicting readback stops publication. Direct `GooglePublisher` users without a reservation store still use the paged preflight and do not have this cross-process guarantee. A live Shared Drive drill and operator repair path remain required before an exactly-once operational claim.

An upload timeout, lost response, transient Drive error, unreadable response, failed independent readback, or conflicting Drive identity is an unresolved archive outcome. Core keeps the publication pending and does not tell the requester that the archive is absent or queue the files as chat-only. A retry with the same publication key reconciles the reserved ID and verifies the file before requester delivery. An unverified file is never cached as a successful publication. A definite pre-upload failure such as missing credentials may use the separate chat-only path only when the publication has no earlier attempt or reserved/recorded Drive file. A later credential or destination failure cannot prove that an earlier upload did not commit. The office still needs a staffed resolution action for an unresolved Drive conflict.

Core records `ARCHIVE_UNCONFIRMED` on the publication before returning an uncertain Drive outcome, and exposes the task as `ARCHIVE_RECONCILIATION` in Desk Needs Action and in the publication-state endpoint. “Recheck Drive Archive” starts a new attempt on the same publication and reserved file ID after Google access is restored; a persistent identity conflict stays open for operator investigation. The internal reconciliation audit flags this as an **unconfirmed** archive, never as proof that a Drive file is missing. A failed Delivery workflow report, including a terminal prepare error, must preserve the marker and leave the task publishing. A later request-owned run must keep that marker until verified Drive receipts replace it. Once Drive is verified, an unconfirmed Sheet row is separately recorded as `SHEET_UNCONFIRMED` and shown as `PUBLISH_RECONCILIATION`; a completed publication clears the error. This is local PostgreSQL bookkeeping and fake-provider recovery. It does not replace live Drive readback or a staffed conflict-resolution procedure.

For Core's own delivery, verified Drive references, any Sheet receipt, publication/task completion, and the requester outbox command commit in one PostgreSQL transaction after the provider call. An unconfirmed Sheet row leaves the task publishing with its receipts and one durable requester command. If any database write fails, the transaction rolls back, Core returns an error, records `ARCHIVE_UNCONFIRMED` in a fresh transaction where possible, and retries the same reserved Drive ID. No requester command or complete task is exposed from the failed attempt. The Telegram send still occurs later through the outbox; a failure of that external send does not undo a valid publication. The Delivery workflow's prepare step commits receipts without a Core outbox command, then its separate finish projection decides completion after requester-send evidence.

Under ADR-045, a publication with `REQUESTER_SEND_UNCONFIRMED` is exposed as `REQUESTER_SEND_RECONCILIATION` in task detail and the Desk queue, separate from `PUBLISH_RECONCILIATION` for an unconfirmed Sheet row. The Desk does not offer delivery or Sheet retry for this requester-send status. An operator must inspect Telegram and durable send records; this status alone does not prove receipt, authorize replay, or close the request. A staffed, audited resolution action and live requester receipt are still required.

The staff evidence endpoint reads only the current request-owned publication and the exact TelegramSender keys of its approved file manifest and delivery notice. It reports the latest local send mark, number of attempted sends and mark time, and explicitly says the requester receipt is unavailable. It does not search all tenant messages, infer a Telegram receipt from a worker mark, or change publication state.

For new critical sends, the Telegram sender records the positive Bot API message ID in the append-only `sent` mark. The staff evidence view displays it as a provider send acknowledgement, not as a person-level receipt. Missing or malformed message IDs are uncertain, including on the plain-text fallback; a successful provider answer that cannot be durably marked `sent` also stays uncertain after bounded database retries. Older `sent` marks without an ID remain historical evidence with no invented ID.

Telegram text, document and photo sends classify a 5xx or a successful HTTP response without a definite Bot API result as uncertain, since a second call could duplicate an accepted message. Text and photo formatting fallbacks run only after an explicit parse-entity rejection. A 429 with a definite rejection remains retryable after the provider's requested delay. The sender retains its mark and exposes the case to staff rather than blindly replaying an ambiguous effect.

ADR-046 adds a separate office-administrator settlement for a request-owned `REQUESTER_SEND_UNCONFIRMED` case. Staff must inspect the exact requester chat and enter one observed Telegram message ID for each approved file and the notice. The current request revision, approval, publication, chat, file set and any locally recorded Bot API IDs must match. Core rechecks stored Drive and Sheet receipts before atomically completing the request, task and publication and recording the staff actor, observed IDs and package hash in an immutable task event. An identical repeated action returns its recorded result; a changed or stale action is refused. Inconclusive cases remain open, no send mark is released, and no automatic replay occurs. The publication-state response identifies staff-visible completion separately from workflow-reported completion. Staff visibility is a human attestation, not proof the requester opened a message; the live requester receipt gate remains open.

Completion locks the named publication and task in that order, verifies the publication belongs to the task, and checks the task state and version before writing `complete`. A cancellation committed after the Drive upload but before the receipt transaction wins: completion rolls back, no requester command is queued, and the task remains cancelled. The archive may still exist externally, so the publication retains `ARCHIVE_UNCONFIRMED`; the internal audit flags it even though the task status remains `CANCELLED`. The publication-state response tells staff to inspect the reserved Drive identity and apply retention policy, without suggesting a requester-delivery retry. A second call on an already complete publication is idempotent and does not append another task event. These checks prevent a local task-state overwrite; they are not a live Drive inspection or a staffed removal/retention operation.

Before Core records a successful publisher answer, it checks that the answer names the same publication key and every approved artifact exactly once, with distinct verified Drive file IDs, expected content hashes, MIME types and byte sizes. An emulated answer cannot qualify. A claimed complete Sheet result must name the configured spreadsheet, task ID, package hash, observed hash and positive row number; a Drive-only result must not claim a synced Sheet row. A false success leaves the publication pending with `ARCHIVE_UNCONFIRMED` and withholds requester delivery. This validates the provider result at Core's trust boundary; it does not independently query Google. The publisher's readback and a live reconciliation drill are separate evidence gates.

The Sheets publisher treats a blank or unreadable cached row identity as untrusted: it searches for the immutable task ID again before updating, rather than writing into the cached row. A Sheet receipt's `observedHash` now comes from an actual row readback; an accepted write without readback leaves it absent and cannot set `completedAt`. A later `reconcile` call that observes a changed row or cannot read it clears the current completion claim and returns `drive_complete` with Sheet sync unconfirmed. These are local adapter and fake-HTTP checks; the live Google row, permissions and staffed repair path remain admission work.

## 6. Sheet columns

Required visible columns:

```text
Task
Client
Project
Request date
Due date
Status
Language
Requester
Current revision
Drive link
Source link
Revisions
Approval
Approver
Approved at
Last updated
```

Hidden/system columns:

```text
task_id
row_version
publication_id
source_event_id
qc_status
sync_hash
last_sync_at
last_sync_error
```

Staff may sort/filter. Updates rely on stored `task_id`/row identity, not row number alone.

## 7. Atomicity and divergence

Drive and Sheets cannot share one transaction. Use a saga/reconciliation model:

- Drive may be complete while Sheet is pending.
- PostgreSQL records each substate.
- Sheets related updates use batch operations where possible.
- A scheduled reconciler checks missing/wrong links, duplicate folders/files, stale rows, and permission drift.

## 8. Permissions

Use a dedicated Google identity/service account with access only to required Shared Drives/folders and Sheets. Avoid domain-wide delegation unless a documented use case proves it necessary.

The app must not inherit broad employee Drive access.

## 9. Knowledge ingestion

Only configured curated folders are indexed. File changes are detected by Drive ID/version/hash and reconciled. A deletion/deprecation removes the source from active retrieval without erasing the audit trail.

## 10. Recovery tests

- upload succeeds but response is lost;
- folder exists but DB write fails;
- DB record exists but file was manually moved/deleted;
- Sheet succeeds but response times out;
- rows are sorted/inserted manually;
- service account permission is revoked/restored;
- quota/rate limit occurs;
- task is republished after approved revision change.

All must converge without duplicate logical artifacts.
