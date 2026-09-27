# Hawdesign audit — 27 September 2026

**Baseline:** `studio-v2` at `59150ca` (2026-09-25). Every file:line below refers to that commit.
**Mode:** read-only. No application code was changed, nothing was deployed, no paid model call was made, no production system was touched.
**Method:** the full check suite was run here (install, lint, typecheck, pack validation, secret scan, `pnpm audit`, the 430-file vitest suite twice), the GitHub Actions history was read, and seven reviewers each re-verified one slice of the 21 September ledger (`output/audits/2026-09-21-engineering-rank-audit/FINDINGS.md`) against the current code and hunted for new defects. The headline claims below were re-checked by hand; the ones marked **reproduced** were executed. Full ledger: [FINDINGS.md](FINDINGS.md).

> Another agent is working on the app toward "10/10". This report is pinned to `59150ca` so each item can be re-checked as fixed or open against a fixed baseline. Section 6 is the gate a 10/10 claim should have to pass.

## 1. Verdict: 5.0 / 10 (was 4.1 on 21 September)

Real progress. The 9,100-line `app.ts` is now 1,129 lines. The break the last audit led with is closed in code: the live Canva outcome now writes `design_revisions` and `qc_runs`, and `notify.published` has a consumer. Postgres is the only store when a database is configured. The outbox has jittered backoff. Inbound Telegram updates are parked, not dropped. A chaos suite runs against real Restate.

It is not higher for five reasons:

1. **Nothing checks a push.** All 60 GitHub Actions runs since 21 September failed within 2–40 s with no runner assigned (`runner_id: 0`, logs 404). Not one CI step has ever executed.
2. **The suite does not pass off the owner's Mac.** With a database it is 46 failed files out of 430. Most failures come from a licensed system font the suite assumes is installed.
3. **Several quality gates can be skipped by the caller, or cannot fail.** Examples: a request-body policy flag skips the approval checks on delivery, the QC gate is opt-in, the release gate hard-codes two PASS values, the DR drill's RLS check always reads 0, and the production model gateway replays the eval answer key.
4. **Privacy is still at 3.5.** There is no retention, deletion or egress enforcement. Raw chats, photos and voice go to OpenAI. 27 named people sit in a committed client file.
5. **No evidence the chain has completed in production.** The durable RequestLifecycle path is switched off there (`HAWA_LIFECYCLE_CHATS` is empty), and no proof run exists after the design fixes of 18–24 September.

## 2. Measured here

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | pass |
| `pnpm typecheck` | pass. But `tsconfig.test.json` excludes `apps/core/**` and `apps/worker/**` and has `strict:false`, so 184 of ~426 test files are checked. |
| `pnpm lint` on a fresh clone | **fail**, 783 errors (the scripts tsconfig needs `dist/`, which only `typecheck` builds). Passes after a build. Its first step `tsc --noEmit` checks **0 files** (root `tsconfig.json` has `files: []`). |
| any-ratchet | 976 against a ceiling of 1,053. It skips `.tsx` and `Map<…, any>`; the real count is 1,263. |
| `validate_pack.py` | PASS=705 FAIL=0 |
| `security_scan.py` | clean. It scans only `git ls-files`, not history. |
| `pnpm audit --prod` | 2 high, both suppressed. The suppression rationale no longer matches the code (SEC-12). |
| `pnpm test`, no database (as a fresh clone runs) | **146 failed / 249 passed / 35 skipped files**. Tests: 206 failed, 2,142 passed. 91 errors are `createDb requires … DATABASE_URL`. |
| `pnpm test` with a Postgres 16 + pgvector test DB (all 23 migrations apply cleanly) | **46 failed / 376 passed / 8 skipped files**. Tests: 153 failed, 3,097 passed, 106 skipped. |
| Of those 153 failures | 115 fail directly on `FONT_UNRESOLVED` / "No admitted body face" (Verdana is not installed; the MS core-fonts download is blocked here). ~35 more are edit/revision tests whose logs show the same font error, so they are probably cascades, but that is not proven. 3 are independent defects: see T-1..T-3 below. |
| GitHub Actions | 60 of 60 runs failed, 21–25 Sept, including `59150ca`. No step has ever run. |
| Git history | Starts at squash `5fd4b96` (2026-09-23). Every commit the 21 Sept reports cite (`2d3a930`, `6d3c583`, `54223ea`, …) no longer exists. |

Independent test defects found while running the suite:

- **T-1** `scripts/enforce_release_gate.sh:46` uses BSD `sed -i ''`. On Linux the refusal drill fails, `set -e` aborts before the `rm`, and `RELEASE_MANIFEST.corrupted.json` is left in the repo root. The release gate is macOS-only. (reproduced)
- **T-2** `apps/core/test/draft-reminders.test.ts:125` is a time bomb. `draft(30)` is 30 h before *now*, compared with the fixed `REMINDERS_FROM = 2026-09-24T06:00Z`. It passed until about 26 Sept and fails from then on. (reproduced)
- **T-3** `apps/core/test/hawa-work-desk-cv17.test.ts:125` needs `apps/desk/dist`, which `pnpm test` never builds.
- A test writes `output/proofs/2026-09-17-research-grade-pipeline/P04_ART/temp_art_*.png` into a tracked proof folder on every run.

## 3. Scorecard

| Area | 21 Sept | Now | One line |
|---|---|---|---|
| Durable workflows and the live chain | 4.8 / 3.4 | **6.5** | Every headline break is closed in code. Delivery is still a non-durable HTTP request that needs a second human press, and the durable path is off in production. |
| Database | 5.0 | **6.0** | Append-only approvals, sheet upsert, pool timeouts and outbox fencing are fixed. Grants are unversioned, the Kysely types are hand-written and wrong, and version bumps are unguarded. |
| Tests | 5.0 | **5.5** | Per-file DB clones and a real chaos suite are genuine gains. Flagship proof tests still cannot fail, and DB suites skip silently. |
| Creative engine / design QA | 4.8 | **5.3** | The visible defects are fixed and tested. Fonts and contrast have 7+ disagreeing lists, there is no script itemisation, and there has been no proof run since 09-18. |
| Core API and security | 3.8 / 5.0 | **5.0** | The split and the random session tokens are real. Identity is still shared static keys, there is no request validation, and authorisation is per-handler. |
| Operator Desk | 4.0 | **5.0** | Token handling, SSE tickets and TanStack Query are real improvements. Always-green pills, dead palette actions and orphaned studio runs remain. |
| Performance and cost | 4.5 | **5.0** | v2 renders are async and billed errors are costed. v3 and motif renders still `spawnSync`. There is no daily dollar cap, and intake spend is unledgered. |
| LLM, gateway and evals | 4.6 | **4.5** | The evals cannot fail, and the production gateway embeds the answer key and mislabels fallback output. |
| Maintainability | 4.1 | **4.5** | The `app.ts` split is a big win. 52k lines of tests are untyped, lint checks nothing, and there are 113 MB of tracked output. |
| Build, CI, deploy, ops | 4.0 | **4.0** | CI has never run. The release gate's verdict does not depend on its gates. Production runs on a per-user Mac with a 24 h RPO. |
| Privacy and licensing | 3.0 | **3.5** | No retention, deletion or egress policy. Four fonts lack licence files. |
| **Mean** | 4.1 | **≈5.0** | |

Re-verification of the 21 Sept ledger (187 rows after merging items two slices both raised): **26 fixed, 78 partially fixed, 82 still open, 1 undeterminable.**

## 4. Evidence honesty

`output/audits/2026-09-21-engineering-rank-audit/FINAL_AUDIT_REPORT.md` ("9.6/10, QUALIFIED FOR PRODUCTION SHIPMENT … zero fake passes") contradicts the code at HEAD. Each of these was checked:

| Claim in FINAL_AUDIT_REPORT / PROOFS_OF_COMPLETION | At `59150ca` |
|---|---|
| Compose runs read-only with `cap_drop: [ALL]` | 0 occurrences of `read_only`, `cap_drop` or `security_opt` in `infra/docker/docker-compose.prod.yml` |
| Enforced mandatory CI gate | 60/60 runs never executed a step |
| Cryptographically signed release manifest | A self-hash only. `SHA256SUMS.txt` and `MANIFEST.json` cover 0 files under `apps/`, `packages/` or `infra/`. |
| Zero fake passes | `enforce_release_gate.sh:285,321` hard-codes `gateB = "PASS"` and `gateG = "PASS"`. `:225-226` falls back to invented counts `185` / `1394`. The R14 pilot counters `crossTenantLeaks` and `flattenedRasterLayers` are never incremented (`r14-controlled-office-pilot.test.ts:122-123,187-188`). The Gate W "restore parity" test concatenates SQL strings (`backup-restore.test.ts:11-48`). |
| DR drill proves 0 cross-tenant rows | `disaster_recovery_drill.sh:323` sets `request.jwt.claims`, but RLS reads `app.tenant_id` (`db/rls.sql:12`). The tenant is NULL, every row is hidden, and the count is always 0. |
| Live Canva-to-delivery chain proven | `e2e-canva-to-delivery-chain.test.ts:261` passes its own `notify.published` handler, replacing the production one. Canva state is seeded by `INSERT`. |
| Quoted `03-grants.sql` and `deploy.sh` code | Neither matches the committed files |
| Clean tree at release | The committed `RELEASE_GATE_EVIDENCE.json` says `"cleanTree": false` and `"status": "QUALIFIED"` |

`plans/traceability.csv` also over-claims. NFR-003 says "RPO = 5 s", but its evidence says 15 s, and production backs up nightly. NFR-007 says privacy is "enforced and verified". FR-062 cites a simulated queue loop. 7 of 68 evidence paths are gitignored. No test file references any `TEST-FR/NFR-*` id.

This breaks `AGENTS.md`: "Never hide a failed or unexecuted test behind prose." The 21 Sept `REPORT.md` (4.1/10) is the honest document of the two.

## 5. Fix first (confirmed, ordered by risk)

| # | Sev | Finding | Where |
|---|---|---|---|
| 1 | critical | CI has never executed. Fix the account or runner issue (runner_id 0 on every job usually means Actions billing or a spending limit), then make the check required on `studio-v2`. | `.github/workflows/ci.yml` |
| 2 | high | `policy: "deliver_approved_stored"` in the request body skips the revision-binding, invalidation and QC checks, and forces APPROVED. Any signed-in role can send it. **(checked)** | `apps/core/src/routes/delivery.routes.ts:404-414`, `services/omnichannel-delivery.ts:365,379` |
| 3 | high | `publish-omnichannel` never calls `changeBlockingDelivery`. A version the client asked to change can still be delivered. `/publish` refuses the same case with 409. | `delivery.routes.ts:394-470` |
| 4 | high | The production model gateway reads `evals/routing_brief.jsonl` expected answers. When no live output is available, the fallback is labelled with the real provider and model and invented tokens (520/140). **(checked)** | `packages/integrations/src/model-gateway.ts:144-173,839-846` |
| 5 | high | Evals cannot fail. The safety eval runs a regex over its own inputs, the judge scores a fixed payload, the red-team counts every attack as blocked, and the runner defaults to the fake gateway. | `packages/evals/src/runner.ts:193-203,338-505`, `redteam-runner.ts:66-80` |
| 6 | high | Release gate: `QUALIFIED` depends only on `--skip-tests`. Gates B and G are literal PASS. The macOS-only sed (T-1). The gate rewrites a tracked evidence file, which pushes operators toward `ALLOW_DIRTY_DEPLOY=1`. **(checked)** | `scripts/enforce_release_gate.sh:46,225,239,285,321` |
| 7 | high | The DR drill's RLS check can never fail. **(checked)** | `scripts/disaster_recovery_drill.sh:323` |
| 8 | high | Test DBs grant blanket DML and never apply `db/03-grants.sql`. Code that breaks under production grants passes every test. This already caused the 09-24 `outbox_commands` incident. | `packages/db/src/test-template.ts:88-95` |
| 9 | high | Once CI runs it would skip every DB suite. It has no Postgres service and 66 files use `describe.skipIf(!url)`. It would also fail on missing Verdana and rsvg. | `ci.yml:40-78` |
| 10 | medium | `/ingress/promote` takes `tenantId` and `userId` from the body into the RLS context. A requester can act as the administrator in another tenant. **(checked)** | `apps/core/src/routes/ingress.routes.ts:130-136` |
| 11 | medium | The SVG sanitizer is single-pass: `<scr<script/>ipt>` comes out as a `<script>` tag with `ok:true`. Reachable through asset upload. **(reproduced)** | `packages/domain/src/sanitizer.ts:70-74`, `routes/assets.routes.ts:93` |
| 12 | medium | Delivery notice can be lost while the task still completes. The outbox insert failure is only logged, then COMPLETE is written in a separate transaction. **(checked)** | `services/omnichannel-delivery.ts:811-845` |
| 13 | medium | Reconciliation restores invalidated approvals. It accepts any `approved` row, with no invalidation or current-revision check. **(checked)** | `packages/db/src/task-reconciliation.ts:101-108` |
| 14 | medium | The approval QC gate is opt-in (`requireQcPass` / `x-require-qc`) and fails open when the lookup errors. | `routes/decisions.routes.ts:233-241` |
| 15 | medium | Rules taken from a chat or PDF become "authoritative" system-prompt text for every later design, with no review. | `services/telegram-rules-intake.ts:275-289`, `design-studio-service.ts:799-808` |
| 16 | medium | Client scope is not frozen once a run starts. Rules and the reference pack are re-read on every stage (violates the AGENTS.md invariant). | `design-studio-service.ts:1029,1198` |
| 17 | medium | Any role can release a kill switch an administrator threw. The route answers before the DB write. | `routes/system.routes.ts:517-531` |
| 18 | medium | The KAAE logo is the default in every client's render. Judge-canary renders draw no photos, so the judge scores something that never ships. | `packages/creative/src/render-layout-v2.ts:1538-1545`, `pipeline-v3.ts:1444,1450` |
| 19 | medium | `spawnSync` rasterisation still runs on Core's live judge, art and font-probe paths. | `pipeline-v3.ts:1444,1450`, `motifs.ts:310`, `render-layout-v2.ts:268` |
| 20 | medium | Intake-side model calls (classifier, voice, guideline PDF, planner) sit outside every ledger and cap. There is no daily dollar cap. | `telegram-classifier.ts:451`, `voice-transcriber.ts:96`, `canva-design-planner.ts:476` |
| 21 | medium | The service worker caches authenticated `/v1/` JSON, and sign-out never clears it. | `apps/desk/public/sw.js:136-150`, `services/serviceWorker.ts:49` |
| 22 | medium | `/Users/hawzhin/Hawdesign/...` paths are in shipped source. The KAAE DNA is not copied into the image, so the loaders silently do nothing in Docker. | `operations-to-svg.ts:28-30`, `feedback-miner.ts:452`, `client-learning.routes.ts:214` |

The remaining ~150 items, with evidence, are in [FINDINGS.md](FINDINGS.md).

## 6. The 10/10 gate

Score claims should only count when they come with these results, produced on a clean Linux checkout (not the owner's Mac) at a named commit:

1. **CI is green on that exact commit on GitHub**, with every job's steps visibly executed (non-empty logs), and required on `studio-v2`.
2. **The suite passes on a fresh `ubuntu-latest`** with a Postgres service, `pnpm test:db` provisioning, the fonts and rsvg installed by a checked-in script. **0 failed** tests, and a skip count reported and justified (no `describe.skipIf(!url)` skipping silently).
3. **`pnpm lint` passes on a fresh clone** and actually checks files (`tsc -b`). `tsconfig.test.json` includes `apps/core` and `apps/worker` with `strict: true`.
4. **The release gate derives every verdict from real checks.** No literal PASS values, no fallback numbers, portable sed, a `mktemp` workspace. `RELEASE_GATE_EVIDENCE.json` is not tracked.
5. **Negative controls exist and fail when they should:**
   - the DR RLS check fails on a DB with RLS disabled;
   - an eval run with the gateway returning garbage fails;
   - the release gate fails on a corrupted manifest on Linux;
   - an R14 counter moves when a flattened layer is injected.
6. **Findings #2–#22 above are closed.** Each has a regression test that fails on `59150ca` and passes on the fix commit.
7. **The production gateway has no eval data and never labels fallback output as a provider's.** Evals run against recorded real outputs with a held-out set not stored next to the tuning script.
8. **Test DBs are built with `db/03-grants.sql`.** Production grants are reconciled by a checksummed migration. There is an RLS cross-tenant test for approvals, publications, outbox and audit.
9. **One real production chain is recorded:** Telegram request → Canva draft → approval → Drive/Sheets → files received by the requester. Row counts from the production DB (counts and dates only) show new `design_revisions`, `approvals` and `publications` rows after the fix date. At least one **Arabic** and one **Sorani** design are in the proof set (today: 0 Arabic).
10. **Privacy minimum:**
    - a retention job that reads `retention_policy`;
    - a delete/export path;
    - raw payload encryption (or a documented, approved decision not to);
    - named people removed from `config/clients/kaae.dna.json`;
    - licence files for Cairo, Cinzel, Playfair Display and Plus Jakarta Sans.
11. **`plans/traceability.csv` statuses only say QUALIFIED where a test id and a present evidence file back them.** The false lines in section 4 are corrected.

Until 1–4 hold, any score above about 6 cannot be verified by anyone other than its author.

## 7. How this was run (repeatable)

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint            # lint only passes after typecheck has built dist/
python3 scripts/validate_pack.py && python3 infra/security/security_scan.py && pnpm audit --prod
pnpm test                              # as a fresh clone: no DB
# with a DB: `pnpm test:db` needs Docker. Without Docker, run Postgres 16/17 + pgvector on 127.0.0.1:55432
# with the credentials from ~/.hawa/test-postgres.env, build hawa_test / hawa_repair with
# packages/db/src/test-template.ts buildDatabase(), apply db/test-fixtures.sql, export the four
# lines from `envTestLines()`, then `pnpm test`.
```

Environment differences: Postgres 16 here (production uses 17). Verdana was not installable (the MS core-fonts download is blocked), so the ~150 font-dependent failures are attributed, not disproven. rsvg-convert 2.58 was installed from apt.
