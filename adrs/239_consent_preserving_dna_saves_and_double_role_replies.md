# ADR-239: DNA Saves Keep a Client's Model Consent Only When Safe; One Person Who Is Requester and Office

**Date:** 2026-10-01
**Status:** Implemented on branch `claude/consent-and-double-role` (from production `baffce10`); not deployed.
**Requirements:** FR-066 and NFR-007 (per-client model-egress policy, enforceable and testable), NFR-006 (auditable authorisation), FR-054 (only authorised humans supersede Client DNA), FR-005 (requester messages), FR-061 (cancel with an audit trail).
**Changes a foundation:** no. No migration, no new dependency, no new paid call. `egressAllowed()` and voice admission are unchanged.
**Builds on:** ADR-234 (an administrator records a client's model consent), ADR-230 (a request can be withdrawn), ADR-040 addendum and ADR-200 (the office decides in Telegram, read like a chat), ADR-180 (the draft photo alert).
**Number:** 239, assigned by the lead. The owner approved both fixes on 2026-10-01: "go ahead with all of them".

## 1. Context

### 1.1 A DNA save switched model reading off without a word

ADR-234 §4 named this consequence. Every DNA writer saves the new version with `approved_by` NULL:

- POST `/v1/clients/:clientId/dna` (the Desk's DNA editor);
- POST `/snapshots`;
- POST `/dna/rollback`.

`egressAllowed()` (requester-intent-model.ts) and voice admission (lifecycle-voice.ts) read only an approved active version. So once KAAE's consent was recorded, the next Desk edit of a colour closed the intake router, the office reader, the copy reader and voice transcription for KAAE. Nobody was told.

There was a second fault in the same route. The Desk sends back what GET `/dna` showed it, which includes the previous version's `__commitMessage` and `__createdBy`. POST `/dna` hashed those into `content_hash`. Design reads hash the stored DNA without them, so a Desk-saved version could fail their check.

### 1.2 One person who is both requester and office member

The owner's chat (7191500129) is both an office member's chat and a requester's chat. Live, 2026-10-01, about their own draft waiting for review, the owner wrote:

> please cancel the Quality Assurance Workshop poster, it was only a test

The ADR-200 office turn read it as an office rejection of the named draft. It answered:

> About the **KAAE: Quality Assurance Workshop** draft I sent you just now:
> Rejected: **KAAE: Quality Assurance Workshop**. Nothing was sent to you.

A requester's cancel is a withdraw (ADR-230). It should have said "Cancelled …. Nothing more will be made for it."

Two office lines also still told members to reply to a picture:

- the draft alert caption: "Reply to this picture with “approved” …";
- `office.lostTrack`: "… please reply to the draft picture with what you want."

The owner's rule is natural language only. Since ADR-200 the office chat reads words with no reply anyway.

## 2. Decision

### 2.1 A DNA save keeps consent only when it is safe

The three writers save through one function, `saveDnaVersionKeepingConsent` (client-model-consent.ts). It runs in the save's transaction and takes the consent action's per-client advisory lock. It reads the active version `FOR UPDATE`.

**When consent is kept.** The new version is approved by the saving administrator only when all of these hold:

1. **Previous consent.** The superseded version was approved and has a `privacy` block.
2. **No race.** The new version directly follows it.
3. **Same privacy.** The new `privacy` block is canonically identical (`canonicalJson`) to the superseded one.
4. **A human administrator.** The actor passes ADR-234's identity rules:
   - role `administrator`;
   - a uuid user id that is not a service id;
   - not a worker, design worker, anonymous or test principal;
   - in this tenant;
   - `hawa.has_tenant_role(tenant, administrator)` holds in Postgres.

When all hold:

- `approved_by` is the administrator's user id.
- One `hawa.audit_events` row is written in the same transaction:
  - action `client.model_consent.kept`;
  - before and after content hashes;
  - in `data`: the route (`dna`, `snapshot` or `rollback`), the versions, the privacy block, the previous approver, and the actor (user id, actor id, auth method, role).

The production trusted office (user `…0002`, `trusted_office_team`) qualifies, as it does for ADR-234.

**Any other save.** A non-administrator, a service or test identity, a changed or removed privacy block, a client with no recorded consent, or a moved version: the save is unapproved as before, and nothing is weakened.

**The answer.** Every database-backed save's answer now carries `modelReading`, read through the real `egressAllowed()` after commit:

- POST `/dna`: the DNA plus `modelReading`.
- POST `/snapshots`: the snapshot plus `modelReading`.
- POST `/dna/rollback`: `modelReading` beside `activeDna`.

The value is `{ openai: true }`, or `{ openai: false, reason }`. The reason is one of:

| Case | Reason begins with |
|---|---|
| No recorded consent | "This client has no administrator-approved consent to model reading." |
| Not a human administrator | "Only an office administrator, signed in as a person, keeps the client's model consent when saving DNA." |
| Privacy changed | "The privacy block changed in this save, so the client's model consent was not carried over." |
| Version moved | "The active DNA version changed during this save, …" |
| Consent kept, but it or the client's policy does not admit OpenAI | "The client's recorded consent or its model policy does not admit OpenAI." |

**Rollback.** It follows the same rule. Rolling back to a version from before the consent (no privacy block) changes the privacy block, so model reading closes, with the reason.

**What POST `/dna` no longer stores.** Before hashing, it drops `__commitMessage`, `__createdBy` and `modelReading` from the body. The stored version gets its own commit message, as before. Its content hash is now the one design reads verify.

### 2.2 An office member's cancel of their own request is a requester's withdraw

The office turn plans as before. A plan is handed to intake instead of being carried out when all of these hold:

- it decides a `reject` of category `task`, which is what the rules read from cancelling words ("cancel it", "scrap this", "please cancel the … poster, it was only a test");
- its words are this message's own;
- its request's `chat_id` is this member's chat.

When it is handed over:

- **Receipt.** The turn is recorded as `requester-withdraw`. A replay of the update finds that receipt and hands the words over again, whatever the queue holds by then. It never re-plans onto another draft.
- **Office turn.** It answers nothing.
- **Intake.** It reads the words as any requester's cancel. A named, replied-to or only open design is withdrawn (ADR-230): "Cancelled **Quality Assurance Workshop**. Nothing more will be made for it." Other office members are told by name. A cancel intake is not sure of is asked first, as for any requester.

**Unchanged:**

- Rejecting words ("reject", "not approved") and approval from the same person stay the office's (ADR-040, ADR-200). Approval keeps its confirmation rules.
- The same member cancelling someone else's draft is still the office's rejection.
- An answer to the bot's own question ("which draft?" answered "2") is not handed over, because intake would read only "2". It is decided as before.

### 2.3 Plain-chat office wording

**`office.draftAlertDecide`** (the photo alert's last line):

- English: "Just say “approved” to send it to {requester}, or tell me what to change. You can also decide in Hawa Desk."
- Sorani: "تەنها بڵێ «پەسەندە» بۆ ئەوەی بۆ {requester} بنێردرێت، یان پێم بڵێ چی بگۆڕدرێت. دەشتوانیت لە Hawa Desk بڕیار بدەیت."

**`office.lostTrack`:**

- English: "I've lost track of that question, so I haven't done anything. Just tell me again what you'd like me to do with the draft."
- Sorani: "ئەو پرسیارەم لێ ون بوو، بۆیە هیچم نەکرد. تەنها جارێکی تر پێم بڵێ دەتەوێت چی لە ڕەشنووسەکە بکەم."

Both Sorani lines are listed in `SORANI_REVIEW.md` for native review.

The catalogue test no longer exempts office lines from the no-reply-target rule. It also refuses the Sorani "answer this picture" wording. A reply to the picture still works; it is just not asked for.

## 3. Consequences

- **Saving a consented client's DNA.** The office's own saves no longer silently stop model reading. Any save that does stop it says so in its answer. The Desk does not show that yet (§4).
- **What the kept approval means.** A kept version is approved by the administrator who saved it, including its design changes. Under ADR-234 `approved_by` gates only egress; design reads check the content hash, which is now consistent.
- **Who can save at all.** An administrator with no membership cannot save DNA, because row-level security hides the client. So the membership check only matters for an actor that RLS lets through.
- **Mixed deployments.** No schema or worker change. An older Desk ignores the new `modelReading` field. The route drops it from what the Desk sends back, so it never reaches the DNA.
- **The owner's own cancels.** A cancel from the owner about their own draft in review is now a withdraw. The request is `cancelled`, not `rejected`, and the owner hears the requester's words. Other office members hear ADR-230's alert.
- **Not changed (requester-facing legacy wording).** The legacy Canva-outcome caption ("Reply to this image with any change you want.", canva-outcome.routes.ts) and the legacy classifier's "Reply “new” or “revise”" are on the pre-lifecycle path. Both still name a reply target. They are left for the legacy retirement.

## 4. Handoff to Codex (Desk)

`apps/desk/src/screens/DnaScreen.tsx` `saveDnaChanges` sets the POST `/dna` answer as the current DNA and shows the success notice. It should also read `saved.modelReading`.

- **When `modelReading.openai === false`:**
  - show a warning beside the success notice: "Model reading is now off for this client: <reason>".
  - offer a way to record consent again: GET and POST `/v1/clients/:id/dna/model-consent` (ADR-234), administrators only.
- **When `modelReading.openai === true`:** nothing new is needed.
- **Snapshots and rollback:** handle `modelReading` on the snapshot-commit and rollback answers the same way.
- **Before sending the DNA back:** strip `modelReading` from `currentDna`. Core ignores it either way.

No Core change is needed for this.

## 5. Verification

### 5.1 `apps/core/test/dna-save-keeps-consent.test.ts` (10)

It runs against the per-file test database as `hawa_app` under RLS, through the real routes, the real trusted-office identity and the real `egressAllowed()`. It covers:

- **The office administrator's Desk save** (GET, then edit, then POST, as the Desk does):
  - version 2 is approved by `…0002` with the same privacy block, and the gate stays open;
  - a reading reaches the provider through the real ledger and allowance;
  - the content hash is the stored DNA's, and a design reference on version 2 is current;
  - the audit row is written;
  - the next save, which sends that answer back, is kept again and stores no `modelReading`.
- **Saves that stay unapproved** (operator, art director, test administrator, service id holding the administrator role): the gate closes, and the answer gives the reason.
- **An administrator's privacy change** (a provider added, or the block removed): unapproved, with the reason.
- **No recorded consent** (none at all, or a privacy block on an unapproved version): unapproved, with the reason.
- **Snapshots:** an administrator's is kept; an operator's is not.
- **Rollbacks:**
  - an administrator's rollback to the same privacy is kept;
  - an art director's is not;
  - a rollback to before the consent changes the privacy block, so it is unapproved.

Red before: with `clients.routes.ts` and `client-model-consent.ts` at `baffce10`, all 10 fail.

### 5.2 `apps/core/test/office-telegram-approval.test.ts` (+3)

These run through Core's intake, the signed gateway and RequestLifecycle's own `withdraw`:

- **The owner's exact live words about their own draft in review:**
  - intake decides `withdraw` for that request and the office turn answers nothing;
  - RequestLifecycle closes it, and the owner hears "Cancelled <b>Quality Assurance Workshop</b>. Nothing more will be made for it.";
  - nothing says "Rejected", no office decision is sent, and a replay decides the same.
- **"cancel this" in reply to the picture of their own draft:** withdrawn the same way, and another requester's draft is untouched.
- **Guard:** "approved" from the same person on their own draft stays the office approval ("Approved. Sending … to you now."). "cancel this" on someone else's draft stays the office's rejection.

Red before: with `office-telegram-turn.ts` at `baffce10`, the first two fail (the office turn answered); the guard passes.

### 5.3 Wording tests

- `packages/integrations/test/requester-messages.test.ts`: the office lines are held to the no-reply-target rule, in English and Sorani. Red before: 3 tests fail with the old `office.ts` (both lines, and the Sorani review list).
- Changed deliberately, with the reason in each test:
  - `lifecycle-office-draft-alert.test.ts`, `office-caption-and-title.test.ts` (the caption);
  - `office-telegram-approval.test.ts` (`LOST`).

### 5.4 Full run

Full `apps/core`, `apps/worker` and `packages/integrations` run (348 files, after a Desk `vite build` for the bundle-size check): 4247 passed, 4 skipped, 0 failed (345 files passed, 3 skipped). `pnpm typecheck` (670 test roots) and `pnpm lint` pass.

Not run: live Telegram, a Restate server, chaos, and a native Sorani review.
