# R26 — Isolated full-app candidate rehearsal

**Date:** 2026-09-27. **Status:** in progress; no production admission.

## Scope and reason

The earlier source/voice drills did not exercise the production Desk build and
nginx together with Core, worker, PostgreSQL, Restate and the real offline parser.
The existing `hawa-chaos` project now has an optional candidate profile for this
connected rehearsal. No architectural foundation or runtime dependency changes.
Requirements: FR-001/014/017/060/065/069/070/075 and NFR-003/008/011/013/024/025;
linked source contracts remain in `plans/traceability.csv` and WORK_ITEMS.csv.

## Defect found and repaired

Browser entry saved `canva_manual` copyEn/copyCkb with separate design instructions,
but the planner's legacy parser required headlineEn or an inline divider. The
explicit **Design in Canva** action refused the saved request with COPY_REQUIRED.
The planner now recognizes structured Desk copy, preserves the exact strings,
accepts Sorani-only requests, and excludes the queue title from design copy.
Missing/invalid copy still fails closed. Historical source/document branches keep
their existing exact-copy rules. Desk's hard-coded model promise was replaced with
wording that points to the actual saved model receipt.

The added tests first returned **3 failed / 26 passed**: two demonstrated the
bilingual/Sorani-only rejection; one failed only on diagnostic wording (missing
copy was already refused). After the fix, planner/intake/fake regression checks
passed **3 files / 47 tests**. Repository source/test typecheck, standalone chaos
typecheck, lint and security scan passed. Core and Desk Docker builds passed.

## Observed development trial

The first deployed candidate scenario passed **16 invariants** in 78.5 seconds
before the manual-copy addition. It used real offline Docling, synthetic PDF and
silent Ogg fixtures, and explicit fake provider/model/Telegram/Canva services.
A Restate SIGKILL/restart and worker SIGKILL/restart preserved the review wait.
One original download per source, exact requester confirmation, manual voice with
no paid attempt, one revision child and one simulated delivery were verified.

Browser interaction verified sign-in/out, retained originals and manual voice
review, bilingual task entry, the initial copy rejection and the repaired explicit
handoff. The rebuilt app displayed the saved planner receipt and a retrieved
simulated Canva import. Screenshot: [Desk handoff](R26_DESK_HANDOFF.png). The browser
checks used keyboard actions; pointer targeting in the embedded browser hit
unexpected controls, so those observations were not treated as authentication bugs.

The final candidate scenario adds bilingual intake/generation replay, exact saved
copy/source hash, image-label verification and internal-network checks. Its clean
source run and full regression are still pending at this implementation checkpoint.

## Reproduction

```sh
pnpm exec tsx packages/testkit/chaos/run.ts --candidate --only R1.S3.SOURCES --poller worker --keep
```

See `packages/testkit/chaos/README.md`. This replaces only disposable hawa-chaos
data. The sanitized report includes source commit, changed runtime file hashes,
immutable image IDs, build labels and network names. No credentials enter evidence.
Memory observations are sparse samples, not continuous peaks. Recreating Core/Desk
requires refreshing nginx's cached upstream addresses; production deploy already
handles its proxy reload/restart.

## Remaining qualification

- Manual requests still receive NEEDS_A_DESIGNER from the guarded retired workflow;
  Desk misleadingly describes this as an automatic draft failure. Correct the
  manual ownership/status behavior without enabling automatic generation.
- Export preview still uses generic QA-pending wording; any improved status must
  bind to the exact captured artifact/revision, not infer approval from task state.
- Real Canva source editing/reopen, exact export binding and native Sorani review.
- Real named OIDC reviewer and human decisions; this trial uses a synthetic role.
- Real provider/delivery/billing and multilingual speech/PDF quality. Silence and
  fake models establish no creative or transcription quality claim.
- Clean-host WAL/PITR/Restate restore and sustained resource/load evidence. Chaos
  PostgreSQL uses fsync=off, and source downloads here use direct Core responses;
  production X-Accel paths and physical durability have separate gates.
- Retrieval relevance/latency and independent blind creative-quality admission.

No live provider calls, real messages, production deployment or flag changes were
made. App-wide 10/10 is not established by this rehearsal.
