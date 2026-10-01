# ADR205 — Exercise current service boundaries in the deployed candidate

Date: 2026-10-01. Status: proposed; acceptance pending.
Requirements: FR-069, FR-070, NFR-012, NFR-024, NFR-025.
Sources: docs/10_WORKFLOW_RELIABILITY.md; docs/14_SECURITY_THREAT_MODEL.md;
MASTER_SPEC; ADR183; R26 deployed candidate and coordinated recovery contracts.

## Evidence

The exact f73c25ef candidate fails before any scenario: nginx exits during startup.
Independent validation with its actual production configuration confirms the missing
/etc/nginx/hawa-office-proof.conf include. The rehearsal mounts nginx.conf but not
that file. Its workers also inherit Core's operator/provider environment and app
database login, unlike the currently deployed restricted worker boundary.
The failed hook and original receipt are retained; 57 skipped scenarios prove no
successful recovery or deployment qualification.

## Decision

Generate an independent private office proof for each disposable project life,
mount its include read-only, and overwrite the same inode with synchronized writes.
Bind Core to the same proof without changing the rehearsal's required-auth policy.
Never use production credentials, configuration files or data stores.

Give both rehearsal workers the current production service environment and a separate
hawa_worker_login. Provision it through the existing owner-only role provisioner
after versioned upgrades. Reuse ADR183's grants and effective-privilege verification;
add no grants or production behavior. Mount source blobs read-only. Retain only the
fake control URL, private fake CA and test identity as rehearsal-specific additions.

Verify actual interpolated Compose boundaries, mounted nginx validation and running
worker identity/denials. Run the fresh deployed candidate and authenticated coordinated
PostgreSQL/Restate/blob recovery with external-effect reconciliation. Keep real providers,
native Canva, human decisions and whole-product admission separate from this fake-provider
workflow rehearsal. Record missing or failed evidence honestly.

The first repaired rehearsal correctly ends its linked revision with
NATIVE_REVISION_HANDOFF_REQUIRED. Preserve ADR113/114 admission: exercise a synthetic
office copy/edit of the existing fixture, current request-scoped binding and exact
copy confirmation, retained PNG/PPTX, and signed owner review before a separate
reviewer approval. The fake copy operation is test control only, not a new Connect
API or native-preservation claim. Keep unrelated OOXML parts and shape/style bytes
unchanged when editing its fixture text. Fail fast on unexpected terminal design
outcomes and retain checks already observed when later scenario work fails.

The native journey also exposes stale disposable DNA: its seed has no tenant in
the document, no synthetic office author, and an MD5 content hash. Use the current
scoped DNA identity/SHA-256 contract and the existing test office actor. This only
represents fixture authority and cannot establish human authorship or taste quality
for a real client. Preserve the application's manual export refusal checks.

The next trial reaches signed review and explicit approval, then the recovery
subprocess refuses Compose interpolation because it inherited no office-proof
path. Pass the same project-scoped Compose environment to that subprocess; do not
derive a second configuration or write production files. Share the observed-check
array through recovery too so later failures retain its completed checks.

Both restores and uncertain-send reconciliation then pass; the last sheet check
uses an unsupported legacy A:Z read and mistakes its HTTP 500 for no rows. An
independent current tab-aware read returns the header and actual task row. Use the
existing Sheets data-filter API and require exactly one matching task row. Do not
relax publication or mirror checks, synthesize a row, or accept transport failure.
