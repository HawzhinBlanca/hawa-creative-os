# R09 — delivery truth and reconciliation evidence

**Date:** 2026-09-25. **Status:** in progress. **Source:** `4ac0a4d`. **Decision:** ADR-043.

## First pass — require requester-send proof

The legacy Restate Delivery report previously moved a task to `complete` whenever Drive and Sheets reported success, even if the Telegram file or notice was refused or uncertain. The worker could also call an archive-only result `delivered` when it had no requester chat or no approved files. The publication-state endpoint could then say complete based on Drive and Sheets even though the requester's send was unresolved.

The worker now reports failure for missing requester chat or approved files. Core completes a workflow publication only when the outcome is `delivered`, no send is uncertain, and the confirmed file count equals the publication manifest's count. An archived package with an unresolved requester send stays `publishing` and records `REQUESTER_SEND_UNCONFIRMED` on the publication. The publication-state endpoint names the reconciliation need. A repeated prepare can adopt the same verified Drive receipt; a file ID with changed hash, size or destination is refused.

The focused Delivery and Core integration tests passed **2 files / 23 tests**. They exercise confirmed sends, uncertain and refused Telegram files, archived and Sheet-confirmed failure, replay of preparation, a conflicting Drive receipt, and absent requester chat/files. The source suite excluding only the unsealed release gate passed **419 files / 3,130 tests**, with **4 files / 48 tests skipped**. TypeScript including tests and lint passed; blueprint validation reported **753 pass / 0 warning / 0 failure**. The exact-tree release manifest is verified after this evidence checkpoint.

## Limits and next proof

This hardens the existing legacy workflow and prepares the request-owned path; it does **not** connect ADR-043's `deliver` decision to RequestLifecycle. A request-owned approved task still cannot be delivered through the Desk. The integration uses a simulated Restate ingress, synthetic exports, emulated Drive/Sheets and Telegram, and isolated PostgreSQL. A real provider read-back, uncertain-send operator resolution, process-kill replay, clean-host restore and end-to-end request-owned delivery remain open. No publication flag or production deployment was changed.
