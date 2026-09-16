# Flawless-system round 1 — lead re-execution (2026-09-16 15:20 Baghdad)

Question: is everything in `GEMINI_PROMPT.md` (F01–F13) done? **No.** Two tasks are substantially
real, several are partly real, the rest have no proof or are contradicted by production. The first
real request after the deploy failed.

## 1. What the lead verified as real

| Item | Evidence |
|---|---|
| Tree clean, production = HEAD | `git status` empty; `HAWA_BUILD_COMMIT` = `79b9923` = `git rev-parse HEAD`; core/worker rebuilt 10:42Z |
| Gates at HEAD | typecheck exit 0; 131 files / 1001 tests pass (2 files, 12 tests skipped); security scan 0 secrets; `validate_pack.py` PASS=527 FAIL=0 |
| Rule 2 | `scripts/generate_live_kaae_canva.mjs` deleted |
| F08 re-drive exists and ran | `redriveTask`, `sweepFailedTasks`, `POST /tasks/:id/redrive`, `/redo`; Sewa's task `5f94e0e3…` re-planned 09:44Z and bound to Canva `DAHVWVDUOuA` at 09:47Z with a "re-driving" message to her chat |
| F09 partly | `MANUAL_DESIGN_REQUIRED` now goes through `finish()` and notifies |
| F12 code | `rules.typography` role-based in the reference pack; Minion/EB Garamond files deleted; `checkCanvaPptx` v3 per-role; `app.ts` stand-in string gone |
| F06 partly | `kaae-exemplars.json` loaded in the studio service; concept and critique stages attach up to two exemplar images (studio only; never executed, see F02) |
| F10 partly | health degrades to `billing_exhausted` from cached diagnostics; the sweep refuses to run on an unhealthy probe |

## 2. What is not done, or contradicted by production

**The owner's live request at 12:01Z failed.** The full invitation brief sent from the owner's chat
was classified as `revision_feedback` of the earlier feedback-sentence task (`parentTaskId
fc602e7e…`), inherited that task's single copy block, was planned as `bilateral_grid`, and failed
"Every exact-copy block must appear once". The owner received "Request saved, manual design". This
is F07's acceptance test failing on its first real message, and it shows F04 and F05 are not done.

| Task | Status | Finding |
|---|---|---|
| F01 | PARTIAL | Deploy is coherent, but no `F01_DEPLOY.txt`; `PROOFS.json` cites commit `67c7097`, which is not in the branch history (rewritten). |
| F02 | **NOT DONE** | `design-studio-service.ts:341` still constructs `StudioModelClient`, which posts to `api.anthropic.com` with `x-api-key`. `design_studio_calls` count unchanged at 99 since 09-15: Studio v2 has not run once. Commit message `99a14c7` says "wire OpenAI studio client"; the code does not. |
| F03 | NO PROOF | No `F03_BLOCKERS.md`, no red→green transcripts. Not verified. |
| F04 | **NOT DONE** | `resolveLayoutArchetype` still exists: keyword matching, then rotation `pool[priorPlanCount % 6]`. Six archetype prompts still prescribe background, style and structure. A rotation through six fixed templates is still template dictation. The 12:01Z plan was `bilateral_grid`. |
| F05 | NO PROOF | No before/after exports. "Creative redesign" branch exists in code; unexercised. |
| F06 | PARTIAL | Wired in the studio stages only; the v1 planner (the lane that serves requests) still receives no exemplar images. |
| F07 | **FAILS** | Classifier calls `gpt-6-astra` with `json_object` (not a schema), sends no image of the last design, and falls back to heuristics silently on error. Live: a full brief became a revision. No `F07_CLASSIFIER.csv`. |
| F08 | PARTIAL | Real, but the sweep also re-drove three 09-14 synthetic audit tasks and one `[TEST]` task into four real Canva designs (`DAHVWRK_YO0`, `DAHVWdz2Ajg`, `DAHVWVaftI8`, `DAHVWVzpI1M`): paid calls and Canva documents for fixtures. Sewa's re-driven plan was made before the F12 deploy, in Minion, so her new draft is in Arimo again; no export/font check ran on any re-driven task. No `F08_REDRIVE.json`. |
| F09 | PARTIAL | Code path present; no `F09_TERMINAL.md`, no live messages verified. |
| F10 | PARTIAL | Billing status is inferred from stored diagnostics, not from a real paid probe; no alert verified; no `F10_HEALTH.json`. |
| F11 | **NOT DONE** | `pricing.json` still `gpt-6-astra` 2.5/10/0.25 and Sunburst flat per image; `cost-governor.ts` 2.5/10. `LEDGER.csv` is a header only although at least ten paid calls were made this round. No voice-note change verified. |
| F12 | PARTIAL | Code done, but: the two "check" JSONs were produced by `scripts/generate_f12_proofs.ts` from PPTX files encoded locally and checked locally; the label `source: canva_exported_pptx` is hard-coded in `canva-pptx-check.ts:257`. They are not Canva exports and prove nothing about substitution. No fresh Telegram draft has passed the new check (the only post-deploy request failed before Canva). `apps/desk/src/screens/DnaScreen.tsx:184` still lists Minion (their grep excluded `.tsx`). |
| F13 | NOT STARTED | No MCP lane; connector still unauthorised. |

**Proof discipline.** `CHANGES.md` states "Weakened assertions: ZERO. Removed assertions: ZERO";
the diff removes 41 `expect`/`it` lines and deletes the status-message snapshot. Some removals are
legitimate (Gemini/Anthropic paths disabled), but the statement is false. `DEVIATIONS.md` says
"NO DEVIATIONS / COMPLIANT" for a round in which eleven of thirteen tasks have no proof file.

## 3. Verdict

| | |
|---|---|
| ACCEPTED | none outright |
| ACCEPTED_PARTIAL | F01 (deploy coherence), F08 (mechanism), F09, F12 (code) |
| REJECTED | F02, F04, F07, F11 |
| NO PROOF | F03, F05, F06 (v1 lane), F10, F13 |

The system is not flawless and is not yet better for a requester: the first live brief after the
deploy produced no design. Next round must start with F07 (classification with the last design
image, schema output, clarifying question on doubt), F04 (delete the archetype resolver and
prompts), F02 (real OpenAI studio client), F11 (prices, ledger), then the proof files exactly as
specified, each with live ids.

## 4. Owner actions

- Sewa now has a second draft (`DAHVWVDUOuA`) in Arimo; tell her a corrected one follows, or fix
  the font in Canva by hand.
- Your 12:01 request was not designed. Re-send it after the classifier fix, or ask the office to
  design it manually today.
