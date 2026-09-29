# ADR-140: Thanks and Receipts Open No Request

**Date:** 2026-09-29
**Status:** Implemented and locally qualified; not deployed.
**Requirements:** FR-005 (passive messages become tasks only through an explicit command or an approved classifier policy).
**Changes a foundation:** no. It narrows what the local classifier (`classifyWithHeuristics`) calls a new brief.
**Builds on:** ADR-135 (every Telegram request takes the lifecycle path; Core's internal intake opens a request for an unlinked message it classifies `new_brief`), the acknowledgement rule of 2026-09-23 (`isAcknowledgement`, thanks under a draft start no paid revision).

## 1. Context

Chaos scenario R10.H1 (2026-09-29, branch `worktree-agent-a5c2332c781ce70aa`) ends with a requester thanking the office after a delivery: "Thank you, we received the files." With no request waiting for the requester, Core's internal intake (`apps/core/src/routes/lifecycle-internal.routes.ts`, the `mayOpen` block) asks `classifyWithHeuristics` whether the message is a brief. The acknowledgement list held whole phrases only ("thanks", "thank you", "received"), so the added clause "we received the files" did not match. It had six words, which is too many for the short-chatter rule, so the message fell to the default `{kind: 'new_brief', confidence 0.8, reason 'Standard new design brief text'}`. Core opened a manual lifecycle request in the Desk, and the requester was told "Request received. An art director will review it." The previous release's legacy intake did the same ("Brief received and queued in Hawa Desk").

## 2. Decision

- **A receipt is an acknowledgement.** `isAcknowledgement` also accepts receipt clauses built from a closed vocabulary:
  - English: an optional subject ("I", "we", "we've", "we have just"), then "received" or "got", then an optional object ("it", "them", "everything", "all", "the files", "your design", "the final posters", …).
  - English, the other way round: the object first, then "received", "arrived" or "came through" ("files received", "everything has been received").
  - Sorani: an optional noun (فایل, دیزاین, پۆستەر, وێنە, بەڵگەنامە, هەموو, with its suffixes), an optional پێم/پێمان, then گەیشت/گەیشتن/گەیشتووە, وەرمگرت/وەرمانگرت or وەرگیرا.

  An optional adverb can close a clause ("safely", "in full", "thanks"). The thanks list also gains "thanks again", "thank you again", "with thanks" and شکرا/شكراً. Everything in the message must be these phrases, clauses, emoji and punctuation, and it may be at most 100 characters (it was 60). A clause that goes on ("we received the files. Please make a poster for 5 May", "we received an award, make a poster") is not a receipt, and the brief rules decide as before.
- **No other rule changes.** The acknowledgement check already ran before every other heuristic rule and before any model call, so a receipt is now `{kind: 'other', reason: 'Acknowledgement'}` whether or not the chat has a recent design and whether or not the message is a reply. The intake route is unchanged: a non-brief with no waiting request goes to the old intake's finish-only scope, as greetings and questions already did.
- **A receipt is thanked back.** The old intake answered every non-reply `other` with "Hello! How can Hawa Creative OS assist you today? Please send your event brief…", which reads as if the files never arrived. An acknowledgement is now answered "🙏 Thank you." (Sorani: "🙏 سوپاس."). A thanks sent as a reply to a draft keeps its existing answer.

## 3. Consequences

- A thanks or receipt in a chat with no waiting request no longer opens a lifecycle request, creates a Desk item or tells the requester an art director will review it. Under a draft it still starts no revision.
- A message that pairs a receipt with a request ("received, but please change the date") is read as before, as a change or a brief. The receipt vocabulary is closed, so a receipt worded outside it ("the files reached us yesterday") is still a brief. The Desk still shows such a message for a person to discard. The cost is at most one unneeded manual request, as before this ADR.
- A waiting request still takes any unlinked message as its answer or revision (ADR-135). This ADR does not change that.

## 4. Verification

- `apps/core/test/telegram-classifier.test.ts`, "thanks and receipts are not briefs":
  - 23 English, Sorani and Arabic thanks/receipts are `other`/`Acknowledgement`, with and without a recent design.
  - A receipt costs no model call when the model is allowed.
  - Six one-line briefs that open with thanks or mention receiving something are still `new_brief`.
  - A change after a receipt is still `feedback`.
- `apps/core/test/lifecycle-internal-intake.test.ts`, "a thanks … with no waiting request opens no lifecycle request". The worker intake route is run against the per-file database in three cases: a new chat, a chat whose request was delivered, and the Sorani thanks after a delivery. In each case the answer names no lifecycle action or request, the chat's task and request counts are unchanged, and the requester is thanked back, with no "Request received", "Brief received", "art director" or "send your event brief" message.
- Red first: with the classifier and reply change reverted, 21 of the new tests failed. Thanks the old list already knew ("thanks", "سوپاس", …) passed.
- Full suite in a fresh worktree: 4,942 passed, 64 skipped, 1 failed. The failure was `hawa-work-desk-cv17` (bundle size), which needs a Desk build the fresh worktree lacked; after `vite build` it passed 7/7. `pnpm typecheck` (587 test roots) and `pnpm lint` passed.
- Not run: chaos R10.H1 against this change, and any live Telegram traffic.
