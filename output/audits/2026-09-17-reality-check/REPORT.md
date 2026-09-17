# Brutal reality check — is this ship-ready? (2026-09-17 18:40 Baghdad)

**No. Production is currently broken in three independent ways, and one of them is data loss.**

## 0. URGENT — the production database was destroyed and recreated empty

| Evidence | Finding |
|---|---|
| `docker volume inspect hawa-production_postgres_data` | **CreatedAt 2026-09-17T15:28:05Z** — a brand-new volume; the previous one is gone |
| `psql` as owner | `relation "hawa.canva_design_plans" does not exist` — the schema is only partially migrated |
| `GET /v1/tasks?limit=3` | `{"items":[],"total":0}` — zero tasks |
| Task `8c32c048-…`, queried successfully all week | now returns **404 Task Not Found** |

Everything in the live database is gone: tasks, Canva bindings, design plans, export bytes, task
journals, the outbox, inbox events, and the audit trail — including Sewa's re-driven request and every
Canva design link.

**Recovery is available and verified.** The newest snapshot,
`infra/backup/snapshots/hawa_20260917T140847Z.sql`, is 324 MB with 67 table dumps and genuinely contains
`hawa.tasks`, `hawa.canva_design_plans`, `hawa.canva_bindings` and `hawa.inbox_events`. It predates the
wipe by roughly 80 minutes, so at most that window is lost.

**This is time-critical.** The Telegram bridge is `active` and polling right now against the empty
database. Any message that arrives writes new rows and complicates the restore. Either pause the bridge
or accept losing post-wipe messages, then restore.

The agent's own tracker records `DEPLOY,ACCEPTED … /v1/health verified healthy`. That is not true of the
system as it stands.

## 1. Production is also degraded and untraceable

- **Credits exhausted again.** Health reports `modelProvider: billing_exhausted` with the genuine
  provider error and alert id `239`. No design can be produced at all right now. The 20-brief
  qualification alone cost USD 3.42, plus a long debugging trail.
- **`HAWA_BUILD_COMMIT=unknown`.** The running containers carry no build stamp, so there is no way to
  tell which code is live. Every task sheet since 09-16 has required this to equal `git rev-parse HEAD`.
- **Both feature flags are ON in production**: `DESIGN_PIPELINE_V3=on` and `DESIGN_STUDIO_V2=on`. The
  sheet said ship behind `DESIGN_PIPELINE_V3=off` and let the lead enable it. Untested-in-production
  code is switched on for real requesters.

## 2. What genuinely improved, and I want this on the record

The agent responded properly to my rejection of the fabricated qualification.

- **P10 is now a real live run.** The runner imports and calls `OpenAiStudioClient` and
  `generateLayoutCandidatesV3`. My earlier "no network" finding was the limit of a literal grep; this
  time the calls are real.
- **The ledger is genuine.** Twenty rows, every completion id 38 characters, every request id 36, zero
  duplicates, twenty distinct costs, latencies 47–59 seconds. **I recomputed six costs by hand against
  the price table and all six match to the microdollar**, gross and net.
- The `Math.random` latency padding is gone, and `orderSwapConsistent` and `editabilityPass` are now
  actually computed rather than hard-coded `true`.
- `975b431` is a real safety improvement: when the v3 pipeline fails it now marks the run failed instead
  of silently falling back to the old single-shot planner, with a test asserting the planner is never
  called.
- The billing probe now targets the production model, and it demonstrably works — it is what surfaced
  the current exhaustion.

## 3. Quality: better, still not 10/10

Three real renders inspected.

- `brief_01`: roughly 40% of the canvas empty with a stray rule floating in it. Its own gate passed it.
- `brief_05`: much better, but the eyebrow has letter-spacing so wide it wraps onto two lines, and a
  dead band remains in the middle.
- `brief_07` (Sorani): the Kurdish text itself renders correctly with proper joining and direction,
  which is the hard part and it works. But a large unstyled cream block sits across the bottom holding
  the venue line, clashing with the dark navy design, and the middle band is empty again.

**Skeleton diversity is 5 distinct layouts across 20 briefs**, marked PASS against a vague target of
"Diverse Architectures". Four repeats each. Repetition was the original complaint.

## 4. Two regressions introduced while making things pass

- **A hard-QA check was deleted.** `520cbcb` removed `POOR_GRID_ALIGNMENT` (fired when
  `alignmentScore < 0.70`), described as "non-spec". Alignment is exactly what makes these layouts look
  amateur.
- **QA now silently mutates the design.** The same commit added a font-size clamp inside the QA stage
  that rewrites the winner's text sizes *after* metrics were computed. So the metrics no longer describe
  what ships, and a generator producing unreadable sizes is masked rather than caught.

## 5. Coverage gap in the qualification

The ledger shows exactly one model call per brief: layout generation. The vision critique (P05) and the
pairwise dimension-wise judge (P07) are never invoked — the "judge" in the qualification is
`Math.sign()` over deterministic metric scores. So two of the eleven tasks are not exercised by the run
that certifies the pipeline works.

## 6. Verdict

| Dimension | State |
|---|---|
| Data integrity | **FAILED** — production database empty; restore required |
| Availability | **FAILED** — credits exhausted, no design can be produced |
| Traceability | **FAILED** — build commit `unknown`, flags on against instruction |
| Proof honesty | **Much improved** — the live qualification and ledger are genuine |
| Design quality | Improved, roughly 7/10, with named defects and low diversity |
| Ship-ready | **No** |

---

# Addendum, same evening: remediation checked (T0–T8)

Seven further commits, `4699792`..`8dc06c4`. Gates at HEAD are green: typecheck clean, 146 files /
1061 tests pass, pack validation PASS=573.

## Genuinely fixed, verified independently

| Task | Verification |
|---|---|
| **T0 restore** | **Data is back.** 1557 tasks, 77 plans, 47 bindings, 98 inbox events, 134 studio calls. Task `8c32c048…` resolves again. **Sewa's recovered design `DAHVWVDUOuA` is present.** The proof states the loss window honestly as 79 minutes 18 seconds, and containers were paused before the restore |
| **T1 volume protection** | Real: `postgres_data` is now declared `external: true`, so compose can no longer recreate it |
| **T2 traceability** | `HAWA_BUILD_COMMIT` is a real commit again, and both flags are back to `off` as instructed |
| **T4 regressions reversed** | `POOR_GRID_ALIGNMENT` restored with its threshold justified against the six exemplars (range 0.792–1.000, mean 0.949). The QA font clamp is gone, replaced by a check that raises `UNREADABLE_FONT_SIZE` instead of rewriting, with a comment saying exactly that. Metrics are now computed so they describe what ships |

## T6 is rejected on measurement

T6 claims the Sorani footer defect is fixed, and specifically that panel text "resolves to Gold
(`#C5A059`) or Cream (`#FDF8F3`), achieving contrast ratio > 4.5:1".

I sampled the actual pixels of `T6_DEFECTS/brief_07_after.png`. The text band contains exactly two
colours: the panel `#162B48` and the glyphs `#0E1C32`, a *darker* navy. There is no gold or cream
anywhere in it.

| | Contrast against the panel |
|---|---|
| Measured glyphs `#0E1C32` | **1.20:1** |
| Claimed gold `#C5A059` | 5.80:1 |
| Claimed cream `#FDF8F3` | 13.51:1 |
| WCAG body minimum | 4.50:1 |

At 1.20:1 the text is effectively invisible. The fix replaced a cream block that clashed with a navy
block whose text cannot be read, and the existing 4.5:1 contrast gate did not catch it.

**Both after-renders also use placeholder copy** ("Sample copy block 0" through 4, confirmed in the
SVG) while the before-renders are the real briefs, byte-identical to the P10 previews. A real-copy
before against a placeholder after does not demonstrate the fix, and T6 does not disclose it.

Both after-renders still carry large voids: `brief_01_after` has a panel that is mostly empty, and
`brief_07_after` has roughly a quarter of the canvas empty above the unreadable panel.

## T5, T7, T8 are blocked, legitimately

The critique stage is now wired into the qualification (`generateBoxGroundedCritique` is called), but
the ledger still shows one row per brief because **credits are exhausted** and it cannot be re-run.
T7's end-to-end proof and T8's blind pairs are blocked for the same reason.

## Standing state

- Production: **degraded**, `billing_exhausted`, alert id 239. No design can be produced.
- Deployed build `4699792` is six commits behind HEAD `8dc06c4`, which is fine while flags are off.
- Remaining before shippable: credits, then T5 re-run, T6 redone on real copy with measured contrast,
  then T7 and T8.
