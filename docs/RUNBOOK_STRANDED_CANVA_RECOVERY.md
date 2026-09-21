# Runbook: Recovering Stranded Canva Operations & Incident Triage

## Purpose
This runbook provides on-call engineers and operators with the exact procedures to detect, triage, and recover stranded Canva design creation and export operations in Hawa Creative OS (remediating Technical Debt Items 3 and 9).

---

## 1. Symptoms & Detection
A task is considered "stranded" if:
1. The Canva import step is initiated, but subsequent attempts fail with:
   ```
   409 CANVA_CREATE_CONFLICT: Canva operation already in progress
   ```
2. The task status remains in `creating` or `design_rejected` with no corresponding row in `hawa.canva_bindings`.
3. In PostgreSQL:
   ```sql
   SELECT id, task_id, kind, status, remote_job_id, created_at
   FROM hawa.canva_remote_operations
   WHERE status IN ('submitted', 'creating', 'uncertain')
     AND created_at < NOW() - INTERVAL '10 minutes';
   ```

---

## 2. Automated Sweeper Execution
The background sweeper automatically identifies and resolves operations that have stalled:
- **Dry-Run Inspection (no modifications):**
  ```bash
  pnpm tsx scripts/recover_stranded_canva_jobs.ts --dry-run
  ```
- **Live Recovery:**
  ```bash
  pnpm tsx scripts/recover_stranded_canva_jobs.ts
  ```

---

## 3. Triage & Decision Flowchart
```
[Non-Terminal Operation Found]
         │
         ├── Has valid Canva remote_job_id?
         │         │
         │         ├── YES: Query Canva Job Status (GET /v1/imports/{jobId} or /v1/exports/{jobId})
         │         │         ├── Job SUCCESS: Bind design_id, mark operation 'success', transition task.
         │         │         ├── Job FAILED: Record error reason, mark operation 'failed', clear lock.
         │         │         └── Job EXPIRED / NOT FOUND: Mark operation 'failed', allow task redrive.
         │         │
         │         └── NO: Operation abandoned before remote submission.
         │                   Mark operation 'failed', clear conflict lock.
```

---

## 4. Manual Intervention (PostgreSQL)
If an individual task must be immediately unlocked for an emergency re-run:
```sql
-- View active operation lock
SELECT id, task_id, status, kind, remote_job_id
FROM hawa.canva_remote_operations
WHERE task_id = '<TASK_UUID>';

-- Transition stuck operation to failed to allow retry
UPDATE hawa.canva_remote_operations
SET status = 'failed',
    error_message = 'Manually cleared per runbook incident triage',
    updated_at = NOW()
WHERE task_id = '<TASK_UUID>'
  AND status IN ('submitted', 'creating', 'uncertain');
```

---

## 5. Verification
After running the recovery procedure:
1. Verify no lingering stranded operations:
   ```bash
   pnpm tsx scripts/recover_stranded_canva_jobs.ts --dry-run
   # Expected output: Found 0 stranded Canva operation(s) across tenant.
   ```
2. Re-trigger the task dispatch from Desk or CLI:
   ```bash
   curl -X POST http://127.0.0.1:8080/v1/tasks/<TASK_UUID>/actions \
     -H "Authorization: Bearer $HAWA_REVIEWER_KEY" \
     -H "Content-Type: application/json" \
     -d '{"action": "retry"}'
   ```
