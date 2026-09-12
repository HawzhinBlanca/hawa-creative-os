# CV-10: Bounded Creative Planner and Asset Route

**Status:** VERIFIED  
**Date:** 2026-09-11  
**Lead Verification:** Gemini Agent  
**Requirements Covered:** `FR-013`, `FR-014`, `FR-015`, `FR-016`, `FR-024`, `FR-025`, `FR-026`, `FR-040`, `FR-056`, `FR-057`, `FR-058`, `FR-059`, `FR-062`, `FR-079`, `NFR-018`.

---

## 1. Overview & Objective

Task CV-10 delivers the production-grade, bounded creative planner and asset route for Hawa Creative OS. It bridges intake ingress with downstream Canva native composition, enforcing strict invariants around factual integrity, model admission, asset isolation, and bounded autonomous repair.

Crucially, **a tiny model OK test does not qualify design quality.** The planner preserves all protected fields and halts cleanly whenever indispensable inputs or provider access are missing.

---

## 2. Architectural Components Implemented

### 2.1 Schema-Valid Structured Brief & Fact Defense (`FR-013`, `FR-014`)
- Implemented in `BriefBuilder` and `BoundedCreativePlanner`:
  - Produces schema-valid `DesignBrief` records with target variants, exact copy blocks, locale/direction metadata, and extracted protected tokens.
  - **Blocking Fact Defense:** Tasks requesting event announcements, discount sales, or clinical product promos that omit dates, prices, or required claims halt immediately with `BRIEF_HAS_MISSING_FACTS` and safe action `Transition task to NEEDS_INFORMATION`. Facts are never invented or assumed.

### 2.2 Dual Task Routing & Cost Efficiency (`FR-016`, `NFR-018`)
- Implemented in `DesignRouter` and `BoundedCreativePlanner`:
  - **Routine Template Route (`template_fill`):** Detects institutional decree archetypes (e.g. KAAE accreditation decree, milestone card, peer evaluator call) and routine brand templates. Enforces `NFR-018` by consuming zero deep-reasoning models and zero image diffusion (cost: $0.000000).
  - **Novel Composition Route (`creative_director`):** Routes complex novel visual campaigns to the Creative Director planner.
  - **Omnichannel Multi-Format Route (`multi_format_composition`):** Detects multi-format requests and coordinates plans across all 4 canonical formats: Feed (4:5), Story (9:16), Landscape (16:9), and Print A4 (1:1.414).
  - **Human-Only Route (`human_only`):** Pauses low-confidence or ambiguous requests for human operator direction.

### 2.3 Exact-Copy Lock & Holdout Copy Auditor (`FR-014`, `FR-015`)
- Implemented in `HoldoutCopyAuditor`:
  - Compares candidate layouts and generated operations against the original brief's approved text and protected tokens.
  - **Price Tampering Defense:** Rejects mutated price tokens with `PROTECTED_TOKEN_MUTATED` (e.g. $10 changed to $20, or 25,000 IQD to 20,000 IQD).
  - **Statutory Disclaimer Defense:** Rejects omitted mandatory disclaimers with `MANDATORY_DISCLAIMER_MISSING` (e.g. Drustee dietary supplement disclaimer or KAAE institutional decree citations).
  - **Factual Headline Lock:** Halts if candidate text drops or hallucinates headlines with `CORRUPTED_FACTUAL_COPY`.

### 2.4 Model Admission & Authentic Usage Accounting (`FR-056`, `FR-057`, `FR-079`)
- Implemented in `ResilientModelGateway`:
  - **Eliminated Hidden Model Remapping:** Removed code that silently remapped model snapshots (e.g., `model.startsWith('gpt-5') ? 'gpt-4o'`). Admitted snapshots (`gpt-5.6-sol`, `claude-opus-5`, `claude-sonnet-5`, `gemini-3.8-flash`) are preserved verbatim.
  - **Model Admission Enforcement:** Checks deployment admission state (`primary`, `canary`, `fallback`, `retired`, `blocked`). Retired or blocked models are skipped or rejected with structured error.
  - **Robust JSON Parsing:** Added `parseModelJsonResponse` to parse model JSON outputs across markdown code fences, XML tags, and raw JSON strings.
  - **Authentic Token & Cost Accounting:** Reads actual token counts from provider payloads (`usage.prompt_tokens`, `usageMetadata.promptTokenCount`) and commits real `CostReceipt` records into the `CostGovernor` financial ledger.
  - **Capacity & Budget Gate (`FR-062`, `FR-079`):** Pre-flight budget checks halt execution if a client's monthly allocation or task budget ceiling is exceeded.

### 2.5 Provider Outage & Failover (`FR-058`, `FR-059`)
- Circuit breakers per provider (`google`, `anthropic`, `openai`, `local`) trip to `OPEN` on consecutive failures.
- When primary providers return 429 rate limits or network timeouts, the gateway automatically cascades to evaluated secondary fallbacks without losing work or dropping tasks.

### 2.6 Visual Ingredient Bounding & Invariant #4 (`FR-024`, `FR-026`)
- **Diffusion Logo & Lettering Prohibition:** Diffusion image models are strictly restricted to approved visual ingredients (background, texture, subject cutout). Official logos and badges MUST be sourced from verified vector assets (`official_asset`). Requests to invent logos via diffusion halt with `PROHIBITED_DIFFUSION_LETTERING_OR_LOGO` / `MISSING_BRAND_ASSET`.
- **Private Reference Isolation (Invariant #4):** Novel designs may generate one private art-direction reference whose pixels MUST have `shippedInArtifact: false`. Any attempt to ship reference pixels in export deliverables is rejected with `REFERENCE_PIXEL_SHIPPING_BLOCKED`.

### 2.7 Bounded Autonomous Repair (`FR-040`)
- Limits automatic repair to a maximum of 2 cycles.
- On attempt 3, the engine halts with `MAX_REPAIR_BUDGET_EXCEEDED`, transitions the task to `OPERATOR_REQUIRED`, and preserves all checkpoints, operations, and candidate assets in the task state for the human designer. Work is never lost.

---

## 3. Test Verification & Results

The dedicated verification suite in `apps/core/test/creative-planner-asset-route.test.ts` passed 14/14 tests:

```bash
$ pnpm --filter @hawa/core exec vitest run test/creative-planner-asset-route.test.ts

 ✓ test/creative-planner-asset-route.test.ts (14 tests) 8ms
   ✓ 1. Structured Brief Generation & Missing Facts Defense (FR-013, FR-014)
   ✓ 2. Dual Task Route Selection & Cost Efficiency (FR-016, NFR-018)
   ✓ 3. Model Admission & Authentic Provider Receipts (FR-056, FR-057, FR-079)
   ✓ 4. Provider Outage Handling & Circuit Breaker (FR-058, FR-059)
   ✓ 5. Wrong-Output Holdout Controls (FR-014, FR-015)
   ✓ 6. Bounded Autonomous Repair (Max 2 Cycles) & Work Preservation (FR-040)
   ✓ 7. Visual Ingredient Bounding & Art-Direction Reference Safety (FR-024, FR-026)

Test Files  1 passed (1)
     Tests  14 passed (14)
```

Full core test suite verification:
```bash
$ pnpm --filter @hawa/core test
Test Files  19 passed (19)
     Tests  137 passed (137)
```

Pack validation:
```bash
$ python3 scripts/validate_pack.py
PASS=464 WARN=0 FAIL=0
```

Zero production database pollution:
```bash
$ docker exec hawa-production-postgres-1 psql -U hawa_owner -d hawa -c "SELECT (SELECT count(*) FROM hawa.tasks) AS task_count, (SELECT count(*) FROM hawa.outbox_commands) AS outbox_count;"
 task_count | outbox_count 
------------+--------------
       1449 |         1449
(1 row)
```

---

## 4. Evidence Artifacts

1. `evidence/canva-migration/2026-09-11-run-1/CV-10/STRUCTURED_BRIEFS_AND_PLANS.json`: Schema-valid briefs and format-calibrated layout plans.
2. `evidence/canva-migration/2026-09-11-run-1/CV-10/PROVIDER_USAGE_RECEIPTS.json`: Model admissions, unmapped snapshot usage, real cost receipts, and failover traces.
3. `evidence/canva-migration/2026-09-11-run-1/CV-10/HOLDOUT_AND_BOUNDED_REPAIR.json`: Holdout copy audit records, price tampering rejections, 2-cycle bounded repair trajectory, and reference pixel isolation proofs.
4. `evidence/canva-migration/2026-09-11-run-1/CV-10/README.md`: This completion certificate.
