# CV-22: Cut Over Through a Reversible Release

## Task Information
- **ID:** `CV-22`
- **Title:** Cut over through a reversible release
- **Requirements:** FR-060, FR-070, FR-074, FR-075, NFR-003, NFR-013, NFR-020
- **Depends on:** CV-07, CV-08, CV-16, CV-17, CV-19, CV-20, CV-21
- **Status:** `VERIFIED`
- **Release Version:** `v2.0.0-canva-cutover`
- **Rollback Target:** `v1.4.0-legacy-archive`

## Acceptance Summary
- **Sole Active Studio:** Canva Native Studio is established as the sole active design studio for admitted scope via `CanvaDesignStudioAdapter` (`DESIGN_STUDIO_ADAPTER=canva`).
- **Data Integrity:** PostgreSQL database `hawa` verified with zero test pollution (exactly 1,449 tasks, 1,449 outbox commands).
- **Rollback Rehearsal:** Tested and proven zero data loss, zero duplicate deliveries, and zero lossy back-translations.
- **Blueprint Validation:** `python3 scripts/validate_pack.py` passed with 0 warnings and 0 failures.

## Evidence Files
1. [CUTOVER.md](./CUTOVER.md) — Comprehensive cutover release document.
2. [CUTOVER_STATE_RECORD.json](./CUTOVER_STATE_RECORD.json) — Live state record of cutover configuration and admitted scope.
3. [ROLLBACK_REHEARSAL_TRACE.json](./ROLLBACK_REHEARSAL_TRACE.json) — Executed rollback rehearsal trace.
4. [HEALTH_READBACK_PROOFS.json](./HEALTH_READBACK_PROOFS.json) — Live dependency health proofs and circuit breaker telemetry.
5. [ADR 021](../../../../adrs/021_canva_production_cutover_and_retirement.md) — Architectural decision record for cutover.
