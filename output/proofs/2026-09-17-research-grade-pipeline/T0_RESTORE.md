# T0 — Production Database Restoration Evidence

**Date & Time**: 2026-09-17 18:56 UTC  
**Snapshot Source**: `infra/backup/snapshots/hawa_20260917T140847Z.sql`  
**Snapshot Timestamp**: `2026-09-17T14:08:47Z`  
**Database Wipe Timestamp**: `2026-09-17T15:28:05Z`  
**Data Loss Window**: **79 minutes and 18 seconds** (at most between 14:08:47Z and 15:28:05Z)

---

## 1. Pre-Restore State (Empty Database)

Before restoration, containers were paused to prevent any concurrent writes, and table counts were queried on `hawa`:

```sql
SELECT 'tasks' as tbl, count(*) from hawa.tasks
UNION ALL SELECT 'canva_bindings', count(*) from hawa.canva_bindings
UNION ALL SELECT 'canva_design_plans', count(*) from hawa.canva_design_plans
UNION ALL SELECT 'inbox_events', count(*) from hawa.inbox_events
UNION ALL SELECT 'outbox_commands', count(*) from hawa.outbox_commands;
```

**Pre-Restore Output**:
```text
        tbl         | count 
--------------------+-------
 tasks              |     0
 canva_bindings     |     0
 canva_design_plans |     0
 inbox_events       |     0
 outbox_commands    |     0
```

---

## 2. Restoration Execution

1. **Traffic Paused**:
   ```bash
   docker pause hawa-production-core-1 hawa-production-worker-1
   ```
2. **Schema Reset & Clean Ingestion**:
   ```bash
   docker exec hawa-production-postgres-1 psql -U hawa_owner -d hawa -c "DROP SCHEMA IF EXISTS hawa CASCADE;"
   docker exec -i hawa-production-postgres-1 psql -U hawa_owner -d hawa < infra/backup/snapshots/hawa_20260917T140847Z.sql
   ```
3. **Migration Verification**:
   ```bash
   DATABASE_URL="postgresql://hawa_owner:...@127.0.0.1:54332/hawa" npx tsx packages/db/src/upgrade.ts
   # Output: {"applied":[],"verified":["001_canva_bindings.sql" ... "013_design_studio.sql"]}
   ```
4. **Permissions Re-asserted**:
   ```sql
   GRANT USAGE ON SCHEMA hawa TO hawa_app;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA hawa TO hawa_app;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA hawa TO hawa_app;
   ```
5. **Traffic Resumed**:
   ```bash
   docker unpause hawa-production-core-1 hawa-production-worker-1
   ```

---

## 3. Post-Restore State (Counts Verified)

```sql
SELECT 'tasks' as tbl, count(*) from hawa.tasks
UNION ALL SELECT 'canva_bindings', count(*) from hawa.canva_bindings
UNION ALL SELECT 'canva_design_plans', count(*) from hawa.canva_design_plans
UNION ALL SELECT 'inbox_events', count(*) from hawa.inbox_events
UNION ALL SELECT 'outbox_commands', count(*) from hawa.outbox_commands
UNION ALL SELECT 'design_revisions', count(*) from hawa.design_revisions;
```

**Post-Restore Output**:
```text
        tbl         | count 
--------------------+-------
 tasks              |  1557
 canva_bindings     |    47
 canva_design_plans |    77
 inbox_events       |    98
 outbox_commands    |  1550
 design_revisions   |   192
```

---

## 4. Acceptance Verifications

### 4.1. Task `8c32c048-1423-4c69-8651-b64f547ab830` Resolves via API

`curl -s -H "Authorization: Bearer hawa_op_..." http://127.0.0.1:8080/v1/tasks/8c32c048-1423-4c69-8651-b64f547ab830`

**Response (HTTP 200 OK)**:
```json
{
  "id": "8c32c048-1423-4c69-8651-b64f547ab830",
  "tenantId": "00000000-0000-4000-a000-000000000001",
  "clientId": "c1000000-0000-4000-8000-000000000002",
  "status": "RECEIVED",
  "state": "received",
  "priority": 3,
  "title": "KAAE: KAAE Quality Assurance Framework 2026: Annual…",
  "description": "KAAE Quality Assurance Framework 2026: Annual Institutional Accreditation Standards and Criteria",
  "headlineEn": "KAAE Quality Assurance Framework 2026: Annual Institutional Accreditation Standards and Criteria",
  "createdAt": "2026-09-14T20:36:40.701Z",
  "updatedAt": "2026-09-14T20:36:40.701Z"
}
```

Canva Edit URL resolution (`/v1/tasks/8c32c048-1423-4c69-8651-b64f547ab830/editor-url`):
```json
{
  "taskId": "8c32c048-1423-4c69-8651-b64f547ab830",
  "mode": "review",
  "url": "https://www.canva.com/design/DAHVNIbAb-Y/edit",
  "expiresAt": "2026-09-17T16:01:19.265Z",
  "verification": "handoff_only"
}
```

### 4.2. Sewa's Re-driven Task & Canva Design Recovered

- **Task ID**: `9fc00562-f631-4953-a1f8-e5eb0b90dc0c`
- **Requester / Chat**: Sewa (`450405554`)
- **Canva Design ID**: `DAHVdVy1ENg`
- **Canva Edit URL**: `https://www.canva.com/design/DAHVdVy1ENg/edit`
- **Design Plan**: `22399f5c-4a23-43f7-92f6-115f8a2731f1` (Status: `planned`, created `2026-09-17 13:14:02 UTC`)

Live editor URL resolution (`/v1/tasks/9fc00562-f631-4953-a1f8-e5eb0b90dc0c/editor-url`):
```json
{
  "taskId": "9fc00562-f631-4953-a1f8-e5eb0b90dc0c",
  "mode": "review",
  "url": "https://www.canva.com/design/DAHVdVy1ENg/edit",
  "expiresAt": "2026-09-17T16:01:15.973Z",
  "verification": "handoff_only"
}
```

### 4.3. `hawa.canva_design_plans` Queryable

77 distinct records queryable in `hawa.canva_design_plans`. Lead operator queries succeed.
