# Wave 8a evidence (2026-09-25): file-store rehearsal and the nightly Restate backup

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
