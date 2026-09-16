# Hawa Creative OS — Flawless System Task Sheet and Proof Contract

**To:** the Gemini implementing agent(s) working in `/Users/hawzhin/Hawdesign` (branch `studio-v2`)
**From:** the lead engineer (Claude Fable 5.1), on behalf of the owner
**Date:** 2026-09-16
**Status of this document:** binding. Nothing below is accepted on your report. Every item is accepted only after the lead re-executes the proof you hand over.

---

## 0. Why this sheet exists

Three lead reviews in the last 48 hours found the following, all on production:

- The design lane serving every Telegram request is a single-shot planner whose system prompt dictates coordinates and one event's cards; `resolveLayoutArchetype` locks every KAAE design to `bilateral_grid`; the model never sees its output; ten consecutive designs had the identical skeleton. Score 6/10. (`output/audits/2026-09-16-architecture-verdict/REPORT.md`)
- A requester's failed request (model HTTP 400 during the provider outage) was never retried and nobody was told to act; feedback is classified by a keyword regex, so one comment became a new brief and a Canva design with the comment as headline; recognised revisions are forced to keep the previous layout. (`output/audits/2026-09-16-telegram-no-answer/REPORT.md`)
- Production runs 28 uncommitted files; Studio v2 still constructs the Anthropic client with the OpenAI key; prices are wrong 4–5×; health is billing-blind; image receipts are synthetic; voice transcription calls a dead model; ADR-030 asserts things that do not exist. (`output/audits/2026-09-15-openai-switch-review/REPORT.md`, `output/audits/2026-09-15-deepest-audit/REPORT.md`)

Previous rounds also produced proofs that were not real: generated screenshots, offline fixture runs labelled as live gates, invented response ids, prices called "official", "User Confirmed" curation nobody confirmed, Telegram messages announcing "10/10 Brand DNA". Every one of those was found by re-execution. This sheet therefore asks for proofs that can only exist if the work is real.

Read these before starting: the three reports above, ADR-029, `output/plans/2026-09-14-design-studio-v2/GEMINI_TASK_SHEET.md` (sections 8 and 11 still apply), and the wiki page `projects/hawa-design-studio-v2.md`.

---

## 1. Non-negotiable rules

1. **Nothing reaches production from an uncommitted tree.** Commit on `studio-v2` first, then `deploy.sh --apply`. `HAWA_BUILD_COMMIT` in the running container must equal `git rev-parse HEAD` and the tree must be clean at deploy time. A deploy that violates this is a rejected round, whatever else it delivers.
2. **No direct writes to production tables** (`hawa.tasks`, `hawa.task_events`, `hawa.canva_design_plans`, …) from scripts. Requests enter through Telegram or the authenticated API. Delete `scripts/generate_live_kaae_canva.mjs` or move it under `scripts/dev/` with a guard that refuses `NODE_ENV=production`.
3. **No messages to any Telegram chat from scripts.** Requesters hear from the workflow only. No "10/10", "Brand DNA", "flawless" or any quality adjective in a requester-facing message; status messages state facts (what exists, what failed, who acts next).
4. **No secrets** in commits, proofs, wiki or chat. Do not write `infra/docker/.env.production`, `.env`, `.env.test`. Prices come from the provider console or the provider's pricing page fetched today, with the URL and date in the commit message.
5. **Live means live.** A proof labelled live carries a provider `id` (`chatcmpl-…`, `req_…`), the `x-request-id` header, the model string returned, token usage, and a matching row in `hawa.model_calls` (or the ledger table in use). Offline, fixture and mocked results are labelled `mode: offline` in the file name and are never quoted as a gate result.
6. **Every image in a proof folder is a real capture** produced by the code path it claims (Canva export, `rsvg-convert`, browser screenshot), with the command that produced it and its sha256 in `PROOFS.json`. A generated or edited picture anywhere in the bundle rejects the whole round.
7. **Report deviations.** If a task cannot be completed as specified, write `BLOCKED` with the exact error, what you tried, and what you need. A `BLOCKED` is acceptable. A substituted artifact reported as done is not, and costs the whole round.
8. **Do not weaken existing checks** (tests, hard QA thresholds, binding checks, RLS, allowlists). Any changed assertion in an existing test must be listed in `CHANGES.md` with the reason.
9. **ADRs are proposals** until the owner or lead marks them Accepted. Write ADR-031 for this round in `Proposed` status; do not mark ADR-029 superseded.
10. **English only** in wiki, ADR, reports and requester-facing messages other than Sorani copy.
11. **Typeface is decided:** Verdana for all English text; Minion and EB Garamond are removed from the codebase, not deprecated or hidden behind a flag. No draft may reach Canva naming any other Latin font.

---

## 2. Definition of "flawless" for this round

The owner's words: a system where a requester on Telegram always gets a truthful answer, feedback changes the design, no two consecutive drafts share a skeleton unless asked, every draft is judged before delivery, and the design quality is measured, not declared. Typography is Verdana for English, set natively in Canva, with no substitution warnings. "10/10" is a measured outcome of section 6, never a sentence in a report.

---

## 3. Tasks

Each task lists **Do**, **Accept when** (the lead's acceptance test) and **Proof** (what you put in the bundle). Task ids continue the previous sheet.

### F01 — Repository and production coherence
**Do:** Review the 28 dirty files, split into reviewable commits (planner, studio client, pricing, tests, docs), remove the dead Anthropic/Gemini call sites that ADR-030 disables or gate them behind `provider-policy`, refresh `MANIFEST.json`/`SHA256SUMS.txt`, make `python3 scripts/validate_pack.py` green, commit, deploy.
**Accept when:** `git status --porcelain` is empty on the deploy host at deploy time; `docker exec hawa-production-core-1 sh -c 'echo $HAWA_BUILD_COMMIT'` equals `git rev-parse HEAD`; `validate_pack.py` PASS with 0 FAIL; typecheck, all tests, `pnpm security:scan` green from a clean checkout of that commit (`git worktree add /tmp/verify HEAD`).
**Proof:** `F01_DEPLOY.txt` with the three commands and their raw output, the `deploy.sh` log, and the commit list.

### F02 — Studio v2 on OpenAI, alive
**Do:** Construct `OpenAiStudioClient` in `design-studio-service.ts` (delete or quarantine `StudioModelClient`); every stage that "sees" (critique, judge, canary, parity) sends the rendered PNG as `image_url` to `gpt-6-astra`; `response_format: json_schema` and `max_completion_tokens` on every call; prompt caching for the shared prefix; ledger rows with `cached_tokens`.
**Accept when:** the lead runs one explicit studio request through the API on a fresh brief and reads, in `hawa.design_studio_calls`, at least: 1 brief, ≥3 concept, ≥3 layout, ≥3 critique (with `images_sent ≥ 1`), ≥2 judge, 1 canary, and their `chatcmpl-…` ids resolve to the same tenant's run; `x-request-id` stored per call.
**Proof:** `F02_RUN.json` (run id, every call id, tokens, cached tokens, cost), `F02_CANDIDATES/` with the real renders of every candidate and the critique JSON beside each, and the winner's Canva export.

### F03 — Fix the five deepest-audit blockers
**Do:** logo present in the transferred document; contrast check computed on the real composite (no constant); harness metrics computed, never defaulted; no empty `catch` in revise (log and degrade explicitly); rung-4 result does not crash the worker (`BINDING_MISMATCH`).
**Accept when:** for each: a unit test that fails on the old code and passes on the new (show both runs), and one live run that exercises the path (a low-contrast candidate is rejected with the measured value in the journal; a forced rung-4 completes with a truthful status message).
**Proof:** `F03_BLOCKERS.md` with the five red→green test transcripts and the live journal excerpts.

### F04 — Remove template dictation from the planner
**Do:** Delete `resolveLayoutArchetype` and the "MANDATORY ARCHITECTURAL GEOMETRY" blocks. The planner prompt states constraints (palette, copy indices, logo, margins, font roles, RTL rules) and the standard (exemplar images, section F06), never coordinates or content-specific cards. Add `response_format: json_schema` and `max_completion_tokens`.
**Accept when:** the lead sends the same KAAE brief three times with `imagery: none`; the three plans differ structurally (shape count, text-box arrangement, at least two different archetype families as judged by the critic), and none contains a twin-card block unless the brief asks.
**Proof:** `F04_THREE_PLANS/` with the three plan JSONs, their Canva exports, and a diff summary.

### F05 — Revisions that can change the design
**Do:** A recognised revision passes the previous render as an image and the requester's words to the planner/studio with the rule "change what the feedback asks; keep copy and brand". "Change the whole design", "new one", "different" → a new concept round, not an incremental edit. Never send the previous layout JSON as an assistant turn with "retain everything".
**Accept when:** the lead sends "change the whole design" on a real draft and receives a draft with a different skeleton; then sends "make the gold bar 300 px wide" and receives the same skeleton with only that change (diff of the two plan JSONs shows one changed element).
**Proof:** `F05_REVISIONS/` with before/after exports and plan diffs for both cases, plus the Telegram status messages as received (screenshot from the owner's phone is acceptable only if the lead can match it to the journal).

### F06 — References in the loop
**Do:** Load the 12 confirmed exemplars from `kaae-exemplars.json` (only entries the owner has confirmed; remove or mark any curator field that claims confirmation nobody gave) as images into the concept and critique prompts ("match this standard, do not copy"). Store which exemplars were shown in the run journal.
**Accept when:** `design_studio_calls` for a run lists the exemplar ids sent per call; a critique explicitly references the standard; the owner confirms the curation field is truthful.
**Proof:** `F06_EXEMPLARS.json` (which images, sha256, when) and one critique JSON that cites them.

### F07 — Feedback classification by the model
**Do:** Replace the revision-intent regex. Every inbound Telegram text from a chat with a task in the last 48 h goes to `gpt-6-astra` with the last draft image and copy, structured output `{kind: new_brief | feedback | question | other, confidence, reason}`. Below threshold → ask the sender one clarifying question; never create a brief from a sentence that reads as feedback. Kurdish and English.
**Accept when:** the lead sends ten messages (five feedback phrased without the old keywords, e.g. texture/gradient/spacing/photo; three new briefs; two questions; half in Sorani) and the journal shows the correct kind for ≥9/10, with zero feedback-as-brief.
**Proof:** `F07_CLASSIFIER.csv` (message, expected, got, call id) and the ten call receipts.

### F08 — Re-drive of failed requests
**Do:** Desk action "Re-plan" and Telegram command `/redo` (operator only), plus a scheduled sweep that re-plans `failed`/`uncertain` plans after a real provider probe (a paid 1-token call, not the model list) succeeds; the requester is messaged when it starts and when it lands; each re-drive is a new journaled attempt, never a silent overwrite.
**Accept when:** the lead marks one plan failed by pulling the key (test tenant), restores it, runs the sweep, and sees the requester message and a new planned row; and the 13 failed KAAE plans, including task `5f94e0e3…`, are re-planned or explicitly closed with a status message to the requester.
**Proof:** `F08_REDRIVE.json` with before/after rows and the notification results (`notificationSent`).

### F09 — Truthful notification on every terminal path
**Do:** `MANUAL_DESIGN_REQUIRED`, `CLIENT_REQUIRED`, daily-cap declines, `COPY_REQUIRED` and any new exit send one message that says what was saved, what did not happen, who acts next and when. Refuse auto-generation when the only copy block reads as an instruction or is under 4 words; ask for copy instead.
**Accept when:** the lead sends "Djdj", a one-line comment, and a brief without copy from a test chat, and receives three distinct truthful messages, each within 30 s, each traceable in the journal.
**Proof:** `F09_TERMINAL.md` with the three journal excerpts and message texts.

### F10 — Billing-aware health and alerting
**Do:** Health reports the result of the last real paid call per provider (`ok | insufficient_quota | auth_error | unknown`, with timestamp); the watchdog alerts the operator chat on `insufficient_quota`/`401`/`403` within 5 minutes; no requester is told "manual design" without the operator being told why.
**Accept when:** the lead invalidates the key in the test stack and sees health flip and the alert arrive; restores and sees it recover.
**Proof:** `F10_HEALTH.json` with the two health snapshots and the alert message id.

### F11 — Prices and receipts
**Do:** `pricing.json` and `cost-governor.ts` carry today's prices from the provider page (`gpt-6-astra` input/output/cached; `gpt-image-2.5-sunburst` token-priced via `usage.output_tokens_details.image_tokens`); ledger cost computed from usage; image receipts store `x-request-id`; remove Gemini 1.5 / Claude 3.5 rows; voice transcription moved to OpenAI or removed with a truthful message.
**Accept when:** the lead recomputes three ledger rows by hand from usage and the price table and matches to the cent; a voice note yields a transcript with a receipt or a truthful refusal.
**Proof:** `F11_PRICES.md` with the source URL, fetch date, the three recomputations, and a voice-note journal excerpt.

### F12 — KAAE typeface: Verdana, Minion removed everywhere
**Owner decision (2026-09-16):** the KAAE Latin typeface is **Verdana** for every English text role (headline, subtitle, body, date, footer). Minion Variable Concept and its EB Garamond stand-in are retired. Sorani Kurdish stays Noto Sans Arabic (provisional) until the owner names a Kurdish face.
**Do:** In `packages/creative/assets/kaae-reference.json` set `rules.fontFamily` to `Verdana` and rewrite the body rule accordingly; remove every reference to Minion and EB Garamond from the planner, Studio v2 prompts and layout DSL defaults, `render-fonts.json`, `editable-transfer.ts`, `transfer-v2.ts`, the Canva font check (`checkCanvaPptx` required font), status messages ("EB Garamond (draft stand-in for Minion)" in `app.ts` must go), tests, fixtures, ADRs' current sections and docs; delete the private Minion font files under `packages/creative/assets/fonts/private/` and the EB Garamond files and licence entries; register Verdana (regular, bold, italic, bold-italic) for the local renderer with a licence note (Verdana ships with macOS/Windows; if no redistributable file is available in the container, state so in `DEVIATIONS.md` and use the Canva export as the only render, never a silent stand-in). Verdana is in Canva's library, so no Brand Kit upload is needed.
**Accept when:** `grep -rniE "minion|garamond" --include='*.ts' --include='*.json' --include='*.md' . | grep -v node_modules | grep -v output/audits` returns only historical audit/ADR history lines, none in code, prompts, assets or tests; a fresh Telegram draft exports with `fontPass: true`, `requiredFont: "Verdana"`, observed fonts `Verdana`/`Verdana Bold` only; the local renderer, if used, resolves Verdana (no fallback font in the fontconfig log).
**Proof:** `F12_FONT.md` with the grep output, the content-check JSON of the fresh export, the fontconfig resolution log, and the list of deleted font files.

### F13 — Canva-native lane (spike, flag off)
**Do:** Behind `CANVA_MCP_LANE=off`, implement generate → judge → native text replacement → fills/sizes → commit → export against Canva's MCP using the office OAuth the owner grants. No shared tokens, no bulk automation.
**Accept when:** one real brief yields a Canva design whose text objects are native, copy exact by the existing PPTX check, with the MCP operation ids journaled.
**Proof:** `F13_MCP.json` with operation ids, the design id, and the export.

---

## 4. Proof bundle

Folder: `output/proofs/2026-09-16-flawless-system/`.
Required files: `PROOFS.json` (every artifact with sha256, producing command, time, commit), `CHANGES.md` (every file changed and why; every weakened or removed assertion), `LEDGER.csv` (every paid call this round: provider, model, ids, tokens, cost), `DEVIATIONS.md` (`BLOCKED`/`PARTIAL` items with exact errors), and the per-task files above.
Forbidden: any quality adjective as a result ("flawless", "10/10", "perfect", "production-grade"); any image not produced by the stated command; any fixture result outside a file named `*.offline.*`.

---

## 5. Reality checks the lead will run before accepting anything

1. `git worktree add` at your commit; run typecheck, tests, security scan, `validate_pack.py`; diff every existing test against `main` for weakened assertions.
2. Compare `HAWA_BUILD_COMMIT`, image creation time and `git log` on the deploy host.
3. Recompute sha256 of every artifact in `PROOFS.json`; open every image (Read); compare renders to the plan JSON beside them.
4. Query production with `app.tenant_id`, `app.user_id`, `app.role` set: plans, calls, journals, bindings; match every `chatcmpl-…`/`req_…` you cite to a row.
5. Send my own briefs and feedback from a test chat, and from the owner's chat where the owner agrees; read what comes back.
6. Query Restate `sys_invocation`/`sys_journal` for every run you cite.
7. Check the OpenAI usage dashboard totals against `LEDGER.csv` (owner supplies the screenshot).
8. Grep the diff for `catch {}`, `catch (e) {}`, `|| 8.5`, `?? 9`, hard-coded scores, and disabled tests.

A round is accepted only when every task is `ACCEPTED` or honestly `BLOCKED` with a cause outside your control.

---

## 6. How quality is measured (the only path to "10/10")

The lead runs the qualification after F01–F11 are accepted: 20 held-out briefs (10 English, 10 Sorani; five sizes) through the v1 planner (as fixed), Studio v2, and, if F13 lands, the Canva lane; judges rotated (`gpt-6-astra`, plus any second provider the owner funds) with order swap and canary; the owner rates blind pairs. Gates: zero hard-QA escapes, canary ≥ 19/20, swap consistency ≥ 80 %, judge mean ≥ 8.0, owner preference for the new lane ≥ 8/10 pairs, Canva parity ≥ 18/20, no two consecutive drafts of the same brief with the same skeleton, median cost and time recorded. The result table is the quality claim. Nothing else is.

---

## 7. Reporting format

One message per task, in this exact shape:

```
TASK: F0x — <name>
STATUS: DONE | PARTIAL | BLOCKED
COMMITS: <sha list>
PROOF: <file paths>
LIVE IDS: <provider ids or "none">
DEVIATIONS: <exact text or "none">
WHAT I DID NOT DO: <exact text or "nothing">
```

Do not send a summary table with "PASS" columns. Do not describe images; the lead opens them. Do not paste requester chat ids or tokens.
