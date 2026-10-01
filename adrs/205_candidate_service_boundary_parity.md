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
