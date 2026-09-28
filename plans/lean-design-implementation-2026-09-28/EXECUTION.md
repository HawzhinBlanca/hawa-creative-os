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

## 2026-09-28 — Continuation by Claude after Codex's usage limit

Codex reached its weekly limit at 06:30 (reset 2026-10-04). On the owner's instruction ("when gpt6 hit
limit u finish all") Claude continued this ledger from `7b8de71e`, in isolated worktrees, one agent
per item, each followed by an adversarial reviewer that re-ran the tests and a fix round where it
found a blocking defect. The branches were merged into `claude/mainline`; the parallel items reserved
migration numbers, which the merge renumbered to be contiguous (065 substep bindings, 066 initial
native policy). The entries below are the implementers' checkpoints as written, corrected only for
that renumbering. On the merged tree all 43 affected test files pass (450 tests).

## 2026-09-28 — Semantic substep recovery (ADR-122)

ADR-122/migration 065 records a semantic substep, its attempt and a canonical, hash-checked binding with every new Studio call. Substeps are brief/request, brief/images-rebrief, brief/late-reference, concepts/board, layout/concept-N, layout/set and art/candidate-N. Undeclared calls use sequence/<stage>, and parity uses a content-keyed substep. Recovery consumes retained results per substep in attempt order, not by the run's call order. A persisted rebrief branch and an interleaved definite image refusal now resume without transport or charge. Changed bindings, a failure before later retained work, unknown outcomes and paid calls without results still hold. Bindings add schema, capability policy, current authority (not for artwork) and the renderer/font basis where local rendering feeds the request. A withdrawn approval with unchanged request bytes now holds; previously the retained reply was silently reused. Pre-065 rows keep the ordered prefix. Only one admission is allowed per run/substep/attempt.

Real resume exposed a second cause of the rebrief hold. The in-process rebrief differed in key order from the jsonb form a resume reads back, so the next request could never match. A persisted rebrief now continues from its stored form, and only when the stored content is identical. The domain's planStudioReuse defines explicit invalidation. A keyed date correction recomputes measurement, group geometry, render, native capture and approval, and reuses the artwork with its hashes. Undeclared drift, a font/renderer change and revoked or unknown asset authorization all hold. The same keyed change applies once. No route declares a change yet.

Initial red run: 4 of 7 service cases failed on the previous source. Two resumes held, the date case was blocked by the same refusal, and a stale authority was reused. Final affected run: 56 files/632 passed/0 failed/0 skipped. All 535 strict test roots compile, and any/egress/security and pack validation pass. Two studio-ledger fixtures had failed at the base since ADR-113; they were repaired. The full suite was run once and had 6 failures. Two stale migration lists were then corrected, and the Desk bundle test passes once the Desk is built. Route-inventory, blob-gc coverage and the r11 release manifest failures come from earlier changes and remain open. See SUBSTEP_RECOVERY_PROOF.json.

Package 3 remains open: no amend route declares changes, and native capture/approval are not wired to the planner. Per-asset model-call bindings, the remaining stage substeps, runtime/cutout pins, region mapping and bounded concurrency are also still open. No paid or native call, production migration, deployment, process-kill drill or human study took place. The full six-package objective remains active. Next: package 4 amend routing consumes planStudioReuse.

## 2026-09-28 — Renderer/cut-out runtime pins and reserved-region mapping (ADR-123)

ADR-123 adds the rasteriser to the retained basis: the rsvg-convert executable hash, its
--version answer and the operating-system release files. The font basis becomes version 2 and
visual bundles version 3. A changed renderer holds a pinned run before the next model or render
stage, as a font change does; restoring it resumes. Version-2 bundles lack renderer attestation
and are held for review. ADR-122 renderer bindings use the same basis. The cut-out service
(hawa-cutout/2) reports its code, package versions and face detector. Each pinned cut-out and
focus derivation records source, bytes and runtime; mismatches hold at capture and recovery. A
pinned run never asks the service again, so a changed live service does not hold it.

The art prompt described the calm region in layout pixels ("centered around (0, 945) measuring
1080x405") to a 1024x1024 request and stated 9:16. It is now mapped through the renderer's cover
crop into the requested frame, with that frame's aspect. The plan and a check of the returned
image are retained; final QA records the final layout's landing (moved/frame_mismatch/
unreadable) and each photo crop, including an unapplied focus on unreadable sizes. This is
evidence, not a gate.

Qualification: 34 files / 329 tests passed, zero failed/skipped, plus 4 Python identity tests.
Real temporary executables and release files; real librsvg pixels confirm the crop mapping on
macOS 2.62.3 and Debian 2.54.7; isolated PostgreSQL hold/restore through fresh services. Initial
red: 5 failed/3 files unloadable, 6/6 art-stage cases (layout-pixel prompt), 1 Python error;
fixture corrections retained. Source/scripts and 538 strict test roots, any 954/1053, egress and
security pass. Full suite 537 files: 4505 passed, 3 failed, 60 skipped. The same three failures
occur at base with this change stashed. See RUNTIME_REGION_PROOF.json.

Not done: shared-library byte identity, a rebuilt cut-out image, paid art quality of the corrected
prompt, deployment, and the inventory of active runs that will hold. Package 3 still needs safe
bounded concurrency; all six packages remain active.

Evidence and commands:
- Initial red run: 27 tests, 22 passed, 5 failed, and 3 files could not load. The art stage failed 6 of 6, showing the layout-pixel prompt. The Python identity test had 1 error.
- Before the final runs I corrected five test mistakes, all kept in the proof: an unavailable import (pngjs) in the Core test, a wrong assumption about a missing rsvg path, a missing test logo, a misnamed field, and one outdated expectation for focus points.
- Final affected runs: 17 creative files (194 tests), 14 Core files (118 tests) and 3 Core recovery/schema/accounting files (17 tests), with no failures or skips. Python: 4 of 4 passed.
- The full suite has 3 failures that are not from this change; I spawned a separate task to fix them.

Files (all under /Users/hawzhin/Hawdesign/.claude/worktrees/wf_82dde19f-6dc-1):
- adrs/123_renderer_runtime_and_region_mapping.md
- plans/lean-design-implementation-2026-09-28/RUNTIME_REGION_PROOF.json
- packages/creative/src/studio/renderer-identity.ts and placement-map.ts
- apps/core/src/services/design-studio/visual-inputs.ts, stages/art.stage.ts and stages/qa.stage.ts
- services/cutout/hawa_cutout/identity.py
- Logs: output/acceptance/2026-09-28-runtime-region-*

## 2026-09-28 — Brief-bound judge challenger (ADR-124)

ADR-124 adds a challenger to the existing R06 metric-blind calibration interface. It receives the requester's instructions, the recorded brief fields and the exact copy unchanged. It never sees metrics, ranks or prestige wording. Correctness, communication and aesthetic preference are judged separately. Each dimension allows a tie or an abstention and can carry localized findings. The model returns no overall winner. The application applies a fixed rule over both orders: correctness first, then communication, then aesthetic preference. An abstention, a position flip or a pick contradicted by its own severe findings makes the pair uncertain. An uncertain pair keeps the higher composite and records humanChoiceRecommended.

HAWA_STUDIO_JUDGE_PROTOCOL keeps the incumbent by default. Only brief_bound_v1 selects the challenger. Any other value is refused visibly, with no model call. The challenger reuses the same eligible top two, rendered bytes, degraded canary, ledger client and budget. Core stores the packet and image hashes, the verdict, the decision and the receipt. No migration was needed; 067 is unused.

scripts/run_judge_experiment.ts compares both judges on one pinned corpus, with the same bytes and model, in both orders. It uses a frozen, hashed plan (3ab6847d…):
- Primary endpoint: seeded-defect detection. Estimate: paired, lineage-clustered bootstrap. Worthwhile effect: +0.10, with the lower bound above 0.
- Regression margins: human agreement and order consistency (-0.05), clean-control critical findings (at most 0.05), cost per case (at most 2x).
- Minimum sample: 20 seeded and 10 clean lineages.
- Ties, abstentions, flips, invalid replies and calls not run all count as failures.

Every request is quoted with the ADR-091 policy before dispatch. It is admitted only against a run cap and the office daily ledger. The first provider error stops the run. A paid run must type back the plan hash.

Initial red run: 71 passed, 26 failed, and one test module was missing. The Core test showed the flag had no effect. Two corpus defects were found and fixed:
- A Sorani clean control had byte-identical images.
- The offline layout overlapped its own copy. Blocks are now stacked by measured height, and hard QA must pass for every clean side.

The final connected run passed 21 files and 228 tests, with 0 failed and 0 skipped. I ran the full suite once: 534 files, 4484 passed, 9 failed, 60 skipped. The same 9 failures in 8 files also fail with the worktree detached at base 7b8de71e (69 passed, 9 failed). The failing areas are migration and route fixtures, the release manifest, the Desk bundle size, blob-gc coverage, planner accounting and 2 studio-ledger stubs.

A 72-case development corpus (24 golden briefs) ran end to end with the synthetic provider:
- 288 calls, office ledger equal to run spend.
- Decision: SYNTHETIC_PLUMBING_ONLY.
- A quote-only run dispatched nothing. Worst-case reservations: USD 2.54 on gpt-4.1-mini, USD 99.47 on gpt-6-astra.

Source, script and 535 test roots type-check. The any ratchet (956/1053), provider egress and security checks passed. Evidence is in JUDGE_CHALLENGER_PROOF.json.

Still open: paid comparison, blind human labels (overall and per dimension), native Sorani review, calibration and holdout corpora from retained exports, shadow run, the remaining package 5 items, and the whole six-package objective. The golden-brief corpus is development material only. The flag must not be enabled in production on this evidence.

## 2026-09-28 — One negative-space policy and an executable brief contract (ADR-125)

The v3 generator was told "0.35 to 0.58" and "never leave 40% empty", but the checker it is ranked, repaired and judged by passes measured-line emptiness from 0.36 to 0.84. Version 2026-09-28.1 of `studio.negative-space` now holds the occupancy rules, both bands, the gap and bottom-void penalties and the pass score. QA scores through it. The generator statement is rendered from it, including that photographs and artwork are not counted. Every score records the policy id, version, digest and measure. The numbers are the existing calibration, so no accept or reject decision changes. A digest test is pinned to the version.

Before the first layout call, a new or afresh-designed run records one executable brief contract on its stages, together with the policy identities it was built under:
- exact copy and client assets, by hash
- source-copy order and the relations checks already enforce (keepInside, noOverlap, aspect), marked protected
- composition and cover-fit crop, marked permitted
- every model brief field, as a proposal or an unknown

The model readingOrder stays a proposal. Element IDs are the renderer's. Validation refuses any model proposal placed in the exact, protected or permitted layers.

Disagreements are recorded with their resolution rather than resolved silently: an order proposal that is not adopted, no-imagery with client photos, and a background mapped to the palette.

The copy-fit screen is free. It uses the validator's own admitted faces and QA's own measurement and width tolerance. When every admitted face shows an unbreakable run wider than the safe width at the 12px minimum, the run stops before layout. It gets a short explanation and only CLIENT_APPROVES_REVISED_COPY or CHOOSE_WIDER_APPROVED_FORMAT. Nothing is shrunk, omitted, split or reworded. If a face cannot be measured, the result is unknown, never a conflict. A changed recorded contract holds the run (BRIEF_CONTRACT_CHANGED) before any provider call.

The initial red run failed all four new files. In the Core file, the unbreakable copy reached the layout boundary and no contract was recorded. An unseeded-client fixture and a key-filtering test helper were corrected.

Final results:
- New tests: 4 files, 21 passed.
- Final connected run: 11 files, 95 passed, 0 failed, 0 skipped.
- Affected packages: 32 files, 377 passed.
- Affected Core/worker: 26 files, 241 passed and 2 failed. Both failures are in studio-ledger and reproduce on the base source.
- Full suite, run once: 4,468 passed, 9 failed, 60 skipped. All 9 failures reproduce with the base sources restored.
- Build, source/scripts types, 537 strict roots, the any ratchet (954/1053), egress and security checks pass.
- Local screen timing: about 114ms warm median for eight bilingual blocks.

There were no paid, native or deployment actions. See BRIEF_CONTRACT_PROOF.json.

All six packages remain active. Still open:
- aggregate area and hierarchy capacity screens
- edit contracts for directed and native amendments
- a clarification route for unknowns
- whether photos and artwork belong in the negative-space measure
- re-deriving the band from the exemplars
- the generator margin statement (0.05 normalized), which is looser than the validator's 6% of the short edge
- the separate Desk whitespaceRatio display figure
- an equal-budget human comparison

Next: the aggregate capacity screen and the native edit contract.

## 2026-09-28 — Brief contract fix round

Review found that a directed revision whose edit failed, and was designed afresh, held for good if it was interrupted after its contract was written. The contract labelled inherited copy as source copy. The mid-stage write persisted directedFailed, so the resumed stage skipped the edit and laid out the request copy. A real-PostgreSQL test with retained calls and a synthetic transport reproduced BRIEF_CONTRACT_CHANGED. Without inherited copy it reproduced the inferred MODEL_STAGE_REPLAY_UNSAFE. On the base source the same resume failed the run on the unique candidate ordinal.

The contract now takes its copy authority from the copy the run lays out. Inherited copy is kept as the run's own, the mid-stage write leaves out directedFailed, and the afresh slots are reserved once. The resumed stage replays all four retained calls with no transport and reaches the layout boundary with the same copy and contract. An identity digest separates authorities from policy and measurement evidence: evidence changes re-admit the contract and are recorded, while identity changes hold. The write is conditional on laying_out. Every run records stages.policies. Policy 2026-09-28.2 states the span semantics with the same numbers, and the art gate measures lines when copy is supplied. Directed revisions stay held by ADR-113; the test bypasses only that admission.

Five changed test files: 8/51 initially red, 51/51 after the fix. Affected Core/worker: 48 files, 530 passed, 2 failed (the known studio-ledger cases). Affected packages: 37 files, 434 passed. Full suite: 537 files, 4,477 passed, 9 failed (the same 9 as the first round, which reproduced on base in that round), 60 skipped. Types (538 roots), any ratchet 954/1053, egress and security pass. See BRIEF_CONTRACT_PROOF.json.

Local qualification only. No paid, native, human, deployment or release evidence. Before deploy, confirm that no Studio run sits in laying_out with a retained layout call.

## 2026-09-28 — Initial manual request recovery (ADR-126)

ADR-126/migration 066 closes the Package 1 intake gap. A request opened for manual design has no run. Its owner state previously refused review, approval and delivery, and Core refused its design writes. The origin is now identified from the immutable rev-1 open receipt (manual, autoGenerate false, same root task) and from the absence of Studio run state. No run is fabricated. At revision 1 the office links the request's own separate design, confirms exact copy (initialNativeCopy event) and captures PNG/PPTX. This happens under the lifecycle lock, the active-user snapshot check and explicit request headers. The existing global binding uniqueness refuses a design already linked to another task. Capture before confirmation is refused, and capture does not advance the request.

The same signed submission, at expectedRev 1, projects the revision, QA and the manual-to-in_review change once. Its hash-bound receipt survives lost Core and gateway replies and fresh hawa_app connections, and cannot rewind a later approval. The owner adopts it into a manual-origin state with no run. That state approves and delivers. A requester revision round is refused in both the owner and Core, because the requester's reply would start automatic generation. Rejection was not separately exercised. Migration 066 keeps an initial policy current only for the latest confirmation, binding and Client DNA. Other captures, and captures without a policy, cannot qualify such a task. Desk shows an initial variant and keeps a rev-1 submission across remounts. The non-lifecycle ADR-077 path already keeps Core as owner and the saved copy as the authority, so it was not changed.

Initial red: 20 failed/11 passed across 4 files. Final connected run: 29 files/305 passed, zero failed or skipped. A mutation check that removed the two revise guards failed 3 cases. The earlier connected run surfaced a superseded ADR-114 expectation (expectedRev 1 treated as invalid) and a hard-coded upgrade list that was already stale at base; both were corrected. Source and script types pass, all 535 strict test roots compile, and the Desk build, any ratchet, egress check, security scan and validate_pack pass. The full suite gave 4474 passed/7 failed/60 skipped across 534 files. The six failing files have expectations that predate routes, migrations and release manifests already present at base. I inferred this from the base tree; I did not run the suite at base. See INITIAL_MANUAL_RECOVERY_PROOF.json.

Open: Core delivery projection for this origin was exercised only through the owner with a mocked Core. Still open: an office-owned revision route, live native qualification, human judgment, full release and independent recovery. No paid or native calls, production SQL, migration or deployment occurred. All six packages remain active.

Files are in the worktree above; evidence logs are gitignored under output/acceptance/2026-09-28-initial-native-*. I did not write to the wiki; the lead owns the merged record.

## 2026-09-28 — studio-v2 integration (ADR-127)

2026-09-28 STUDIO-V2 INTEGRATION (ADR-127, LOCAL, NOT DEPLOYED). Base 7b8de71e, head acc9b387 on worktree-wf_512e9b2d-671-1.
- Ported or adapted:
  - Client packs (5 packs; KAAE live, 4 onboarding with no automatic drafts), the thumbnail playbook, KAAE persona and palette out of shared code, v1 KAAE templates retired (410), and 9 audit fixes.
  - Deploy health retry and task-control OpenAPI; CI on a clean runner with Pango; release-manifest ancestor check.
  - Adaptive Canva panel poll; file store backfill fixes and staged release B keys (checked against 023-064); Restate backup recovery after SIGKILL, plus the watchdog.
  - Load scripts and the runbook (only three test-server blocks re-run; the rest marked not re-run); history documents with supersession notes.
- Not ported: studio-v2's RequestLifecycle and its migration 023; the release-manifest chores.
- Red first, per item (all logs are in output/acceptance/2026-09-28-studio-v2-integration/):
  - deploy 7, OpenAPI 3, poll (module missing), art temp 1, manifest check 4, file store 10 plus the missing staged file
  - Restate (import failure plus SIGKILL demo), runbook 2, packs 2, thumbnail, shared code 7 of 9, templates 3, audit 7
- Full suite (w3): 10 failed, 4535 passed; each failure is explained above. After the fixes, the affected files pass; r11 (manifest) and the two pre-existing studio-ledger cases still fail.
- Build, typecheck, lint, security and validate_pack pass.
- Proof: plans/lean-design-implementation-2026-09-28/STUDIO_V2_INTEGRATION_PROOF.json.
- Not executed: chaos and load runs, pnpm test:db, production, native Canva, paid calls, Telegram, a live Restate rehearsal, deployment, RELEASE_MANIFEST.

## 2026-09-28 — studio-v2 integration review fixes (ADR-127)

2026-09-28, integration fix round (worktree-wf_512e9b2d-671-1, 89b15dcc..4482f671; ADR-127; no migration, 070 unused).
- Done: the watchdog now restarts and reports stopped stack containers whatever the backup recovery says, and never starts Restate while a backup holds the archive lock. Also: KAAE is named "Association" in its pack profile; a packaged-KAAE run without its exemplar pack is refused 503 CLIENT_EXEMPLARS_UNAVAILABLE; the CTA contrast is checked again after the fallback; the stable prefix names no client; client-pack rows are tested as hawa_app; the Canva panel refreshes when the office comes back to the tab; the studio-ledger stubs admit the task.
- Evidence: red and green logs are in output/acceptance/2026-09-28-studio-v2-integration/review-*.log, referenced by hash in STUDIO_V2_INTEGRATION_PROOF.json. Full suite 4560/4621 passed; only r11 fails, on the manifest. Build, typecheck and lint pass (any 955 of 1053; egress 9 existing exceptions). Security scan: 0 secrets. 79 backup Python tests pass.
- Open: RELEASE_MANIFEST.json (lead). Watchdog verified only against stubbed docker, curl, open and sleep.
- Next: lead merges; owner steps unchanged.

STUDIO-V2 COMMIT TABLE (integration total, this branch's commits in brackets):
| Commit | Outcome |
|---|---|
| 8b0d140b, d5a884cf, 5fb37d29, 736b0e9b, 3904fe07, 6269ef4e | Superseded by this branch's own RequestLifecycle (ADR-034, ADR-052, ADR-059+); migration 023 not ported |
| 5e64ae31 | Adapted [f49bf1ce]: runbook Phase 2 sections rewritten for this branch's lifecycle; command blocks say whether they were re-run |
| e8169f44 | Skipped: a duplicate-key YAML load finds no duplicate in this branch's compose file |
| 644fd8dd | Adapted [f1d81424]: deploy health retry; OpenAPI task-control paths |
| 4e2e6e58, 75153027 | Ported/adapted [ef2e57a7, 88da484f]: backfill fixes, staged release-B keys (not a migration), PHASE3_EVIDENCE |
| 088ce5e6 | Superseded by ADR-053 to 057 and ADR-081 (backup, restore, drill not ported) |
| 4eb16341 | Adapted [dd0c5343, 89b15dcc]: recovery of a killed backup through restate_nightly.py --recover and the watchdog; wave 8a evidence kept as history |
| ecc9af71 | Adapted [d97c9149, 8b33a064]: 5 s/60 s poll, live-event refresh, plus refresh on tab focus |
| 82240d9e, 9a4a38b3, 1869518d | Kept as history [11192568] with a supersession note |
| 1a160953, 9cd4afeb, c2bf4943 | Ported/adapted [45d4949b, 9925e1f6, 4e167b7d]: CI on a clean runner (Pango headers), manifest check accepts merges |
| a5a50dad | Adapted [a85e136f]: client packs route and scope; Client DNA stays the brand authority; ADR-038 renumbered to ADR-127 |
| 1d07664b | Playbook ported [aff64337]; logo half superseded by ADR-047/ADR-109 (stricter) |
| d66804ce | Superseded by ADR-047/ADR-109 |
| 27e9e4f1, f6d6ed1b | Adapted [144941e9, 8b33a064]: persona and palette out of shared code; guard extended to the stable prefix |
| 24a787cd | Adapted, narrowed [144941e9]: packs name their exemplar manifest; retrieval stays ADR-115, KAAE only |
| 4d3f393d | Ported [7d57f7a3]: v1 KAAE templates retired (410) |
| 66e483e8 | Adapted [f4d652f7]: audit #2 #3 #11 #14 #15 #16 #17 #21 #22 ported; #12 and #16's drift check superseded by stricter branch behaviour |
| 59150ca3, ce851ee0, b58f8a59, 10af521a, 674ed84b, 1d5644b9, f423cea6, d9ae139f, f55ab8d3, 809e1073, b646b42d | Skipped as instructed ("chore(release): record manifest"); MANIFEST.json and SHA256SUMS.txt refreshed instead |

## 2026-09-28 — Security boundary repairs (ADR-128)

ADR-128 closes Phase 4 security findings 7, 8, 10, 11, 12 and 28. Each intake switch has one role rule on every route that changes it. WhatsApp is the administrator's in both directions, as POST /waha/kill-switch already was. Telegram stays with operator, administrator and art director, so the Desk and the nightly Restate backup keep working unchanged. /operations/kill-switch now answers only after PostgreSQL has the switch, and a WhatsApp change there also sets WAHA_KILL_SWITCH. The Delivery internal routes accept only the service role from verifyRequestAuth, so a worker token that is short or equal to another key closes them as it already closed intake. HAWA_DEV_TOKEN joins the keys the worker token must differ from, and /auth/session never issues a session for the service token. The query-string session is retired. nginx no longer logs missing stored files, and it answers /v1/internal/ and its /api prefixes with 404. The worker reaches Core at http://core:3001 on the compose network. db/03-grants.sql is init-only: once hawa.schema_upgrades exists it changes nothing.

Initial red: 16 failed/58 passed, each reproducing its finding. Final: six files/74 passed/0 failed/0 skipped. Directly affected: 48 files/537 passed/1 failed/2 opt-in skips; the failure is a stale migration constant that also fails at the base. Full suite once: 4467 passed/9 failed/60 skipped; the same 9 tests fail at 7b8de71e. Isolated PostgreSQL through hawa_app, and the production nginx image with stub Core and Desk on a throwaway network. Source/scripts types and 534 strict test roots pass; any/egress/security checks pass. See SECURITY_BOUNDARY_PROOF.json.

No deployment, production read or write, live nginx reload, live backup rehearsal or credential rotation. Next: the owner deploys Core and nginx together and checks the next nightly backup; the stale fixtures behind the 9 pre-existing failures need repair. The six-package objective remains active.

## 2026-09-28 — Operations fix round (ADR-129)

This round fixes Phase 4 operations findings 1, 2, 3, 4, 6 and 26. No migration.

- **Poller switch (1).** deploy.sh no longer moves HAWA_TELEGRAM_POLLER to Core before the colour that takes over exists. Core keeps the value it runs with (or core, when no Core container exists) until register succeeds, and is then recreated once. The idle worker image is built and verified before step 7. A failed exit now says which process polls.
- **Rollback split (2).** register reads the new colour's /ready service list and refuses, before any POST, a build that lacks a service Restate already routes to the worker. A build without a list counts as TaskWorkflow and TaskService only. The README advice that could not work is replaced: a worker rollback below a service-adding build is unsupported, and an existing split has no repository recovery.
- **Poller health (3).** Core probes getMe whichever process polls and names the poller in /v1/health. The polling worker colour degrades on a poller that did not start, a 401/404 token or five minutes without a working cycle. The watchdog alerts when Core names the worker and no colour polls.
- **Worker token rotation (4).** Rotation now takes two deploys. Core and the worker accept HAWA_WORKER_TOKEN_PREVIOUS, and Core signs with it while it is set. deploy.sh refuses a running token that matches neither value and never prints values.
- **Log shipper config (6).** vector.yaml is validated before step 7 and vector is restarted when it sees another file.
- **Restore (26).** Restores now go into a new database, are checked against the dump's policies, foreign keys and triggers, and are swapped in by two renames in one transaction.

Red: 44 tests; 42 failed, 2 passed, and one worker file did not load. Behavioural reds: the fake Restate registered a TaskWorkflow/TaskService-only rollback build, Core answered 401 to the previous token, production skipped getMe, and health had no poller owner.

Final affected run: 49 files, 447 tests, 444 passed, 1 failed, 2 skipped. The failure is the pre-existing stale LAST constant in startup-schema-check. The skips are opt-in process-kill drills. All 47 new tests pass.

Full suite (539 files, 4563 tests): 8 failed, in 7 files. The same 8 fail with the tree restored to 7b8de71e.

Restore drill on the test server: a production pre-deploy dump (counts only) with migrations 022-064 applied, 116/194/28 → 160/258/70 (policies/FKs/triggers).
- The old runbook command exited 1 and left 44 policies; the application role then saw 0 tasks.
- The docs/25 variant exited 1 with 84 errors and a mixed schema.
- The runbook block, read from the file, restored 116/194/28 and schema 021. The application role saw 1612 tasks with its tenant context and 0 without it.
- All scratch databases were dropped.

Source, script and 540 test-root types, lint (any 954/1053, egress) and the security scan (0 secrets) pass.

Not executed: deploy.sh --apply, a live poller switch or Restate registration, a production rotation or restore, Compose run/restart of vector, the plain-SQL restore path and the watchdog alert path. See OPERATIONS_FIXES_PROOF.json.

Next:
- The owner runs a deploy with this change.
- Repair the 8 pre-existing suite failures on this branch.
- Decide whether the existing split-colour state needs a tested Restate admin procedure.

Additional notes:
- Finding 4 required one-line signing edits in native-review.routes.ts, decisions.routes.ts and delivery.routes.ts, outside the files the finding names. native-review.routes.ts is a native revision path that another engineer may be changing, so expect a small merge conflict there.
- The worktree's pre-commit hook failed until I copied the gitignored output/audits/2026-09-25-architecture-design-reality/REPORT.md from the main checkout into the worktree. It is a real file, not committed; PLAN.md links to it and validate_pack checks that link.
- The scratchpad is shared with other agents: my commit-msg.txt there was overwritten after I committed. I checked that commit 72cb6fae carries my own message.

## 2026-09-28 — Operations review fixes (ADR-129)

A separate review of 72cb6fae found a blocking regression in the poller hold. Core was held at worker on a switch back to Core. When register exited 4 and the new colour, created with core, was kept, nobody polled, and the exit note said the worker colour did. Only a move to the worker is held now; a move back takes effect at step 7. A kept colour that will not poll makes Core poll. The note states Core's own value and the ChatInbox rule. "--hosts unknown" now means no list, not a service named unknown. deploy.sh reads the service list from the built worker image (no network, no pull), and check-hosts refuses a split build before step 7 replaces Core and the Desk. The restore-swap block now copies the database owner, grants and scalar settings, and swaps only when they compare equal. With a production pre-deploy dump on the test server, CONNECT revoked from PUBLIC and two settings set, the earlier block swapped in a database that hawa_app could connect to, and the login role lost statement_timeout and work_mem. The new block kept both, and the login role saw its 1612 tasks. Red: 13 of 36 new/changed tests, 2 of 4 block tests, and a failing drill verdict. Final: 19 affected files, 152 passed and 0 failed. The full suite (540 files, 4579 tests) had 8 failures, the same 8 as recorded at 72cb6fae. Types, lint, security scan and validate_pack pass. No migration. Production's datacl and pg_db_role_setting were not read; the block checks them at restore time. No deploy, live poller switch, Restate registration or production restore took place. See OPERATIONS_REVIEW_FIXES_PROOF.json.

## 2026-09-28 — Phase 4 lifecycle and Desk fixes (ADR-130)

ADR-130 closes findings 22, 13 and 19 of the Phase 4 review, verified at `7b8de71e`.
A Telegram refusal whose failed mark cannot be written is journaled; a retried step
corrects the mark before the sender waits and resends, or answers refused for a 4xx.
A 5xx, a lost answer or a crash before the answer was journaled stays uncertain,
is never resent and alerts the office once. A requester reply to a request in review,
approved, delivering or delivered keeps its words under the update ID, alerts the
office with them and tells the requester plainly they were not applied. A new
request-owned Deliver is held until an office member acknowledges each change; the
actor and action are recorded. The Desk Deliver key includes the task version, so a
press after a failed delivery is a new action. No migration.

Red runs first: sender 8 of 38 failed; Deliver key 1 failed; late words 10 of 108 failed;
Desk prompt 2 failed. Final affected run: 13 files, 222 passed, zero failed or skipped,
with crash before and after every journal entry, an injected PostgreSQL outage and
isolated per-file databases. 533 strict test roots, any ceiling, egress and security
checks pass. The full suite gave 4471 passed and 8 failed; the same 8 fail on `7b8de71e`.
See LIFECYCLE_DESK_FIXES_PROOF.json.

The journal is a Restate test double, not the server; there was no process-kill drill,
no live Telegram send, no browser run of the Desk dialog and no deployment. Unlinked
messages after approval and replies to delivery files or notices are not covered. A
sent mark that cannot be written after a successful send still answers uncertain.
The six-package objective remains active. Next: decide on unlinked late messages, and
refresh the stale route-inventory, migration-list and release-manifest fixtures
separately.

## 2026-09-28 — Merged mainline (lead)

`claude/mainline` = `7b8de71e` plus the continuation (ADR-122..126), the studio-v2 integration
(ADR-127) and the Phase 4 fix rounds (ADR-128..130). Merge decisions: migrations renumbered to
065/066; the operations kill-switch route keeps ADR-127's administrator-only rule while the office's
ingress toggle keeps ADR-128's per-channel rule (the nightly backup uses the toggle); the watchdog
carries both the worker-poller check (ADR-129) and the backup recovery (ADR-127). The 44 migrations
023-066 were applied to the 2026-09-28 nightly dump restored into a scratch database on the test
server: 0.70 s, 1,612 tasks and 2,090 events unchanged, a second run applied nothing and verified 66;
the scratch database was dropped. Release gate results follow in the release record.
