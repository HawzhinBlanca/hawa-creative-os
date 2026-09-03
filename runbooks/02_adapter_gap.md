# Runbook: Messaging Adapter Gap or Outage

1. Mark adapter degraded/unavailable; do not mark canonical tasks failed.
2. Capture last successful source cursor/update ID and last event timestamp.
3. Verify credentials/session/webhook route and source platform status.
4. Continue office work through Hawa Desk; use Telegram if WAHA is down.
5. Run adapter reconciliation from a safe overlap window.
6. Import events through normal uniqueness constraints.
7. Review detected edits/deletions and ambiguous promotions.
8. Confirm no duplicate logical tasks.
9. Restore notifications separately.

For WAHA reauthentication, use the dedicated office account only. Never substitute a personal account during an incident.
