# R26 — Isolated full-app candidate rehearsal

**Date:** 2026-09-27. **Status:** in progress; no production admission.

## Scope and reason

The earlier source/voice drills did not exercise the production Desk build and
nginx together with Core, worker, PostgreSQL, Restate and the real offline parser.
The existing `hawa-chaos` project now has an optional candidate profile for this
connected rehearsal. No architectural foundation or runtime dependency changes.
Requirements: FR-001/014/017/060/065/069/070/075 and NFR-003/008/011/013/024/025;
linked source contracts remain in `plans/traceability.csv` and WORK_ITEMS.csv.

## Defect found and repaired

Browser entry saved `canva_manual` copyEn/copyCkb with separate design instructions,
but the planner's legacy parser required headlineEn or an inline divider. The
explicit **Design in Canva** action refused the saved request with COPY_REQUIRED.
The planner now recognizes structured Desk copy, preserves the exact strings,
accepts Sorani-only requests, and excludes the queue title from design copy.
Missing/invalid copy still fails closed. Historical source/document branches keep
their existing exact-copy rules. Desk's hard-coded model promise was replaced with
wording that points to the actual saved model receipt.

The added tests first returned **3 failed / 26 passed**: two demonstrated the
bilingual/Sorani-only rejection; one failed only on diagnostic wording (missing
copy was already refused). After the fix, planner/intake/fake regression checks
passed **3 files / 47 tests**. Repository source/test typecheck, standalone chaos
typecheck, lint and security scan passed. Core and Desk Docker builds passed.

## Observed development trial

The first deployed candidate scenario passed **16 invariants** in 78.5 seconds
before the manual-copy addition. It used real offline Docling, synthetic PDF and
silent Ogg fixtures, and explicit fake provider/model/Telegram/Canva services.
A Restate SIGKILL/restart and worker SIGKILL/restart preserved the review wait.
One original download per source, exact requester confirmation, manual voice with
no paid attempt, one revision child and one simulated delivery were verified.

Browser interaction verified sign-in/out, retained originals and manual voice
review, bilingual task entry, the initial copy rejection and the repaired explicit
handoff. The rebuilt app displayed the saved planner receipt and a retrieved
simulated Canva import. Screenshot: [Desk handoff](R26_DESK_HANDOFF.png). The browser
checks used keyboard actions; pointer targeting in the embedded browser hit
unexpected controls, so those observations were not treated as authentication bugs.

The final candidate scenario adds bilingual intake/generation replay, exact saved
copy/source hash, image-label verification and internal-network checks. Its clean
source run and full regression are still pending at this implementation checkpoint.

## Reproduction

```sh
pnpm exec tsx packages/testkit/chaos/run.ts --candidate --only R1.S3.SOURCES --poller worker --keep
```

See `packages/testkit/chaos/README.md`. This replaces only disposable hawa-chaos
data. The sanitized report includes source commit, changed runtime file hashes,
immutable image IDs, build labels and network names. No credentials enter evidence.
Memory observations are sparse samples, not continuous peaks. Recreating Core/Desk
requires refreshing nginx's cached upstream addresses; production deploy already
handles its proxy reload/restart.

## Remaining qualification

- Manual requests still receive NEEDS_A_DESIGNER from the guarded retired workflow;
  Desk misleadingly describes this as an automatic draft failure. Correct the
  manual ownership/status behavior without enabling automatic generation.
- Export preview still uses generic QA-pending wording; any improved status must
  bind to the exact captured artifact/revision, not infer approval from task state.
- Real Canva source editing/reopen, exact export binding and native Sorani review.
- Real named OIDC reviewer and human decisions; this trial uses a synthetic role.
- Real provider/delivery/billing and multilingual speech/PDF quality. Silence and
  fake models establish no creative or transcription quality claim.
- Clean-host WAL/PITR/Restate restore and sustained resource/load evidence. Chaos
  PostgreSQL uses fsync=off, and source downloads here use direct Core responses;
  production X-Accel paths and physical durability have separate gates.
- Retrieval relevance/latency and independent blind creative-quality admission.

No live provider calls, real messages, production deployment or flag changes were
made. App-wide 10/10 is not established by this rehearsal.

## Clean candidate qualification — 2026-09-27

Source `9e3a00a`, tested seal `4c113ae`: the full source regression passed
**447 files / 3,531 tests**, with **7 files / 59 tests skipped**, in 104.31 seconds.
The separately enabled deployed candidate passed **21/21 invariants** in 83.71
seconds including setup (the scenario itself took 25.68 seconds); 43 unrelated
chaos cases were skipped. All Core/worker/Desk image labels equal the tested seal,
no changed runtime sources were present, provider callers/parser use internal
networks, and the fake model ledger has no unmatched calls. The clean source
release manifest verified. Exact IDs, hashes, checks and limits are in
[R26_CANDIDATE_PROOF.json](R26_CANDIDATE_PROOF.json). This supersedes the pending
qualification statement at the implementation checkpoint above.

The isolated candidate remains at `http://127.0.0.1:56081`; production is unchanged.
Next is accurate manual-work status and the full manual capture/review flow, then
real Canva edit/reopen, named human review and the remaining acceptance gates.

## Fully fresh reset follow-up — 2026-09-27

Final health inspection found that inactive candidate-profile nginx and Docling
were left running by the original teardown. Compose knows those containers, so
`--remove-orphans` did not remove them; nginx also held the blob volume. The
preceding 21-check run remains recorded as workflow evidence and does **not**
establish a fully fresh reset. Its original report is retained at git `5492e87`.

Source `196d415` explicitly tears down both profiles, propagates failure before
deleting ephemeral credentials and verifies that all eight containers were
created after the rehearsal started. The fresh run passed **22/22 checks** in
82.91 seconds including setup, with no changed runtime files
and no unmatched fake model calls. The receipt includes every creation time.
Core/worker/Desk image labels equal this candidate source commit.

The previous manifest correctly refused the later harness commit because it no
longer matched its recent release commits. A new clean seal `94321df` passed
the release verifier and the final full regression: **447 files / 3,531 passed**,
**7 files / 59 skipped**, 100.61 seconds. Product source is unchanged from
the bilingual fix; this follow-up strengthens the test environment. The final
proof links the deployed source and tested seal separately. All stated live,
physical-recovery and human-quality limitations remain.

## Manual capture/review implementation — ADR-076, 2026-09-27

Requirements FR-001/041/043/064/069 and NFR-017/020. The first review was unreachable:
PNG capture created no revision and the existing recorder required one. The new
manual path creates a source-backed review from matching retained PNG/PPTX. It
preserves submitted exact copy separately from the inspected source text, requires
real unique PPTX object identities, and labels native Canva verification unknown.
Stable per-action PNG/PPTX keys survive ambiguous responses and browser reloads.
Manual recapture creates fresh evidence and invalidates approval once; an old
capture cannot return a later decision to review. No auto-approval is introduced.

A real integration failure initially exposed the missing editable object map (422).
The next recapture check exposed the source-hash uniqueness constraint, which
incorrectly treated identical bytes as identical review checkpoints. Migration 045
keeps the true source hash and distinct revision identity. An existing Desk test
also classified any occurrence of “saved” as the RECEIVED state; it now checks the
actual RECEIVED message instead. Early fixture-size/hash and missing test-import
errors were setup failures, not evidence of product defects. A sandbox DB socket
refusal and tsx IPC refusal were rerun with the required local permissions.

Final affected set: **14 files / 151 tests passed**. It includes first review,
concurrent/replayed captures, HTTP resume across app instances, actual approval,
copy-mismatch refusal, same-source recapture with one approval invalidation,
requested changes, completed/cancelled tasks, binding change, tenant refusal,
storage-integrity enforcement, source-identity verification and stale preview
checks. Types, lint, production Desk build and security scan passed. The candidate
scenario now exercises manual capture/review/approval/archive publication too;
its fresh deployment and the final full suite are pending at this checkpoint.

This is source implementation evidence. It does not qualify a production build,
real Canva layer editability, human approval, visual/RTL quality or real delivery.

## Manual capture qualification — source b78810a, tested seal 619827c

The fresh candidate passed **25/25 invariants** in 85.147s including setup.
Core, worker and Desk retain source `b78810a` image labels; all eight services were
newly created, external callers remain on internal networks, and runtime source
changes were empty. The extension exercised the actual Desk capture coordinator,
retained same-version PNG/PPTX, one review on replay, one simulated approval and
one completed archive publication. Docling was real; external adapters and the
approval identity were synthetic. No real provider or human acceptance is implied.

Browser verification saved another task, generated/imported through the fake,
clicked Capture for Review, reached **Needs approval**, and displayed PNG+PPTX
selected in the approval dialog. Confirm Approval was disabled for the operator;
the dialog was cancelled and the task remains unapproved. Screenshot:
[R26_MANUAL_REVIEW.png](R26_MANUAL_REVIEW.png).

The first full run passed 3552 tests with **2 failures / 59 skipped**. The new
migration exposed a hard-coded 044 expectation; successful regeneration exposed
a repair-budget test reusing its old revision ID. Test-only commit `177c2c3` updates
both and explicitly verifies stale decisions return 409. Its 42 tests passed.
No production guard or runtime source changed after the deployed rehearsal.
Final exact sealed regression: **449 files / 3554 passed;
7 files / 59 skipped**. Types, lint, Desk build, security,
source manifest and tested-seal blueprint **867/0/0** passed. Exact images, hashes,
commands, source lineage and limitations: [R26_MANUAL_REVIEW_PROOF.json](R26_MANUAL_REVIEW_PROOF.json).

Remaining engineering: checked exports of blank/manual-only Canva designs still
require source copy/font admission, and the dark approval warning needs improved
contrast. Native edit/reopen, named human multilingual/creative review, live
provider/delivery/billing, measured retrieval and clean-host recovery remain open.
The source-backed imported-draft manual path is locally qualified; all-app 10/10
and production admission remain unproven.

## 2026-09-27 — Blank-design policy qualification (ADR-077)

Implementation `196daf2`, corrected candidate `4686e90`, tested seal `6ff3659`:
manual Desk request → blank Canva creation → explicit synthetic manual edit →
checked PNG/PPTX → review → simulated approval/publication passed **29/29 fresh
deployed checks**. Runtime image labels match the candidate; eight services were
newly created, provider callers/parser have internal networks, and no runtime
source changed between candidate and tested seal. Prior PDF/voice/restart/import
checks remain in the same rehearsal. See R26_BLANK_POLICY_PROOF.json.

Full sealed regression: **450 files / 3,574 passed; 7 files / 59 skipped**, 103.00s.
Affected run: 8 files/139 passed, then the expanded blank-policy file/19 passed
(including restricted runtime RLS); counts overlap. Types, lint, production Desk
build, security, blueprint **873/0/0** and release manifest passed. Initial fixture,
type and scanner failures are recorded in the proof. First source-196daf2 rehearsal
passed 28 transport checks, but browser inspection found missing defaultLocale in
the synthetic DNA. Corrected fixture and directory assertion qualify this run;
no runtime validator was weakened.

The existing export operation now freezes matching source policy or exact manual
copy plus active, hashed, human-authored Client DNA families. Migration 046 prevents
policy mutation. Historical-key replay is stable after DNA changes; new review,
approval and publication reject superseded policy. Manual font checks inspect the
script declarations of each run without default or family-prefix admission.
No import row is invented; another design's source or another actor's inaccessible
source cannot provide a fallback. The retained policy accompanies source review.

Browser created task `a0516d5c-118a-4adc-9d9c-4fa4251e38cc`, used blank creation and Capture for
Review, and reached Needs Approval with two exports and zero imported sources.
The bright warning and gray disabled Confirm Approval were visually inspected;
PNG/PPTX stayed selected, the dialog was cancelled and the task remains unapproved.
Screenshot: R26_BLANK_POLICY.png. Provider editing is an explicit fake fixture;
real native edit/reopen and human quality remain unqualified. Production unchanged.

Next: qualify remaining Desk status/control behavior (hard-coded Studio models,
stale intake/binding messages, closed-task action admission). Flags govern automatic
intake in the inspected code; establish the explicit Studio action contract before
changing availability. Then live native/human/provider acceptance, retrieval
measurements and clean-host WAL/PITR/Restate restore. App-wide completion is unproven.


## 2026-09-27 — Task generation admission (ADR-078), implementation

Requirements FR-060/061/064, NFR-017/020. Paid Studio admission previously ignored
task closure; the initial regression run reproduced seven failures with ten older
tests passing. The fix locks current task authority at every new design boundary,
while retaining outcomes admitted before closure. Desk reflects those controls and
uses recorded requested/served models. New source: task-generation-guard.ts and
shared taskGenerationBlocker; no new provider or workflow dependency.

The first affected run passed 185 tests and failed three: two isolated ledger mocks
expected reconciliation refusal before any task DB read, and the race observer
reused a PostgreSQL statistics snapshot. Reordering read-only reconciliation ahead
of the task preflight and clearing the observer snapshot produced 188 passes.
Expanded restricted-runtime coverage then passed 210 tests and failed one because
the synthetic operator lacked membership and call admission lacked caller context.
The test now has a real synthetic membership (also tests revocation), and the
production reservation carries authenticated actor identity. Final results below
will identify the actual tested candidate. No live acceptance claim is made.


### Durable controls and affected qualification

Inspection found legacy cancel→failed_operator and pause/resume/retry→planning,
with database write errors swallowed. ADR-078 replaces this with attributed,
versioned, keyed task control receipts in the same transaction as the state change.
Cancel is terminal, pause blocks admissions, and resume restores only an actual
operator checkpoint. Generic retry returns a safe refusal naming saved-run controls.
The legacy memory-only mutation path now refuses without durable storage. Desk
exposes these controls and recovers the saved Studio run after reload. An in-flight
Studio resume cache now includes task/actor/role, preventing another scope inheriting
an authorized promise. Automatic intake flags are unchanged.

Final affected run: **16 files / 279 passed**, 7.36s. Added HTTP tests cover receipt
replay after Core replacement, concurrent version conflicts, changed keyed payload,
missing requester checkpoint, role/input refusal and event-write rollback. Desk tests
cover required reason, stable retry key after response loss and closed/role controls.
The first control test fixture lacked Client DNA/manual intake admission (six failures);
the fixture now creates an ordinary seeded task, while the deployed rehearsal tests
actual manual intake. Two bigint string expectations were normalized explicitly.
Source/test types, full milestone regression and deployed proof are recorded below
only after execution. Native editability, human quality and live providers are not
qualified by these synthetic tests.
