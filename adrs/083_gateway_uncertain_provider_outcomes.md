# ADR-083 — Stop the shared model gateway after uncertain or unusable paid work

Date: 2026-09-27. Status: accepted for implementation; live billing and durable evaluation recovery remain unqualified.
Requirements: FR-059/060/065/067/079, NFR-001; docs/07, docs/10 and docs/14.

The shared gateway used by evaluations still tried another provider after a lost
connection, timeout, HTTP 5xx, unreadable success, invalid output or model mismatch.
A later local/cloud success then described only its own cost. This bypassed the
Studio rule in ADR-048 and could conceal accepted work or cause a second charge.

The gateway stops the current logical call after uncertain acceptance, including
HTTP 408/5xx, or an unusable successful response. Return a non-retryable typed
error with provider/model, attempts, observed HTTP status/request ID and null total
cost. Never include the provider body or raw exception text in the public error.
Definite rejection, such as 429, may still use an authorized bounded fallback.
Failure before dispatch is distinguished from acceptance uncertainty.

Evaluation batches stop further model calls after this hold and report attempted,
failed and unexecuted cases separately. The original provider facts must survive
in the returned report; an unexecuted case is not a passed or failed model result.

This does not add a provider lookup, a persistent evaluation-call ledger or safe
automatic restart of a held evaluation. Re-running remains an operator action;
process death and unknown provider billing remain R21/R22 admission limits.
