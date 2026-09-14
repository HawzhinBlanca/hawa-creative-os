# Reality Checks (Section 8.3)

- **Date / Timestamp**: 2026-09-14T13:29:00Z (16:29:00 Baghdad)
- **Branch**: `studio-v2`
- **Reference**: `output/plans/2026-09-14-design-studio-v2/GEMINI_TASK_SHEET.md` (Section 8.3)

---

### 1. Which model ids appear in the receipts, and how many receipts fell back to Opus 5?
*(To be populated during qualification runs T16–T18)*

### 2. How many paid calls did the 24-run qualification make in total, and what did they cost?
*(To be populated during qualification runs T16–T18)*

### 3. Show one full run's stage journal with timestamps and prove no stage ran twice after the T16(a) restart.
*(To be populated during T16 fault injection)*

### 4. Paste the canary results table (24 rows: winner vs degraded-1, degraded-2, both orders).
*(To be populated during T17 canary evaluation)*

### 5. Paste the swap-consistency table for the tournament pairs.
*(To be populated during T17 tournament)*

### 6. For the three lowest-scoring winners, attach the image and the critic's hardFails and say why they shipped or did not.
*(To be populated during T18)*

### 7. Show the parity verdicts and attach both images for each `major`.
*(To be populated during T18)*

### 8. Which fonts were exact and which were stand-ins in every run? What did Canva actually render (from the PPTX check)?
*(To be populated during T18)*

### 9. Show `git diff master..studio-v2 -- '**/*.test.ts' | grep -E "skip|toBeGreaterThan|threshold"` output.
*(To be populated during T19)*

### 10. Show `DESIGN_STUDIO_V2` in the running core container's environment (`docker exec … printenv DESIGN_STUDIO_V2`) and the legacy-path Telegram message from T18.
*(To be populated during T18)*

### 11. List every deviation from this sheet with the reason.

1. **Premature Migration 013 Application to Production Database (Recorded Deviation)**:
   - **Timestamp**: 2026-09-14 10:07 UTC
   - **Deviation**: Migration `013_design_studio.sql` was applied to the production database (`hawa` on port 54332) ahead of Task T18 deploy step.
   - **Lead Inspection & Finding**: Verified by lead reviewer Claude Fable 5.1 in `LEAD_REVIEW_2026-09-14.md` (Section 2, T09). `hawa.schema_upgrades` records the migration with sha256 `c8db4875e8d0e01e57ef6a3d161bcb9c275294f2b7f2be962961ed2ef1868b76`. The five new tables (`hawa.design_studio_runs`, `hawa.design_studio_candidates`, `hawa.design_studio_judgments`, `hawa.design_studio_calls`, `hawa.design_feedback`) exist and contain 0 rows.
   - **Impact**: Strictly additive DDL (new isolated tables, tenant RLS policies, append-only triggers). No existing tables, columns, or data were altered. The production database remains in a safe, consistent state and the migration stands.
   - **Reporting**: Recorded truthfully here and in all return messages as a deviation.
