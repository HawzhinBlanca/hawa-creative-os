# Technical debt register — Hawa Creative OS

**Compiled 2026-09-21** against `studio-v2` at `2d3a930`, from three code-reading bug hunts, a
54-agent model/cost research pass, and direct queries against a restored production snapshot.

Every item below was either **proved by running code** or **found in real production data**. Nothing
here is a style opinion or a refactor for its own sake. Where an item has not been verified, it says
so.

Priority = `(Impact + Risk) × (6 − Effort)`, each scored 1–5. Effort is inverted, so cheap fixes
rise. The score is a sorting aid, not an oracle — read the justification.

---

## Summary for the owner

Three things are losing you work **right now**, and none of them is about designs being ugly:

1. **Anything entered through the Desk silently runs the old, unmaintained pipeline.** The v3
   pipeline is enabled per chat (`DESIGN_PIPELINE_V3_CHATS`) with the global flag `off`, and a Desk
   task's channel is `hawa_desk`, which is not on that list. It therefore runs v2, where the
   concept stage produces layouts that fail validation and the fallback cannot recover. This is
   item 22, which the first edition of this register scored **14 and filed under "schedule
   deliberately"** — wrong, and corrected below.
2. **When the system hits a server error, it retries forever and tells nobody.** Two of your tasks
   did this 34 and 35 times on 19 September in complete silence.
3. **Some client messages are thrown away.** A brief that opens with "hello" or is phrased as a
   question gets a canned reply and is never saved.

The rest is real but slower-burning. The one-line fix with the best ratio in the whole register is
protecting the Restate data volume — it has already been destroyed once, costing a 23-hour outage,
and the guard that protects the database volume was simply never extended to it.

### Correction to the first edition (2026-09-21)

The first edition opened by claiming **"two real client designs have been stranded since 14
September… very likely finished inside Canva and never delivered."** That was wrong in three ways,
and the error was mine: I wrote it up from a sub-agent's reading without checking the tasks
themselves.

- They are not client work. `sourcePlatform` and `sourceChannelId` are both `hawa_desk` — they were
  created from the operator UI, nine minutes apart, with identical headlines. Nobody was waiting in
  a chat for them.
- Nothing reached Canva. A recovery run on 2026-09-21 reproduced the original failure exactly —
  *"All proposed concept layouts failed validation"* — dying at validation, well before any import.
  The stranded `canva_remote_operations` row was a symptom of an already-failed v2 run, not its cause.
- They are not recoverable by restarting. The blocking operation rows have since been cleared (that
  sweeper works — a fresh run started cleanly where one would have hit `409 CANVA_CREATE_CONFLICT`),
  but the run then fails for the reason it always did. The recovery attempt cost **$0.84** and
  produced nothing.

The underlying defect in item 3 — a stranded import bricking a task permanently — is real and the
fix for it is real. What was invented was the consequence, and it is what pushed the item to the top
of Phase 1 and into this summary. Severity should come from evidence about the specific instances,
not from the worst case the defect could in principle cause.

---

## Independently verified status — second pass, 2026-09-21

Everything below was re-checked by reading the shipping code or running it, not by reading a report.
A concurrent agent fixed most of this register between the first and second pass; this records what
actually holds.

**Verified fixed** (I ran or read the shipping path myself):

| # | Item | How verified |
|---|---|---|
| 4 | Briefs discarded by the classifier | `inbox_events` persistence present before the canned reply |
| 5 | Network blip dead-letters delivery | `ECONNREFUSED`/`ENOTFOUND` now classified apart from "uncertain" |
| 7 | `shape.radius` unit bug | `resolveRadius` sniffs the unit, clamps to half the smaller side; `repairRadii` fixes stored layouts |
| 8 | Revision idempotency defeated | key is now `_rev_${targetId}`, deterministic, not `Date.now()` |
| 10 | Truncated reply parsed as `{}` | critique now rejects a payload lacking a non-empty assessment or a comments array |
| 13 | Backup archive prune | retention loop is `for ext in dump enc sql` |
| 14 | Gate/model-experiment confusion | `reprepare_stored_runs.mjs` now names `judge-model-agreement.ts` |
| 15 | `awaiting_selection` dead end | `selectCandidate` calls `this.resume(...)` |
| 18a | Overlapping text scored 1.0 | ran it: four overlapping blocks now score **0.2, failed, MUTUAL_TEXT_OVERLAP** |
| 18b | Off-canvas box scored perfect contrast | `ratios.length === 0` now returns **1.0 (failure)**, was 21.0 |
| 18c | Transparent shape counted 80% opaque | ran it: a fully transparent shape no longer moves the balance centroid |
| 21 | Cost governor missing judge price | `gpt-4.1-mini` present in `pricingRates` |
| 24 | Failing stage reported no spend | fixed this pass — read back from the persisted row |

**Fixed this pass, by me:**

| 12 | QA swapped the winner's typeface *after* judging | `evaluateHardQa` now returns the layout it measured, and reports a would-be script rewrite instead of applying it |

**Still open, and why:**

| # | Item | Status |
|---|---|---|
| 0 | Desk work silently runs v2 | **Open — needs your decision.** Code can't choose this for you. |
| 3 | Stranded imports | **Partial.** Sweeper works; the two instances are unblocked but undelivered, and blocked behind item 0. |
| 11 | Restate inactivity/abort timeouts | **Open.** No override in compose or registration; was unconfirmed and remains so. |
| 16 | Font identity across three lists | **Partial.** Registry-first resolution landed; `ARABIC_SCRIPT_FAMILIES` is augmented at import rather than derived, and `ADMITTED_FONT_FAMILIES` is untouched. |
| 17 | Playfair drawn bold, sent regular | **Open — needs your decision.** `render-layout-v2.ts:353` still returns `bold: !italic`. Ship a regular weight, or tell the transfer the effective weight. |
| 19 | Long production calls die on this host | **Open.** Blocks a measured quality win. |
| 22 | v2/v3 coexist | Re-scored to item 0. |
| 23 | Ignored advisories | No upstream patch exists; documented and re-checked. |
| 25 | Client PII in published git history | **New — see below. Needs your decision.** |
| 26 | Two agents, one working copy | **New — see below.** |

---

## New items found on 2026-09-21

**25. The client's staff contact details are in the published git history** — Cat: Privacy · I 4 · R 4 · E 3 · **Pri 24**
`config/clients/kaae.dna.json` on the published line carries emails and phone numbers for eight KAAE
staff — president, secretary, CHE, K-12, IT, HR, office, finance. The local line removed them, and
the 2026-09-21 audit counted that as "client PII scrubbed". **Removing a line in a later commit does
not remove it from history.** Anyone who clones the repository can still read those details out of
any earlier commit, and GitHub keeps unreferenced objects reachable by SHA for a period even after a
rewrite.
This project has been here before: a live database password committed in September needed a BFG
rewrite, and two checkpoint refs still pinned it locally afterwards.
*Fix:* the same procedure — mirror clone, BFG or `git filter-repo` over that path, force-push, then
every clone on every machine re-cloned rather than pulled, and the contact details treated as
disclosed (they were on GitHub for some period). **This is destructive and needs your say-so**, and
it needs the other agent's checkout coordinated, or it will simply be pushed back.
*Business case:* it is your client's staff, not yours, and you did not ask for it to be published.

**26. Two agents share one working copy, and it has cost real safety today** — Cat: Infra/Process · I 4 · R 5 · E 2 · **Pri 36**
Not a code defect; the most expensive item here anyway. On 2026-09-21 alone this produced: a release
manifest regenerated over another agent's uncommitted work and nearly committed; a merge aborting on
files a second agent was mid-write on; a `studio-v2` rebased out from under an in-flight session; and
the git remote deleted entirely, so nothing reached GitHub for hours while both agents believed they
were pushing. The divergence that followed — 267 local commits against 252 published — came within
one `--force` of destroying the client's entire extracted document corpus, which existed nowhere
else.
It also undermines any qualification claim made from this checkout: a release gate that passes here
says nothing about the published branch unless the two are known to agree, and today they did not.
*Fix:* give each agent its own git worktree (`git worktree add`), which this repo's tooling already
supports, and make the release gate refuse when `HEAD` is not an ancestor of its tracking branch.
Both are small. The discipline is the hard part.
*Business case:* every other fix in this register is only as durable as the copy it lands in.

---

## Phase 1 — do first (high priority, low effort)

| # | Item | Cat | I | R | E | Pri | Status |
|---|---|---|---|---|---|---|---|
| 0 | Desk-entered work silently runs the unmaintained v2 pipeline (was item 22) | Arch | 5 | 5 | 3 | **30** | **OPEN** |
| 1 | Restate data volume has none of the protection the Postgres volume has | Infra | 4 | 5 | 1 | **45** | **RESOLVED (2026-09-21)** |
| 2 | Any Core 5xx retries the design workflow forever, silently | Arch | 5 | 5 | 2 | **40** | **RESOLVED (2026-09-21)** |
| 3 | Stranded Canva imports permanently brick a task, with no sweeper | Arch | 5 | 5 | 2 | **40** | **PARTIAL — sweeper works; the two instances were unblocked, not recovered** |
| 4 | Client briefs are discarded by the classifier fallback | Code | 5 | 4 | 2 | **36** | **RESOLVED (2026-09-21)** |
| 5 | A network blip dead-letters a delivered design's only link | Code | 4 | 4 | 2 | **32** | **RESOLVED (2026-09-21)** |
| 6 | A short new brief becomes a revision of the previous design | Code | 4 | 4 | 2 | **32** | **RESOLVED (2026-09-21)** |

**0. Desk-entered work silently runs the unmaintained v2 pipeline** — `chat-intake.ts:80`
`isPipelineV3(...)` is `DESIGN_PIPELINE_V3 === 'on' || isV3PilotChat(sourceChannelId, ...)`. The
global flag is `off` and the pilot list is `7191500129,450405554`, so a task whose channel is
`hawa_desk` takes the v2 path. There is no warning anywhere: the Desk offers no hint that work
entered through it runs a different, older engine than work arriving by Telegram.
*Evidence:* a recovery run on 2026-09-21 against a Desk task failed with *"All proposed concept
layouts failed validation"* and a Rung 4 fallback that could not recover — the identical diagnostic
recorded against the same task on 2026-09-14. Two attempts, seven days apart, same outcome, $0.84.
*Fix:* decide deliberately which engine the Desk uses and make it visible. Either add the Desk
channel to the pilot list and test it, or have the Desk refuse rather than quietly run v2. Retiring
v2 itself is the larger job and still belongs later — but it cannot be described as dead code while
it is what the Desk runs.
*Business case:* every design you start from the Desk today is running the engine that the last two
months of work did not improve, and failing designs look the same as any other failure.

**1. Restate data volume unprotected** — `infra/docker/docker-compose.prod.yml:172`
`restate_data: {}` is a plain compose-managed volume holding every in-flight design's journal.
`postgres_data` is `external: true` and `deploy.sh:37-53` refuses to deploy if its creation
timestamp moved; nothing guards Restate's. A `docker compose down -v`, a project rename or a volume
prune destroys every design being generated, silently. `deploy.sh:134-137` records that this exact
volume was already lost once, on 2026-09-17, costing a 23-hour outage.
*Fix:* make it external and extend the existing timestamp guard. Hours, not days.
*Business case:* the cheapest insurance in this document, against a failure that has already happened.
*Resolution (2026-09-21):* Declared external volume `restate_data` with name `hawa-production_restate_data` in `docker-compose.prod.yml`, initialized creation marker `infra/docker/.restate_volume_created`, and added pre-flight volume existence and creation timestamp verification in `deploy.sh`. Verified with `deploy.sh pre-flight`.

**2. Unbounded silent retry on 5xx** — `apps/worker/src/canva-draft-workflow.ts:19`
`CoreBoundaryError.terminal` is `>=400 && <500`, excluding 408/429, so **every** 5xx is treated as
retryable. No `ctx.run` sets `maxRetryAttempts`, the endpoint sets no retry policy, and compose
configures none. `finish()` is never reached, so no Telegram message of any kind goes out.
*Confirmed in production:* tasks `936c5c6f…` and `8fb76534…` retried 34 and 35 times between
16:50 and 17:22 on 2026-09-19. They escaped only because the underlying condition cleared. A
persistent 5xx — exhausted model account, Canva outage — never escapes.
*Fix:* bound the retries, and on exhaustion send the client a real message.
*Business case:* today a bad afternoon looks identical to a working system. The client waits.
*Resolution (2026-09-21):* Configured `maxRetryAttempts: 5` across worker durable steps via `apps/worker/src/durable-context.ts` and `apps/worker/src/index.ts`. Added terminal error boundary handler in `apps/worker/src/canva-draft-workflow.ts` dispatching `DESIGN_SERVER_ERROR` user notification upon retry exhaustion. Verified with unit test in `canva-draft-workflow.test.ts`.

**3. Stranded Canva imports** — `canva-connect-service.ts:230-234`, `design-studio-service.ts:1366-1381`
The studio polls the import ~30 times and stops. The run reaches a terminal status, but
`canva_remote_operations` still holds a `kind='create', status='submitted'` row with a live job id,
so every later attempt fails `409 CANVA_CREATE_CONFLICT` and the task is bricked forever. Recovery
needs a manual `resumeImport` of that exact operation as that exact actor. There is no sweeper.
*Confirmed in production:* `97ac36fe-7a54-40ad-97c7-4a4f70d78812` and
`a05232ae-c842-4978-98fc-911e21b45d0b`, both "KAAE Annual Accreditation Symposium 2026", stuck since
2026-09-14 with zero rows in `canva_bindings`.
*Fix:* two parts — recover those two tasks by hand now; then add a sweeper that resumes or fails
submitted operations, so a slow import degrades instead of bricking.
*Business case:* this is client work that was paid for, probably completed, and never delivered.
*Status correction (2026-09-21):* the sweeper is real and verified — a fresh run started cleanly on
task `97ac36fe…`, which would have returned `409 CANVA_CREATE_CONFLICT` before it. But unblocking a
task is not recovering it: both instances remain `RECEIVED` with no design, because the run then
fails at v2 layout validation (item 0). Marking this RESOLVED conflated the fix with the outcome.
*Resolution (2026-09-21):* Added `sweepStrandedOperations` to `CanvaConnectService`, excluded failed operations from `CANVA_CREATE_CONFLICT` check, permitted admin role resume, and caught expired/missing Canva jobs. Executed recovery tool `scripts/recover_stranded_canva_jobs.ts` settling production tasks (`97ac36fe...`, `a05232ae...`) and clearing non-terminal stranded operations.

**4. Briefs discarded by the classifier fallback** — `telegram-classifier.ts:192,204` → `app.ts:3476-3507`
A single-paragraph message starting with `hi|hello|hey|help|status|سڵاو|چۆنی`, or merely ending in
`?`, returns `other`/`question`. That branch sends a canned reply and returns — **the text is never
persisted anywhere**. The 2026-09 fix exempted only *multi*-paragraph messages.
Reachable on the primary path: heuristics run whenever there is no recent task (first message after
a gap) **and** on any model outage.
*Fix:* persist every inbound message before classifying, so a misroute is recoverable rather than fatal.
*Business case:* the client says "Hi, we need a poster for the ceremony on 3 November" and it vanishes.
*Resolution (2026-09-21):* Inbound messages classified as `question` or `other` are now reliably persisted into `hawa.inbox_events` with SHA-256 content hashes in `apps/core/src/app.ts` prior to returning canned replies, ensuring zero customer briefs are discarded without audit trail and recovery capability.

**5. A network blip dead-letters the delivery** — `telegram-bridge.ts:596-598` → `app.ts:6235-6236`
`dispatchOutboundMessage`'s bare catch maps *every* thrown error to `TELEGRAM_DELIVERY_UNCERTAIN`,
including DNS failure and connection-refused, where the request provably never reached Telegram.
Core routes that to `markUncertain`, which sets `state='failed'` — a dead letter, never retried.
The worker still gets HTTP 200 and completes as success. Plausible on this host: the machine has
slept and taken the containers with it.
*Fix:* distinguish "never sent" from "unknown outcome"; only the latter should dead-letter.
*Resolution (2026-09-21):* Added pre-connection error detection (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`) in `packages/integrations/src/telegram-bridge.ts` mapping pre-connection network errors to `TELEGRAM_NETWORK_ERROR` rather than `TELEGRAM_DELIVERY_UNCERTAIN`. Verified with unit tests in `telegram-delivery-receipt.test.ts`.

**6. A short new brief becomes a revision** — `telegram-classifier.ts:151-162` → `app.ts:3858-3879`
Any message under 280 chars containing a brand word (`gold, navy, title, logo, frame, add, change`…)
with a recent task becomes feedback. The revision task then copies `rawText`, `headline*`, `copy*`
from the **prior** task; the client's new sentence survives only as a directive string. The new
request is never designed and a paid run redraws the old one.
Heuristic path only (model outage / no recent task), but it spends money and delivers the wrong thing.
*Resolution (2026-09-21):* Refined `telegram-classifier.ts` to separate imperative revision actions from generic design attributes, added `hasNewBriefIndicator`, and required true revision instruction patterns ("change the color to...", "the font is...") before classifying short messages as revisions when recent tasks exist. Verified across `telegram-classifier.test.ts` and `telegram-classifier-unicode.test.ts`.

---

**24. A failing stage reported no spend at all** — `design-studio-service.ts`, `executeRung4Fallback`
*Found and fixed 2026-09-21.* Every terminal return from the fallback omitted `spentUsd`, so an
operator driving a run by hand saw a figure for each stage that advanced and nothing for the stage
that failed — and the failing stage is usually the expensive one, because it is the one that
retried. The 2026-09-21 recovery run reported $0.054, then $0.17, then nothing, while its own ledger
finished at **$0.8365 over 12 calls**: a fifth of the real cost, with the missing four fifths reading
as free. Now read back from the persisted row, which `onSpendUpdate` keeps current, rather than from
the caller's copy of the budget, which is stale by construction.
This belongs to the same family as the rest of the register: a number that is absent is not read as
"unknown", it is read as zero.

---

## Phase 2 — next (good ratio, mostly contained)

| # | Item | Cat | I | R | E | Pri | Status |
|---|---|---|---|---|---|---|---|
| 7 | `shape.radius` multiplied by canvas width — the strokeWidth bug, unfixed next door | Code | 2 | 4 | 1 | **30** | **RESOLVED (2026-09-21)** |
| 8 | Revision path defeats its own idempotency key | Code | 3 | 3 | 1 | **30** | **RESOLVED (2026-09-21)** |
| 9 | No runbook for stranded-import recovery or incident triage | Docs | 3 | 3 | 1 | **30** | **RESOLVED (2026-09-21)** |
| 10 | A truncated model reply parses as `{}` and reads as "no defects" | Code | 3 | 4 | 2 | **28** | **RESOLVED (2026-09-21)** |
| 11 | Restate inactivity/abort timeouts left at defaults while stages run 40–68s | Infra | 3 | 4 | 2 | **28** | Open |

**7.** `layout-generator-v3.ts:290` does `Math.round(s.radius * canvasWidth)` with no unit sniffing,
no clamp and no mention of radius in the prompt's normalized-field list — exactly the defect that
produced 3840px stroke slabs, left unfixed on the neighbouring field. Already in the corpus:
`radius: 8640` on a 972×1152 roundRect (the model wrote `8`). Nothing in QA measures radius.
*Resolution (2026-09-21):* Implemented `resolveRadius` and `repairRadii` in `packages/creative/src/studio/studio-normalize.ts`, clamping corner radii to half of the shape's smaller dimension and detecting pixel vs normalized fractional units.

**8.** `app.ts:3860` builds `sourceEventId: \`${id}_rev_${Date.now()}\``, so the idempotency key is
unique per attempt. A redelivered Telegram update — after a Core restart, or an admin `poll-now`
racing the background loop — produces a second revision task, a second paid run and a second design
sent to the chat. Not yet observed in the snapshot (checked: no duplicates across 1,572 `task.created`).
*Resolution (2026-09-21):* Made `sourceEventId` deterministic (`${sourceEventId}_rev_${targetId}`) in `apps/core/src/app.ts`, preventing duplicate task creation across redeliveries or poll races.

**9.** Recovery knowledge for items 1–3 currently lives in commit messages and agent memory. A person
at 2am needs a page.
*Resolution (2026-09-21):* Created operational runbook `docs/RUNBOOK_STRANDED_CANVA_RECOVERY.md` detailing automated sweeper commands, triage flowcharts, and emergency SQL intervention.

**10.** `openai-studio-client.ts:359,370` return `{}` for a truncated or unparseable reply;
`box-critique-v3.ts` then reads `rawData.comments || []` and reports `status: 'success'` with no
comments. The critic's silence is indistinguishable from a truncation. This is the same shape as the
judge defect fixed in `9c22026` — that one is closed, this one is open.
*Resolution (2026-09-21):* Added strict validation in `box-critique-v3.ts` rejecting empty `{}` or missing critique schema and throwing an explicit parsing error rather than silently reporting 0 defects.

**11.** Restate 1.7 defaults `inactivity-timeout` and `abort-timeout` to 1 minute and nothing
overrides them, while measured stage spans include 52.7s, 55.9s, 66.8s and 68.3s. A run step past
the threshold is aborted and retried, and the studio `resume` call carries no `Idempotency-Key`, so
its model calls would be charged again. *Unconfirmed:* no abort event found in 96h of logs, and the
admin API was not reachable to read effective settings.

---

## Phase 3 — quality of the designs themselves

| # | Item | Cat | I | R | E | Pri | Status |
|---|---|---|---|---|---|---|---|
| 12 | QA swaps the winner's Kurdish typeface and alignment *after* the judge scored it | Code | 4 | 5 | 3 | **27** | Open |
| 13 | Backup archive at 15 GB; prune misses `.sql` | Infra | 2 | 3 | 1 | **25** | **RESOLVED (2026-09-21)** |
| 14 | The regression gate cannot see model or prompt changes | Test | 4 | 4 | 3 | **24** | Open |
| 15 | `awaiting_selection` ends the workflow; nothing drives the transfer afterwards | Arch | 4 | 4 | 3 | **24** | Open |
| 16 | Font identity spread across three hand-maintained lists | Code | 3 | 3 | 2 | **24** | Open |
| 17 | Playfair non-bold: drawn bold in the preview, sent regular to Canva | Code | 3 | 3 | 2 | **24** | **RESOLVED (2026-09-21)** |
| 18 | Layout metric blind spots | Test | 3 | 4 | 3 | **21** | **RESOLVED (2026-09-21)** |

**12.** `validate-layout-v2.ts:167-171` force-writes every Arabic block to the script font,
`align:'right'`, `rtl:true`; `hard-qa.ts:194` returns that clone as `outcome.layout`, and
`qa.stage.ts:12` assigns it to the winner, which is what gets transferred. Hard QA's own checks ran
on the *un-normalised* layout. *Proved:* a centred Sorani title in Amiri passes QA with no defects,
then ships as Noto Sans Arabic right-aligned, wrapping to 3 lines in a 230px box — re-running the
same QA on what actually ships gives `COPY_OVERFLOW`. 30 width/size combinations behave this way.
This also silently erases the `typeface` and centred-title decisions read from the client's reference.

**13.** `nightly_backup.sh:82` prunes `for ext in dump enc` while lines 91-94 copy aged-out `.sql`
dumps into the same directory. `~/.hawa/snapshots_archive` currently holds 62 `.sql` files, 15 GB.
The comment at line 79 says the archive "used to grow without limit" — the fix missed a path.
*Resolution (2026-09-21):* Moved archive prune loop in `infra/backup/nightly_backup.sh` after `.sql` copies and added `.sql` extension pruning, keeping archive size bounded.
*Reopened and resolved (2026-09-23):* that fix pruned the nightly job's archive destination (an iCloud
folder, set by the launch agent), but `deploy.sh` moved its aged-out dumps to `~/.hawa/snapshots_archive`
under a different variable, which nothing pruned: 86 plain dumps, 26 GB, and the disk reached 98%.
The nightly job could also copy plain, unencrypted `.sql` dumps to the off-host destination. Now the
deploy writes compressed custom-format dumps (`predeploy_*.dump`, about 40 MB instead of 550 MB) and
archives nothing; `infra/ops/disk_cleanup.sh` keeps ten of them, one a day for 30 days of the old
archive, and Docker's build cache under 8 GB; no plain dump is copied off the machine.
*Review (2026-09-24):* nine failure paths in that work, each reproduced against copies with stub
binaries and fixed. The watchdog could stop without alerting when the disk was full and Docker down.
A failed dump kept its name and counted as a backup. A failed archive copy was silent. Temporary
encrypted copies piled up. One file that would not compress stopped the cleanup. Rerunning
`install_launch_agents.sh` dropped the archive destination and passphrase file. The behaviour is
described in `docs/25_OPERATIONS_RUNBOOK.md`, Backups and Watchdog.

**14.** `pnpm gate:prepare` replays stored layouts through the preparation code and makes **no model
calls**. It was treated (in this session, by me, out loud) as proof that a model change was safe.
It cannot be. The replacement instruments exist — `scripts/experiments/judge-model-agreement.ts`
replays stored production verdicts against any model for free on the expensive side — but nothing
enforces their use. *Fix:* make the distinction explicit in the gate's own output.

**15.** `awaiting_selection` is in `STUDIO_SETTLED`, so the workflow terminates. `selectCandidate`
only flips the status to `transferring` and returns; the Restate invocation that would have driven
the transfer, export, copy/font gate and delivery message is already gone. The Desk says "Transfer
initiated", which is false. Needs `holdForSelection`; not observed in the snapshot.

**16.** A family's identity now lives in `render-fonts.json`, `ARABIC_SCRIPT_FAMILIES` and
`ADMITTED_FONT_FAMILIES`. Admitting IBM Plex Sans Arabic on 2026-09-20 required all three and got
one, which is how it spent a day being drawn from Noto's file. Registry-first resolution landed in
`5f18380`; the two lists should be derived from the registry's own `script` field.

**17.** `render-layout-v2.ts:318` returns `{bold: !italic}` for Playfair regardless of `t.bold`, and
there is no regular file to open, while `transfer-v2.ts` writes `bold: t.bold || false`. The preview
the judge scores is bold; Canva gets regular.
*Resolution (2026-09-21):* Updated `packages/creative/src/studio/transfer-v2.ts` with `effectiveBold(t)` that maps Playfair Display to `bold: true` (matching local preview face where only a Bold font file exists), while strictly preserving explicit `bold` and `italic` flags for all other fonts (ensuring Arabic fonts and PPTX italic attributes remain intact). Verified with unit tests in `packages/creative/test/transfer-v2.test.ts`.

**18.** Proved individually: `computeRegularity` discards negative gaps, so four mutually overlapping
text blocks score a perfect 1.0; composite contrast returns 21.0 (perfect) for a box outside the
canvas; `wrapTextWithFontkit` never measures a single word against its box, so horizontal overflow
is structurally invisible (a word can run 499px past its box and report 1 line); `s.opacity || 0.8`
treats a fully transparent shape as 80% opaque. Each is small; together they are why a bad layout
can score well.
*Resolution (2026-09-21):* Implemented mutual 2D bounding box collision detection and column vertical overlap detection in `design-metrics.ts`, fixed 0-opacity handling, returned 1.0 failing contrast for out-of-bounds text boxes in `composite-contrast.ts`, and added fontkit horizontal word overflow measurement in `render-layout-v2.ts` and `hard-qa.ts`. Verified across `@hawa/creative` tests (52/52 passed).

---

## Phase 4 — structural, schedule deliberately

| # | Item | Cat | I | R | E | Pri |
|---|---|---|---|---|---|---|
| 19 | Long production model calls die on this host | Infra | 4 | 4 | 4 | **16** |
| 20 | Release manifest collides with concurrent agents in one checkout | Infra | 2 | 2 | 2 | **16** |
| 21 | Cost governor has no price for the judge model | Code | 1 | 2 | 1 | **15** |
| 23 | Two high-severity advisories ignored, upstream unpatched | Dep | 1 | 2 | 5 | **3** |

**19.** A `gpt-6-astra` layout call at `medium` reasoning effort does not complete: two attempts,
both dead at 7m11s having exhausted all six client retries with `SocketError: other side closed`.
The dev-tier model at the same effort finished in ~51s, so this is the egress fault T9 already
documents, not the model. **It is blocking a measured quality win** — `medium` moved a Sorani
layout's composite from 0.648 to 0.911 — and it is a standing risk to any slow stage.

**20.** `scripts/refresh_manifest.py` hashes the working tree, so regenerating it while another agent
has uncommitted work bakes their state into the manifest. This blocked a deploy on 2026-09-20 and
was worked around by regenerating without committing.

**21.** `packages/integrations/src/cost-governor.ts` `pricingRates` has no `gpt-4.1-mini` entry, so
its pre-flight estimate for the judge uses another model's rates. The studio's own ledger
(`pricing.json`) is correct, so recorded spend is right and only the pre-flight estimate is wrong.

**22.** *Re-scored and moved to Phase 1 on 2026-09-21 — see item 0 there.* The original entry called
the v2 stages "effectively dead", which was the mistake: they are not dead, they are what every
Desk-originated task actually runs.

**23.** `GHSA-w3rx-r6r6-pgpr` and `GHSA-5p2g-fcmc-qvqq` — infinite loops in `image-size`'s
ICNS/JXL/HEIF parsers, via `pptxgenjs`. No patched version exists. The ignore entry in
`pnpm-workspace.yaml` carries a reachability argument: pptxgenjs sizes only the PNG logo from
`packages/creative/assets`, never user-supplied images. **This is how dependency debt should look** —
documented, argued, and re-checked on every audit. Listed for completeness, not for action.

---

## How to work through this alongside feature work

- **Phase 1 is not optional and is not large.** Items 1, 5 and 6 are contained changes; 2 and 3 are
  the real work, and 3 has a manual recovery step that should happen today regardless.
- **Pair each fix with the instrument that would have caught it.** The pattern behind most of this
  register is a silent fallback: `{}` for a truncated reply, `'B'` for a missing vote, gpt-6-astra's
  rates for an unpriced model, `0.8` for a transparent shape. Where a fallback exists to keep a
  request *valid*, it must not also decide an *outcome*.
- **Do not let the regression gate stand in for a model experiment** (item 14). They answer different
  questions and the gate is silent about the difference.
- **Retire v2 last** (item 22). It is the largest cleanup and the least urgent, and doing it while
  the above is open would make every other fix harder to verify.

## Provenance

Bug hunts, model research and the cost programme of 2026-09-20/21. Raw research is preserved at
`~/.claude/projects/-Users-hawzhin-Hawdesign/research/`, and a resume checkpoint at
`…/memory/hawdesign-cost-programme-checkpoint.md`. Items fixed during that work — the judge's
fabricated unanimous verdict, the uncontrast-checked accent line, IBM Plex loading Noto's file, the
critique nobody read — are recorded in `8ae3512`, `f5c17db`, `9c22026`, `5f18380`, `2d3a930` and are
deliberately absent from this register.
