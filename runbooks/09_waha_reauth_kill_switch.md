# Runbook: WAHA Reauthentication or Kill Switch

- Set WAHA integration to disabled/degraded in Hawa Desk.
- Stop outbound messages first; retain canonical tasks.
- Revoke the session when compromise/account anomaly is suspected.
- Reauthenticate only the dedicated office account on the isolated adapter host.
- Verify allowlisted groups, message cursor, and no unexpected sessions/devices.
- Run overlapping reconciliation; uniqueness constraints absorb duplicates.
- Re-enable read-only ingestion, observe, then notifications.

If WhatsApp behavior or account risk changes, leave WAHA disabled indefinitely; Hawa Desk and Telegram remain the supported path.
