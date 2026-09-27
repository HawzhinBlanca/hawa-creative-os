# Supervised real-office pilot

Requirements: NFR-013/015/020/024; current Canva contract, ADR-064/065/076/077.
Latest bounded evidence: `plans/research-grade-upgrade-2026-09-25/R26_LIVE_PREFLIGHT_PROOF.json`.

## Current checkpoint (2026-09-27)

Production is healthy with connected Canva, but has migrations 001–022 and no
configured named Google reviewer login. A live-data clone passed migration
023–046, retained historical records, and was removed. The refreshed isolated
candidate passed 36 workflow invariants and four deployed font-QA reads with
synthetic providers. This does not authorize a production cutover by itself.

### Latest isolated candidate follow-up

Candidate `8dd04cc` includes locale provenance, per-paragraph QA, canonical task-copy
handling and explicit LTR transfer repairs. It passes 36 workflow invariants, four
list/detail reads and compiled checks of retained real Canva bytes. Final source
regression: 3,687 passed/59 skipped after correcting two obsolete backup
test expectations; runtime unchanged from candidate. Production remains unchanged.
See `R19_EXPLICIT_DIRECTION_PROOF.json`; human review and real delivery are open.

## Prepare the real pilot

1. Confirm the office's Google Workspace domain. Configure
   `HAWA_GOOGLE_OIDC_CLIENT_ID`, `HAWA_GOOGLE_OIDC_CLIENT_SECRET`,
   `HAWA_GOOGLE_OIDC_REDIRECT_URI` and `HAWA_GOOGLE_OIDC_HOSTED_DOMAINS` through
   the deployment secret/configuration process. The callback must be HTTPS and
   end in `/auth/google/callback`; the Desk origin must match the registered app.
   Keep credentials out of chat, artifacts and source control.
2. Provision server-verified Google subjects and tenant/client memberships. Have
   a named administrator assign the reviewer to the pilot client/project. Do not
   invent subjects, activate a shared credential as human proof, or count an
   automated test decision as the reviewer's action. Follow `CHAT_REVIEW_ACCEPTANCE.md`.
3. Freeze the candidate image digests and source identity. Prepare a verified
   production database/blob/Restate recovery set and rollback procedure before
   applying migrations. Retain flags and task executor ownership until their
   cutover gates pass. The disposable migration clone is not the recovery set.
4. Apply the verified production change only through the normal deployment gate;
   read back exact image identities, all migration checksums, readiness and login.

## Run and record one real job

1. Select an authorized office brief with explicit client, dimensions, approved
   exact copy and assets. Preserve its original source and client scope.
2. Create one Desk task with a stable action key. Verify retry/reload identifies
   that same task. Keep facts unchanged through the design plan and Canva import.
3. Inspect independent native text/assets, make the authorized edit, save/reopen,
   and capture actual PNG/PPTX/requested PDF. Record Canva ID, hashes, revision,
   client font policy and QA findings. A font-family pass proves no glyph license
   or rendering guarantee. A native reader must inspect Sorani/Arabic output.
4. Have the assigned person inspect the final capture and record their own
   decision. Verify stale revisions and revoked/cross-client authority are refused.
   A changed export needs a new capture and approval.
5. After approval and authorization to deliver, publish the pinned bytes. Read back
   the Drive files and Sheets identity/row; retain actual requester-send receipts
   only when sending that message is authorized. Reconcile uncertain effects
   instead of replaying an unconfirmed send.
6. Reload Desk and verify the final state against those durable receipts. Record
   elapsed time, provider cost, exact output hashes, reviewer findings and defects.

Any missing prerequisite or failed check remains explicit. This pilot does not
replace the multilingual corpus, independent-host recovery, or held-out quality
and cost evaluations required for broad release admission.
