# ADR-233: A Redo and Changes Sent While Designing Are Fresh Designs

**Date:** 2026-10-01
**Status:** Implemented on branch `claude/fresh-design-rounds` (from production `13adc35f`); not deployed.
**Requirements:** FR-005 (requester messages), FR-029 (the creative structure of a revision), FR-059 (a failure asks a person without losing work), FR-079 (caps before expensive reruns).
**Changes a foundation:** no. ADR-113's guard is unchanged for native revisions. No migration, no new dependency, no new paid call per design.
**Builds on:** ADR-113 (native revision handoff), ADR-142 (office retry), ADR-200 §6 (redo words), ADR-230 §6 (changes sent while designing), ADR-231 (office alert style), ADR-232 (grounded copy).
**Number:** 233, assigned by the lead.

## 1. Context

Live test L13, production `13adc35f`, 2026-10-01 15:09:58Z. The owner replied to the delivered KAAE K-12 design (request 95eeb08d): "do a better design that's similar to the earlier ones, use more of the photos arranged creatively, not the same plain background".

- ADR-200 §6 reopened the request and started a round (task cdfadbf0).
- Every lifecycle round named its parent in `studioOptions.parentTaskId`. So `nativeRevisionIntent()` was true, and `assertNativeRevisionAdmission` refused the run before any spend (NATIVE_REVISION_HANDOFF_REQUIRED).
- The owner heard "I'll redo …" from ChatInbox. In the same second, the refused round's outcome said "A designer will make this change to … by hand".
- The office, and the owner's own chat (the owner is an office member), got "Automatic design needs an operator in Hawa Desk. Task cdfadbf0-…: DESIGN_REJECTED (NATIVE_REVISION_HANDOFF_REQUIRED)."
- Request 95eeb08d was left `manual` on cdfadbf0.

ADR-230 §6's round for changes sent while designing (L8) had the same intent and would be refused the same way. Both had been tested only with mocked design runs.

## 2. Decision

### 2.1 Two kinds of round are new designs, not native edits

ADR-113 is right for a targeted edit of a design that a person may have changed in Canva. It stays exactly as it is for that case. Two kinds of round are not such edits:

- **a redo**: ADR-200 §6 redo words, on a delivered design or on a draft the office sent back ("do a better design", "make another version");
- **pending changes**: a round that ADR-230 §6 starts from changes sent while the first draft was being made, before anyone reviewed it.

Such a round is created with `studioOptions.freshFrom = { parentTaskId, kind: 'redo' | 'pending_changes', directive }`. It has no `parentTaskId` and no `revisionDirective`. `nativeRevisionIntent()` is undefined for it.

The round inherits from its parent:
- the client scope;
- the copy (`exactCopy` and the headline and copy fields, as ADR-232 inherits them);
- the format and Studio options.

Its photos come from the parent chain: the Studio's `imagesForRun` and `chainLinksOf` follow `freshFrom.parentTaskId` as they follow a revision's parent.

The Studio makes a new design and a new Canva design for the new task. The parent's Canva design is never opened, edited or overwritten, so no manual edit is lost.

**The requester's words are art direction.** The studio input that carries direction is the request's instructions: the brief quotes them, and the layout generator's CLIENT DIRECTION rule follows them. The round adds one line to the parent's `designInstructions`:
- for a redo: "Redo requested: make a new, different design … The requester's words about the earlier version, as art direction, not text to print: "…"";
- for pending changes: "Changes the requester sent while the first draft was being made, as art direction …".

The words are never copy. `savedDesignCopy` does not read a copy divider in a fresh round's words. No creative-package change was needed.

**Malformed or ambiguous intent is refused.** All of these are held as a native revision, before any spend:
- a `freshFrom` with an unknown kind;
- a missing or blank directive, or an extra field;
- a parent that is not a UUID;
- a `parentTaskId` beside a `freshFrom`.

`assertNativeRevisionAdmission` also refuses a fresh round whose parent is not another task of the same request and client.

Office "revise" rounds and requester change rounds after review keep `parentTaskId` and the ADR-113 handoff.

### 2.2 Changes sent while designing are applied to the copy when they add or alter words

`planPendingCopyChanges` (`fresh-round-copy.ts`) reads each change. It uses rules only, with no model call:

- **An addition.** Examples: "also please add that seats are limited", "add "Registration is free"". The words after "add that", a quotation or "add: …" are rebuilt from the requester's own message by ADR-232's `groundLine`. They become one new copy block, in their own script, and are added to `copyEn` or `copyCkb`. "seats are limited" is printed as typed.
- **An alteration.** Example: "change 15 October to 16 October". The words to replace must stand exactly once in the copy, and must be more than a field name ("the time"). The new words are grounded the same way.
- **Art direction.** Examples: "make the background blue", "add the logo", "make the title bigger". These stay direction only.
- **Anything else about the words.** Examples: "add the date", "change the time to 11:00", "remove the date line", a Sorani text change. These cannot be applied safely. The round does not start, and ADR-230 §6's existing fallback applies: the draft goes to review, and the office alert lists the changes with the reason ("a change to the design's words could not be applied safely: …"). The changes stay unread, so Deliver waits.

### 2.3 One truthful message, after the outcome is known

**The start notice waits for admission.** ChatInbox no longer sends "I'll redo …" or "I'm making those changes now" at once. It passes the words to RequestLifecycle as the decision's `startNotice` (same key, `chatinbox:change-taken:<update>`). RequestLifecycle puts them on the round's `DesignRunInput`.

The DesignRun sends the notice to TelegramSender once Core has admitted the run (the Studio run or plan exists; `LifecycleOutcomeReporter.started`), and before any outcome. ADR-230 §6's "Your first draft of … is done. I'm now adding …" moves into the new round's start notice the same way, under the key the outcome message used.

A round refused at admission is therefore answered once, by its outcome. An office retry never repeats a start notice. A start notice for another chat, or with extra fields, is refused.

**Outcome alerts with no draft are plain words.** The office alert for an outcome with no draft (`composeNoDraftOfficeAlert`, ADR-231's style) says who it is for, names the design, and says what to do in plain sentences. It ends with one "Desk search: <id8>" line. Examples:
- "The change Hawzhin asked for on "KAAE K-12 Pilot Study…" has to be made by hand: …";
- "The automatic design of … stopped without a draft. Open it in Hawa Desk to see why, then retry it or make it by hand."

The code stays in the task's history in the Desk.

**A requester who is also an office member** hears one message about such an outcome: their own line, then the office's sentence. They are not sent the office alert separately. The other members get the alert. A draft's photo alert is unchanged (ADR-155).

### 2.4 Recovery of 95eeb08d: the existing office retry

ADR-142's office retry applies to 95eeb08d as it stands:
- the request is `manual`;
- the last revision is a design outcome of cdfadbf0 with no draft and no question;
- the task is `failed_operator`;
- no Studio run exists.

cdfadbf0's saved intent still names a native parent, and a creation event cannot change. So the retry projection (`freshSuccessor`) converts a round of this exact shape:
- the round is words alone;
- it was refused with NATIVE_REVISION_HANDOFF_REQUIRED;
- its parent is this request's `complete` (delivered) task (a redo), or its draft superseded by pending changes.

The projection creates a fresh successor task with `freshFrom`, built from the parent's brief, under the daily allowance. It moves the request to `designing` on the successor and closes cdfadbf0 (`failed_operator → cancelled`, with `supersededBy`). RequestLifecycle starts `dr-<successor>`.

Any other task is retried as before. A replay answers `replayed`. Nothing is sent to the requester.

## 3. Cost

No new paid call. Each fresh round is one design run, the same as the round that was refused. It is allowed because it is the requester's explicit instruction. It counts against the daily automatic-design allowance (`persistChatIntake`). Pending rounds keep `MAX_PENDING_ROUNDS` (3), and office retries keep `MAX_OFFICE_RETRIES` (3). Copy changes are read by rules.

## 4. Handoffs

**To Codex (studio).** A redo says "similar to the earlier ones". Today the studio can only read that as words; it cannot see the earlier design. A `previousDesign` input, with the parent's winning layout or preview marked as a reference that is not to be copied and not counted as a photo, would let the brief and the judge compare against it. This is not needed for correctness, and nothing here depends on it.

**To Codex (Desk).** The Desk's "Re-drive Generation" answers 202 with `freshTaskId` for a converted round. The Desk could open the successor task.

## 5. Verification

**`apps/core/test/fresh-design-rounds.test.ts` (12 tests).** The test database is real, the harness's DesignRun stand-in runs Core's real admission guard, and the real `DesignStudioService.createOrGetRun` and `CanvaDesignPlanner.generate` admit or refuse each round:
- the live L13 words after delivery: admitted as a new design, parent binding, task and runs untouched, one "I'll redo" message;
- redo words on a draft sent back;
- replay;
- the album's photos reach the fresh round;
- the owner as office member;
- the live L8 words: admitted, with "seats are limited" in the run's copy blocks;
- an unsafe text change falls back to review with the changes listed;
- the copy rules as units;
- an after-review change: still refused, one plain message, a plain office alert;
- malformed, ambiguous and out-of-scope intent: refused;
- a no-draft outcome for an office-member requester;
- recovery: a pre-ADR-233 refused redo, retried from the Desk, is designed as a fresh successor; then `replayed`; then reviewed.

**`apps/worker/test/design-start-notice.test.ts` (3 tests).** A refused run is never announced; an admitted one is announced once, before its outcome; RequestLifecycle carries the notice and refuses one for another chat.

**Changed deliberately**, with the reason in each test:
- `pending-change-round.test.ts` and `redo-understanding.test.ts`: `freshFrom` in place of `parentTaskId`;
- `lifecycle-office-retry.test.ts`: the plain office alert;
- `chat-inbox.test.ts`: the change notice travels with the decision;
- the conversation harness: it runs the real guard at design start, sends the start notice on admission, and can report refusals and office retries.

The chaos matchers for operator alerts were updated but not run (the chaos project is shared and locked).

Red first and full-suite totals are recorded in section 6.

## 6. Local qualification

**Red first.** With `apps/core/src`, `apps/worker/src` and `packages/domain/src` at `13adc35f` (domain dist rebuilt), and the new tests and harness kept, 14 of the 16 new tests fail:
- 11 of the 12 in `fresh-design-rounds.test.ts`. On the base, every redo or pending-changes round is refused by the guard. The requester first hears "I'll redo …" and then "by hand", and the office gets the code. The twelfth is the unit test of the new copy rules.
- 2 of the 3 in `design-start-notice.test.ts`. The third, "a refused run is never announced", passes on the base too: the early announcement came from ChatInbox, which the core tests cover.
- The new domain test.

**Full runs.** `apps/core`, `apps/worker`, `packages/integrations` and `packages/domain` together: 359 files and 4,297 tests passed, with 3 files and 4 tests skipped. A Desk `vite build` was in place. `pnpm typecheck` (661 test roots) and `pnpm lint` pass.

**Changed by the first full run.** With the harness now reporting refusals as production does:
- S030, S031, S034, S043 and S045 answered nothing until the default was set to report refusals.
- S043 now expects what production does: each after-review change is answered once, "by hand" (section 7).
- `late-reference-rebrief` showed that the Studio must read a fresh round's parent from the run's own request (`fresh`), as it reads `directed`, not from a new database read.
- Three alert tests now expect the plain wording.

## 7. Limits

- **Not tested live.** No live Telegram, Canva or model call. Chaos was not run.
- **Copy changes are read by English rules.** A Sorani change to the words is left to the office. An alteration must quote the words it replaces.
- **A fresh round does not see the earlier design** (handoff above).
- **A change after review is refused each time.** After a refused native revision, the request is `manual` again, so each further change the requester sends starts another round that the guard refuses (no spend). Each is answered once, "by hand". Keeping those words for the office instead of starting a round is a separate decision (open).
- **Mixed deployments.** Core and the worker ship together. An older worker ignores `startNotice`, so the requester would hear nothing when a round starts. An older Core never sends `freshTaskId`.
