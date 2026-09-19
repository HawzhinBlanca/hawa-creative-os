# Proof Dossier: Remediation Tasks R01 & R02

Date: 2026-09-19  
Baseline Source: `664ad55b85930b3cd29c6be170fc13f0d2876f66`  
Scope: Truthful Evaluation Gates (R01), Build/Topology Identity Manifest (R02), and Test Fixture Classification.

---

## 1. Task R01 — Truthful Evidence and Preserved Failing Baseline

### Claim and Scope
- **Task ID**: R01
- **Requirements**: FR-055, FR-057; NFR-024, NFR-025.
- **Affected Packages**: `packages/evals` (`live-runner.ts`, `report-generator.ts`, `runner.ts`, `types.ts`).
- **Target Invariant**: Missing evaluation metrics are strictly reported as `unmeasured` / `incomplete` / `undefined`, causing qualification gates to fail closed. An always-abstaining model must fail on non-abstaining cases.

### Before/After Counterexamples

1. **Missing Evidence Probe** (`output/audits/2026-09-19-architecture-reliability/offline-eval-probes.mjs`):
   - **Before**: API returning empty `transferred` resulted in fabricated `winnerScore: 8.5`, canary `passed: true` with four `9.0` scores, swap consistency `1.0`, parity `'match'`, and `defectReproduced: true`.
   - **After**: API returning empty `transferred` yields `status: "incomplete"`, `winnerScore: undefined`, canary `passed: false` with verdict `"UNMEASURED"`, tournament `swapConsistencyRate: undefined`, parity `undefined`, and `defectReproduced: false`.

2. **Always-Abstain Router Probe** (`output/audits/2026-09-19-architecture-reliability/offline-eval-probes.mjs`):
   - **Before**: Injected `decision: "abstain", confidence: 1.0` scored `200/200` (100% pass rate) despite 195 cases requiring routing (`must_abstain: false`).
   - **After**: Scored `5/200` (2.5% pass rate), correctly failing all 195 non-abstaining cases, and `defectReproduced: false`.

### What Actually Ran
```bash
# Automated regression suite
pnpm vitest run packages/evals/test/evidence-truthfulness.test.ts
# Result: 5 passed (Audit Probe 1, Audit Probe 2, wrong-client negative, bad-confidence negative, fail-closed report generator)

# Audit counterexample verification
node --import tsx output/audits/2026-09-19-architecture-reliability/offline-eval-probes.mjs
# Output saved to: output/repairs/2026-09-19-architecture-remediation/R01_EVAL_PROBE_RESULT.json (Exit 0, defectReproduced: false)

# Full evals package test suite
pnpm vitest run packages/evals/test/
# Result: 6 test files, 38 tests passed
```

### Raw Evidence Artifacts
- Machine-readable probe result: `output/repairs/2026-09-19-architecture-remediation/R01_EVAL_PROBE_RESULT.json`
- Test suite: `packages/evals/test/evidence-truthfulness.test.ts`

### Result
**PASS** for R01 scope.

---

## 2. Task R02 — Exact Build, Configuration, and Active Workflow Identity

### Claim and Scope
- **Task ID**: R02
- **Requirements**: FR-074; NFR-013, NFR-025.
- **Topology**: Canonical production topology is `infra/docker/docker-compose.prod.yml` (multi-container: `core`, `desk`, `worker`, `postgres`, `nginx`).
- **Flags**: `DESIGN_PIPELINE_V3: "off"`, `DESIGN_STUDIO_V2: "off"`.

### Implementation
- Added manifest contract and validator: `packages/contracts/src/release-manifest.ts`
- Added manifest generator: `scripts/generate_release_manifest.ts`
- Added manifest verifier: `scripts/verify_release_manifest.ts`
- Generated canonical release manifest: `RELEASE_MANIFEST.json` with commit SHA, tree cleanliness status, migration versions, component source hashes, and pinned models.

### What Actually Ran
```bash
# Contracts test suite
pnpm test:contracts
# Result: 3 passed (including R02 ReleaseManifest topology and strict flag invariants)

# Generate and verify manifest
pnpm tsx scripts/generate_release_manifest.ts && pnpm tsx scripts/verify_release_manifest.ts
# Result: Generated RELEASE_MANIFEST.json; verification exited 0
```

### Raw Evidence Artifacts
- Manifest: `RELEASE_MANIFEST.json` (SHA-256: `24705133ece2f3dd5765511670ef09eee681838bcc3658bc9b91f2443964e469`)
- Verifier: `scripts/verify_release_manifest.ts`

### Result
**PASS** for R02 scope.

---

## 3. Test Fixture False Positive Fix

### Scope
- File: `infra/security/secret_allowlist.txt`
- Resolved the scanner false positive for `apps/desk/test/desk-auth.test.ts:18` (`operator-token-7f3a`) and offline audit probe synthetic tokens without altering scanner regex patterns.

### What Actually Ran
```bash
python3 infra/security/security_scan.py && python3 infra/security/security_scan.py --self-test
# Result: Exit code 0, self-test passed (11 patterns detect their fixtures and ignore benign text)
```
