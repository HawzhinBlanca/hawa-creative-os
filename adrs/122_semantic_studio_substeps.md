# ADR-122 — Semantic Studio substeps and explicit dependency invalidation

Date: 2026-09-28 (fix round the same day). Status: implementation; locally qualified for
serial recovery.
Requirements: NFR-001/014/020, FR-060/079. Normative sources: MASTER_SPEC.md,
docs/10_WORKFLOW_RELIABILITY.md, docs/17_UI_UX.md; report section 7 of
output/research/2026-09-28-lean-system-final-review/REPORT.md.

## Decision

Give each Studio model call a stable semantic substep identity, separate from the
execution attempt that produced it: `brief/request`, `brief/images-rebrief`,
`brief/late-reference`, `concepts/board`, `layout/concept-N`, `layout/set`,
`art/candidate-N`. Undeclared calls use one ordered substep per stage,
`sequence/<stage>`; content-keyed parity checks use `parity/request-<digest>`.
Migration 065 records the key, the attempt number and a canonical binding with its
SHA-256 at admission, immutable with the rest of the admission identity. One row
per run/substep/attempt is admitted; a concurrent duplicate is a conflict.

The binding names what a retained result is valid for: the exact provider request
digest (which covers prompt, schema, images and model settings), stage, provider,
model, schema name and pricing/capability policy. Calls other than artwork also
bind the current authority (client reference, exemplar approvals, standing rules,
admitted fonts), so a withdrawn approval is rechecked even when the bytes sent to
the provider are unchanged. For the packaged KAAE profile, per-exemplar approval
lives in the packaged manifest (an entry is admitted only while it is `CONFIRMED`
or inherits the collection's confirmation; a withdrawn entry is set to `pending`),
so the authority digest, taken over the whole manifest, changes when one exemplar
is withdrawn. Calls whose inputs come from the local renderer bind the retained
font/renderer basis (ADR-116/118). Brief, concept and artwork calls do not: a copy
or font change elsewhere does not invalidate an image.

The art verifier's structured call runs inside its artwork's substep
(`art/candidate-N`) and binds neither authority nor renderer. It reads no client
policy: its request is a fixed compliance question about the image bytes
(letters, digits, logos, flags, emblems, faces or people), and the request digest
covers the image, question, schema and model. What the verdict means for the
design is decided locally on every resume, not retained.

Recovery consumes retained results per substep, in attempt order, not by the run's
global call order. Each recorded attempt is consumed at most once; a repeated
request in the same substep is a new admission. A definite image refusal
(`IMAGE_REQUEST_REJECTED`, not accepted, no charge) is reproduced as the same
outcome without transport. Any other unaccepted failure is re-attempted only when
nothing was saved after it anywhere in the interrupted stage, by admission order
(call ordinal, then start time); otherwise it holds before any transport. Work
admitted later in any substep may have been designed from the control flow that
followed the failure: when `brief/late-reference` fails, the stored blind brief
stays in place and `concepts/board` is designed from it. Re-running the re-read
would pay for a brief that orphans the saved board. No declared dependency between
substeps proves such work independent, so none is assumed. Rows admitted before
migration 065 keep ADR-111's ordered-prefix rule for the whole pool. In a pool that
crossed the deploy, post-065 rows must still match their substep and binding; pre-065
rows carry no binding and are matched by stage, provider, model and request digest
only, so for them a withdrawn approval with unchanged request bytes is not rechecked.

Saved results in the interrupted stage that the resume did not read are logged
with their call, substep and attempt when the resume ends, whether it completed or
held. A persisted rebrief is listed too: its result is already applied in the
stored brief, and the operator compares it with the stage before settling it.

A rebrief persisted inside a stage now continues from its stored form, the form a
resume reads. PostgreSQL jsonb reorders keys and later prompts embed the brief's
JSON text, so the in-memory form made the next request unreplayable. Only the form
is adopted: stored content that differs from what was written is never substituted.

`planStudioReuse` in the domain package is the explicit invalidation policy. A node
reuses its result only when its binding is unchanged, every upstream is reused and
every relied-on asset is currently authorized. A difference is recomputed only when
an idempotently keyed declared change names it, or an upstream is recomputed.
Undeclared drift holds and holds propagate downstream. A revoked or unknown asset
authorization holds even with unchanged bytes. The same keyed change applied twice,
or replayed after its recomputation, changes nothing more.

Every ADR-111/112/116 guarantee is kept: no charge or call slot for reuse; holds on
unknown outcomes, paid calls without a retained result, corrupt or missing bytes and
changed inputs; task authority and cancellation rechecked; pinned visual and font
basis verified before any stage.

## Acceptance

Tests first against the previous source. Real isolated PostgreSQL and synthetic
providers: persisted rebrief branch resumes through a fresh `hawa_app` connection
with no transport, spend or new rows; a changed persisted branch still holds;
interleaved image refusal replays and the retained image/verdict are reused; an
unreproducible interleaved failure holds; a date change reuses retained art with the
same image hash and holds the layout derived from the old date; one retained reply
applies once per attempt and replay is stable across services; an authorization
change holds with unchanged request bytes, both injected and through a withdrawn
exemplar in the packaged manifest as the context reads it (one fewer eligible
exemplar); a failed late-reference re-read followed by a saved board holds with no
transport, spend or new row; the resume logs the saved rebrief it did not read.
Domain metamorphic tests for the date change, revoked asset, keyed replay and
renderer identity; a failure followed by saved work in another substep holds (also
with parity's null ordinals), a trailing one is re-attempted; a mixed pre/post-065
pool rechecks post-065 bindings. Database constraints for
self-consistent bindings, one admission per attempt and immutable identity.

## Limits

No Studio route declares an amendment change yet: within a run, a changed input
holds. `planStudioReuse` is the policy the package 4 amend route must consume; it is
not wired to native capture or approval, which remain owned by ADR-113/114/121.
Stages other than those named above keep one ordered substep per stage. This is
serial recovery; no concurrent substep execution is admitted. Declared independence
between substeps does not exist, so a non-reproducible failure followed by any saved
work in the stage holds even when that work did not depend on it (an
`art/candidate-1` transport failure before a saved `art/candidate-2`); this keeps
ADR-111's hold rather than spending. Migration 065 adds columns, a validated CHECK
constraint and a non-concurrent unique index in one transaction: it holds an ACCESS
EXCLUSIVE lock on `design_studio_calls` until commit (observed on a test clone), so
it is applied with Core and the worker stopped. Bindings do not yet
carry per-asset identities for model calls; the authority digest is the coarser
proxy. No paid call, native Canva operation, process-kill drill, deployment or
human quality study is claimed. Local evidence:
`plans/lean-design-implementation-2026-09-28/SUBSTEP_RECOVERY_PROOF.json`.
