# Tasks to reach a shippable 10/10 — for the implementing agent (2026-09-17 18:45)

Context: `output/audits/2026-09-17-reality-check/REPORT.md`. All rules in
`output/plans/2026-09-16-flawless-system/GEMINI_PROMPT.md` still apply. Work strictly in this order.
T0 and T1 come before any feature work.

---

## T0 — Restore the production database (do nothing else first)

The live database was destroyed and recreated empty at `2026-09-17T15:28:05Z`. Tasks, Canva bindings,
design plans, export bytes, journals, outbox and inbox are all gone.

**Do:** pause the Telegram bridge so no new rows land mid-restore. Restore
`infra/backup/snapshots/hawa_20260917T140847Z.sql` (324 MB, 67 table dumps, verified to contain
`hawa.tasks`, `hawa.canva_design_plans`, `hawa.canva_bindings`, `hawa.inbox_events`). Re-run migrations
to bring the restored schema to head. Resume the bridge.
**Accept when:** task `8c32c048-1423-4c69-8651-b64f547ab830` resolves again through the API; the plan,
binding and inbox counts match the snapshot; Sewa's re-driven task and its Canva design id are present;
the lead can query `hawa.canva_design_plans` again.
**Proof:** `T0_RESTORE.md` — pre-restore counts (zero), the restore log, post-restore counts per table,
and the recovered task resolving by id. State plainly how many minutes of data were lost.

## T1 — Make this impossible to repeat

**Do:** (a) the postgres volume must never be recreated by a deploy — pin it as external, or make
`deploy.sh` refuse to continue if the volume's creation timestamp changed. (b) `deploy.sh` must abort
when `HAWA_BUILD_COMMIT` would be `unknown`; no build stamp, no deploy. (c) copy each nightly snapshot
off this disk (58 snapshots totalling ~19 GB currently sit beside the database they protect).
(d) schedule the existing `backup_restore_drill.sh` and record results in `hawa.backup_drills`, which is
currently unused.
**Accept when:** the lead runs `deploy.sh --apply` twice and the volume timestamp is unchanged both
times; a deliberately unstamped deploy is refused; a restore drill row exists with a real timestamp.
**Proof:** `T1_DURABILITY.md` with the refusal transcript and the drill record.

## T2 — Restore traceability and flag discipline

**Do:** set `DESIGN_PIPELINE_V3=off` and `DESIGN_STUDIO_V2=off` in production until the lead enables
them. Flags are the owner's to turn on, not the implementer's. Ensure the deployed containers report a
real `HAWA_BUILD_COMMIT` equal to `git rev-parse HEAD`.
**Accept when:** health and the container env both show the true commit, and both flags read `off`.
**Proof:** `T2_TRACE.md` with the env dump and `git rev-parse HEAD` side by side.

## T3 — Spend control, so a test run cannot drain the account

Credits are exhausted again; the qualification alone cost USD 3.42 and production cannot serve anyone.

**Do:** enforce the caps already specified (USD 1.00 per brief, USD 30 per day office-wide) in the cost
governor, applied to scripts and qualification runs too, not only to requester traffic. A run that would
breach the cap stops and says so. Add a low-balance warning to the operator chat before exhaustion, not
after.
**Accept when:** the lead sets the daily cap to USD 0.01 and a qualification run refuses to start with a
truthful message; the warning fires at the configured threshold.
**Proof:** `T3_SPEND.md` with both transcripts and the ledger for the run.

## T4 — Undo the two regressions made to go green

**Do:** (a) restore the `POOR_GRID_ALIGNMENT` hard-QA defect removed in `520cbcb`, or replace it with a
stricter alignment gate and justify the threshold against the six confirmed exemplars. Poor alignment is
precisely what makes these layouts look amateur. (b) remove the font-size clamp that mutates the
winner's layout inside the QA stage. QA must **fail** a layout with unreadable sizes, not silently
rewrite it after the metrics were computed. Fix the generator instead, by passing the minimum size as a
constraint into the layout call.
**Accept when:** a layout with 9 px body text fails QA with a named defect instead of being rewritten;
a layout with alignment below the threshold fails; the metrics report describes exactly what ships.
**Proof:** `T4_REGRESSIONS.md` with a red-before/green-after transcript for each.

## T5 — Qualify the whole pipeline, not one stage

The current ledger shows one call per brief — layout generation only. The vision critique (P05) and the
pairwise dimension-wise judge (P07) are never invoked; the qualification's "judge" is `Math.sign()` over
metric scores.

**Do:** the qualification must exercise the full path per brief: retrieval, layout, art where the
concept asks for it, **the real vision critique**, gated refinement, and **the real LLM judge** with
order swap and the degraded canary. Every model call gets its own ledger row with stage, completion id,
request id, tokens, cached tokens and recomputed cost.
**Accept when:** the ledger shows multiple rows per brief covering at least layout, critique and judge;
the lead recomputes three rows by hand and they match; the canary is beaten by the real judge, not by a
metric comparison.
**Proof:** `T5_FULL_QUALIFICATION/` with the ledger and per-brief journals.

## T6 — Fix the named design defects

From three inspected renders: `brief_01` is roughly 40% empty with a stray floating rule; `brief_05` has
eyebrow letter-spacing so wide it wraps onto two lines; `brief_07` has a large unstyled cream block
across the bottom clashing with the dark design. Sorani text itself renders correctly — keep that.

**Do:** (a) recalibrate the negative-space and density metrics against the six confirmed exemplars so a
40%-empty canvas fails. (b) constrain tracking so an eyebrow can never wrap. (c) fix the footer or venue
band so it inherits the palette instead of defaulting to cream. (d) raise skeleton diversity: 5 distinct
layouts across 20 briefs means each repeats four times, and repetition was the original complaint.
**Accept when:** twenty fresh briefs produce at least 12 distinct skeletons, no eyebrow wraps, no
off-palette block appears, and the lead cannot find a render with a large empty band.
**Proof:** `T6_DEFECTS/` with before and after renders for each defect.

## T7 — End-to-end live proof from a real message

**Do:** with credits restored and flags enabled for one test chat only, send a real Telegram brief and
carry it all the way through to a Canva link, then send a revision and carry that through too.
**Accept when:** the lead reads the full journal for both, opens both Canva designs, and the copy and
font checks pass on the exported file.
**Proof:** `T7_E2E.md` with the journals, the Canva ids and the exports.

## T8 — The owner's blind preference test

**Do:** prepare 10 pairs, new pipeline against the current planner, unlabelled and randomised, with the
randomisation sealed before the owner sees them.
**Accept when:** the owner has rated all ten and the result is recorded with the seal.
**Proof:** `T8_BLIND.md`.

---

## Definition of 10/10

All of: production data intact with a tested restore path; a deploy that refuses to run unstamped and
cannot recreate the data volume; spend capped so no run can exhaust the account; no QA check deleted and
no silent mutation of designs; a qualification that exercises every stage with a hand-checkable ledger;
zero named visual defects and at least 12 distinct skeletons in 20; one real Telegram brief and one real
revision proven end to end; and the owner preferring the new pipeline in a sealed blind test.

Report per task in the usual shape: `TASK / STATUS / COMMITS / PROOF / LIVE IDS / DEVIATIONS / WHAT I DID
NOT DO`. Do not mark anything accepted yourself; the lead re-executes every proof.

---

## T9 — Make the qualification survivable (added 2026-09-17 after two failed lead runs)

The lead ran the full multi-stage qualification twice. Both runs made genuine multi-stage calls — the
log confirms P05 vision critique, P07 order-swapped judge and a real degraded-canary judgement per
brief — and both died with `TypeError: fetch failed` / `UND_ERR_SOCKET` ("other side closed") against
`172.66.0.243:443`, first at brief 7 of 20, then at brief 5 of 20. **Neither run wrote any output**, so
`LEDGER.csv` and `P10_QUALIFICATION.*` are still the earlier single-stage run, and roughly ten briefs of
paid calls were spent with nothing recorded. This is now the blocker on the whole qualification.

**Do:**
1. **Checkpoint per brief.** Append each brief's ledger row and write its artifacts as soon as that
   brief completes. A failure at brief 12 must leave 11 briefs of usable, paid-for evidence.
2. **Resume.** Support `--resume` so a re-run skips briefs already completed rather than paying twice.
3. **Retry transient failures with backoff.** `UND_ERR_SOCKET`, `ECONNRESET`, `ETIMEDOUT` and
   `fetch failed` are retryable: at least three attempts with exponential backoff, and log each retry.
   A run must not die on one dropped connection.
4. **Hold the connection properly.** Configure an HTTP agent with keep-alive for these long
   multi-minute requests, and reduce concurrency if that is what is provoking the drops.
5. **Report partial runs honestly.** If only 14 of 20 briefs completed, the report says 14 of 20 — it
   must never present a partial run as a full one, and must never fill gaps with estimates.

**Accept when:** the lead kills the process deliberately at around brief 8 and the ledger still contains
eight complete, hand-checkable rows; a re-run with `--resume` completes the remainder without repaying
for the first eight; and a full run finishes with one ledger row per stage per brief.
**Proof:** `T9_RESILIENCE.md` with the deliberate-kill transcript, the resumed run, and the final ledger.

**Note for whoever investigates:** the failing socket had local address `10.3.0.2`, which suggests a
tunnel or VPN in the path rather than an OpenAI fault. Confirm the host's egress route before assuming
the provider is at fault.
