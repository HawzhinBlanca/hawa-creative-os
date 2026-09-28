# Current editable-studio contract

**Decision authority:** [ADR 025](../adrs/025_canva_only_archive.md), accepted 2026-09-13. **Reconciled:** 2026-09-25. This page defines the active source and export contract. Earlier HyCanvas and fallback-editor instructions in the 2026-09-03 research freeze are historical records, not an admission path.

## Selected boundary

Canva is the sole active editor and exporter. The native Canva design ID and URL identify the working editable master. Hawa owns the task, brief, copy, assets, revision ledger, approval, and publication identity. A PPTX or other interchange file used to import structured elements into Canva is an input artifact, not a second user editor or a guaranteed lossless backup of later Canva edits.

The design is reviewable only after Hawa captures the real Canva design ID and a current export. An uncaptured, inaccessible, or stale design is `unknown` or `not_captured`, never an invented ID or a passed editability check. The selected Canva design and captured export must be bound to the task's revision and content hashes before approval. A later edit requires a new capture and invalidates the earlier approval if rendered or semantic content changed.

## Source and recovery package

For each approved revision, retain an immutable package with:

- Canva design ID, edit URL, account/workspace identifier and capture time;
- exact approved copy, semantic element map where extraction supports it, dimensions, locale, direction, and supported editable element classes;
- original approved assets, official asset IDs and hashes, font references, and the import/operation recipe with versioned inputs;
- final Canva export bytes, MIME, SHA-256, QA profile and result, approval identity, and publication receipts;
- PNG and requested PDF exports, plus any other *actually produced and verified* standard format.

The manifest may help reconstruct a design if Canva becomes unavailable. It does **not** prove arbitrary manual Canva edits can be reproduced outside Canva. Portability is admitted element by element through an export, edit, reopen and reconstruction drill. Text, logos, photos, vectors, groups and Sorani typography must each be reported as restored, partially restored, or lost. No `.hyc` file is part of the current contract; SVG/PPTX/PSD are optional only when produced and their actual editability is measured.

## Admission evidence

Before a task is called editable and ready for review, prove that the native Canva source opens with independent live text and required assets, that the captured export matches the pinned revision, and that exact-copy, asset, glyph, layout and format gates pass on that export. Missing source inspection or unavailable export is an unknown result requiring operator review. The release and restore drills in [acceptance gates](29_ACCEPTANCE_GATES.md) and the [research-grade upgrade plan](../plans/research-grade-upgrade-2026-09-25/PLAN.md) determine whether the implementation has met this contract; this page itself is not proof of those tests.

## Supersession map

ADR 025 supersedes the studio selection, `.hyc` source, HyCanvas proof sprint, Penpot/Shotluma fallback, and backup-without-Canva promises in the initial versions of `AI_BUILD_PROMPT.md`, `DECISION_SUMMARY.md`, `MASTER_SPEC.md`, `docs/06_EDITABLE_DOCUMENT_STRATEGY.md`, and `docs/11_QA_RTL_MULTILINGUAL.md`. The historical baseline remains in Git before this reconciliation and in [ADR 025](../adrs/025_canva_only_archive.md); it must not be used to qualify the present system. A future foundation change requires a new ADR and new proof.

## Manual designs without an import (ADR-077)

A blank native design may be checked against the manual Desk request’s exact saved
copy and active, hash-verified, human-authored Client DNA font families. The export
operation freezes the policy and its version before submission. This creates no
imported-source record. Superseded policy remains historical evidence but cannot
qualify a new review, approval or publication. Family membership does not establish
font-file glyph coverage, native editability or visual quality. See
[ADR-077](../adrs/077_manual_canva_export_policy.md) for the boundary and acceptance.

## Revisions of an existing native design (ADR-113)

An earlier generated layout is not the current native revision basis. Until a
native patch operation is qualified, linked revision requests stop before new
creative work or a fresh import. Desk directs an operator to duplicate the current
Canva design, preserve unrelated edits, link the separate copy and confirm its exact
final text. The confirmation retains the actor, request key, expected task version
and parent/child binding basis as an immutable event. It is human testimony, not
automated native-preservation evidence or approval.

PNG and checked PPTX must belong to that current confirmation and the same observed
native update version before they become a review. New confirmation, changed binding
or parent task basis, or superseded Client DNA invalidates previous policy evidence.
Approval and publication retain their existing independent gates. Native timestamps
and local task versions do not prove absence of concurrent Canva edits.

Existing uncertain imports remain reconcilable. RequestLifecycle retains ownership;
the legacy handoff cannot mutate its tasks. Native operation admission and completion
of the lifecycle-owned manual recovery route remain separate work. See
[ADR-113](../adrs/113_native_revision_handoff.md).

## Request-owned native revision recovery (ADR-114)

The current manual stage of an automatic lifecycle revision delegates only separate
copy linking, exact-copy confirmation and export preparation to an office human.
Each write carries the expected request ID/revision and rechecks ownership under
the lifecycle transaction lock. Initial manual requests without an automatic run
are outside this revision-specific admission.

Capturing files does not advance the request. A separate signed submission names
the current confirmation, checked artifact and expected task/request versions.
RequestLifecycle projects the captured revision, QA and manual-to-in_review change
in one transaction, retains a keyed content hash, then adopts that projection.
Identical retries reconcile both projection-response and owner-response loss;
altered content under the same action is refused. Desk retains pending submission
identity across reload until a result or definite refusal is known. Approval and
native preservation qualification remain independent. See
[ADR-114](../adrs/114_lifecycle_native_revision_recovery.md).

## Initial manual request recovery (ADR-126)

A request whose immutable first projection receipt records a manual open without
automatic generation, and whose task has no Studio run state, delegates the same
preparation at request revision 1: link the request's own separate native design,
confirm its exact final text, and capture PNG/PPTX under that confirmation. There is
no parent design, so the human assertion is that the linked design is this request's
own separate design; the global binding uniqueness refuses a design already linked
elsewhere. Capture before confirmation is refused.

Capture retains files without advancing the request. The same signed submission
reaches RequestLifecycle, which projects revision, QA and manual-to-in_review once
and adopts the hash-bound receipt after lost replies. The owner then holds a
manual-origin state with no run: approval, rejection and delivery proceed as usual;
a requester revision round is refused because its reply would start generation.
Frozen initial policy stays current only while its confirmation, binding and Client
DNA are unchanged. See [ADR-126](../adrs/126_initial_manual_native_recovery.md).


## Retained font basis (ADR-116)

A new Studio visual bundle records the actual font-file and font-registry hashes.
Recovery verifies this basis before the next model/render stage. A replaced, missing
or newly available font or changed registry requires restoring the original basis
or reviewing the existing run; the change cannot be silently adopted on resume.
Historical version-1 bundles lack this evidence and remain held for review. This is
font-input evidence, not native Canva fidelity or full renderer/OS reproducibility.
See [ADR-116](../adrs/116_retained_font_basis.md).

## Renderer runtime and reserved-region mapping (ADR-123)

The retained basis now also names the rasteriser that draws (rsvg-convert bytes and its
reported version) and the operating-system release. A change holds a pinned run before the next
model/render stage, as a font change does; version-2 bundles without this evidence are held for
review. Cut-out and focus derivations record the service runtime, face detector and cut-out
bytes; a pinned run never asks the service again. The art prompt describes the calm region in the
provider's requested frame after the renderer's cover crop. The art provenance keeps that plan
and a check of the returned image; final QA records where the final layout's calm region and
each photo crop landed. These are evidence, not a gate. See
[ADR-123](../adrs/123_renderer_runtime_and_region_mapping.md).

## Native amendment observation (ADR-119)

Desk can explicitly inspect the current link's named fields and account capability
advertisements through the authenticated app connection. These reads retain a task,
binding and native metadata basis and reject a detected change during inspection.
They do not authorize writes or establish native preservation. Timestamp equality
does not exclude concurrent edits. A denied capability read remains unknown,
including when the optional profile:read grant is absent; it does not establish a
subscription limitation. See [ADR-119](../adrs/119_native_amendment_capability_observation.md)
and [the inspection runbook](../runbooks/CANVA_AMENDMENT_INSPECTION.md).

## Native text copy qualification (ADR-120)

The integration client can submit a bounded text-only `create_from_design` job
against observed exact dataset names and read back that same job. It refuses
in-place results, a source identity returned as a copy, malformed metadata and
unknown target fields. The caller must retain its claim before dispatch and
reconcile uncertain outcomes; transport success does not prove the edit or
preservation. This qualification interface grants no Desk write or production
revision authority. Current manual handoff and approval requirements remain in
force until owner integration and native postconditions are qualified. See
[ADR-120](../adrs/120_native_text_copy_qualification.md).

## Durable copy candidates (ADR-121)

Internal candidate preparation uses the current lifecycle-owned manual revision,
its office actor and same-client parent binding. Task/handoff/native metadata and
exact named text are pinned before the existing operation ledger commits its claim.
Unknown results cannot authorize another copy; an acquired job is reconciled and
its IDs are immutable. The existing sweeper recognizes pending native text copies.

A retrieved candidate is explicitly unverified. Preparation never changes a
binding, task version, request stage, review, approval or delivery. There is no
HTTP/Desk creation route until native preservation admission. The current human
handoff remains the review authority. Read/metadata stability does not establish
atomicity against direct Canva edits. See [ADR-121](../adrs/121_durable_native_copy_candidates.md).

## Brief-bound judge challenger (ADR-124)

P07 remains the default judge. `HAWA_STUDIO_JUDGE_PROTOCOL=brief_bound_v1`
selects the challenger when the judge stage runs; any value other than unset,
`incumbent` or `brief_bound_v1` is refused as an unavailable judge, with no call,
and the higher eligible composite stands. The challenger sees the requester's
instructions, the recorded brief fields and the exact copy, never layout metrics,
ranks or prestige wording. It judges correctness, communication and aesthetic
preference separately, with tie and abstention, and returns no overall winner.

Selection keeps the same eligible top two, rendered bytes, degraded-copy canary,
ledger client and budget. The application decides: correctness, then
communication, then aesthetic preference, each stable across both orders. An
uncertain pair keeps the higher composite and records `humanChoiceRecommended`;
a failed canary does the same with the judge marked unreliable. A canary that
renders the same bytes as the pick is not called; the untested pick is not
trusted, the composite stands and `judgeReliable` is null. An unavailable judge
records the refusal's `errorCode` and `humanChoiceRecommended`, and the Desk
Studio panel asks the reviewer to choose whenever that flag is set. The
challenger accepts up to 24,000 characters of request instructions within a
30,000-character packet; a longer request is refused, never truncated. Judgments keep
packet and image hashes, the validated verdict, the decision and the receipt.
The flag is not admitted for production until the ADR-124 experiment, human
labels and a shadow run say so. See [ADR-124](../adrs/124_brief_bound_judge_challenger.md).

## Executable brief contract and negative-space policy (ADR-125)

The v3 layout prompt states the negative-space definition the checker scores, rendered from one
versioned policy (`studio.negative-space` `2026-09-28.2`); every score records that version, and
every run that reaches laying out records it in `stages.policies`.

Before the first layout call a new or afresh-designed run records one executable brief contract
on its stages: exact copy and client assets by hash, source-copy order and checked relations as
protected, composition freedoms as permitted, and every model brief field as a proposal or an
unknown. The model's readingOrder remains a proposal. A recorded contract whose authorities
changed holds the run; one whose only change is policy or measurement evidence is re-admitted and
the re-admission recorded. An afresh-designed revision records the copy it lays out as its own, and
its resume replays the failed edit's retained calls.
Copy with a run no admitted face can set inside the safe width at the minimum size stops the run
before layout with an explanation and only the authorized choices (revised approved copy, or a
wider approved format); nothing is shrunk, omitted, split or reworded. Directed edits do not yet
carry an edit contract. See [ADR-125](../adrs/125_executable_brief_contract.md).
