# Supervised real-office pilot

## Final local qualification — 2026-09-27

Tested and running isolated candidate **b38f60dd**: **4,237 passed, zero failed,
60 skipped** (505 passing/7 skipped files). Final lint passes; source build and 513
strict test roots passed before qualification. The selected deployed rehearsal passes
63 invariants, with 43 scenarios unselected and external providers simulated. Two fake
Gemini calls are outside the fixture coverage. This is not real-provider acceptance.

The Operations browser check shows saved scheduled checks with timestamps and evidence
hashes, and correctly labels incomplete Google/permission evidence as unverified.
The 314px panel is readable; the final screenshot and browser record are retained.
No manual run, repair, approval or delivery was performed through this panel.

A consistent read-only production snapshot was streamed directly into a private test
clone: all 38 pending migrations (023–060) applied, all 76 historical tables retained
their original data, and replay verified 60 migrations without applying any again.
The clone was removed. This is not an off-host restore or a retained rollback backup.
Production app images/schema remain unchanged; the tested nginx configuration-only
repair restored healthy HTTP 200 and Canva remains authorized.

**Next is one supervised real-office job.** Google reviewer login is unconfigured;
the office domain and reviewer email have been requested. Real login credentials and
Google/Canva approval are not fabricated. Prepare a verified production recovery set
before controlled cutover, then run a real brief, human review and authorized delivery.
Historical adoption/reporting, approved permission policy and broader quality/recovery
gates remain open. No whole-app 10/10 claim or new completion ETA is made.

Earlier failures below remain retained; this section supersedes the earlier pending
local-qualification status and the earlier claim that production was wholly unchanged.


## Latest preflight correction — 2026-09-27

Production's proxy returned 502 while Core itself was healthy: it retained Core's
old Docker IP. Validated graceful reload restored HTTP 200. The same installed nginx
1.27.5 now uses Docker DNS with five-second refresh and shared upstream zones; a
real disposable changed-IP drill verifies Core/Desk recovery without a proxy restart.
Only proxy configuration changed; production application images, schema and flags
remain on their earlier version. Reviewer OIDC configuration is still absent.

The isolated candidate includes scheduled external inspection (migration 060).
Final source/runtime qualification is recorded in
`plans/research-grade-upgrade-2026-09-25/R09_PUBLICATION_INSPECTIONS_PROOF.json`.
Historical checkpoints below are evidence for their own versions, not this candidate.

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
