# Phase 3.1 evidence: the file store rehearsal on a restored copy (2026-09-25)

ADR-035, FILESTORE_DESIGN.md sections 2.3, 4, 5 and 7 ("Order and gates", step 2). Worktree branch `worktree-wf_8f9499c9-d1e-1`, from `studio-v2` at `1c1316d`. Everything below ran on this Mac against the **test** server (`hawa-test-postgres`, 127.0.0.1:55432). Nothing touched production: no SQL, no port 54332, no `hawa-production-*` container, no chaos stack. The dump holds client data; it stayed in the session scratchpad, and it and the database are gone (section 9). This file gives counts and sizes only.

## Summary

| Item | Result |
|---|---|
| Restore of the newest nightly dump | done: `hawa_20260924T003003Z`, 1,607 tasks and 2,080 events, 5.31 s |
| Rehearsal: measure, copy, verify, strip, verify, VACUUM FULL, measure | done |
| Database size | **331,544,243 → 65,189,555 bytes (−80.3 %)** |
| `pg_dump -Fc --compress=zstd:long` | **41,291,070 → 13,710,435 bytes (−66.8 %); 1.17 s → 0.39 s** (mean of 3) |
| File store | 275 files, 143,291,629 bytes |
| Zero-inline checks | **not zero**: 22 outbox payloads, 22 `task_events`, 1 planner request still carry a photo. This release does not strip JSON photos, on purpose (section 5) |
| Rehearsal receipt | written: `~/.hawa/logs/blob_backfill_rehearsal.json`, `verifyFailures` 0, one row left as it is, `foreignKeyBlockers` 1 |
| Second copy and second strip do nothing | proven (0 stored, 0 linked; 0 stripped) |
| Copy stopped by SIGINT resumes | proven: same files and same rows as a copy that was never stopped |
| Bugs the rehearsal found in `blob_backfill.ts` | 2, fixed tests first (section 6) |
| Release B foreign keys (staged) | `staged/blob_fks.sql`. **Fails on the restored copy as it is**, because of one test-fixture row in production (section 7). It validates once that row is resolved, and fails at VALIDATE when one referenced blob row is missing |
| Code paths still writing image bytes into Postgres | listed with file:line (section 8) |
| Scratch database and `~/.hawa/blobs-rehearsal` removed | done (section 9) |

## 1. The dump and the restore

The newest nightly is `hawa_20260924T003003Z`. The 2026-09-25 night had not run yet. The archive copy (`HawaBackups/hawa_20260924T003003Z.dump.enc` in the owner's iCloud folder, the launch agent's `HAWA_BACKUP_ARCHIVE_DEST`) was decrypted into the scratchpad the way `restore_drill.sh` decrypts: `openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -pass file:~/.hawa/backup_passphrase`. No key was printed.

- `shasum -a 256` of the `.enc` file equals its `.sha256` sidecar (`8bb97a8f…`).
- The decrypted dump hashes to `32d1fc4a…`, the same as `infra/backup/snapshots/hawa_20260924T003003Z.dump.sha256`. It is 41,262,495 bytes.
- `pg_restore -l` lists no `hawa.blobs`: the dump predates migration 019. The restored `hawa.schema_upgrades` ends at `017_comparison_link_reissue.sql`.
- Restore: `createdb hawa_restore_20260924t003003z`, then `pg_restore --exit-on-error` (as the owner, with owners and privileges kept) took **5.31 s**. The copy has 1,607 tasks and 2,080 task events, which matches `backup.log` for that night (`tasks=1607 events=2080`).
- `npx tsx packages/db/src/upgrade.ts` (deploy.sh step 6) with `DATABASE_URL` set to the copy. It applied `018_desk_list_indexes`, `019_blob_store`, `020_inbox_event_dedupe`, `021_review_comments` and `022_publication_executor`.
- Store: `initBlobStoreDir("$HOME/.hawa/blobs-rehearsal")` wrote the marker, `sha256/` and `tmp/`.

Every step ran through a scratchpad wrapper. It takes the owner URL from `.env.test`, replaces only the database name, and refuses anything that is not `@127.0.0.1:55432/hawa_restore_*`. It exports `HAWA_BLOB_DIR=$HOME/.hawa/blobs-rehearsal`, and runs `node --import tsx scripts/blob_backfill.ts … --log <scratchpad>/<step>.ndjson`. Wall times come from `time.time()` before and after each command.

**Two passes.** Pass 1 ran on the script as merged (1c1316d) and found the two bugs in section 6. The database and store were then dropped. Pass 2 is a fresh restore, run with the fixed script. **Every number in this file is from pass 2** unless it says pass 1.

## 2. The rehearsal, step by step (pass 2)

| # | Command (`blob_backfill.ts` unless noted) | Exit | Wall | Result |
|---|---|---|---|---|
| 1 | `--phase all --mode verify --measure` | 1 | 2.32 s | Not copied yet: 45 JSON photos, 151 plan and editable sources, 255 candidate PNGs. 0 cut-outs and 0 comparison pairs in this dump. One row left as it is (section 7) |
| 1b | `dumptime.sh` (pg_dump × 3) | 0 | 1.21 / 1.12 / 1.17 s | 41,291,070 bytes each time |
| 2 | `--phase all --mode copy --batch 1`, SIGINT at progress line 41 | **3** | | "Stopping after this batch…". Reference photos done (22 stored, 22 linked); plan sources 19 stored, then stopped; candidates stopped; 25 files, 0 `tmp/*.part` |
| 3 | `--phase all --mode copy` (resume) | 1 | 5.15 s | 61 plan sources stored; 217 candidate puts (189 distinct files), 99 hash columns linked. Exit 1 = the one row left as it is |
| 4 | `--phase all --mode copy` (again) | 1 | 0.27 s | **0 stored, 0 linked**; no progress line carries a hash |
| 5 | `--phase all --mode verify` | 1 | 0.82 s | `notCopied` 0 in every phase; strippable 151 + 255; `inlineJson` 45; one problem: the fixture plan (`leftAsIs`, `blocksForeignKey`) |
| 6 | `fkproof.sh` on three clones (section 7) | | | as expected |
| 7 | `--phase all --mode strip` | 1 | 1.40 s | **406 bytea values set to NULL**: 151 plan and editable sources, 255 candidate PNGs. Exit 1 = reference photos refused (section 5) |
| 8 | `--phase all --mode strip` (again) | 1 | 0.21 s | **0 stripped**, 0 scanned. `pg_trigger.tgenabled` is `O` for `task_events_append_only`, `immutable_canva_plan`, `canva_editable_sources_immutable`, `protect_comparison_pair` |
| 9 | `--phase all --mode verify --write-receipt` | 1 | 0.87 s | Receipt written (section 4) |
| 10 | `vacuum.sh`: `VACUUM (FULL, ANALYZE)` on the seven tables of step 2 | 0 | 0.07–0.15 s each | |
| 11 | `--phase all --mode verify --measure` | 1 | 0.60 s | sizes below |
| 11b | `dumptime.sh` | 0 | 0.42 / 0.37 / 0.38 s | 13,710,435 bytes each time |
| 12 | `node apps/core/dist/tools/blob-verify.js` (the drill's check) | 0 | | `rows 275, checked 275, missing 0, corrupt 0, orphanFiles 0, referencedWithoutRow 1` (the fixture's hash) |
| 13 | `find ~/.hawa/blobs-rehearsal/sha256 …` | | | 0 files not mode 0444, 0 directories not 0755, 0 files in `tmp/` |

The CLI exits 1 on any problem, including rows left as they are. A strip with `--phase all` therefore always exits 1, because the reference-photo refusal is recorded as a problem (section 10).

## 3. Measurements (`--measure`, `dumptime.sh`)

| | Before (step 1) | After (step 11) | Change |
|---|---:|---:|---:|
| `pg_database_size` | 331,544,243 | 65,189,555 | −80.3 % |
| `canva_design_plans` | 122,855,424 | 696,320 | |
| `canva_editable_sources` | 114,229,248 | 278,528 | |
| `design_studio_candidates` | 30,769,152 | 442,368 | |
| `task_events` | 7,806,976 | 7,462,912 | JSON photos stay |
| `outbox_commands` | 4,653,056 | 4,431,872 | JSON photos stay |
| `photo_cutouts` | 40,960 | 40,960 | no rows |
| `comparison_pairs` | 49,152 | 49,152 | no rows |
| pg_dump size | 41,291,070 | 13,710,435 | −66.8 % |
| pg_dump wall, mean of 3 | 1.17 s | 0.39 s | |

All sizes are in bytes (`pg_total_relation_size`). The largest table after the move is `canva_export_bytes` at 34,062,336 bytes, which stays in bytea by ADR-035.

**The store** (from `hawa.blobs`) holds 275 files and 143,291,629 bytes:
- 80 PPTX files, 117,850,901 bytes;
- 189 PNGs, 24,996,040 bytes;
- 6 JPEG photos, 444,688 bytes.

`du` gives 140,532 KB for `sha256/`. All 71 editable sources have a hash equal to a plan source's, so copy stored no file for them (0 scanned in step 3). The 45 JSON photo occurrences are 22 task links and 6 distinct files.

**Against the design's expectations** (section 5):
- Database "about 60 MB after VACUUM FULL": measured 62.2 MiB (65,189,555 bytes).
- Store "about 155 MB": measured 143.3 MB. The design counted production on 2026-09-24 with 82 sources and 2 cut-outs; this dump has 80 PPTX sources and 0 cut-outs.

**Caveat.** A freshly restored database has no bloat. So "before" here is smaller than production's own size (328 MB in the design, 2026-09-24). Production's before and after must be measured on production's own run. That was not done here, because production is off limits.

## 4. The rehearsal receipt

`~/.hawa/logs/blob_backfill_rehearsal.json`, mode 0600, 2,757 bytes. This is the path `assertTargetAllowed` reads by default. It was written by step 9. Its contents:
- `database`: `hawa_restore_20260924t003003z`
- `verifyFailures`: 0
- `foreignKeyBlockers`: 1
- `leftAsIs`: one entry, table `canva_design_plans`, "source_content is of no type the store knows; left as it is", `blocksForeignKey: true`
- all five phases
- 22 migration checksums, 001 to 022

What a production copy will need, from this receipt:
- `--production --accept-left-as-is 1`;
- production's `hawa.schema_upgrades` must have exactly these 22 checksums, which means deployed from this code with 018 to 022 applied. If another migration merges before the production copy, the checksums differ and the rehearsal must be run again.

## 5. Zero-inline checks (FILESTORE_DESIGN.md section 7, acceptance 1)

This acceptance is in section 7 of the design; the task called it section 6. The outbox query is the design's, verbatim. The same `inline` test was run on `task_events.data` and `canva_design_plans.request` (`inline.sql`, after step 11).

| Check | inline | Rows |
|---|---:|---:|
| `outbox_commands`, `task.created`/`task.dispatch` | **22** | 1,595 |
| … `over` (> 4 KB with text fields ≤ 2 KB) | **53** | |
| `task_events.data` | **22** (all `task.created`, 5,165,101 bytes of JSON) | 2,080 |
| `canva_design_plans.request` | **1** | 107 |
| inline `task_events` whose task has no `task_files` row | 0 | |
| inline outbox rows whose task has no `task_files` row | 0 | |
| bytea still set after strip | plans 1 (the fixture), editable 0, candidates 0, cut-outs 0, pairs 0 | |

**Acceptance 1 is not met, and cannot be in this release.** `strip` refuses reference photos in JSON, because readers still read the base64:
- `design-studio-service.ts:208-266` (`requestImages`);
- `canva-design-planner.ts:164` and `:340-365`.

Every photo is in the store, and every task that carries one has its `task_files` row. So the JSON strip can follow as soon as those readers read `task_files`.

Of the 53 `over` rows, 31 carry no inline bytes at all; the largest is 5,989 bytes. This confirms the design's finding 2 on this copy: the 4 KB target fails on text alone.

## 6. Bugs the rehearsal found, fixed tests first

Tests are in `packages/db/test/blob-backfill.test.ts`. On the merged script, 3 of 17 failed: the two new tests below, and the receipt test that depends on the second. After the fix, 17 of 17 pass.

1. **Verify missed hashes that name no file row when the row has no bytes, so a clean receipt did not predict release B's VALIDATE.** Verify checked stored hashes only through `JOIN hawa.blobs`, and copy's select needs bytes. A row with a hash, no bytes and no file row (a failed put before 019, or bytes lost) was invisible to both, but it fails `VALIDATE CONSTRAINT`. Rows copy leaves as they are, when they carry a hash, fail it too; that is the fixture in section 7.
   - Fix: verify now reports such rows (`leftAsIs`, `blocksForeignKey`), and marks `blocksForeignKey` on left-as-is rows that carry a hash. The receipt gains `foreignKeyBlockers`.
   - Test: "verify names every row whose hash has no file row (release B's foreign keys reject it), and the receipt counts them".
2. **A stopped run was reported wrongly and exited 0.**
   - `stoppedEarly` was set whenever the budget or the signal flag was seen at the top of the loop. So a `--limit` that ran out exactly as a phase finished reported that phase as stopped, and every later phase was marked stopped even with nothing to do (pass 1: cut-outs and comparisons "stopped" with 0 rows).
   - The CLI exited 0 after SIGINT (pass 1, exit 0), so `copy && …` carried on as if the copy were complete.
   - Fix: the stop is checked after the next batch is read, and only when rows remain. The CLI exits **3** when a run stopped with rows left.
   - Pass 2, step 2: exit 3; cut-outs and comparisons `stoppedEarly: false`.
   - Tests: "the CLI exits 3 when a run stops before it is done, and 0 once a later run finishes" (failed before) and "a run stopped by a signal finishes the batch in hand, says so, and the next run copies the rest" (coverage; passes on both).

**Resume proof.** Pass 1 compared two databases: one where copy was stopped by SIGINT and then resumed, and one where copy was never stopped (a second restore of the same dump with its own store, `…_sigint`, since dropped). The same query (`fingerprint.sql`) gave the same result on both:
- `task_files` 22 rows, md5 `a927814f…`;
- candidate hash columns, md5 `e5518746…`;
- `hawa.blobs` 275 rows, md5 `68ac0895…`, 143,291,629 bytes.

`cmp` of the two stores' sorted file lists: identical. Pass 2's interrupted and resumed copy gave the same three fingerprints again.

## 7. Release B's foreign keys: `staged/blob_fks.sql`

The file is `output/plans/2026-09-24-architecture-programme/staged/blob_fks.sql`, deliberately **not** in `packages/db/migrations/`. It holds the design's "Migration 020" block: six foreign keys, each added `NOT VALID` and then validated.
- `dsc_preview_blob_fk`, `dsc_art_blob_fk`, `canva_plan_source_blob_fk`, `canva_editable_blob_fk`, `comparison_hawa_blob_fk`, `comparison_designer_blob_fk`.
- Each is dropped if it exists first, so the file runs twice.
- The design says "each of the seven", but its block has six; the other hash columns got their foreign keys in 019.
- New test `packages/db/test/blob-fks-staged.test.ts` (3 tests, pass): the file is not in the migrations directory; run as the upgrade runner runs a file, it fails at VALIDATE on a dangling preview hash and leaves no constraint; with every hash stored it validates all six, rejects a new dangling hash and a delete of a referenced blob, and runs twice.

Proof on the rehearsal copy after copy (`fkproof.sh`). Three clones were made with `createdb -T hawa_restore_20260924t003003z`, the file was applied with `psql -v ON_ERROR_STOP=1 -f`, and the clones were dropped afterwards:

| Clone | Prepared how | Result |
|---|---|---|
| `_fk_asis` | as copied | **fails**: `canva_plan_source_blob_fk`, "Key (source_sha256)=(…) is not present in table blobs"; 0 constraints left; 0.084 s |
| `_fk_ok` | the fixture plan retired (below) | **validates: 6 of 6 `convalidated`**, 0.092 s; applied again: 6 of 6, 0.080 s; `DELETE` of a referenced blob row is refused by `dsc_preview_blob_fk`. `blob_backfill --mode verify` on this clone: exit 0, 0 problems, 0 blockers |
| `_fk_missing` | fixture retired, then one referenced `hawa.blobs` row deleted (274 left) | **fails at VALIDATE**: `dsc_preview_blob_fk`, "Key (preview_sha256)=(…) is not present in table blobs"; 0 constraints left; 0.082 s |

### The blocker: a test fixture in production (needs the owner)

Production's dump holds one `canva_design_plans` row, `planned`, created 2026-09-14 21:37:22Z by the system actor. Its source is 21 bytes of text: `fallback-plan-content`, the fixture string at `apps/core/test/design-studio-orchestrator.test.ts:462`.
- A `design_studio_runs` row (`degraded`, 3 candidates) points at it. Deleting it runs into `design_studio_runs_plan_id_fkey`, then the append-only triggers of runs and of the calls ledger.
- 12 tasks and 12 studio runs were created between 21:36:35Z and 21:38:17Z that day. **I did not check which of them are test rows.**
- The store refuses the bytes (not a PPTX), so copy leaves the row as it is, and its `source_sha256` names no file row. It is the one `leftAsIs` row and the one `foreignKeyBlocker` in the receipt.
- Release B's migration **will fail on production** until it is resolved.

The resolution proved on `_fk_ok` (a clone only) keeps the row, its request and its run, and clears only the fake bytes:
```sql
ALTER TABLE hawa.canva_design_plans DISABLE TRIGGER immutable_canva_plan;
UPDATE hawa.canva_design_plans SET status = 'abandoned', source_content = NULL, source_sha256 = NULL
  WHERE source_content IS NOT NULL AND substring(source_content FROM 1 FOR 4) <> '\x504b0304'::bytea;
ALTER TABLE hawa.canva_design_plans ENABLE TRIGGER immutable_canva_plan;
```
The alternative is to remove all of that test run's residue. Either way it is a production data change. **The owner decides; nothing was changed on production.**

## 8. Code paths that still write image bytes into Postgres (what release B stops)

Line numbers are at `1c1316d` plus this branch, which changes none of these files. "RL" marks files the RequestLifecycle (2.3/2.4) work owns or is likely to touch: `apps/core/src/services/telegram-intake/**`, `apps/core/src/routes/**`, `apps/worker/**`, `packages/domain/**`.

**Reference photos as base64 data URIs in JSON.** They are written into `task_events.data`, twice per row, and into `outbox_commands.payload`. The Telegram paths also write them into `inbox_events.payload` through the simulator's `rawJson`.

| Where the bytes are written | file:line | RL |
|---|---|---|
| `task.created` event: `payload` plus the `...payload` spread (the photo twice) | `packages/db/src/repositories/task.repository.ts:517-539` | |
| `task.created` outbox command payload | `packages/db/src/repositories/task.repository.ts:543-561` | |
| Intake payload `studioOptions`, then `createTaskAggregate` | `apps/core/src/services/chat-intake.ts:244`, `:262-266` | |
| `inbox_events.payload` = `rawJson` (a simulator update carries `referenceImageBase64`) | `apps/core/src/services/chat-intake.ts:258-261` | |
| Re-drive copies the task payload, photo included, into a new `task.dispatch` | `apps/core/src/services/redrive.ts:180-194` (spread at `:187`) | |
| Telegram photo downloaded into a data URI | `apps/core/src/services/telegram-intake/media.ts:124`; simulator `:136-137` | RL |
| Photo for an existing request / new request / album part | `telegram-intake/media.ts:254-266`, `:298-310`, `:340-352` | RL |
| Answer to a question (the question task's `studioOptions` spread, plus the answer photo) | `telegram-intake/questions.ts:129`, `:132-154` | RL |
| Pending clarification carries the photo (memory), then a question or "other" with a photo | `telegram-intake/replies.ts:338`, `:377`, `:432-444` | RL |
| Change request with a photo | `telegram-intake/changes.ts:282-305` | RL |
| Reformat copies the prior `studioOptions`, photo included (`...kept`) | `telegram-intake/requester-actions.ts:181`, `:183-201` | RL |
| Webhook intake into `ingestChatCampaignTask` with the photo | `apps/core/src/routes/telegram-webhook.routes.ts:178-185`, `:207-214`, `:226-233` | RL |
| Campaign intake puts it in `studioOptions` | `apps/core/src/services/chat-campaign-intake.ts:397-409` | |
| Legacy planner request JSON (`request.referenceImageBase64`) | `apps/core/src/services/canva-design-planner.ts:164`, `:188`, insert `:256` | |

**bytea columns.** All of these already dual-write since 3.1b (store first, then the bytes). Release B stops the bytes.

| Where | file:line | RL |
|---|---|---|
| Plan source (PPTX), legacy planner | `apps/core/src/services/canva-design-planner.ts:568` | |
| Plan source (PPTX), studio transfer | `apps/core/src/services/design-studio/design-studio-service.ts:2012-2019` | |
| Editable source (PPTX) for the Canva import | `apps/core/src/services/canva-connect-service.ts:340-341` | |
| Candidate `preview_png`, `composite_png`, `art_png`: insert | `packages/db/src/repositories/design-studio.repository.ts:324`, `:326`, `:328` | |
| Candidate PNGs: update | `packages/db/src/repositories/design-studio.repository.ts:443`, `:447`, `:453` | |
| Cut-out `png`, `shadow_png` | `apps/core/src/services/design-studio/photo-cutouts.ts:315-317` | |
| Comparison `hawa_png`, `designer_png` | `apps/core/src/services/comparison-study.ts:707-710` | |
| (stays by ADR-035) Canva export bytes | `apps/core/src/services/canva-connect-service.ts:548` | |

**What the RequestLifecycle work might touch.** Every Telegram path that turns a photo into base64 and hands it to intake is in `telegram-intake/*` and `routes/telegram-webhook.routes.ts`, all RL files. So is the in-memory `pendingClarifications` photo (`replies.ts:26`, `:338`, `:377`), which slice 2.3 replaces with object state. If 2.3 moves questions and answers into Restate, the photo must go in as a blob reference: `put` at `media.ts:124` and a `task_files` row, never the base64. Otherwise the Restate journal and object state gain the bytes that 0.2 stripped from the outbox claim. The `task.dispatch` handler in `apps/worker/src/outbox-consumer.ts:427-428` reads the payload, and 2.5 retires it. None of the bytea writers are in RL files. `task.repository.ts`, `chat-intake.ts`, `chat-campaign-intake.ts` and `redrive.ts` are not in the listed RL directories, but every RL intake path calls them.

## 9. Clean-up

- `dropdb` for `hawa_restore_20260924t003003z`, the pass-1 copies (`hawa_restore_20260924t003003z`, `…_sigint`, `…_before`) and the three FK clones. Afterwards `SELECT count(*) FROM pg_database WHERE datname LIKE 'hawa_restore%'` returned **0**.
- `rm -rf ~/.hawa/blobs-rehearsal ~/.hawa/blobs-rehearsal-sigint`: `ls` answers "No such file or directory" for both.
- The decrypted dump was deleted from the scratchpad; each timing dump was deleted right after it was measured.
- Kept: the receipt (section 4) and the progress logs and summaries in the session scratchpad. They carry row ids, hashes and counts, no client content.

## 10. Not done, and open points

- **Zero-inline acceptance** is not met: the JSON photo strip is not built. It needs readers on `task_files` first (section 5).
- **The production copy, production measurements and release B** are not done: production is off limits for this item. Release B is blocked by the fixture row until the owner decides (section 7).
- **Restate `sys_journal` check for `data:image`** (design section 5) is not done: it needs the production Restate.
- **`--measure` does not time `pg_dump`.** The dump times above come from a scratchpad script (`docker exec hawa-test-postgres pg_dump -Fc --no-owner --compress=zstd:long`, three runs).
- **A strip with `--phase all` always exits 1**, because refusing reference photos is recorded as a problem. It is left as it is; say `--phase plan_sources,candidates,cutouts,comparisons` for a clean exit status.
- **Traceability.** `plans/traceability.csv` is outside this item's files and was not updated.
- **Timings are from this Mac while production runs on it.** They are one run each, except the dump times (three runs).
