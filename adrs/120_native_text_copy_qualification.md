# ADR-120 — Qualify native text amendments on a separate copy

Date: 2026-09-28. Status: qualification in progress; production admission open.
Requirements: FR-029/032/042/053, NFR-020. Sources: docs/05_CREATIVE_ENGINE.md,
docs/11_QA_RTL_MULTILINGUAL.md and docs/30_CURRENT_STUDIO_CONTRACT.md through traceability.

## Decision

Add a narrow typed transport for Canva `create_from_design` text autofill and its
job readback. The caller supplies a just-observed named-field dataset; missing or
non-text target names refuse dispatch. Preserve exact requested strings and bound
the number of fields, title and payload size. The returned job is not evidence of
the intended edit, preservation, native version atomicity, or approval.

Start qualification on a separate synthetic copy. This avoids destructive update
of the current master while provider revision-precondition support remains absent
from the reviewed contract. It does not resolve concurrent source changes: capture
and compare the actual resulting native state before admission. In-place updates,
other field types and arbitrary layout operations remain separate capability cases.
This initial trial does not reduce the existing eight-operation qualification scope.

Reuse the existing bounded authenticated transport. POST 5xx, lost replies and
malformed success bodies are uncertain and are not retried as fresh creations.
Only definite transient refusal/pre-send failure uses existing bounded retry.
Callers must durably record a claim before dispatch and reconcile a returned job
ID. A claimed operation with no ID cannot create again automatically. Reject an
unexpected job ID, result kind, source-design ID returned as a supposed copy, or
unvalidated returned metadata. Never expose provider error bodies.

## Qualification

Create one clearly marked synthetic fixture with a date, other English/Sorani
text, and a cropped grid image. Map the exact date field through the native editor
and make separate native position adjustments before the test. Canva connector
commits require the tool's explicit preview approval. Backend autofill must then
demonstrate that it can create a separate amended copy, retain exact unrelated
copy, native image and positions, reopen, export, and pass bounded recovery cases.
Synthetic geometry is technical evidence, not human design or language review.

Before production routing, add the owner-scoped durable operation and all required
postcondition/approval gates. This transport and synthetic trial enable no new
Desk write and do not bypass the current native revision handoff.

## Transport checkpoint — 2026-09-28

Typed copy creation and exact-job readback are implemented. The dispatch body is
frozen before asynchronous work; caller mutation cannot change the source against
which the returned copy is checked. Own dataset fields, UTF-8 total byte limits,
exact Unicode/whitespace, provider metadata and safe error codes are validated.
Only whitelisted metadata survives. In-place results and the source ID returned
as a copy are refused. Uncertain 5xx, lost replies and malformed successful replies
never trigger another creation from this client.

The initial 15 tests failed because the methods did not exist. Final focused
qualification: six adapter files, 70 passed, zero failed/skipped; all 532 strict
test roots compile. This is transport evidence with fake provider responses,
not a native preservation, durable owner integration or release claim.
The prepared synthetic fixture's native draft remains uncommitted pending the
explicit preview approval required by the Canva editing interface.

Official references checked 2026-09-28:
- https://www.canva.dev/docs/apps/rest-apis/reference/autofills/create-design-autofill-job/
- https://www.canva.dev/docs/apps/rest-apis/reference/autofills/get-design-autofill-job/
