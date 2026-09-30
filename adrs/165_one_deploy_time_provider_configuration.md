# ADR-165 — One durable provider configuration path

Date: 2026-09-30
Status: Accepted for implementation; deployment verification pending
Requirements: NFR-006, FR-064, FR-066, FR-071, FR-074

## Reason and choice

The Settings route changes Core's process environment but neither persists the
change nor updates the Telegram worker. A restart restores the old key; changing
Telegram in Core leaves the actual poller on another credential. A second live
secret store would require a new coordinated reload and rollback protocol.

Use the existing canonical host-local `.env.production` and verified release
deployment as the only credential activation path. Retire browser/process-only
overrides, returning an explicit deployment-required result without verifying,
logging or echoing submitted secrets. Settings remains a presence readback and
explains how the operator manages configuration. Canva OAuth grants remain in
their existing encrypted durable store.

Extend the existing host rotation tool to OpenAI, resolve the ADR-158 shared
configuration path, atomically replace the canonical file and record an
owner-only audit receipt of changed field names, reason, host actor, timestamp
and before/after hashes. Never record credential values in the audit. Redeploy
the active sealed release through the ordinary preflight/backup/blue-green path;
ADR-163 regenerates the allowlisted worker environment. Failed deployment keeps
the change as pending host configuration and is reported as failed, never active.

This deliberately keeps one configuration system. No browser-selected endpoint
is contacted and no browser request can redirect a provider call to an arbitrary
host. Public-customer secret administration is outside this private-office task.

## Verification

Unauthorized/worker writes remain refused; authorized writes receive the explicit
deployment-required response and change no process/file. Verify planted secret
exclusion, credential-free Settings copy, host-tool syntax, atomic/audited updates
in isolated fixtures and actual matching Core/worker configuration at deployment.
