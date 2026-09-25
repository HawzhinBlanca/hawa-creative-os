# Research-grade upgrade: current-candidate reality check

**Date:** 2026-09-25. **Branch:** `codex/research-grade-design-system`. **Latest source candidate:** `1d93807` (sealed manifest commit `c42dc3f`). **Verdict:** engineering work is progressing; **Hawdesign is not qualified as 10/10**. The earlier source checkpoints in this report were `3b5bc8a` and `9eaa8bc`; their observations remain historical evidence.

## What has been demonstrated

- The current branch has one accepted item (R00), ten in progress and seventeen planned. R01–R05, R07–R08, R11 and R17–R18 have implemented slices and dated evidence. `WORK_ITEMS.csv` records each exit criterion; an in-progress row is not accepted.
- The fixed-tree whole suite passed **406 test files / 3,047 tests**; 4 files / 48 tests were skipped. TypeScript checks passed. Blueprint validation passed **729**, with zero warnings and zero failures. The release manifest verified the source candidate and its flags (`DESIGN_PIPELINE_V3=off`, `DESIGN_STUDIO_V2=off`). The first Studio whole-suite run failed 5 tests in 3 files because older fixtures omitted the new saved-run hash fields or did not await the asynchronous context builder; those fixtures were repaired and the full suite rerun passed.
- The Canva planner generated a mocked second-client editable draft from active versioned DNA and a hash-checked logo, with no KAAE palette or assets in the model request. Stale brand versions refuse a fresh import. This is a partial R11 implementation; Studio v3 remains KAAE-specific, and brand asset approval is unproved.
- Standard Studio now binds a second client's own DNA and logo to its run and refuses an unqualified v3 route. Its focused proof reaches the brief stage and a logo-policy validator; no completed second-client Studio design or export has been qualified. Historical DNA bytes remain recoverable by saved version/hash, while new generation stops after supersession.
- Approval requires an explicit export selection, checks selected bytes, and refuses absent QA. A normal checked Canva PPTX recapture after approval creates a new revision and invalidates the earlier approval. Delivery refuses an approval if a later Canva export is stored, including when the QC callback did not complete. Mocked-Canva and isolated PostgreSQL negative controls cover these cases.
- Blinded study packaging and analysis, a private corpus inventory, truthful review missing states, and fail-closed unimplemented lifecycle delivery targets exist. Their evidence files state why none is final admission.

## What failed or remains unproved

- The formal seven-stage release script passed stages 1–5 and its production database isolation check, then **stopped in stage 6** because this branch has no remote tracking branch. Its stage 7 was not run. The separately executed full suite does not turn that gate green. Log: `/private/tmp/hawdesign-rg-20260925-final-gate.log` on this host.
- No inspected deployment receipt ties this candidate to a running immutable image. All product admission Gates A–H therefore remain `NOT_RUN_DEPLOYMENT_REQUIRED` under `scripts/release_admission_verdict.ts`.
- No independently authorized, sealed 200-case corpus and no blinded human ratings were supplied. Creative superiority, language quality and model promotion remain unmeasured. The 100-task office pilot test uses synthetic in-memory export bytes; it is **not** a production pilot.
- Exact export-to-revision and capture-set proof is missing. An edit not followed by a stored export, a race between freshness lookup and publication, and complete Canva/source restoration are not closed. R17 is in progress, even though the exercised capture paths now refuse stale delivery.
- The RequestLifecycle questions/decisions/cutover work, complete client-general BrandKit and retrieval, final-export visual preflight, typed model egress and uncertain-call accounting, live Drive/Sheets/requester receipt, clean-host recovery, and a dated A–H dossier remain planned or partial. Production flags are off.
- Studio's packaged renderer still contains a KAAE logo fallback when no logo is supplied. Its v3 prompts, font selection and exemplars are not client-general. Client asset approvals and three unlike-client design trials remain open.

## Decision and next proof order

Do not call this candidate 10/10 or enable the new pipeline on the strength of the green suite. Continue R07–R10 to close one durable request-to-receipt path, R11–R16 to prove client-general editable designs and final-export QA, and R17 to bind capture/QC/revision with publication-time concurrency protection. Then run the authorized blind human study, deployed-image and recovery gates. Each work item is accepted only when its own negative tests and external evidence match its exit condition.

No production deployment, remote push, public PR or human study result was made by this checkpoint.
