# ADR-111: Retain validated Studio results for interrupted-stage recovery

Date: 2026-09-28. Status: implemented; locally qualified.

Requirements: NFR-001, NFR-014, FR-079; MASTER_SPEC.md and docs/10_WORKFLOW_RELIABILITY.md,
docs/07_MODEL_REGISTRY_AND_EVALUATION.md, docs/17_UI_UX.md.

Validated structured results and provider image results are saved with the first
successful call finalization. Content lives in a separate immutable, scoped result
table, not the operational receipt ledger. Images use the existing content-addressed
store when configured, with a bounded PostgreSQL bytea fallback for installations
without it. Retained blobs are garbage-collection roots.

Resume consumes the original stage's ordered call prefix. It reserializes the
provider request and compares its digest, model, provider and stage to the saved
admission before returning a hash-verified result. A changed request, missing/corrupt
result, unknown outcome or legacy paid error stops recovery; none permits another
charge. Once the prefix is exhausted, normal task authority, reservations and
atomic ordinal admission apply to any new call. Reuse consumes no new budget slot
and does not add already recorded spend again. Task/client authorization is rechecked.

The current serial execution order is preserved. This does not admit concurrent
model calls; stable parallel substep allocation remains separate work. Nor does
result retention itself pin all upstream derivations or qualify native Canva edits.

Qualification must cover fresh-instance reuse, changed input refusal, incomplete
legacy evidence, corruption, scope, immutable content, budget exhaustion on replay,
and loss after successful finalization but before stage persistence. A provider
reply lost before local retention remains uncertain and requires reconciliation.

Local evidence: `plans/lean-design-implementation-2026-09-28/RETAINED_RESULTS_PROOF.json`.
The public resume test runs on a fresh connection under `hawa_app`, after injected
failure between receipt retention and stage persistence, at the call cap. Art tests
cover both a fully retained image/verdict and interruption before the verifier.
Runtime-role tests cover tenant/client scope, immutable content, and hash-verified
image reads. Repository-created runs now initialize stages as an object; empty
legacy arrays normalize before persistence, avoiding loss of the recovered brief.

This does not claim process-kill/restore or paid-provider qualification. If an earlier
persisted rebrief changes which substep executes first, or a failed attempt is
interleaved, ordered prefix comparison may hold for review. Fine-grained durable
substep checkpoints and pinned derivations remain open.
