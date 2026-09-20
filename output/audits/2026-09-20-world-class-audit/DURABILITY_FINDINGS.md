# Durability delta audit — 20 September 2026

Current checkout: `9c22026f444c81494d286354960a0b10efaa1176`. This is a source/isolated-execution audit, not a production deployment attestation. No external service, production/test database, credential file or provider was accessed. Only new audit artifacts were written. Previous `664ad55` is no longer resolvable in this Git history, so findings were verified against current source rather than relying on a Git diff.

## What has genuinely improved

- Both publication routes now derive `pub_key_<task>_<approval>`; the previous distinct-key defect is fixed in source. Omnichannel requests share a process-local in-flight promise, improving same-process concurrency ([app.ts:2476](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:2476)). This does not protect independent processes or the separate ordinary publication implementation.
- Publication intent is now attempted before provider calls ([app.ts:2584](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:2584), [5422](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:5422)). The ordering improvement is real, but durability remains incomplete below.
- A moved Sheet row is located by immutable task ID when the identity read succeeds. The new offline probe confirms another task's inserted row survives this healthy-read scenario.
- Approval repository locks the task (`FOR UPDATE`) and checks an expected version ([revision.repository.ts:225](/Users/hawzhin/Hawdesign/packages/db/src/repositories/revision.repository.ts:225)); latest QA is selected by `started_at DESC` ([258](/Users/hawzhin/Hawdesign/packages/db/src/repositories/revision.repository.ts:258)). These fix specific September 19 weaknesses in source. Concurrent live database proof was not run here.
- Terminal notifications now normally persist a uniquely keyed outbox command before the inline send, retain the composed message, and distinguish returned uncertainty from returned transient failure ([app.ts:6171](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:6171), [6227](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:6227)). This is substantial progress, but the registered consumer and pre-enqueue boundaries remain broken.

## Executed results

`PUBLICATION_PROBE.mjs` transpiles the current adapter source and replaces all HTTP transport. Unlike `emulateNetworkForTesting`, it executes the real adapter branches against a synthetic remote store. `PUBLICATION_PROBE.json` records the source SHA-256 and output. The initial draft of the new probe overescaped the identity-match regex; this was corrected, the complete probe rerun, and only the corrected output saved.

| Scenario | Current observation |
|---|---|
| Fresh adapter instance, same publication | 2 Drive files and 2 Sheet rows |
| Remote Drive upload commits, response lost | Retry creates a second file |
| Remote Sheet append commits, response lost | Retry appends a second row |
| Remote checksum wrong, same name/type/size | COMPLETE and verified; a later explicit `verify` correctly detects the mismatch |
| Row inserted above task; identity read succeeds | Correctly updates the task's moved row; other row preserved — FIXED |
| Same move; identity verification returns HTTP503 | Overwrites the unrelated row, leaves two task rows, reports COMPLETE — FAIL |
| Concurrent calls to adapter using same key | 2 files and 2 rows; route-local fencing is not adapter/process-wide safety |

`NOTIFICATION_PROBE.mjs` executes the actual worker workflow with a deterministic completed-step journal and synthetic Core HTTP503. The notification step records `{}` as success. Replaying after Core recovery makes no second HTTP call and creates no notification intent. This is an executed lost-notification defect, not an inference from comments. No real Restate or Telegram was contacted.

## P1-D20-01: Publication crash recovery is still absent despite an intent row

The adapter still uses `inMemoryLedger` and `taskRowMap` ([google-publisher.ts:29](/Users/hawzhin/Hawdesign/packages/integrations/src/google-publisher.ts:29)), issues unconditional new Drive uploads ([294](/Users/hawzhin/Hawdesign/packages/integrations/src/google-publisher.ts:294)), and stores the receipt only after all remote effects ([414](/Users/hawzhin/Hawdesign/packages/integrations/src/google-publisher.ts:414)). Existing durable publication rows are not passed to the provider adapter to resume/reuse remote IDs. Both new intent-writing blocks catch a DB error, log it and continue to the external publisher ([app.ts:2602](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:2602), [5443](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:5443)). Thus intent persistence is best-effort, not a required side-effect fence.

Partial delivery still stores task state `publishing`, while normal retry accepts `approved` or `publish_reconciliation` ([app.ts:2640](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:2640), [5322](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:5322)). Restart-safe ordinary recovery remains source-disproved. The complete-after-restart response can also invent `pub_<taskId>` instead of loading the real receipt ([5331](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:5331)).

Requirements: FR-047, FR-049, FR-060, NFR-014, NFR-020. **Proof task:** persist a unique immutable request and destination hash; require its commit; use one publication workflow across both entry routes; persist/reconcile each external effect; fail closed on DB loss; restore partial state from durable progress. Kill processes before/after each Drive/Sheet call and receipt commit, including multi-file partial success. Re-run from a fresh real process and enumerate remote artifacts independently. One logical file set/row, no unauthorised repeat, no invented receipt. Do not accept a same-app-instance mock test as restart proof.

## P1-D20-02: Row identity protection fails open on network failure

The new verification path only acts when `verifyRes.ok` and a different nonempty identity is read ([google-publisher.ts:469](/Users/hawzhin/Hawdesign/packages/integrations/src/google-publisher.ts:469)). HTTP failure falls through; thrown errors explicitly fall back to the unverified row position ([483](/Users/hawzhin/Hawdesign/packages/integrations/src/google-publisher.ts:483)). The subsequent PUT overwrites that position ([490](/Users/hawzhin/Hawdesign/packages/integrations/src/google-publisher.ts:490)). The probe demonstrates corruption after a shifted row plus HTTP503. On an unknown row number, it still blind-appends without a task-ID search ([497](/Users/hawzhin/Hawdesign/packages/integrations/src/google-publisher.ts:497)), duplicating after lost responses/restarts. All ranges remain unqualified by configured sheet tab.

Requirements: FR-049, FR-050. **Proof task:** refuse writes if row identity is unknown; search/reconcile by immutable identity before append; distinguish lookup failure from absence; detect duplicate IDs; honor configured tab and protect against read/write movement races. Use two tabs with unrelated sentinel rows and inject unavailable reads, insert/move/delete/sort, duplicate IDs and lost success replies. Independently compare every unrelated row before/after. Existing R06 moved-row test uses the separate emulated implementation, which does not exercise the fail-open HTTP branch.

## P1-D20-03: COMPLETE still does not mean remote content verified

Initial readback requests only ID/name/size/type/link ([google-publisher.ts:328](/Users/hawzhin/Hawdesign/packages/integrations/src/google-publisher.ts:328)); verification ignores the remote checksum ([347](/Users/hawzhin/Hawdesign/packages/integrations/src/google-publisher.ts:347)). The wrong-checksum probe still reports COMPLETE. Initial publication does not verify parents/shared-drive membership or permissions. The standalone later `verify` can detect checksum mismatches, but the Core publish paths do not use it as a completion gate.

Requirements: FR-046, FR-048. **Proof task:** make completion require actual remote content digest/readback plus allowed parent/destination/access checks. Equal-sized tampered content, wrong parent and forbidden permissions must block completion. A test of a locally supplied wrong hash, as R06 currently includes, does not prove remote verification.

## P1-D20-04: Durable terminal-notification retry is not wired to a working sender

Core enqueues `notify.telegram` and retains it pending on returned HTTP429. Production `apps/worker/src/index.ts:92` constructs `OutboxConsumer` without custom handlers ([index.ts:92](/Users/hawzhin/Hawdesign/apps/worker/src/index.ts:92)); the default `notify.telegram` handler still throws `Telegram notification transport is not registered; no message was sent` ([outbox-consumer.ts:128](/Users/hawzhin/Hawdesign/apps/worker/src/outbox-consumer.ts:128)). Failed inline sends therefore accumulate attempts/dead-letter instead of actually retrying delivery. The new terminal-notification tests assert persistence/pending state, not successful processing by the production worker.

Separately, the worker catches Core failure *before any outbox intent can exist* inside the journaled step ([canva-draft-workflow.ts:111](/Users/hawzhin/Hawdesign/apps/worker/src/canva-draft-workflow.ts:111)); `NOTIFICATION_PROBE.json` reproduces permanent suppression after HTTP503. Core's new handler also deliberately sends unrecorded if enqueue fails ([app.ts:6205](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:6205)). Crash after Telegram acceptance but before markDelivered leaves pending work that may send again; returned uncertainty handling does not close a process-death window.

Requirements: FR-051, FR-060. **Proof task:** register the actual transport, make terminal-intent acceptance durable and retryable independently of design generation, and define crash-window uncertainty explicitly. Test Core unavailable before enqueue, enqueue DB failure, inline 429, worker pickup, crash after Telegram acceptance, malformed receipt and photo failure. Assert eventual sent or explicit uncertain state using the exact production consumer configuration, preserved real message IDs, and no regeneration of paid design work. Do not claim physical exactly-once Telegram delivery.

## P1-D20-05: Export pins still lack enforced revision/QC lineage

Approval obtains selected exports with only tenant/task/artifact identity ([app.ts:6881](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:6881)). `exportsById` still accepts any retrieved export of the task ([canva-connect-service.ts:375](/Users/hawzhin/Hawdesign/apps/core/src/services/canva-connect-service.ts:375)), regardless of current design/binding version, source revision, passing content check or selected QA run. The latest-QA repository improvement is real but cannot prove the pinned export was what that QA run inspected. The route's stale-binding check also accepts task cache/body status rather than fetching an authoritative binding ([app.ts:6861](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:6861)). These are source-confirmed absent checks; a real database exploit/rejection probe was not performed.

Requirements: FR-041, FR-044, FR-045. **Proof task:** persist and validate immutable source-revision→binding/capture→artifact-set→QA-run→approval lineage in one authoritative transaction. Capture A, change to B, QA B, then attempt pinning A or a failed-content-check export under B's approval; refuse both. Repeat after restart and concurrent edit/approval. Require the server's current binding, never a caller-supplied `bound` assertion.

## Architecture verdict for this bounded audit

The chosen durable-workflow/database approach can support a robust office system. The implemented publication and notification boundaries still do not satisfy the promised failure semantics. A numeric 10/10 cannot be justified while current-source counterexamples corrupt another task's row, duplicate paid/external effects or drop the terminal delivery message. Treat the above as release gates with independently replayable fault evidence, not wording to fix in a report. Source fixes and synthetic probes qualify only the audited commit; actual deployment, restore and live provider drills remain separately NOT_RUN here.
