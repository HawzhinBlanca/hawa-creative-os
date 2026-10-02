# ADR210 — Restore-owned private artifact cleanup evidence

Date: 2026-10-01
Status: Accepted; connected and deployed synthetic recovery verified; production-dump approval pending
Requirements: FR-070, NFR-006, NFR-012, NFR-024

## Corrected diagnosis

The previous candidate cleanup finding misattributed an existing failed-restore
directory to the successful f1eb2098 run. The archived 09:11 UTC refusal on
97e9b3bf names that exact directory. Successful `CandidateRecovery.execute`
already removes its own directory before returning; the failure path deliberately
preserves private recovery artifacts, as ADR080 requires. The old observation of
14 retained files is real, but does not prove a successful-cleanup defect. Preserve
the original receipts and add an explicit correction; do not sweep failed runs.

## Decision

Retain the existing restore/cleanup policy. The caller supplies a fresh validated
16-hex recovery nonce; standalone calls may still generate their own. Refuse an
identity with existing recovery volumes before capture or writer shutdown. Emit an
additive successful cleanup receipt bound to that nonce, the task and exact
restored volume names. Verify
that the owned scratch directory is absent after removal before reporting success.
The caller requires this receipt before starting Core/worker writers. A missing,
inconsistent or false receipt refuses admission. Do not infer ownership or cleanup
from other directories' presence/absence, or from an old last-run file.

Failed validation or cleanup continues to leave writers unadmitted and private
artifacts available for diagnosis. Never delete another recovery's directory,
including a prior failed run, and never automatically resume an older store.
The receipt includes no private file contents, encryption key or key digest.
Production backup retention, application replay and separate-host admission are
unchanged. No new dependency or generic cleanup service is introduced.

## Required evidence

Exercise the actual Python execute path with real tar/encryption/authentication
and simulated Docker/SQL: successful cleanup preserves a foreign failed directory;
validation failure retains this run's private files; removal failure and an
unremoved-directory postcondition cannot emit success. Include these tests in the
normal release suite. Verify both nonce-bound cleanup receipts in the actual
isolated two-restore candidate rehearsal. Preserve the earlier failed-run/source
hashes and the correction in traceability and shared memory.

## Qualification — 1 October 2026

Clean6ae60a8d passes6812 tests/0fail/67skip,687 strict roots and seven
engineering stages. Automatic approval review rejected the production-dump
transfer; explicit authorization is pending and that stage remains NOT_RUN.
The preserved raw receipt records its skip; never describe it as all-eight.
Actual disposable candidate recovery passes98 checks and both nonce/task/volume
cleanup guards. Each authenticates/restores104 tables/174 policies/3 blobs with
zero missing references. No scratch directories remain after success; Docker
containers/volumes removed. Providers/staff are synthetic; two unmatched fake
Gemini requests remain visible. Script receipts do not claim application replay;
subsequent scenario verifies replay/reconciliation without repeating uncertain
requests. Same-host proof does not qualify separate-host or human/native gates.
