# Hawa Creative OS — Operational Incident & Recovery Runbook

**Document ID:** HAW-OPS-RB-2026-01  
**Scope:** Canva API Outages, Channel Disconnects, Credential Expirations, Database Failover, and Delivery Drift  
**Governing Requirements:** FR-059..FR-074, NFR-001, NFR-002, NFR-003, NFR-006, NFR-007, NFR-011, NFR-013, NFR-017, NFR-020, NFR-024

---

## 1. Real-Time Observability & Honest Health Probes

Hawa enforces **honest readiness & liveness probes** with strictly zero hardcoded healthy states:

- **Endpoint:** `GET /v1/health` (and `GET /health`)
- **Key Fields in Response:**
  - `status`: `"healthy"` | `"degraded"` | `"unhealthy"` (returns HTTP 503 if unhealthy)
  - `dependencies.postgres`: `"connected"` | `"disconnected"`
  - `dependencies.canva`: `"connected"` | `"degraded"` | `"outage"`
  - `dependencies.canvaCircuitBreaker`: `"CLOSED"` | `"OPEN"` | `"HALF_OPEN"`
  - `dependencies.telegram`: `"active"` | `"kill_switch_active"` | `"unconfigured"`
  - `dependencies.waha`: `"active"` | `"kill_switch_active"` | `"unconfigured"`
  - `dependencies.disk`: `"writable"` | `"read_only"`
  - `lastVerifiedProgressAt`: ISO timestamp of recent verified progress

---

## 2. Incident Scenario Playbooks

### Playbook A: Canva Cloud Provider Outage (HTTP 500/503/504)

**Symptoms:**
- `/v1/health` reports `canva: "outage"` and `canvaCircuitBreaker: "OPEN"`.
- Canva editing tasks report `CANVA_CIRCUIT_OPEN` or timeout.

**Automated Protection:**
- The `CircuitBreaker` trips to `OPEN` after 3 consecutive errors.
- Dependent Canva actions stop cleanly to prevent corrupted partial state.
- Inbound request intake (Telegram, WhatsApp) and viewing stored design captures remain **100% operational**.

**Operator Recovery Actions:**
1. Check Canva Status page (`status.canva.com`).
2. Operators may switch in-flight tasks to manual handoff URLs if urgent.
3. Once Canva recovers, the circuit breaker executes a half-open canary probe.
4. To force an immediate circuit reset after upstream fix:
   ```bash
   curl -X POST https://api.hawdesign.local/v1/operations/canva/simulate-recovery \
     -H "Authorization: Bearer $OPERATOR_TOKEN"
   ```

---

### Playbook B: Channel Flooding or Compromise (Kill Switch)

**Symptoms:**
- Spammed inbound Telegram or WAHA events; rogue messages or replay attacks.

**Immediate Mitigation:**
1. Activate the channel kill switch:
   ```bash
   # Kill Telegram ingestion
   curl -X POST https://api.hawdesign.local/v1/operations/kill-switch \
     -H "Authorization: Bearer $OPERATOR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"channel": "telegram", "active": true}'

   # Kill WhatsApp (WAHA) ingestion
   curl -X POST https://api.hawdesign.local/v1/operations/kill-switch \
     -H "Authorization: Bearer $OPERATOR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"channel": "waha", "active": true}'
   ```
2. Verify `/v1/health` reflects `telegram: "kill_switch_active"`.
3. Clear malicious messages from Telegram webhook queue or rotate bot token.
4. Disengage kill switch once threat is neutralized (`"active": false`).

---

### Playbook C: Expired OAuth Credentials or Revoked Design Access

**Symptoms:**
- Error code: `CANVA_AUTH_EXPIRED` or `DESIGN_ACCESS_REVOKED`.
- Task transitions to state `BLOCKED_NEEDS_OPERATOR`.

**Recovery Procedure:**
1. Do NOT delete or restart the task. All task history, briefs, and client DNA are safely preserved.
2. In the Hawa Desk, navigate to **Settings > Integrations > Canva**.
3. Click **Renew OAuth Lease** to trigger operator SSO re-authorization.
4. For design-level permission revocation, have the client workspace admin grant `Editor` role to the Hawa Canva Enterprise Team bot account.
5. Once permissions are restored, click **Resume Task** in Hawa Desk.

---

### Playbook D: Sudden Worker Process Crash & Host Failover

**SLA Targets:**
- **RPO (Recovery Point Objective):** <= 0.0 seconds (zero loss of acknowledged tasks).
- **RTO (Recovery Time Objective):** <= 5.0 seconds.

**Architecture Guarantees:**
- Tasks and revisions are written to PostgreSQL before acknowledging HTTP clients.
- On process crash or container restart, state is re-hydrated from PostgreSQL and local WAL.
- In-memory maps reload in under 400ms without stuck locks.

**Verification Steps:**
```bash
# Check production tasks and outbox counts
docker exec hawa-production-postgres-1 psql -U hawa_owner -d hawa \
  -c "SELECT state, count(*) FROM hawa.tasks GROUP BY state;"
```

---

### Playbook E: Google Workspace Delivery Drift (Drive / Sheets)

**Symptoms:**
- Task marked `COMPLETE` or `DELIVERED` in PostgreSQL, but file is missing in Google Shared Drive, or Sheet row status is out of sync.

**Automated Remediation:**
1. Trigger reconciliation audit:
   ```bash
   curl -X POST https://api.hawdesign.local/v1/operations/reconciliation/run \
     -H "Authorization: Bearer $OPERATOR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"autoRepair": true}'
   ```
2. The service idempotently re-uploads missing deliverables using their immutable package hash and updates the Google Sheet row.
