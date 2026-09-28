# ADR-119 — Observe native amendment capability on the app's own connection

Date: 2026-09-28. Status: observation implemented and locally qualified; native operation admission open.
Requirements: FR-029/032/042, NFR-009/020; docs 05/09/11/30 through traceability.

## Decision

Observe account capabilities and the current bound design's autofill dataset using
the existing typed Canva client and task/client/actor scope. Connector access in a
Codex chat is not evidence that the backend token can perform the same operations.
An active OAuth connection is not a qualified amendment operation.

Read-only observation reports supported account capabilities, actual named fields,
unknown/unavailable/forbidden results and a task/binding/native metadata basis.
Recheck the task/binding and native metadata after reading to reject a stale
observation. Native timestamps are observational, not compare-and-swap fences.
Never interpret an absent optional response property as an affirmative capability.
Do not admit a write from this observation alone; preservation, expected-basis
handling, duplicate/uncertain effects and actual postconditions remain required.

Keep existing authorization scopes unchanged during this slice. If `profile:read`
is missing, expose an unknown capability observation and a specific reconnect/setup
action; do not manufacture a negative subscription diagnosis. Dataset inspection
uses `design:content:read`. No broad account search, new database, agent framework,
write retry policy or copied connector credentials.

## Acceptance

Typed bounded provider responses, safe errors without provider bodies, transient
read retry, empty datasets, unknown field kinds and permission failures. Real
isolated-DB task/binding scope, mid-read changes, no writes to designs, and the
actual backend account probe. A mock result or documentation must not qualify
native preservation or enable unattended amendments.

Sources checked 2026-09-28:
https://www.canva.dev/docs/apps/rest-apis/reference/users/get-user-capabilities/
https://www.canva.dev/docs/apps/rest-apis/reference/designs/get-design-dataset/

## Evidence and actual account result

The scoped GET route and explicit Desk action are implemented; they never join the
five-second polling loop or admit a native write. Bigint task/binding revisions
are normalized only when safely representable. Provider fields and capability
inventories are bounded and unknown field types refuse successful observation.

Eight affected files / 136 tests pass, with no skips; source/scripts and all 531
strict test roots plus Desk build pass. Eight missing-method/route tests fail
before implementation. The first implementation run exposed bigint response
normalization and a fixture prevented by the existing cross-client foreign key;
both are corrected and their failed results retained.

The real backend OAuth probe can read the existing synthetic multilingual design,
whose dataset is empty. Capabilities return HTTP 403. The default grant omits
profile:read, so subscription capability remains unknown. This is an actual app
connection result, independent of Codex connector access. Native operations were
GET only; ordinary token refresh was permitted through the existing journaled
connection flow. No deployment or native amendment was performed.

Proof: plans/lean-design-implementation-2026-09-28/NATIVE_OBSERVATION_PROOF.json.
Next: prepare a disposable named-field fixture and qualify the actual amendment,
readback, manual-change preservation and uncertain-outcome boundaries. Account
observation is not that operation's admission record.
