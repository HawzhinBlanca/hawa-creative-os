# R08 — Chat decision acknowledgement containment

**Date:** 2026-09-25. **Status:** in progress. This is a false-acknowledgement repair, not the lifecycle decision implementation.

The public `POST /tasks/:taskId/chat-approval-action` route checked whether an interactive button named the current revision and whether the actor role was allowed, then answered HTTP 200 with `accepted: true`. It did not insert an approval in PostgreSQL or signal a durable review workflow. When a task had no revision, the route substituted the fictional `rev-1`; an action naming `rev-1` therefore received 200. Neither response represented a real decision.

Two isolated-PostgreSQL negative controls reproduced HTTP 200 before the changes: one for a revisionless task and `rev-1`, the other for a valid revision and a button that was only validated. The route now refuses missing current revisions with 412, invalid button revision IDs with 422, and stale buttons with its existing 409. A valid button receives 501 with an explicit statement that no approval was recorded and directs the operator to the durable Desk decision endpoint. The test checks that the task still has no approval. This closes false success at the public boundary while the route is not connected to the database decision transaction.

The focused approval integration file passed **13 tests**. The fixed-tree full suite passed **406 files / 3,040 tests**, with 4 files / 48 tests skipped. TypeScript checks passed and blueprint validation reported **725 pass / 0 warning / 0 failure**. The release manifest will be resealed at this source checkpoint; no production flags or live workflows were changed.

R08 remains **in progress**. A chat decision still cannot be recorded through this endpoint. The complete slice must route Desk and chat decisions through one expected-revision, server-authorized PostgreSQL/RequestLifecycle transaction with append-only reason, restart replay and duplicate-action tests. The existing normal Desk decision endpoint remains the available approval route. No deployment or live decision was tested.
