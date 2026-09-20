# Publication and notification deep recheck — 20 September 2026

> **Latest-candidate amendment (20 September, 20:51 UTC):** DP3's missing-receipt classification and DP4's invalid JSONB/missing-binding predicates were repaired locally during review. Fresh consumer replay classifies receipt invalid as uncertain with zero scheduled retries; its stub deliberately leases twice, so the two artificial sends are NOT evidence of automatic retry after this fix. Actual constant PostgreSQL expressions accept passing checks and reject failed copy/font/status. Latest workflow 503 propagation also works in manual replay. These files still differ from sampled deployed sources. DP1/DP2/DP5 were independently replayed and remain open. REPORT.md and ROOT_RESULTS.json contain the latest verdict; the original observations below are preserved.

Audited HEAD `6d3c583791a404c914e25b77dda558b16d26bd6c`, plus the existing uncommitted workflow. Only new files in this audit directory were written; existing edits and earlier evidence were preserved. Probes execute current TypeScript through transpilation, replacing external transports/dependencies with synthetic boundaries. No real provider call, credential-file access or database operation was performed by this subaudit. They prove local behavior, not real provider/Restate recovery. No unsupported transport endpoint occurred in the publisher probes.

Reproduce from repository root: `node output/audits/2026-09-20-post-change-deep-audit/durability-probe.mjs` and `node output/audits/2026-09-20-post-change-deep-audit/durability-notification-consumer.mjs`. Exit 0 means the experiment ran; inspect the observed results. Source hashes are in the paired JSON files.

## Genuine fixes

- Full-column Sheet lookup HTTP503 now throws ([google-publisher.ts:581](/Users/hawzhin/Hawdesign/packages/integrations/src/google-publisher.ts:581)); the executed probe gets `drive_complete`, zero rows, and an explicit lookup problem, not COMPLETE. Lost append acknowledgement with healthy lookup gives one file/one row. Earlier claimed full-column fix is now real.
- Wrong reported remote checksum now rejects (`failed`, `verified:false`). Missing checksum remains a different unverified case below.
- Both Core intent persistence catches now refuse the external publish ([app.ts:2616](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:2616), [5500](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:5500)). Previously completed durable rows receive an early return. This narrows replay risk; it does not recover ambiguous/incomplete remote effects.
- Core notification enqueue failure now returns 500 instead of sending unrecorded ([app.ts:6271](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:6271)). The default worker Telegram sender is registered ([outbox-consumer.ts:129](/Users/hawzhin/Hawdesign/apps/worker/src/outbox-consumer.ts:129)).
- Latest dirty workflow throws HTTP503 out of the journaled notification step; synthetic replay calls Core twice and journals only the successful attempt. During audit the user corrected `err.status` to `err.httpStatus`; the final probe uses corrected source hash `af6b8880…`, and HTTP400 returns via its intended branch. The initial transient type error is not a final source defect. Real engine replay and deployment remain separately gated.

## P1-DP1: Still no durable publication effect reconciliation

Requirements FR-047, FR-049, FR-050, FR-060 / NFR-014, NFR-020.

The current adapter still unconditionally uploads ([google-publisher.ts:298](/Users/hawzhin/Hawdesign/packages/integrations/src/google-publisher.ts:298)) and keeps receipts in memory ([439](/Users/hawzhin/Hawdesign/packages/integrations/src/google-publisher.ts:439)). It never queries Drive for the task/artifact/package identifiers it writes. Core reads an intent in a transaction, exits the transaction, then invokes the publisher without durable progress ([app.ts:2603](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:2603), [2639](/Users/hawzhin/Hawdesign/apps/core/src/app.ts:2639)). A complete row avoids upload; pending/partially delivered intent does not. `findByKey` neither claims an execution lease nor locks ([publication.repository.ts:53](/Users/hawzhin/Hawdesign/packages/db/src/repositories/publication.repository.ts:53)). Process-local route fencing does not cover another process or lost acknowledgements.

**Executed:** fresh adapter instances: 2 files/1 row. Upload commits but response disappears: 2 files/1 row and COMPLETE. Concurrent same-adapter calls: 2 files/2 rows, both COMPLETE. This is adapter execution, not a claim that every same-process Core route permits concurrency. The route wrapper does not establish crash safety because no durable progress is supplied.

**Proof gate:** one persisted immutable command and destination/package hash, exclusive execution ownership, per-effect durable identities/reconciliation and reloadable receipt. Kill actual isolated workers before/after every remote effect and ledger commit (including multi-file partial success), restart into new processes, and concurrently invoke both entry routes. Independently enumerate the resulting remote test files and rows: one logical package/row, preserved scope, no invented receipt. A selected-case same-instance test is insufficient.

## P1-DP2: Successful row lookup still permits overwriting another task during movement

Requirements FR-049 / FR-050.

The lookup returns a row number ([google-publisher.ts:519](/Users/hawzhin/Hawdesign/packages/integrations/src/google-publisher.ts:519)); PUT later writes that position ([531](/Users/hawzhin/Hawdesign/packages/integrations/src/google-publisher.ts:531)). The synthetic provider inserts another task's row after the successful lookup response but before PUT. The publisher overwrites that unrelated row, leaves two copies of its task ID and reports COMPLETE. Fail-closed network handling fixed the prior outage corruption but not this read/write race. All ranges still target the first/unqualified tab; configured `sheetId` is not used to resolve a tab.

**Proof gate:** choose a Sheet identity/write protocol that cannot overwrite unrelated rows on concurrent movement, or explicitly restrict/protect movement with enforced ownership. Test inserts, sorts, moves and deletes at every lookup/write interleaving, multiple tabs and duplicate task identities. Assert unrelated sentinel rows are unchanged, not merely that the final task row matches. Unknown identity or duplicate identity must not be interpreted as safe append/update.

## P1-DP3: Worker retries an uncertain Telegram receipt

Requirements FR-051 / FR-060.

The bridge returns `TELEGRAM_RECEIPT_INVALID` after HTTP200 when message identity is untrustworthy ([telegram-bridge.ts:590](/Users/hawzhin/Hawdesign/packages/integrations/src/telegram-bridge.ts:590)). Core correctly classifies it as uncertain, but the new worker sender turns it into a plain Error ([outbox-consumer.ts:145](/Users/hawzhin/Hawdesign/apps/worker/src/outbox-consumer.ts:145)), and the consumer's uncertainty pattern omits this value ([229](/Users/hawzhin/Hawdesign/apps/worker/src/outbox-consumer.ts:229)).

**Executed actual consumer/default handler with dependency doubles:** two deliveries returning this error schedule `retry` twice and make two send attempts. This can repeat a message already accepted by Telegram. The sender also drops the successful `messageId`; both inline and background paths mark delivered without preserving the provider receipt. Process death after acceptance but before ledger commit remains an ambiguity not solved by returned-error classification.

**Proof gate:** share typed delivery outcomes across inline/background paths; persist provider receipts and route invalid/lost acknowledgements into explicit uncertain/manual recovery. Test exact production consumer wiring for 429, rejected request, malformed success receipt, timeout and kill-after-send. No automatic resend after uncertainty, no paid design regeneration, and eventual delivery or visible actionable uncertainty. Do not claim physical exactly-once Telegram delivery.

## P1-DP4: New export safety query is invalid for its actual JSONB schema

Requirements FR-041 / FR-044 / FR-045.

`exportsById` now filters current binding/version when binding lookup succeeds, which is an improvement. But its predicate is `(b.content_check IS NULL OR b.content_check != 'failed')` ([canva-connect-service.ts:385](/Users/hawzhin/Hawdesign/apps/core/src/services/canva-connect-service.ts:385)). The column is `jsonb` ([008_canva_roundtrip_checks.sql:4](/Users/hawzhin/Hawdesign/packages/db/migrations/008_canva_roundtrip_checks.sql:4)), and persisted checks are JSON objects ([canva-connect-service.ts:355](/Users/hawzhin/Hawdesign/apps/core/src/services/canva-connect-service.ts:355)). Bare `'failed'` is not valid JSON, so the production query fails before evaluating row/null conditions; it also does not express the object's actual pass/failure fields. Root independently executed read-only `SELECT '{}'::jsonb != 'failed';` against isolated test PostgreSQL: exit 1, invalid input syntax for JSON, token `failed` invalid. This is schema-backed and SQL-executed, not a live approval endpoint test.

Further source gap: binding lookup errors are swallowed ([375](/Users/hawzhin/Hawdesign/apps/core/src/services/canva-connect-service.ts:375)), and absent binding skips design/version checks ([387](/Users/hawzhin/Hawdesign/apps/core/src/services/canva-connect-service.ts:387)). The export lookup and later approval transaction are separate; no evidence yet establishes atomic export/QA/revision lineage under concurrent edit.

**Proof gate:** exercise actual PostgreSQL export query for absent/passing/failing content checks and current/stale/missing bindings; no catch-and-broaden behavior. Then capture A, edit to B, QA B, pin A under B approval: reject before approval commit. Repeat concurrent edit/approve and fresh-process paths with immutable artifacts, binding version and QA lineage in the same authoritative acceptance boundary.

## P2-DP5: Verification and idempotency claims remain broader than checks

The remote checksum check explicitly accepts an absent checksum ([google-publisher.ts:354](/Users/hawzhin/Hawdesign/packages/integrations/src/google-publisher.ts:354)); executed missing-checksum response marks file verified and COMPLETE. The adapter checks no remote parent/shared-drive/permission digest. Complete receipt replay compares package/client/task but not destination ([123](/Users/hawzhin/Hawdesign/packages/integrations/src/google-publisher.ts:123)); executed same-key/different-folder request succeeds with the original folder rather than a conflict. The durable repository likewise returns existing key without payload/hash comparison ([publication.repository.ts:97](/Users/hawzhin/Hawdesign/packages/db/src/repositories/publication.repository.ts:97)).

**Proof gate:** require provider checksum or downloaded-byte hash plus destination/access verification. Bind all immutable command inputs into an accepted hash; changed folder, spreadsheet/tab, file manifest, scope or approval must conflict or use a newly authorized command. Missing data must mean unverified, not verified.

## Conclusion

There are genuine repairs, not a wholesale lack of progress. Current counterexamples still disprove robust publication and notification guarantees. The selected architecture remains viable; completion must be judged by independent failure-matrix evidence, not test totals or a 10/10 label. This bounded review did not run real Restate, provider fault tests, full DB approval flow, live concurrency or recovery drills.
