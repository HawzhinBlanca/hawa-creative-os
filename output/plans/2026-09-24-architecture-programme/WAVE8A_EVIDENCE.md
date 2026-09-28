# Wave 8a evidence (2026-09-25): file-store rehearsal and the nightly Restate backup

> **History only (2026-09-28, ADR-127).** This records studio-v2. On the owner's decision of
> 2026-09-28, `codex/research-grade-design-system` is the mainline; studio-v2's RequestLifecycle
> (wave 7) was superseded there by that branch's own implementation. Of this wave, the file-store
> backfill fixes and staged keys were ported with their tests (the rehearsal was not repeated). The
> Restate backup script and restore drill were not ported: the mainline has its own (ADR-053 to
> ADR-057, ADR-081); only the watchdog's recovery of a backup killed outright was carried over, in
> that design (ADR-127).

Branches merged into `claude/reliability`: `worktree-wf_8f9499c9-d1e-1` (REH: 4e2e6e5, 7515302), `worktree-wf_8f9499c9-d1e-2` (RSB: 088ce5e). Each was implemented, then reviewed by a separate agent that re-ran the tests; REH needed one fix round, RSB passed review.

## Phase 3.1 rehearsal (REH)

Full record: `PHASE3_EVIDENCE.md`. Run on a restore of the nightly dump `hawa_20260924T003003Z` into a scratch database on the test server (no SQL on production); the scratch databases, the rehearsal file store and the decrypted dump were removed afterwards.

| | Before | After copy + strip + VACUUM FULL |
|---|---:|---:|
| Database | 331,544,243 B | 65,189,555 B (−80.3%) |
| `pg_dump -Fc` zstd:long | 41,291,070 B | 13,710,435 B (−66.8%) |
| Dump wall time (mean of 3) | 1.17 s | 0.39 s |

- Store: 275 files, 143,291,629 B; blob-verify: 0 missing, 0 corrupt. A second copy and a second strip do nothing; a SIGINT-interrupted copy resumes to the same result as an uninterrupted one.
- Backfill bugs found and fixed (tests first): verify did not report rows that would fail release B's foreign keys; the stop logic reported `stoppedEarly` when nothing was left and exited 0 after SIGINT.
- Release B's foreign keys are staged in `staged/blob_fks.sql` (not in migrations). They fail on the rehearsal copy because of one production row: a `canva_design_plans` row created 2026-09-14 21:37Z whose source is the fixture string of `design-studio-orchestrator.test.ts`. **Owner decision needed** before release B.
- Not met: the zero-inline checks. 22 outbox payloads, 22 task events and 1 planner request still carry a photo, because the studio service and the planner still read it (PHASE3_EVIDENCE.md section 8).

## Phase 2.6 nightly Restate backup and restore drill (RSB)

- `infra/backup/restate-nightly.sh`: throws the Telegram kill switch through Core, drains (≤5 min, then proceeds), stops Restate, tars its volume with Restate's own image, starts it, waits until it serves the workers, releases the switch, then encrypts with the dump's cipher and retention. Wired first into `nightly_backup.sh` behind `HAWA_RESTATE_BACKUP` (off until the lead enables it).
- Messages sent while the switch is thrown wait in Telegram and are handled after release (code references in `infra/backup/README.md`; confirmed in drill RD1: first answer 1.1 s after release).
- Drill RD1 on the chaos stack, twice: backup 16.6 / 16.8 s, Restate down 6 s, archive 727,072 B, restore 2.9 s, R1 on the restored copy delivered in 10.1 / 9.1 s, 0 resends. All 55 invariants held.
- Not met: the AHEAD reconciliations cannot be checked until RequestLifecycle (2.3) is merged.
- Lead's follow-up (this merge): a backup killed outright left the switch thrown until the next night. `restate-nightly.sh --recover` now undoes a cut-off run's changes, and the watchdog runs it within 5 minutes once that run's process is gone (3 new tests). Two `blob-prebackfill` assertions anchored the nightly OK line at `gc_deleted=…$`; the line now ends with `restate=… restate_s=…`, so they were loosened.

## Gate on the merged branch

- `pnpm build`: 0. Full suite (`HAWA_TEST_WORKERS=3`): 405 files passed, 1 failed, 4 skipped; 3,050 tests passed, 1 failed, 49 skipped. The one failure is `r11-release-gate` test 1, which needs the release manifest the lead writes at release.

## Lead's follow-up: tonight's nightly and the test residue (2026-09-25 03:45-04:10)

- Nightly 20260925T003003Z: OK, restore verified (tasks 1,612, events 2,090), dump 48,338,598 B in 3 s. The first night with the file store: `blobs=0 new_blobs=0 refs_without_row=186 gc_deleted=0`.
- The production store is empty for an ordinary reason. Tonight's dump was restored into a scratch database on the test server (`hawa_scratch_blobcheck_*`, dropped afterwards; no SQL on production). It holds 0 tasks, 0 studio candidates, 0 plans and 0 task files created after release A was deployed (2026-09-24 12:35Z), so nothing has been written yet. The 186 references without a row are hashes of bytes still held in their rows; the production copy (backfill) gives them rows.
- The test residue that blocks release B's keys, identified on the same copy by non-personal fields only:
  - 11 tasks titled `[TEST] Studio Task` (the fixture title; matched by hash against the test sources), created 2026-09-14 21:36:36-21:37:24Z, requested by fixture principal `…b000-000000000010`, with no source message. 10 are `received` and 1 is `human_review`, so they are open in the office's queue. They have 11 studio runs (keys `key-<uuid>`) and 6 Canva plans, including plan `31118789-…` whose 21-byte source blocks `canva_plan_source_blob_fk`.
  - Task `23b71a0c-…` (21:38:17Z, request key `studio-live-golden-01-…`, a 40-character title) is a deliberate live studio proof, not test residue.
  - 2 tasks from 2026-09-13 have titles beginning "test". They look like hand-typed trial requests; they were not classified and are left alone.
- **Owner decision:** retire the 11 `[TEST] Studio Task` tasks, their runs and plans (cancel and soft-delete them through Core, with an audit reason). Nothing has been changed.
