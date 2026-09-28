# ADR-112: Pin the visual inputs used by a Studio run

Date: 2026-09-28. Status: implemented; locally qualified.
Requirements: NFR-014, FR-026, FR-040, FR-041, FR-079; MASTER_SPEC.md,
docs/10_WORKFLOW_RELIABILITY.md, docs/07_MODEL_REGISTRY_AND_EVALUATION.md,
docs/11_QA_RTL_MULTILINGUAL.md and docs/17_UI_UX.md.

Before layout generation or a directed edit, retain one immutable visual-input
bundle for the run: upright source photos and meaning, explicit style reference,
selected exemplar images, actual conditioning thumbnails, selected cutout pixels
and shadows, available derivation identities/check reports, crop focus and sizes.
The manifest binds the immutable run/client and current design-policy identity.
The first transaction wins; concurrent preparation consumes that same winner.
No model/layout work may consume an uncommitted proposed bundle.

Use existing private content-addressed storage, bounded PostgreSQL bytea fallback
when no store is configured, SHA-256 verification, task/client RLS and GC roots.
Save negative cutout outcomes as well, so later service availability cannot change
an already composed design. A newer cached cutout must not replace selected bytes.
Recheck current task/client authority and policy on reuse; a policy change holds
rather than authorizing stale policy. Albums may settle and be rebriefed before
layout; newly arriving images after pinning need a new revision.

Preserve serial retained-call recovery (ADR-111). Pinned visual inputs remove one
source of mismatched replay, not every possible derivation change. Font binaries,
renderer/runtime versions and branch-aware paid substep checkpoints require their
own admission. Historical runs already beyond layout with no pinned visual basis
cannot claim equivalent recovery; surface an explicit hold rather than selecting
new assets silently.

Qualification: interleaved newer cutout, fresh-instance exact-byte reuse, no repeated
image preprocessing/thumbnail/cutout work, negative outcomes, concurrency, changed
policy, scope, integrity, missing files, atomic persistence and production stage
wiring. No paid-provider or OS process-kill claim from synthetic integration tests.


The manifest and all assets commit together; a transaction identity prevents late
asset insertion. PostgreSQL serializes competing preparations on the run/task and
all callers consume the first committed bundle. Each asset is bounded to 32 MiB,
the bundle to 128 MiB/96 assets and its manifest to 1 MiB. Unreferenced files from
an interrupted preparation remain subject to the existing GC grace policy.

Exemplar admission metadata is checked independently of retrieval and stays out of
model prompts. The profile and current design policy must still match on reuse.
Cutout outcomes retain available model/source hashes and a canonical check-report
hash; old missing facts remain unknown. The complete cutout service implementation
and runtime/font binaries are not pinned by this slice. V2 creates no unused V3
conditioning thumbnails. New albums/references may change before layout, not after
its visual bundle commits. Existing terminal/review results are not rewritten.

Qualification is recorded in `plans/lean-design-implementation-2026-09-28/VISUAL_INPUTS_PROOF.json`.
A real PostgreSQL/fresh runtime-role resume receives the original selected pixels
at both layout and critique boundaries after a newer cutout is inserted. Those
stage boundaries and photo sources are intercepted synthetic fixtures, not paid
provider or native-design quality evidence. Before rollout, inventory historical
active runs already past layout: absent pins require an explicit review/handoff.
