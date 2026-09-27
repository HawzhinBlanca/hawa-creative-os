# Recovering a fixture evaluation (ADR-084)

Requirements: FR-059/060/065/067/079, NFR-001. These evaluations are fixture
diagnostics. They do not admit a model or prove design quality.

1. Open Evaluations and read the saved run status. `Calls` shows provider/model
   facts when a receipt exists, recorded estimated costs, and unknown amounts.
2. After a lost HTTP response, use **Retry saved evaluation**. Desk retains the
   original action UUID in session storage. A refreshed Core reads PostgreSQL;
   completed runs return their original report without model transport.
3. An incomplete history entry offers **Resume**. The request uses the original
   name and action UUID. Completed calls replay only their saved scoring fields;
   no raw prompts or free-text model responses are retained.
4. A pending/uncertain call requires review. Process death does not prove that the
   provider rejected or did not bill a request. A fresh action is refused while
   the earlier run is incomplete or has pending/uncertain calls. Do not clear the
   browser key or edit ledger rows to bypass this condition.
5. A version conflict requires the original evaluator, corpus, image and source
   seal. The changed deployment must not silently rescore or resend old work.

API: `POST /v1/evaluations/runs`, `Idempotency-Key: <original UUID>`, JSON
`{"name":"<original name>"}`. `GET /v1/evaluations/runs` returns scoped history;
`GET /v1/evaluations/runs/<runId>` includes sanitized call receipts. Operator or
administrator authority and durable storage are required to start/resume.

A successful receipt's cost is an estimate, not invoice reconciliation. Provider
lookup and an append-only operator settlement workflow are not implemented here.
Collect the provider's actual request/billing facts for a held call; preserve the
original admission and first outcome. Do not claim a held call is free or rerun it
under a different action ID. Clean-host recovery and live billing remain separate
qualification work.
