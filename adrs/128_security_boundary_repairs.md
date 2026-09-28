# ADR-128 — Switch roles, one service principal, and edge and grant boundaries

Date: 2026-09-28. Status: implementation; production rollout remains open.
Requirements: NFR-006, FR-072, FR-070. Normative sources: MASTER_SPEC.md,
docs/14_SECURITY_THREAT_MODEL.md, adrs/034_request_lifecycle_on_restate.md,
adrs/035_content_addressed_file_store.md, adrs/054_fenced_intake_switch_release.md.
Source: Phase 4 adversarial review, security findings 7, 8, 10, 11, 12 and 28,
each re-traced on `codex/research-grade-design-system` at 7b8de71e.

## Decision

Each intake switch has one role rule on every route that changes it. WhatsApp
is the administrator's in both directions, as POST /waha/kill-switch already was.
Telegram stays with operator, administrator and art director: the Desk and the
nightly Restate backup (restate_nightly.py, art-director key first, then the
bearer key, releasing with its pause's changeTag) keep working without change.
/operations/kill-switch applies the same rule and answers only after PostgreSQL
has the switch; it used to assign the in-memory copy and save in the background.
A WhatsApp change there also sets WAHA_KILL_SWITCH, as the toggle does.

/v1/internal/* has one credential check. The Delivery routes take only what
verifyRequestAuth maps to the service role, so serviceTokenOf's refusal of a
short or reused worker token closes them as it closes intake. HAWA_DEV_TOKEN
joins the keys the worker token must differ from, and POST /auth/session
never issues a session for the configured worker token.

No credential is read from a query string. The studio-image `?access_token=`
fallback is retired: the Desk sends the header (AuthorizedImage) or the session
cookie. nginx's /_blobs/ location no longer logs missing files and logs below
crit nowhere, so a request line with a token cannot reach the error log.

nginx answers /v1/internal/, /api/v1/internal/ and /api/internal/ itself with
404, using Core's isInternalPath pattern as a regular-expression location. The
worker calls Core at HAWA_CORE_INTERNAL_URL, default and documented value
http://core:3001, on the compose network; it never uses nginx.

db/03-grants.sql is the init script of an empty data directory. Once the
versioned-upgrade runner has created hawa.schema_upgrades, the file changes
nothing and says so. Its re-run used to re-widen tables the migrations narrowed,
drop migration 022's executor column grants and make schema_upgrades writable.
The partial per-migration repeats it carried for such a re-run are removed.

## Consequences and limits

- An operator or art director who threw WhatsApp through the toggle can no
  longer release it; an administrator must. Throwing it is also refused to them.
- An old link or cached Desk that sends `?access_token=` for a picture gets 401.
  Nothing in the current source produces such a link.
- A worker token equal to HAWA_DEV_TOKEN now closes /v1/internal/* until the
  worker has a key of its own, as any other clash already did.
- A grant change after initialization must be a migration. A database whose
  migrations were applied without the runner is not supported by this file.
- These are defence-in-depth repairs. No exploitation in production was
  observed or investigated; no production data was read.

## Acceptance

Real isolated PostgreSQL through restricted hawa_app connections: art director
and operator refused on both WhatsApp routes in both directions, with the row
and WAHA_KILL_SWITCH unchanged; administrator changes persisted before the
answer; the backup's Telegram pause and conditional release with the art-director
key; client and anonymous refusal. Clashing, short and HAWA_DEV_TOKEN-equal worker
tokens refused on intake and both Delivery routes; the valid worker token reaches
body validation. Query-string session refused; header and cookie accepted.
A re-run of 03-grants.sql after the runner changes no privilege of hawa_app.
The production nginx image with this file, stub Core and Desk: every internal
spelling is 404, ordinary routes still proxy, the compose-network route to Core
is unaffected, and a missing stored file leaves no token in any log.

## Local qualification — 2026-09-28

Initial red: 16 failed / 58 passed over the six changed test files, each for the
reported defect (details in SECURITY_BOUNDARY_PROOF.json). One superseded test
expectation (an operator WhatsApp toggle) failed after the fix and was changed
to the administrator. Final affected verification: 48 files / 537 passed,
1 failed (a pre-existing stale constant in startup-schema-check.test.ts, not
touched here), 2 opt-in process-kill tests skipped. Full suite once: 4467
passed, 9 failed, 60 skipped; the same 9 tests in the same 8 files fail at
7b8de71e in a throwaway worktree, so none is introduced here. No deployment,
production read or write, live nginx change or credential rotation was performed.
