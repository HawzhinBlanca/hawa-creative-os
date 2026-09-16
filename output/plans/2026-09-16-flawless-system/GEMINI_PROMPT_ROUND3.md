# Hawa Creative OS — Round 3 request (2026-09-16 17:15)

To the implementing agent. Round 2 review: `output/audits/2026-09-16-flawless-round2-review/REPORT.md`.
Tracker: `output/plans/2026-09-16-flawless-system/TRACKER.csv`. All rules from `GEMINI_PROMPT.md` still
apply, including rule 7 (report deviations honestly) — round 2 did this correctly for F02, F05 and F13
and that is the standard to keep.

**Accepted, no further work needed:** F01, F03, F06, F07, F11.
**Honestly blocked on the owner, no further agent work needed:** F02, F05, F13 (owner is adding OpenAI
credit and will decide on the Canva OAuth grant separately).

Four items are open. Do these, in this order, each with the proof the original sheet requires.

## R1 — F10: a real, proactive billing probe (most urgent — this is live right now)

The review found that `GET /v1/health` reports `modelProvider: "connected"` while a fresh real OpenAI
call returns `429 credit_balance_exhausted`, verified twice live. The current implementation only
updates billing status when a paid call happens to fail as a side effect of a real request — there is
no active check. This is the same silent-failure class as the Anthropic outage on 09-14/15, now
reproduced for OpenAI, and it is live in production at the time of writing.

**Do:** add a lightweight scheduled probe (every 3–5 minutes is enough; it must be a real, minimal paid
or near-zero-cost call, not the free model list) that updates a `lastPaidProbe` record independently of
whether any request happened to fail. `insufficient_quota`, `credit_balance_exhausted`, `401`, and `403`
all flip health to `billing_exhausted`/`unauthorized` within one probe interval, and the watchdog alerts
the operator chat. Recompute health from that record, not from `lastVerifiedProgressAt` staying stale
for hours.

**Accept when:** the lead invalidates the key in a test stack (or waits out a real exhaustion window)
and sees health flip to `billing_exhausted` within the probe interval **without any Telegram request
having been sent**, and sees the operator alert. Live proof only; a synthetic 401 test is not sufficient
by itself this round — pair it with a live before/after health snapshot bracketing an actual probe
cycle.

**Proof:** `F10_LIVE.json` with two real health snapshots (exhausted and recovered) each timestamped
against an independent probe run, plus the alert message id.

## R2 — F04/F12: enforce the typography policy, don't just report its failure

Three plans were generated this round with the archetype dictation removed — real progress — but all
three exported with body text in Cinzel, Lora or Montserrat instead of Verdana (or Noto Sans Arabic for
Sorani body), and `checkCanvaPptx` correctly caught this (`fontPass: false`) while the proof's own
`DIFF_SUMMARY.md` claimed "verified font and copy pass" for all three, which the adjacent check files
contradict. Also: one of the three "independent" plans (task `0b6722bb`) was created before this round,
before the font policy existed, and was presented as a fresh sample — do not reuse old tasks as new
proof; generate fresh ones.

**Do:** the planner must not merely be checked after the fact for role-correct fonts; it must either (a)
constrain the model's font choice per role in the request/schema so body roles can only select Verdana
or Noto Sans Arabic, or (b) apply the same server-side correction pattern already used for off-palette
colours (silently correct and record the correction count in the manifest) so a body role never ships
in a display font. Fix `DIFF_SUMMARY.md` (and any other proof prose) to only state what the adjacent
check JSON actually shows — never write "verified pass" next to a `fontPass: false`.

**Accept when:** three freshly generated plans (new task ids, created after this fix) each export with
`fontPass: true`; a formal-document brief shows Verdana on every body role and Noto Sans Arabic on any
Sorani body block; an invitation brief shows a free display font on headline/display roles and Verdana
still on any body role it carries.

**Proof:** `F04_THREE_PLANS_V2/` replacing the round-2 folder, three fresh task ids, three passing
`fontPass: true` checks, and a `DIFF_SUMMARY.md` whose every claim matches its adjacent check file.

## R3 — F08: exclude non-Telegram and synthetic tasks from the re-drive sweep

Flagged in round 1, not fixed in round 2: the sweep re-drove the same four fixture/test tasks from the
09-14 audit (`0653aeec…`, `23b71a0c…`, `dc6eb019…`, `59751c4b…`, none with a real Telegram chat id) into
paid model calls and real Canva documents, again. This spends money and creates real Canva documents for
nothing a requester asked for.

**Do:** the sweep only re-drives a plan whose task has a real `sourceChannelId` from `telegram` or
`whatsapp` intake (not `null`, not an `isolated-test-…` id, not a task created by an audit/verification
script). Add a migration or one-off cleanup that marks the four fixture tasks' plans `abandoned` with a
diagnostic saying why, so they never enter the sweep again.

**Accept when:** the lead re-runs the sweep against the current failed/uncertain set and it touches only
real requester tasks; the four fixture tasks are excluded and explicitly closed.

**Proof:** `F08_SWEEP_FILTER.json` — the sweep's candidate list before and after the filter, and the
four fixture plans' new `abandoned` status.

## R4 — F09: replace the synthetic example with a live one

The round-2 proof for the terminal-notification paths uses a labelled synthetic example
(`task_missing_copy_sample`), not the three live messages from a test chat the original sheet asked
for. The code looks right (`finish()` covers every exit; unit tests pass); what is missing is the live
proof.

**Do:** from a test Telegram chat, send: a message with no recognisable copy, a message with no client,
and a normal brief when the daily cap is already reached. Let each reach its real terminal path in
production.

**Accept when:** three journal entries exist for these three real messages, each within 30 seconds of
receipt, with the message text the sender actually got.

**Proof:** `F09_LIVE.md` with the three journal excerpts and message texts, replacing the synthetic
example.

## Reporting

Same format as before: one `TASK:` block per item (R1–R4), `STATUS`, `COMMITS`, `PROOF`, `LIVE IDS`,
`DEVIATIONS`, `WHAT I DID NOT DO`. Keep reporting deviations honestly exactly as you did for F02/F05/F13
this round — that was correct and is the standard going forward.
