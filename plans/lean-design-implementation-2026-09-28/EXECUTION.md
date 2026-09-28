# Lean design implementation

User authorization: implement all recommendations in the 2026-09-28 lean architecture report.
Starting source: `67cbc2e9`, existing branch `codex/research-grade-design-system`.
Research: `output/research/2026-09-28-lean-design-architecture/REPORT.md` and its retained evidence.

## Scope and completion ledger

The entire six-package objective remains active. Source implementation, local qualification,
native capability admission, human quality evaluation and production admission are separate evidence.
No package is complete merely because a smaller test passes.

| Package | Scope | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Preserve uncertain Canva effects, current native revision basis and unrelated manual edits | In progress: uncertainty, reviewed-copy handoff and automatic linked-revision owner recovery locally qualified; actual native preservation and initial manual intake open | ADR-108/113/114; CANVA_UNCERTAINTY_PROOF.json; NATIVE_REVISION_HANDOFF_PROOF.json; LIFECYCLE_NATIVE_RECOVERY_PROOF.json |
| 2 | Complete brief handoff, full copy geometry, scoped visual references/photo meaning, faithful refinement assets | In progress: input/asset handoffs and Unicode lexical exemplar baseline locally qualified; authorized visual order, multilingual semantic retrieval and human comparison open | ADR-109/115; CREATIVE_HANDOFF_PROOF.json; UNICODE_RETRIEVAL_PROOF.json |
| 3 | Free feasibility before art, eligible-only judging, retained typed responses, pinned derivations, safe bounded concurrency | In progress: pre-art/selection eligibility, retained serial results, visual input pins and font basis locally qualified; mandatory text evidence and shared fallback measurement locally qualified; native text qualification, branch checkpoints, renderer/cutout runtime pins, reserved-region mapping and concurrency open | ADR-110/111/112/116/117/118; COMPUTE_ELIGIBILITY_PROOF.json; RETAINED_RESULTS_PROOF.json; VISUAL_INPUTS_PROOF.json; FALLBACK_MEASUREMENT_PROOF.json |
| 4 | Amend/Adapt routing and actual Canva account capability qualification | In progress: scoped observation, typed text-copy transport and internal owner-scoped durable candidate preparation locally qualified; actual preservation and production routing open | ADR-119/120/121; NATIVE_OBSERVATION_PROOF.json; NATIVE_TEXT_COPY_TRANSPORT_PROOF.json; NATIVE_COPY_OWNER_PROOF.json; official documentation is not account admission |
| 5 | Relationship-led composition, calibrated selection, governed edit learning and equal-budget human comparisons | Open | Existing R04–R06/R13/R22–R25 study machinery must be reused |
| 6 | Complete supervised native review/delivery, release qualification and independent recovery | Open | Prior qualification remains scoped to its own candidate |

## First slice: creation uncertainty

Requirements: FR-060, NFR-001, NFR-020, NFR-024; R07/R21.
Normative sources: `MASTER_SPEC.md`, `docs/10_WORKFLOW_RELIABILITY.md`,
`docs/30_CURRENT_STUDIO_CONTRACT.md`, linked through `plans/traceability.csv`.

Acceptance: no second design after lost creation reply, age/sweep, missing job read,
authorization failure or a legacy failed record without positive failure evidence.
Definite provider refusal/failure stays retryable under a new key; an explicit resume
can recover the original job without another creation. Polling is bounded and the
operator sees what requires reconciliation. Concurrent success must not be demoted.

## Verification policy

Use directly affected fake-provider/PostgreSQL tests first, preserve failures, then
source/test type and architecture checks. Perform full candidate qualification once
the integrated release is ready. Paid/native calls need the already required scoped
budget and actual application capabilities; human approvals cannot be substituted.

## 2026-09-28 — First implementation checkpoint

ADR-108 is implemented and locally qualified: uncertain outcomes and historical
failed records without positive evidence cannot permit another design creation.
An explicit original-job check recovers work; polling stops after a durable hold;
Desk explains reconciliation. Pure policy rejects mismatched job evidence and
contradictory returned design identity. Late sweep/read results preserve concurrent
completion. Existing export recovery semantics remain separate.

Six new cases failed before the source correction. Final affected acceptance:
23 files, 296 passed, zero failed/skipped; 514 strict test roots and Desk build pass.
Initial sandbox PostgreSQL/tsx-IPC failures and superseded expectations are retained
in the proof. Source/scripts types, any-count and provider-egress checks passed.
No full release qualification, production deployment, paid calls, native manual
recovery or human-quality study occurred. See `CANVA_UNCERTAINTY_PROOF.json`.

Next: qualify current native revision admission and preservation, then complete
brief/visual handoffs and remove unnecessary creative work. The full six-package
objective remains active; this checkpoint is not a completion claim.

## 2026-09-28 — Creative handoff checkpoint

ADR-109 preserves the full structured brief and complete exact copy in the existing
layout call. Importance and subject/crop notes survive. At most two approved scoped
examples and every classified content photo arrive as pixels, capped at 768px per
edge, with original hashes. Retrieval uses the actual request and saved copy;
the layout stage no longer performs an independent global lookup. Explicit client
references remain last. Source-copy order remains protected: the model brief's
readingOrder is a proposal, not authorization to override client copy ordering.

Rendering, refinement, fallback comparison and both sides of a comparison canary
share the candidate's real logo/art/photos/cutouts. Saved artwork is reloaded for
critique/revision/judging. Refinement also receives the explicit client reference.
No-imagery briefs suppress optional art, including after refinement preparation;
required client photos are retained.

Qualification: 13 affected files passed, 162 tests passed, zero failed, one optional
12 MP external-photo test skipped because HUNT_PHOTO is unset. All 515 strict test
roots, source/scripts types, any-ratchet, provider egress and security scan pass.
The first red run contains four reproduced input losses and one invalid test
fixture setup; the fixture was corrected. A local pixel comparison proves canary
asset fidelity. No extra model calls were added; image conditioning adds input
cost, which has not been measured with a paid provider.

Open: multilingual retrieval experiment; explicit authorized visual order;
durable asset derivation pinning; equal-budget human quality comparison; native
revision preservation; the remaining packages. This is local source qualification,
not a deployment or completion of the six-package goal. Next independent work:
free feasibility before optional artwork and eligible-only comparative judging.

## 2026-09-28 — Creative compute eligibility checkpoint

ADR-110 moves free geometry/copy/font checks ahead of optional artwork on v3
candidates that request art. Proven failures retain their source layouts and
recorded defect codes, are eliminated, and never enter the image provider.
No-art candidates retain the existing bounded refinement route. Contrast over
unfinished imagery is deferred; preflight is explicitly not final hard QA.
Zero survivors stop with NO_FEASIBLE_CANDIDATE and no automatic fresh generation.

Comparison admits only explicit hard-QA passes. Missing evidence is unknown.
One eligible candidate skips pairwise and canary calls. Zero eligible candidates
record NO_ELIGIBLE_CANDIDATE, clear any winner identity and stop. Provider-error
fallback and runner-up recording also exclude failed/unknown candidates.

Evidence: 9 affected files / 138 tests passed, zero failed/skipped. The initial
red run reproduced three selection defects and an artwork status defect. A
corrected generateArt-boundary test was replayed against the committed previous
art stage and proves the unwanted paid invocation (one failed, two passed);
current source was restored exactly. Existing judge-protocol unit fixtures now
carry explicitly synthetic QA; Core service tests use actual hard-QA calculation
and mocked repository writes. Source/scripts/516 strict test roots, architecture
checks and security pass. See COMPUTE_ELIGIBILITY_PROOF.json.

No paid calls, current-runtime deployment, full-suite release qualification or
human quality comparison. Earlier rejection can increase manual finishing or
refusal; the human experiment must measure this alongside cost. Remaining package
3 work is durable typed paid results, pinned derivations, actual provider-region
mapping and safe concurrency. Native preservation and other packages remain open.


## 2026-09-28 — Retained paid results checkpoint

ADR-111/migration 061 stores validated structured replies and image metadata/bytes
separately from operational receipts. The first successful receipt and result commit
atomically; results are immutable and tenant/client scoped. File-store images are
hash-verified GC roots, with bounded PostgreSQL byte storage when no store is configured.
Normal serial resume consumes only matching original request/stage/provider/model
prefixes. It recovers durable spend/call counts and never charges for reused replies,
even at the cap. Task cancellation is rechecked. Unknown calls, legacy successes
without content, changed input, missing storage or corrupt bytes still hold.

Qualification: 6 affected files / 45 tests passed, zero failed/skipped, including
fresh runtime-role public resume after injected post-receipt snapshot failure,
image/verdict replay and image reuse before one newly admitted verifier. The tests
also exposed and fixed repository initialization as [] instead of {}, which could
silently discard named brief properties; empty historical arrays now normalize.
This is fault injection and fresh-service recovery, not an OS process-kill drill.
See RETAINED_RESULTS_PROOF.json for final type/security/manifest checks and retained
initial failures (a genuine stage-persistence defect plus fixture mistakes).

Full six-package objective remains active. Package 3 still needs branch-aware
substeps, pinned derivations, actual provider-region/crop mapping and safe bounded
concurrency. Persisted rebrief branches or interleaved failed attempts can cause a
safe hold. No paid calls, deployment, native qualification, full release suite or
human-quality comparison occurred. Next: pin the actual asset and conditioning
inputs so resumed work is stable and does not repeat derivation unnecessarily.


## 2026-09-28 — Pinned visual basis checkpoint

ADR-112/migration 062 retains the run's actual photos, reference, examples, V3
conditioning thumbnails, cutout/shadow pixels, outcomes and crop focus before
layout/edit work. A first committed manifest wins concurrent preparations; assets
cannot be appended later. Subsequent stages load hash-verified bytes rather than
retrieving examples, rereading incoming images or asking for newer cutouts. Current
client/task authority and design/exemplar policy still apply. Negative outcomes
remain stable. V2 avoids unused thumbnail work. Model/source/check-report identities
are retained where known; unavailable historical identities are not invented.

Local acceptance: 19 files / 180 tests passed, zero failures/skips, with fresh
runtime-role layout and critique boundaries after a newer cutout was inserted,
concurrent connections, failed persistence, scope, corruption/missing files and
legacy holds. Stage-only edit fixtures now provide an in-memory visual repository;
DB and production-wiring tests exercise the actual persistence implementation.
Source/scripts and all 520 strict test roots pass. No paid/model/native quality,
production deployment, full release or OS process-kill/restore claim. See
VISUAL_INPUTS_PROOF.json for exact evidence and initial failures.

The six-package goal remains active. Historical active runs past layout without
pins require review before rollout. Font/renderer/cutout runtime identities,
pre-layout stage pins, durable substep checkpoints, region/crop mapping and safe
concurrency remain open. Next priority: current native Canva revision admission
and preservation of manual edits, the remaining P0 item in the report. Then finish
the remaining compute/retrieval improvements and integrated human/release gates.

## 2026-09-28 — Native revision admission and reviewed-copy handoff

ADR-113/migration 063 prevents linked revisions from silently reconstructing an
old generated layout. Studio start/resume/selection, the older planner, and fresh
Canva creation/import admission enforce the hold. Original uncertain jobs remain
reconcilable. A recovered old import cannot qualify a fresh revision review or
approval without the current human confirmation, including legacy policy-free
captures at the server-derived task boundary.

For non-lifecycle tasks, Desk now presents the original native design and directive,
requires a separately linked copy, and records exact reviewed text plus an explicit
preservation assertion. The immutable event binds actor, request key/hash, expected
task version and parent/child basis. PNG and PPTX freeze the same confirmation and
active human-authored Client DNA. Old previews cannot pair with a new source even
at an equal native timestamp; Desk, approval pins and publication checks use the
confirmation identity too. The parent and bindings remain locked during database
policy validation. Those locks cannot fence direct native Canva edits.

Final affected acceptance: 22 files / 284 tests passed, zero failed/skipped. The
public synthetic-provider journey reaches actual retained PNG/PPTX bytes, recorded
review, explicit test-reviewer approval and publication admission; a new confirmation
invalidates it. Runtime-role connections, keyed/concurrent replay, stale bindings,
scope refusal, policy row locking, malformed input and Desk controls are covered.
Initial fixture mistakes, two reproduced implementation defects (stale preview and
null request), and obsolete reconstruction/migration expectations are retained in
NATIVE_REVISION_HANDOFF_PROOF.json. Existing photo-context checks remain without
granting automatic reconstruction. Stage-only directed-edit fixtures bypass admission
and are not evidence of native preservation.

This is local qualification of the legacy/manual slice. No live native operation,
human preservation judgment, deployment, full release or recovery drill occurred.
The complete six-package objective remains active. Next: implement the owner-controlled
manual recovery path for RequestLifecycle, then qualify actual native operations and
continue the outstanding policy, compute, retrieval and human/release packages.

## 2026-09-28 — Owner-controlled native revision recovery

ADR-114 admits separate-copy binding, exact-copy confirmation and export capture
only for the current linked revision of an automatic request in manual recovery.
The request ID/revision is explicit and rechecked under the lifecycle lock before
preparation writes. Capture retains bytes without advancing the request. A separate
signed office submission goes through RequestLifecycle and one atomic Core
projection; its hash-bound receipt survives lost replies and cannot rewind a later
stage. Desk retains the exact pending submission across remounts and retries.

Local qualification: 23 connected files/198 tests passed before the final active-user
check. The final six-file boundary run passes 63 tests, including restricted runtime
RLS, disabled-user refusal, lost Core/gateway responses, current task/confirmation/
capture checks and explicit test-reviewer approval. A users FOR SHARE policy failure
was reproduced and fixed with a scoped active-user snapshot read, without wider
privileges; concurrent account revocation is not serialized by that read. No
migration is needed. Source/scripts and 525 strict test roots pass; Desk build and
security/any/egress checks pass. Full details, limits and initial failures are in
LIFECYCLE_NATIVE_RECOVERY_PROOF.json.

The entire six-package objective remains active. This closes the local lifecycle
handoff gap for automatic linked revisions, not initial manual requests without a
run, live native preservation, human quality, full release or independent recovery.
No paid/native calls, production migrations or deployment occurred. Next: qualify
one exact native amendment and finish intent/typography/multilingual retrieval,
semantic dependency reuse, calibrated selection and human/release evidence.

Final connected-source verification after the fix: **24 files / 220 tests passed, zero failures or skips**.


## 2026-09-28 — Unicode exemplar selection and available-reference evidence

ADR-115 replaces the fixed English vocabulary/obsolete disk cache with Unicode
lexical ranking over confirmed metadata. Arabic/Kurdish search spelling and numeral
variants preserve original copy. Actual text evidence outranks format; no-match
format/curator selection is labelled explicitly, with no semantic embedding claim.
The complete manifest hash refreshes approval/metadata changes on existing indexes.
The qualification helper no longer supplies a fabricated standards category.

Core uses the authorized client's same manifest snapshot for policy and selection,
checks available image bytes against approved hashes before ranking, and retains
algorithm, matched terms, selected IDs and exclusion reasons with the visual bundle
and run diagnostics. Existing pinned runs recover their original selection without
retrieval. Three of six curated images are absent from both package and recorded
archive; they can no longer displace available verified references silently.

Final connected qualification: 9 files / 74 tests passed, zero failed/skipped;
526 strict test roots and source/scripts types pass. Includes real PostgreSQL/blob
replay through a fresh application-role connection, hash mismatch, approval updates,
non-KAAE client journey, and actual multilingual synthetic metadata. Local 400-query
probe p95 is about 0.018 ms for the three available images using a retained manifest;
this is not end-to-end design latency or an improvement comparison. No provider
calls, new dependencies, migrations or deployment. See UNICODE_RETRIEVAL_PROOF.json.

All six packages remain active. This baseline does not recover missing reference
files, translate English-only metadata, qualify a multilingual semantic model, or
establish human design quality. Next: complete the approved multilingual corpus and
semantic comparison alongside authorized intent/typography and actual native edit
qualification; retain the remaining compute, human and release gates.


## 2026-09-28 — Retained font basis and stale measurement repair

ADR-116 binds new version-2 visual bundles to actual packaged/allowlisted system
font bytes and registry content. Recovery holds before another model/render stage
if that basis changed or cannot be read. Restoring the original environment permits
resumption with the existing retained inputs. Version-1 bundles are held for review;
current hashes cannot attest to their historical environment. No database migration.

The previous path-only fontkit cache reproduced a stale 472px measurement after
font replacement. The repaired cache observes file identity including ctime, hashes
changed bytes, refuses a changing read and never treats deletion as a cache hit.
Fontconfig/family discovery incorporates content inventory; registry and admission/
ink caches invalidate on changed content. Actual font inventory reads cost about
4ms p95 for 27 files over 30 local samples, not an end-to-end latency claim.

Qualification: 11 files / 147 tests passed, zero failed/skipped. Source/scripts and
527 strict roots pass; two test-only spread typing failures were repaired. Real
isolated DB/blob recovery uses an injected changed font identity to prove refusal,
while font replacement/deletion/registry tests use actual temporary files. Original
loader red proof and exact evidence are in FONT_BASIS_PROOF.json. No paid/native
call, live migration, deployment, human study or release qualification occurred.

All six packages remain active. Full shaping/rasterizer/OS identity, retained font
binaries and licensing, concurrent modification during a running stage, native font
fidelity, authorized visual order, semantic replay, native editing and human/release
qualification remain open. Source-copy order remains protected; model reading order
alone grants no authority to rearrange it.


## 2026-09-28 — Mandatory measurement evidence (ADR-117)

Mandatory local QA now records one structured geometry result per required block,
with copy/font/input hashes or an explicit unmeasured reason. Missing/blank copy,
unavailable/corrupt fonts, missing primary-face glyphs, invalid inputs and shaping
failures cannot inherit one-line/zero-width defaults. Optional artwork in both
pipelines rejects unknown measurement before provider use; V3 selection and final
QA retain their hard refusal. Final QA persists the selected candidate's evidence.
A reproduced replacement-winner bug now retains the replacement's passed result,
the former failure separately, and the requested operator selection hold.

Qualification: 16 connected files/208 tests passed; final four-file/48-test boundary
run after extending artwork admission passes. Source/scripts and 528 strict test
roots pass. Four missing-copy false passes reproduced before the fix; the real
isolated DB also reproduced the former-winner QA mismatch. All provider transport
is synthetic; no paid/native calls, migration or deployment. See
TEXT_MEASUREMENT_PROOF.json for source hashes, initial failures and exact limits.

The stronger gate exposes an open typography gap: primary-face fontkit measurement
does not model rasterizer fallback for mixed Sorani/Latin/symbol text. Existing
fixtures now explicitly expect COPY_UNMEASURED for those blocks while preserving
the requested style and checking geometry/contrast independently. This is not
proof that the native designs are visually defective. Broad rollout requires
qualified mixed-font shaping/wrapping; do not waive the gate or silently replace
the chosen font to obtain a pass. The historical corpus baseline was not rewritten.

All six packages remain active. Next: actual mixed-font measurement alongside
native amendment qualification, authorized hierarchy, semantic reuse, human
quality and integrated release/restore. Local wrapping is not native bidi, painted
ink, editability or a whole-application completion certificate.

## Shared fallback text measurement — ADR-118

Source base `1bee749c`. FR-015/037/038/039; normative docs 08/05/11. The current
mandatory gate refused valid Noto/Sorani mixed with Latin/symbol fallback. One
bounded Pango helper now supplies the actual shaped lines, advances, ink extents,
font file hashes and unknown code points. QA, wrapping/balancing, SVG placement and
transfer fitting share the same fallback path. Requested style and original copy
remain intact. A missing helper or invalid evidence refuses successful measurement.
Retained font basis now includes helper/runtime identity; prior incompatible
measurement environments hold on recovery. Full OS/shared-library pinning remains open.

Real measurement exposed missing spaces inside symbol runs. Both licensed symbol
subsets were regenerated from the same hash-pinned sources with U+0020/U+00A0;
letters/digits stay excluded and the fallback-order checks still pass. Build and
CI install development headers only where compilation is needed; the Linux runner
uses its existing Pango/librsvg runtime. No new service, npm dependency or paid call.

Final qualification: **24 files, 281 passed, zero failed/skipped** including
historical Sorani fixture progress, real rasterizer pixels, tracking/italic/RTL,
font mutation, editable transfer, retained visual recovery, Core zero-spend
refusal and isolated database winner/revision journeys. Package/source/scripts
builds and 529 strict test roots pass; any ceiling, egress and security checks pass.
Debian Pango 1.50.12 and macOS 1.58.2 match the tested actual librsvg ink bounds
within 2px. Generated fonts reproduce byte-for-byte. Initial red and intermediate
failures are retained, including subset-space exclusion and an overlapping
build/test run; the final run starts only after builds complete.

Synthetic one-block timing: approximately 140ms first use and 9.4ms warm median
in the retained local sample, including input identity checks. This is not an
end-to-end latency, quality or savings claim. Native Canva shaping/reopen/export,
human Sorani review, all remaining packages and final release/restore remain open.
No deployment, production write or full release qualification was performed.

## Native amendment prerequisites — ADR-119

The typed Canva client now reads account capabilities and exact named-field types.
The authenticated scoped GET and explicit Desk action bind results to task/client,
task version, link identity/version and observed native update metadata; detected
mid-read changes refuse the result. Unknown field kinds, malformed inventories
and unsafe errors cannot appear as positive evidence. A capability 403 remains
unknown because permission and subscription cannot be distinguished from it.
No native write is enabled and no observation enters the five-second UI poll.

Final affected verification: 8 files/136 passed, zero failed/skipped; all 531 strict
test roots, source/scripts, Desk build, any ratchet, egress and security checks pass.
Initial red and intermediate fixture/version failures are retained. Real backend
OAuth GET probe reaches the prior synthetic multilingual fixture: native metadata
stable, dataset empty, capability endpoint403. Existing default scopes omit
profile:read. Ordinary token refresh may update connection metadata; no native
edit, deployment or full release gate was performed.

Proof: NATIVE_OBSERVATION_PROOF.json. Package4 remains open. Next is preparation
and actual qualification of a named-field disposable fixture with protected manual
changes, readback, reopen/export and uncertainty handling. Independent visual-judge
qualification identified in the latest research remains in package5; all six
packages and whole-goal completion remain active.

## 2026-09-28 — Native text copy transport checkpoint

ADR-120 adds typed text-only autofill copy creation and exact-job readback to the
existing Canva client. It preserves exact requested strings, validates own observed
field names/types and bounded UTF-8 payloads, freezes the dispatched source basis,
and retains only validated metadata/error codes. Wrong result kinds, same-source
copies and mismatched jobs refuse. Existing bounded retry repeats definite
throttling/pre-send failures; 5xx, lost replies and malformed successes remain
uncertain without resubmission.

Initial red: 15 missing-method failures. Final six adapter files: 70 passed,
zero failed/skipped. Source/scripts and all 532 strict test roots compile; any
ratchet, provider egress and security checks pass. See
NATIVE_TEXT_COPY_TRANSPORT_PROOF.json for hashes, exact scope and logs.

This is a local transport checkpoint, not native operation admission. The prepared
synthetic fixture draft still needs the editing interface's explicit preview
approval before commit. Actual amendment/export/reopen/preservation, owner-scoped
operation ledger and routing, human review and full release/independent recovery
remain open. No native mutation, paid call or deployment occurred in this checkpoint.
The full six-package objective remains active. Independent next work can proceed
on the owner operation contract and judge experiment while that approval is pending.

## 2026-09-28 — Durable native-copy candidate ownership

ADR-121/migration 064 uses the existing Canva ledger for an internal preparation
operation authorized by the current lifecycle-owned manual revision. The source
is its recorded same-client parent, with task/handoff/native metadata checks and
exact named text. A durable claim precedes POST. Concurrent and identical replays
retain one operation; fresh keys cannot bypass uncertainty. Acquired IDs and
claim inputs are immutable. The original actor can reconcile through a fresh
service, including after the request advances. The sweeper recognizes native
copy jobs. Completion retains an unverified candidate and changes no binding,
task/request version, review, approval or delivery.

The recovery work exposed and fixed contradictory provider evidence: a failed
or in-progress response containing a creation result is no longer accepted.
Two red cases reproduce this; HTTP408/unclassified responses also stay uncertain.
Initial owner-suite failures were test expectations for a bigint and wrapper.
Final seven connected files:95 passed/0 failed/0 skipped. Restricted hawa_app
connections, concurrent calls, fresh service and an injected receipt-write failure
exercise actual PostgreSQL transactions; this is not a process-kill or live Canva
trial. Source/scripts and533 strict test roots, any/egress/security checks pass.
See NATIVE_COPY_OWNER_PROOF.json for exact source/log hashes and limitations.

No HTTP/Desk creation route is admitted. Native preservation, the pending fixture
preview approval, production routing, independent quality evaluation and all
remaining six-package release/recovery requirements remain open. Next independent
work is the brief-bound independent judge challenger; native qualification resumes
only after the editing interface's explicit approval requirement is satisfied.
