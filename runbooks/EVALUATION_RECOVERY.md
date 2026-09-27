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

A successful receipt's cost is an estimate, not invoice reconciliation.

## Closing a held run with evidence (ADR-085)

1. Obtain terminal provider evidence for **every** pending/uncertain call. A timeout,
   a request ID alone, or an empty usage dashboard is insufficient. The provider must
   confirm processing finished and its final cost, or that it never accepted the
   request and charged zero. Unknown acceptance/cost stays held.
2. Sign in as a named office administrator and open the run's **Calls** panel. Shared
   keys cannot settle evaluations. If work is still executing, wait for its result.
3. Enter each final reported USD amount and provider/support reference. Keep the
   provider evidence in the office's retained archive. Choose the local evidence file
   to calculate its SHA-256, or enter that digest. The file is not uploaded to Core.
4. Explain the closure and choose **Record evidence and close evaluation**. The action
   freezes the observed ledger snapshot and complete evidence. A lost answer retains
   the action in this tab: reload or use **Retry saved settlement**. A stale snapshot
   is refused; reload Calls before correcting evidence.
5. The run reads **Closed · evidence retained**. Its first call outcomes, unknown
   original costs, report and scores remain unchanged. Reported final costs are
   administrator attestations, separately visible with actor/time/reference/digest.
   A late first receipt may still be recorded for audit. Closed runs admit no new calls.
6. Start a new evaluation only deliberately. It is distinct billable work; closure
   neither automatically restarts work nor certifies a passing result or model admission.

API: POST `/v1/evaluations/runs/<runId>/settlement`, with a UUID Idempotency-Key,
current `expectedSnapshot` from GET, `reason`, and a `calls` entry for every unresolved
call. Each entry contains `callId`, `conclusion` (`provider_not_accepted` or
`provider_finished`), `reportedCostUsd`, `evidenceReference`, `evidenceSha256`.
Named session/CSRF, active membership, the execution lock and snapshot are checked.
The run and original call rows are never rewritten to claim provider success.

Automatic provider lookup/invoice verification and general Studio response recovery
are not implemented by this control. Independent-host recovery and live billing remain
separate qualification work. Synthetic administrator tests do not substitute for real
provider evidence or a real human decision.
