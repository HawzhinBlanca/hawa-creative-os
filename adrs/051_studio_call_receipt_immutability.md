# ADR-051: Seal Studio Call Identity and First Outcome

**Date:** 2026-09-25
**Status:** Accepted for the local R21 Studio call ledger; provider reconciliation remains open.
**Requirements:** FR-059, FR-060, FR-065, FR-079, NFR-001.
**Amends:** ADR-048, ADR-049 and ADR-050.

## Context

The pre-dispatch Studio call row is the evidence that a paid request may have left Core. Its prior database trigger protected a row only when its status was `ok` or `error`. A caller with the application role could change the run, stage, requested model, ordinal or logical digest of a pending call, or replace a finalized `uncertain` outcome. That could defeat the replay hold or erase the identity needed for provider reconciliation. The repository also allowed finalization to target a row with an existing `finished_at` value.

## Decision

The call's identity and `started_at` are immutable from insertion. Every update to a pending row must write its first outcome with `finished_at`; that write seals every field, including an `uncertain` outcome. The repository finalizes only rows whose `finished_at` is null and refuses a missing or already finalized call. A finalization conflict propagates as a model-call hold through the Studio pipeline. This is a database rule so direct application-role writes cannot bypass it. Existing pending calls can receive their first outcome; existing finished calls cannot be rewritten.

An unresolved or disputed receipt must gain a separate, attributed reconciliation record in a future slice. It must not overwrite the original evidence. No raw prompt or answer content is added by this change.

## Consequences and limits

- A finalized unknown outcome remains visibly unknown until a separate review protocol exists.
- A second finalization is an explicit conflict, not a silent zero-row update or receipt replacement.
- The original `uncertain` insert still permits one first finalization after transport. This does not prove whether the provider accepted an unanswered request or make its response replayable.
