# ADR-253: A Double-Role Member's Polite Cancel, the Client's Possessive, and Text-Only Draft Alerts

**Date:** 2026-10-02
**Status:** Implemented on branch `claude/hunt2-office` (from production `1e0616f0`); not deployed.
**Requirements:** FR-005 (requester messages), FR-061 (cancel with an audit trail), FR-013 (exact copy), FR-043 (office approval).
**Changes a foundation:** no. No migration, no new dependency, no new paid call. One optional field is added to a Telegram send mark's payload (section 2.4).
**Builds on:**
- ADR-239: an office member's cancel of their own request is a requester's withdraw.
- ADR-230: a requester's cancel withdraws a request.
- ADR-200: the office chat is read like a chat.
- ADR-232: copy taken from a request's sentence.
- ADR-180 and ADR-155 addendum: the draft photo alert.

**Number:** 253, assigned by the lead. Bug hunt 2 (2026-10-02), items L20, R8, L21, L22 and the office alert text.

## 1. Context

Live, 2026-10-02, in the owner's chat (an office member and a requester):

- **L20.** About their own draft waiting for review, the owner wrote "could you please cancel the Quality Assurance Workshop poster, we don't need it anymore". The bot answered "What should I do with **KAAE's Quality Assurance Workshop**: approve it and send it, send it back with changes, or reject it?".
  - The requester rules strip a leading "please", not "could you please". The words read as nothing to the rules.
  - The office model read a rejection. ADR-200 lets the model alone never reject, so the bot asked what to do.
  - Because the words were never read as a cancel, ADR-239's handover to intake did not happen.
- **R8 (review).** ADR-239's handover checked only that the request's chat is the member's chat, not that the member asked for it.
- **L21.** "a poster for KAAE's Quality Assurance Workshop" printed the headline "KAAE's Quality Assurance Workshop". The same brief's sibling was titled "KAAE: Quality Assurance Workshop", so the two titles had different forms.
- **L22.** Task f3cb89e8's QA report had `passed: true` with `contrastCompliant`, `safeMargins` and `fontCoverage` all null.
- **Office alert.** When Telegram refuses the draft's photo, the office gets the alert's text instead. That text says "Approve or send it back in Hawa Desk on the office computer." The caption says "Just say “approved” …".

## 2. Decision

### 2.1 Polite cancelling words reject the whole design (office reading)

`readOfficeIntent` drops a polite request opener before it reads cancelling words. The openers are:

- "could / can / would / will you (please / kindly / just)";
- "I'd / we'd like (you) to";
- "please", "kindly".

A closing "?" is dropped too. What remains must cancel by itself (`OFFICE_CANCEL` or the requester rules' `cancel`). If it does, the words are a rejection of the whole design (`task`). For example:

- "could you please cancel …, we don't need it anymore";
- "can you cancel it?";
- "would you please drop it".

"could you please make the title bigger" is still a change. "drop it" and "we don't need it anymore" were already rejections.

### 2.2 Handed over only when this member asked for it (R8)

`ownRequestCancelled` hands the words to intake only when both hold:

- the request is in this chat;
- its requester is this member.

The requester is found as intake finds it (`activeChatRequests` `requesterId`): the sender of the request's source message, or the sender its opening decision was recorded for.

A request in the chat that someone else asked for stays the office's to reject. So does a request whose requester is not known.

### 2.3 Intake's question is intake's to answer

Some cancels hand over words intake is not sure of, such as the live words. Intake then asks, as it asks any requester: "Do you want me to cancel **Quality Assurance Workshop**?".

Until now, the member's "yes" to that question went to the office turn. A model could read it as approval of that very draft. The office turn now leaves the words to intake when all of these hold:

- the member's latest message was answered by intake with a question;
- the question was asked within 30 minutes (`PENDING_ASK_MS`);
- no office alert reached the member since;
- the words answer it plainly: yes, no, a number, or a name it listed.

### 2.4 The client's possessive is not the headline (L21)

**The headline.** A headline chosen by the model or by the rules loses a leading possessive of the identified client: "KAAE's Quality Assurance Workshop" or "KAAE’s …" becomes "Quality Assurance Workshop". The client's names are:

- KAAE's label;
- the pack's code, display name, names and aliases.

Routing nouns are left out of those names ("university", "accreditation"). What remains is still the requester's own characters, in their order. The receipt records what was left out (`copyExtraction.withoutClient`).

**What is unchanged.** Words the requester quoted, another name's possessive ("Sewa's Book Fair") and the client named without one ("KAAE Quality Week").

**Titles.** One form for every title: "KAAE: Quality Assurance Workshop".

- `copyTitle` and `requestTitle` title a headline that starts with the client's possessive as "<client>: <rest>".
- They do this only when the label is the client's.
- A sender's name used as the label is left as it was ("Sara's Bakery opening").

### 2.5 A draft alert sent as text is not a picture to approve (office alert)

**Where both are built.** `office-draft-alert.ts` builds both texts, and `lifecycle-projection.ts` puts them on the alert:

- `officeText` (no `telegramDecision`) is the alert's text;
- `photoCaption` is the photo's caption.

The worker sends the text when the picture cannot be read, has changed, or is refused.

**What was wrong.** The text goes under the photo's key. Its sent mark carries the text message's id, so a reply to it names the draft, and so do plain words. `approvalEvidence` could not tell that no picture arrived, so it approved and recorded a `telegram_photo` visual check that never happened.

**The fix.**

- TelegramSender marks a photo alert it sent as text with `pictureNotSent: true` on the sent mark (`writeSendMark`).
- Core's `alertSentTo` then finds no picture. Telegram approval answers `office.useDesk` ("Please approve it in Hawa Desk").
- Words of change and rejection still work by reply or by plain words.

So the text keeps "Approve or send it back in Hawa Desk". Matching the caption ("Just say “approved”") would invite an approval without the picture.

**Mixed deployments.** An older worker writes no flag, and Core behaves as before. An older Core ignores the flag.

**The conversation harness had the same hole.** `apps/core/test/fixtures/conversation-harness.ts` gave the sender `readDraftImage(ref)`, but the sender calls `(trx, ref)`. So every photo alert in the natural-language stress scripts went as text, and the office still approved from Telegram. With the flag, 12 scripts (S123–S150) failed. The harness now reads `(trx, ref)`, and the pictures are sent as photos.

### 2.6 L22: no change; null means not measured

`evaluateCanvaExportQc` (core-helpers.ts) reads the exported PPTX. It checks copy, fonts and paragraph direction. It does not measure contrast, safe margins or rendered glyph coverage, and its type says so: null means "this evaluator did not measure it". The Desk shows null as ○ "not measured".

Contrast and safe margins are checked earlier, on the Studio render. Only a candidate whose hard QA passed (`evaluateHardQa`, pipeline-v3) goes to Canva.

**Gap, not closed here.** Nothing measures the Canva export that ships. A Canva-side edit, or Canva's own font rendering, can change contrast, wrapping or margins after the Studio check. The office's photo review is the only check on those pixels.

**Proposed follow-up.** Measure contrast and the safe area on the captured PNG export, using the PPTX's text frames for the boxes. Record booleans in `qaReport`, and block on a false.

## 3. Consequences

**Polite cancels.**
- An office member's polite cancel of someone else's draft now rejects it, with no question.
- The same words about their own request go to intake. Until intake reads "could you please …" as a certain cancel (section 4), intake asks "Do you want me to cancel …?", and "yes" withdraws.

**Telegram approval without the picture.** It is now refused once the new worker sends the alert.

**Titles and headlines.**
- New KAAE titles of the form "KAAE's …" are now "KAAE: …".
- Stored titles are shown as they are.

## 4. Handoff (files owned by other agents)

**`requester-turn.ts` `LEAD` (intake).** It should also drop "could / can / would you (please)" before reading a cancel. Then intake withdraws the live words at once instead of asking. The office side already reads them.

**`lifecycle-internal.routes.ts` (friction #6).** With KAAE's model reading on, a cancel intake is unsure of is re-read by the intent model, which has no cancel option. Until that is fixed, the handover in section 2.2 may be read as a change. ADR-239's handover has the same exposure.

## 5. Verification

**`apps/core/test/office-telegram-approval.test.ts` (+12).**
- Intent table: 7 new phrases.
- The live words with a model that reads a rejection, then a model that reads "yes" as approval: the request is withdrawn, never the office question, never approved.
- R8: a request in the member's chat asked for by someone else is rejected by the office.
- A member who did not ask: "could you please cancel …, we don't need it anymore" and "drop it" reject at once.
- A text-only alert: "approved" (reply or none) answers use-Desk, and "make the title bigger" still goes back.
- Red before: 8 fail with `office-telegram-turn.ts` at `1e0616f0`.

**`apps/core/test/request-copy-extraction.test.ts` (+4).** Covers the live brief by the rules, the model's headline with both apostrophes, what is kept, and the titles. Red before: all 4 fail.

**`apps/worker/test/office-draft-alert.test.ts` (3 tests extended).** Covers the mark of a photo sent as a photo, a picture that cannot be read, and a picture Telegram refuses. Red before: 2 fail.

**Full run.** Full `apps/core`, `apps/worker` and `packages/integrations` run, after a Desk `vite build` for the bundle-size check: 4289 passed, 4 skipped, 0 failed (347 files passed, 3 skipped). `pnpm typecheck` passes.

**Not run:** live Telegram, Restate, chaos.
