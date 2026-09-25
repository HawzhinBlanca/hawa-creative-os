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

## 5. Idempotency

File identity:

```text
sha256(task_id | design_revision | variant | artifact_kind | content_hash)
```

The app stores Drive file IDs. On an ambiguous network result, it queries by stored ID/app property or deterministic metadata before uploading again.

For a retry of the same task/artifact, the publisher reads every Drive result page and compares the stored package hash and SHA-256 before uploading. A file with missing package identity, a same-package checksum mismatch, duplicate same-package files, an incomplete search, or an unreadable result page stops publication for reconciliation. A different package hash identifies a later revision of the artifact. This lookup alone does not serialize simultaneous publishers or establish immediate search visibility after an upload.

ADR-044 adds a durable Drive file ID reservation for the default Core publisher. After the paged preflight, Core obtains a Google-generated binary-file ID and commits it in PostgreSQL under the publication/artifact key **before** upload. Concurrent Core processes reuse the committed ID. A retry after an uncertain upload uses that ID; Drive's 409 response is accepted only after independent readback confirms the task, artifact, package, parent folder, size, MIME type and SHA-256. A failed reservation or conflicting readback stops publication. Direct `GooglePublisher` users without a reservation store still use the paged preflight and do not have this cross-process guarantee. A live Shared Drive drill and operator repair path remain required before an exactly-once operational claim.

An upload timeout, lost response, transient Drive error, unreadable response, failed independent readback, or conflicting Drive identity is an unresolved archive outcome. Core keeps the publication pending and does not tell the requester that the archive is absent or queue the files as chat-only. A retry with the same publication key reconciles the reserved ID and verifies the file before requester delivery. An unverified file is never cached as a successful publication. A definite pre-upload failure such as missing credentials may use the separate chat-only path only when the publication has no earlier attempt or reserved/recorded Drive file. A later credential or destination failure cannot prove that an earlier upload did not commit. The office still needs a staffed resolution action for an unresolved Drive conflict.

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
