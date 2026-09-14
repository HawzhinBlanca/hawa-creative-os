# Task T09 Proof: Migration 013 & Repositories

## Summary
Migration 013 (`packages/db/migrations/013_design_studio.sql`) creates the 5 core persistence tables for Design Studio v2:
1. `hawa.design_studio_runs`: Studio pipeline execution lifecycle, immutable core attributes, forced RLS.
2. `hawa.design_studio_candidates`: Multi-concept candidate state, layout array, visual metrics, preview & art bytea with SHA-256 validation checks.
3. `hawa.design_studio_judgments`: Critiques, pairwise tournament judgments, canaries, and parity checks.
4. `hawa.design_studio_calls`: Financial accounting ledger with start-uncertain journal pattern and append-only immutability.
5. `hawa.design_feedback`: Reviewer ratings, approvals, and operator corrections.

Applied and verified against both `hawa` (production) and `hawa_repair` (disposable test database).
Registered in `hawa.schema_upgrades` with sha256 checksum: `c8db4875e8d0e01e57ef6a3d161bcb9c275294f2b7f2be962961ed2ef1868b76`.

---

## 1. PostgreSQL Table Schemas (`\d` from `hawa_repair`)

### 1.1 `hawa.design_studio_runs`
```text
                                                         Table "hawa.design_studio_runs"
       Column        |           Type           | Collation | Nullable |                                 Default                                 
---------------------+--------------------------+-----------+----------+-------------------------------------------------------------------------
 id                  | uuid                     |           | not null | 
 tenant_id           | uuid                     |           | not null | 
 task_id             | uuid                     |           | not null | 
 client_id           | uuid                     |           | not null | 
 actor_id            | text                     |           | not null | 
 request_key         | text                     |           | not null | 
 request_hash        | text                     |           | not null | 
 request             | jsonb                    |           | not null | 
 tier                | text                     |           | not null | 
 status              | text                     |           | not null | 
 judge_status        | text                     |           |          | 
 budget              | jsonb                    |           | not null | '{"calls": 0, "maxUsd": 6.00, "maxCalls": 40, "spentUsd": 0.00}'::jsonb
 stages              | jsonb                    |           | not null | '[]'::jsonb
 winner_candidate_id | uuid                     |           |          | 
 plan_id             | uuid                     |           |          | 
 diagnostic          | text                     |           |          | 
 created_at          | timestamp with time zone |           | not null | now()
 updated_at          | timestamp with time zone |           | not null | now()
Indexes:
    "design_studio_runs_pkey" PRIMARY KEY, btree (id)
    "design_studio_one_active_run" UNIQUE, btree (tenant_id, task_id) WHERE status <> ALL (ARRAY['transferred'::text, 'degraded'::text, 'failed'::text, 'abandoned'::text])
    "design_studio_runs_tenant_id_task_id_request_key_key" UNIQUE CONSTRAINT, btree (tenant_id, task_id, request_key)
Check constraints:
    "design_studio_runs_judge_status_check" CHECK (judge_status IS NULL OR (judge_status = ANY (ARRAY['PENDING'::text, 'RELIABLE'::text, 'UNRELIABLE'::text, 'SKIPPED'::text])))
    "design_studio_runs_status_check" CHECK (status = ANY (ARRAY['briefing'::text, 'conceiving'::text, 'laying_out'::text, 'rendering'::text, 'critiquing'::text, 'revising'::text, 'judging'::text, 'qa'::text, 'awaiting_selection'::text, 'transferring'::text, 'transferred'::text, 'degraded'::text, 'failed'::text, 'abandoned'::text]))
    "design_studio_runs_tier_check" CHECK (tier = ANY (ARRAY['standard'::text, 'premium'::text]))
Foreign-key constraints:
    "design_studio_runs_plan_id_fkey" FOREIGN KEY (plan_id) REFERENCES hawa.canva_design_plans(id)
    "design_studio_runs_tenant_id_task_id_client_id_fkey" FOREIGN KEY (tenant_id, task_id, client_id) REFERENCES hawa.tasks(tenant_id, id, client_id)
Referenced by:
    TABLE "hawa.design_feedback" CONSTRAINT "design_feedback_run_id_fkey" FOREIGN KEY (run_id) REFERENCES hawa.design_studio_runs(id)
    TABLE "hawa.design_studio_calls" CONSTRAINT "design_studio_calls_run_id_fkey" FOREIGN KEY (run_id) REFERENCES hawa.design_studio_runs(id) ON DELETE CASCADE
    TABLE "hawa.design_studio_candidates" CONSTRAINT "design_studio_candidates_run_id_fkey" FOREIGN KEY (run_id) REFERENCES hawa.design_studio_runs(id) ON DELETE CASCADE
    TABLE "hawa.design_studio_judgments" CONSTRAINT "design_studio_judgments_run_id_fkey" FOREIGN KEY (run_id) REFERENCES hawa.design_studio_runs(id) ON DELETE CASCADE
Policies (forced row security enabled):
    POLICY "design_studio_runs_tenant_scope"
      USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid))
      WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid))
Triggers:
    immutable_design_studio_run BEFORE DELETE OR UPDATE ON hawa.design_studio_runs FOR EACH ROW EXECUTE FUNCTION hawa.protect_design_studio_run()
```

### 1.2 `hawa.design_studio_candidates`
```text
                                                Table "hawa.design_studio_candidates"
     Column     |           Type           | Collation | Nullable |                                  Default                                  
----------------+--------------------------+-----------+----------+---------------------------------------------------------------------------
 id             | uuid                     |           | not null | 
 run_id         | uuid                     |           | not null | 
 tenant_id      | uuid                     |           | not null | 
 ordinal        | integer                  |           | not null | 
 concept        | jsonb                    |           | not null | 
 layouts        | jsonb[]                  |           | not null | '{}'::jsonb[]
 metrics        | jsonb                    |           |          | 
 critiques      | jsonb[]                  |           | not null | '{}'::jsonb[]
 score          | numeric                  |           |          | 
 rank           | integer                  |           |          | 
 status         | text                     |           | not null | 
 preview_png    | bytea                    |           |          | 
 preview_sha256 | text                     |           |          | 
 composite_png  | bytea                    |           |          | 
 art_png        | bytea                    |           |          | 
 art_sha256     | text                     |           |          | 
 art_provenance | jsonb                    |           |          | 
 created_at     | timestamp with time zone |           | not null | now()
 updated_at     | timestamp with time zone |           | not null | now()
Indexes:
    "design_studio_candidates_pkey" PRIMARY KEY, btree (id)
    "design_studio_candidates_run_id_ordinal_key" UNIQUE CONSTRAINT, btree (run_id, ordinal)
Check constraints:
    "design_studio_candidates_check" CHECK (preview_png IS NULL OR preview_sha256 = encode(digest(preview_png, 'sha256'::text), 'hex'::text))
    "design_studio_candidates_check1" CHECK (art_png IS NULL OR art_sha256 = encode(digest(art_png, 'sha256'::text), 'hex'::text))
    "design_studio_candidates_status_check" CHECK (status = ANY (ARRAY['draft'::text, 'active'::text, 'eliminated'::text, 'winner'::text, 'runner_up'::text]))
Foreign-key constraints:
    "design_studio_candidates_run_id_fkey" FOREIGN KEY (run_id) REFERENCES hawa.design_studio_runs(id) ON DELETE CASCADE
Referenced by:
    TABLE "hawa.design_feedback" CONSTRAINT "design_feedback_candidate_id_fkey" FOREIGN KEY (candidate_id) REFERENCES hawa.design_studio_candidates(id)
    TABLE "hawa.design_studio_judgments" CONSTRAINT "design_studio_judgments_candidate_a_fkey" FOREIGN KEY (candidate_a) REFERENCES hawa.design_studio_candidates(id)
    TABLE "hawa.design_studio_judgments" CONSTRAINT "design_studio_judgments_candidate_b_fkey" FOREIGN KEY (candidate_b) REFERENCES hawa.design_studio_candidates(id)
Policies (forced row security enabled):
    POLICY "design_studio_candidates_tenant_scope"
      USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid))
      WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid))
```

### 1.3 `hawa.design_studio_judgments`
```text
                   Table "hawa.design_studio_judgments"
    Column     |           Type           | Collation | Nullable | Default 
---------------+--------------------------+-----------+----------+---------
 id            | uuid                     |           | not null | 
 run_id        | uuid                     |           | not null | 
 tenant_id     | uuid                     |           | not null | 
 kind          | text                     |           | not null | 
 candidate_a   | uuid                     |           |          | 
 candidate_b   | uuid                     |           |          | 
 order_swapped | boolean                  |           | not null | false
 verdict       | jsonb                    |           | not null | 
 call_id       | uuid                     |           |          | 
 created_at    | timestamp with time zone |           | not null | now()
Indexes:
    "design_studio_judgments_pkey" PRIMARY KEY, btree (id)
Check constraints:
    "design_studio_judgments_kind_check" CHECK (kind = ANY (ARRAY['critique'::text, 'pairwise'::text, 'canary'::text, 'parity'::text, 'art_check'::text]))
Foreign-key constraints:
    "design_studio_judgments_candidate_a_fkey" FOREIGN KEY (candidate_a) REFERENCES hawa.design_studio_candidates(id)
    "design_studio_judgments_candidate_b_fkey" FOREIGN KEY (candidate_b) REFERENCES hawa.design_studio_candidates(id)
    "design_studio_judgments_run_id_fkey" FOREIGN KEY (run_id) REFERENCES hawa.design_studio_runs(id) ON DELETE CASCADE
Policies (forced row security enabled):
    POLICY "design_studio_judgments_tenant_scope"
      USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid))
      WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid))
```

### 1.4 `hawa.design_studio_calls`
```text
                        Table "hawa.design_studio_calls"
       Column        |           Type           | Collation | Nullable | Default 
---------------------+--------------------------+-----------+----------+---------
 id                  | uuid                     |           | not null | 
 run_id              | uuid                     |           | not null | 
 tenant_id           | uuid                     |           | not null | 
 stage               | text                     |           | not null | 
 provider            | text                     |           | not null | 
 model               | text                     |           | not null | 
 requested_model     | text                     |           | not null | 
 response_id         | text                     |           |          | 
 input_tokens        | integer                  |           | not null | 0
 cached_input_tokens | integer                  |           | not null | 0
 output_tokens       | integer                  |           | not null | 0
 images              | integer                  |           | not null | 0
 usd_estimate        | numeric                  |           | not null | 0
 status              | text                     |           | not null | 
 error_code          | text                     |           |          | 
 started_at          | timestamp with time zone |           | not null | now()
 finished_at         | timestamp with time zone |           |          | 
Indexes:
    "design_studio_calls_pkey" PRIMARY KEY, btree (id)
Check constraints:
    "design_studio_calls_status_check" CHECK (status = ANY (ARRAY['ok'::text, 'error'::text, 'uncertain'::text]))
Foreign-key constraints:
    "design_studio_calls_run_id_fkey" FOREIGN KEY (run_id) REFERENCES hawa.design_studio_runs(id) ON DELETE CASCADE
Policies (forced row security enabled):
    POLICY "design_studio_calls_tenant_scope"
      USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid))
      WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid))
Triggers:
    immutable_design_studio_call BEFORE DELETE OR UPDATE ON hawa.design_studio_calls FOR EACH ROW EXECUTE FUNCTION hawa.protect_design_studio_call()
```

### 1.5 `hawa.design_feedback`
```text
                       Table "hawa.design_feedback"
    Column    |           Type           | Collation | Nullable | Default 
--------------+--------------------------+-----------+----------+---------
 id           | uuid                     |           | not null | 
 tenant_id    | uuid                     |           | not null | 
 task_id      | uuid                     |           | not null | 
 run_id       | uuid                     |           |          | 
 candidate_id | uuid                     |           |          | 
 actor_id     | text                     |           | not null | 
 source       | text                     |           | not null | 
 verdict      | text                     |           | not null | 
 rating       | integer                  |           |          | 
 notes        | text                     |           |          | 
 created_at   | timestamp with time zone |           | not null | now()
Indexes:
    "design_feedback_pkey" PRIMARY KEY, btree (id)
Check constraints:
    "design_feedback_rating_check" CHECK (rating IS NULL OR rating >= 1 AND rating <= 10)
    "design_feedback_source_check" CHECK (source = ANY (ARRAY['desk'::text, 'telegram'::text, 'import'::text]))
    "design_feedback_verdict_check" CHECK (verdict = ANY (ARRAY['approve'::text, 'reject'::text, 'revise'::text, 'rating'::text]))
Foreign-key constraints:
    "design_feedback_candidate_id_fkey" FOREIGN KEY (candidate_id) REFERENCES hawa.design_studio_candidates(id)
    "design_feedback_run_id_fkey" FOREIGN KEY (run_id) REFERENCES hawa.design_studio_runs(id)
Policies (forced row security enabled):
    POLICY "design_feedback_tenant_scope"
      USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid))
      WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid))
```

---

## 2. Automated Test Suite Evidence

Executed on PostgreSQL database `hawa_repair`:
```bash
HAWA_ISOLATED_TEST_DB="postgresql://hawa_owner:***@127.0.0.1:54332/hawa_repair" pnpm --filter @hawa/db test test/design-studio.test.ts
```

Output:
```text
$ vitest run test/design-studio.test.ts

 RUN  v4.1.11 /Users/hawzhin/Hawdesign/packages/db

 ✓ test/design-studio.test.ts (5 tests) 64ms
   ✓ enforces RLS isolation across all 5 design studio tables for tenant_id 15ms
   ✓ rejects deletion or mutation of completed run via immutability trigger 16ms
   ✓ enforces append-only call ledger and rejects update/deletion of finalized call 8ms
   ✓ enforces one active run per task index constraint 7ms
   ✓ enforces SHA256 integrity checks on candidate preview and art bytea 5ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

Schema upgrade verification:
```bash
HAWA_ISOLATED_TEST_DB="postgresql://hawa_owner:***@127.0.0.1:54332/hawa_repair" pnpm --filter @hawa/db test test/schema-upgrade.test.ts
```

Output:
```text
$ vitest run test/schema-upgrade.test.ts

 RUN  v4.1.11 /Users/hawzhin/Hawdesign/packages/db

 ✓ test/schema-upgrade.test.ts (3 tests) 54ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
```

---

## 3. Verification Details

1. **RLS Isolation Between Two Tenants**:
   - `tenantA` created a run, candidate, judgment, call, and feedback row.
   - When queried under `app.tenant_id = tenantA` as `hawa_app`, all rows are visible.
   - When queried under `app.tenant_id = tenantB` as `hawa_app`, 0 rows returned across all 5 tables.
2. **Immutability Trigger on Runs**:
   - `hawa.protect_design_studio_run()` prevents mutation of core identification (`id`, `tenant_id`, `task_id`, `client_id`, `actor_id`, `request_key`, `request_hash`).
   - When a run reaches terminal status (`transferred`), any further status update is rejected with `Completed design studio run is immutable (status: transferred)`.
   - Any `DELETE` statement is rejected with `Design studio runs are append-only`.
3. **Immutability Trigger on Calls Ledger**:
   - `hawa.protect_design_studio_call()` ensures ledger is append-only.
   - Any `DELETE` is rejected with `Design studio calls ledger is append-only`.
   - Any `UPDATE` on a finalized call (`status IN ('ok', 'error')`) is rejected with `Completed design studio call is immutable`.
4. **Ledger Call Ordering (Insert-Before-Response)**:
   - Verified that `recordCallStart` inserts the call record with `status: 'uncertain'` before network dispatch.
   - `finalizeCall` transitions status to `'ok'` or `'error'` with input/cached/output tokens and `usd_estimate`.
5. **One Active Run per Task**:
   - Partial unique index `design_studio_one_active_run` strictly prevents more than one active run per task until the previous run is terminal (`transferred`, `degraded`, `failed`, or `abandoned`).
## 4. Commit Hash
- **Branch**: `studio-v2`
- **Commit**: `32b6ef1` (`studio(T09): migration 013, rls policies, immutability triggers and repositories`)
