# ADR-048: Unknown Model Acceptance Blocks Automatic Replay

**Date:** 2026-09-25
**Status:** Accepted for the local R21 Studio call boundary; provider reconciliation and deployment proof remain open.
**Requirements:** FR-059, FR-060, FR-079, NFR-001.
**Amends:** The retry interpretation in the Studio OpenAI client and its financial call ledger.

## Context

The Studio client retried a request when `fetch` rejected before returning response headers. A reset, timeout, or gateway failure does not establish that the provider did not accept or bill the request. The old path could make three paid calls for one logical question while its ledger represented them as one call, then classify the final failure as a zero-dollar error. A worker killed after ledger insertion could resume the stage and send another call while its original outcome remained unknown.

## Decision

The Studio OpenAI text and image client makes no automatic second request after a fetch rejection or HTTP 5xx. The generated-art adapter applies the same rule to OpenAI and Google image requests. Those cases, and timeouts or unreadable image responses, are `uncertain`: they do not imply zero provider spend. An explicit 429 remains a bounded retry only while it is a definite rate-limit rejection and not exhausted quota.

Core writes an `uncertain` call outcome to the existing pre-dispatch ledger. An unfinalized pre-dispatch row has the same meaning after a crash. An active Studio run with any uncertain call cannot resume its next paid stage; an operator must reconcile the provider outcome and record a separate reviewed action before a fresh run. The evidence API returns a null total cost and null cost for each uncertain call, alongside the known subtotal and uncertain count. The database's numeric zero is only a storage placeholder for that unresolved amount.

An active run also refuses to repeat its current stage when its ledger already contains a completed call from that stage and no stage transition was saved. This covers a worker death after a recorded reply but before the stage result commit. Generated art is associated with the `laying_out` stage for this check. A completed call from an earlier stage does not block the current stage.

The handler that classifies provider failures encloses only the provider request. A successful paid reply is finalized before the run's budget write; failure of that later accounting write must not reclassify the ledger row as a free provider error. If finalization itself fails, the pre-dispatch row remains unresolved and resume stays held. This favors truthful cost and a manual hold over automatic replay.

## Consequences and limits

- A dropped transport can reduce automatic availability. It cannot silently cause a second Studio OpenAI charge.
- This slice does not provide provider-side status lookup or an automatic reconciliation action. It deliberately leaves the run needing operator review.
- The ledger does not yet retain a stable logical-call hash or the response body needed for automatic stage replay. A current-stage call is held for operator review rather than reconstructed.
- Other direct model adapters and evaluation scripts still need this boundary. This ADR does not make R21 accepted or establish the clean-host kill-after-send drill.
