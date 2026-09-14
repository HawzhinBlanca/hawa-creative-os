# T01 Proof: Baseline Gates and V1 Comparison Runs

- **Date / Timestamp**: 2026-09-14T09:23:07Z (12:23:07 local)
- **Git Commit**: `dcf6c99b82bb8a7ee482813158c3dbcbceeb7c6f`
- **Branch**: `studio-v2`
- **Environment**: Local production stack (`hawa-production-*` containers: core, worker, nginx, restate, postgres, desk) on `127.0.0.1:8080`, Postgres on port 54332.

---

## 1. Test Suite & Validation Gates

All required gates executed and confirmed 100% green without any weakened assertions:

| Gate | Command | Result | Details |
|---|---|---|---|
| **TypeScript Typecheck** | `pnpm typecheck` | **PASS (exit 0)** | Clean build via `tsc -b` across all packages and apps |
| **Unit & Integration Tests** | `pnpm test` | **PASS (exit 0)** | **115 passed \| 2 skipped (117 files)**<br>**833 passed \| 12 skipped (845 tests)** |
| **Security Credential Scan** | `pnpm security:scan` | **PASS (exit 0)** | **0 secrets** in committable files; 40 justified allowlist items |
| **Blueprint Pack Validation** | `python3 scripts/validate_pack.py` | **PASS (exit 0)** | **PASS=509 WARN=0 FAIL=0** |

---

## 2. 10 Comparison Briefs (V1 Single-Shot Planner Runs)

10 authentic KAAE briefs (5 Latin/English, 3 Sorani Kurdish Arabic-script, 2 Bilingual mixed) were created in `packages/evals/src/design-studio/briefs/compare-01.json` through `compare-10.json` and executed live against `POST /v1/tasks/:taskId/canva/generate` on the local production stack with the operator bearer token.

Every run completed the full vertical slice:
1. Durable task creation (`hawa.tasks` + `hawa.task_events` with KAAE client `c1000000-0000-4000-8000-000000000002`).
2. Single-shot layout generation via Anthropic `claude-opus-5`.
3. Editable transfer PPTX encoding.
4. Native Canva import via Canva Connect API.
5. Task Canva binding (`hawa.canva_bindings`).
6. Native PNG export generation (`POST /v1/tasks/:taskId/canva/exports`).
7. Bounded settlement and export retrieval (`hawa.canva_export_bytes`).
8. Artifact download, SHA-256 verification, and receipt persistence.

### Detailed Run Ledger

| Brief | Name | Lang | Dims | Task ID | Canva Design ID | PNG SHA-256 | Bytes | In Tok | Out Tok | Time |
|---|---|---|---|---|---|---|---|---|---|---|
| `compare-01` | Annual Accreditation Symposium | EN | 1080×1350 | `dac86ec6` | `DAHVKfswoNI` | `bdf847160e...` | 83,263 | 1,960 | 668 | 24.5s |
| `compare-02` | Institutional Standard 2026 | EN | 1080×1080 | `41ad5a19` | `DAHVKZagLXI` | `e3390f713d...` | 72,952 | 1,897 | 448 | 23.3s |
| `compare-03` | Leadership Forum Story | EN | 1080×1920 | `ce84c0b3` | `DAHVKQ8sxU8` | `05cd1a8b86...` | 93,717 | 1,923 | 1,926 | 45.3s |
| `compare-04` | Council Session Document | EN | 1240×1754 | `57504e28` | `DAHVKTdDAh4` | `c737fd0763...` | 218,320 | 1,965 | 2,150 | 43.1s |
| `compare-05` | Quality Summit Screen | EN | 1920×1080 | `9a0bb701` | `DAHVKVupkXk` | `a7c1318e92...` | 75,589 | 1,898 | 1,146 | 32.3s |
| `compare-06` | Kurdish Conference Invitation | CKB | 1080×1350 | `12dd5829` | `DAHVKSHhUoA` | `874a351d38...` | 88,540 | 2,138 | 1,295 | 32.8s |
| `compare-07` | Kurdish Accreditation Post | CKB | 1080×1080 | `c05576b9` | `DAHVKfOT7v4` | `d06d7787e6...` | 79,736 | 2,046 | 991 | 31.7s |
| `compare-08` | Kurdish QA Workshop Story | CKB | 1080×1920 | `673ac606` | `DAHVKWWPioA` | `9479a41cf0...` | 108,637 | 2,008 | 1,410 | 35.2s |
| `compare-09` | Bilingual Symposium Invitation | Mixed | 1080×1350 | `33df1ff3` | `DAHVKatHKsI` | `288457ed3d...` | 85,592 | 2,062 | 1,539 | 38.6s |
| `compare-10` | Bilingual Board Convening | Mixed | 1240×1754 | `8699ec05` | `DAHVKYZGZoc` | `5c65db85ea...` | 203,587 | 2,001 | 1,774 | 47.1s |

---

## 3. Token Counts & Financial Spend

- **Total Input Tokens**: 19,898 tokens
- **Total Output Tokens**: 13,347 tokens
- **Anthropic Model**: `claude-opus-5`
- **Cost Calculation** (Official Opus 5 rates: $5.00 / MTok input, $25.00 / MTok output):
  $$\text{Input Spend} = \frac{19898}{1{,}000{,}000} \times \$5.00 = \$0.09949$$
  $$\text{Output Spend} = \frac{13347}{1{,}000{,}000} \times \$25.00 = \$0.333675$$
  $$\mathbf{\text{Total Spend}} = \mathbf{\$0.433165\text{ USD}} \approx \mathbf{\$0.433\text{ USD}}$$
- **Average Cost per V1 Run**: **$0.0433 USD** (~4.3 cents per design).

---

## 4. Generated Artifacts & Proof Files

All 10 PNG exports and provider receipts are saved in `output/proofs/2026-09-14-design-studio-v2/baseline/`:

```
output/proofs/2026-09-14-design-studio-v2/baseline/
├── summary.json
├── v1-compare-01.png (83,263 bytes)
├── v1-compare-01.receipt.json
├── v1-compare-02.png (72,952 bytes)
├── v1-compare-02.receipt.json
├── v1-compare-03.png (93,717 bytes)
├── v1-compare-03.receipt.json
├── v1-compare-04.png (218,320 bytes)
├── v1-compare-04.receipt.json
├── v1-compare-05.png (75,589 bytes)
├── v1-compare-05.receipt.json
├── v1-compare-06.png (88,540 bytes)
├── v1-compare-06.receipt.json
├── v1-compare-07.png (79,736 bytes)
├── v1-compare-07.receipt.json
├── v1-compare-08.png (108,637 bytes)
├── v1-compare-08.receipt.json
├── v1-compare-09.png (85,592 bytes)
├── v1-compare-09.receipt.json
├── v1-compare-10.png (203,587 bytes)
└── v1-compare-10.receipt.json
```

These 10 baseline PNGs serve as the ground truth "Candidate B" for the blind human evaluation in Task T15.
