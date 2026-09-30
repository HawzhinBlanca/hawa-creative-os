# ADR-040: Authenticated Desk Decisions Enter the Private RequestLifecycle Through a Narrow Gateway

**Date:** 2026-09-25
**Status:** Accepted for implementation on `codex/research-grade-design-system`; no production cutover.
**Amends:** ADR-034 section 2.3 (how Desk asks the private request object to decide).

## Context

`RequestLifecycle` is private to Restate service calls. Core's authenticated Desk route cannot invoke it through public ingress. Making that entire object public would expose its open, design-finished and state handlers. Writing a Desk approval straight to PostgreSQL would leave the object's stage behind, recreating two authorities.

## Decision

Add one public, stateless `OfficeDecisionGateway` Restate service. Core verifies the signed-in user and allowed office role, reads the task's persisted request owner, and sends only a versioned revision request with the existing Desk UUID action key. Core signs the exact event with the shared worker credential under a domain-separated HMAC. The gateway verifies the signature in constant time and then calls the private `RequestLifecycle.officeDecision` handler. The object and Core projection check the expected revision and current draft and keep the role, task version and hash-bound receipt fences. Core deliberately forwards a retry after the request has advanced, so the object can return the original result for the same action key. Missing credentials or Restate ingress fail closed; the Desk never reports a decision until a committed result is returned. Retrying the same action key returns the same approval; changed content is a conflict.

The gateway name is permanent in the worker service inventory for blue/green compatibility. It admits only this decision shape. Approval, rejection, later rounds and chat actions require their own explicit contracts and tests. Keep lifecycle chat flags off until the wider request loop and deployed recovery gates pass.

## Why

The narrow service gives Core one authenticated path into the private request owner without exposing other lifecycle methods. The signed event prevents a caller of Restate's public ingress from asserting a reviewer identity. The request object's existing serialization and PostgreSQL projection keep one authority for task, approval and request state after network loss or retry.

## Alternatives

- Publicly expose the whole RequestLifecycle object: too broad an ingress surface for its internal report and state handlers.
- Write the approval directly in Core: the object's state would not advance with the database, so the next event could act on stale stage.
- Reuse ChatInbox as an office gateway: it keys by chat and would mix unrelated identity and ordering domains.

## Addendum (2026-09-30): office members decide on a draft in Telegram, in plain words

Branch `claude/office-telegram-approval` from `claude/office-draft-preview` (73076f80, on production 6af16cb8); not deployed.

**Owner decision; a foundation decision changes.** Until now approval stayed in Hawa Desk. ADR-022 made the captured bytes the approval boundary, behind a human review in the Desk, and ADR-065 made chat notifications navigation only. On 2026-09-30 the owner was asked "Should office members also be able to approve from Telegram by replying to the draft image in plain words?" and answered "Yes, office can approve in Telegram". The owner decided this change. The Desk path is unchanged. ADR-065's `chat-approval-action` route is also unchanged and still records nothing. The new path is Core's Telegram intake, and it ends in the Desk's own Core actions.

Decisions:

1. **Who may decide.** Only a member of the office list (`TELEGRAM_ALLOWED_USERS`) can decide, and only with text in their own private chat with the bot (chat id equals sender id). Forwarded messages never decide: `forward_origin`, `forward_from*`, `forward_date`, `forward_sender_name` and automatic forwards are all refused. Edits and bots never decide, and neither does any group chat. A requester who is not on the list never reaches this path, so their "approved" changes nothing, as before.
2. **Owner-as-office exception.** The lead's question: may an office member who is also a requester (the owner) approve other people's drafts, and their own? Chosen: yes to both, since the owner is the office. Requesters still cannot approve their own design. The requester-side "looks good, send it" handling (ADR-144) is unchanged: it tells the office the requester is happy and approves nothing. One guard protects the owner's own work. A member may write a change with no reply while they have requests of their own under way (designing, waiting, manual, approved or delivering). That change goes to requester routing and never lands on someone else's draft.
3. **Which draft.** TelegramSender now writes the chat id on every send mark, beside Telegram's message id (`writeSendMark` payload `chatId`), because message ids are unique only per chat. A reply to an office alert, photo or text, therefore maps to the request and revision in its key `lc:<request>:<rev>:office-alert[:<chat>]:send`, per member. A mark written before this change is matched by its key's chat, or for the key without one, by the first office member.
   - With no reply and exactly one draft in the office queue (`requests.stage = in_review`, task `human_review`), that draft is the target.
   - With several drafts waiting, the bot asks once, in plain words, and lists numbered titles. It accepts a number, an ordinal or a name (`parseChoice`). The question stays open for a day, until the member's next message.
   - Intake reads everything else as before: a reply to any other message, and words with no reply that do not clearly decide. So the owner's own briefs are unaffected.
4. **What the words mean.** The requester rules (`readIntentByRules`, `readsAsChange`) read the words, with a few office phrases added (`office-telegram-turn.ts`, `readOfficeIntent`).
   - Approve: "approved", "ok send it", "looks good, send it", «پەسەندە», «باشە بینێرە».
   - Change: any described change. A mixed "ok but make the title bigger" is a change, not an approval.
   - Reject: "reject" or "rejected" (category `concept`); "no, cancel this" (category `task`).
   - Anything else in reply to a draft: a brief question.

   No model is called, so no paid call is added.
5. **The same path as the Desk.** The request-owned branches of `POST …/decisions` and `POST …/publish` moved unchanged into `services/office-decisions.ts` (`decideRequestOwned`, `startRequestOwnedDelivery`). The Desk routes and the Telegram turn both call them. They share the receipts, the fingerprinted action keys, the QA and pinned-export proof, the late-change hold (finding 13) and the signed gateway call.
   - **Actor.** The office team's principal: `ADMIN_USER_ID`, role `administrator`, the same principal as the trusted-office Desk (ADR-146). It carries `authMethod: 'telegram_office'` and `telegramChatId`. The gateway admits exactly that shape: a private chat id and no session hash. Core writes both into `approvals.decision_payload`, and the reason names the member. In a named-reviewer deployment (ADR-064), Telegram decides nothing.
   - **Keys.** Action ids are UUIDs (v5 layout) derived from the chat, the update and the intent. The delivery's key is separate from the approval's. Expected revisions are read as the Desk reads them.
6. **Approval evidence; the photo is the visual check.** Approval is refused unless the latest QA run of the current revision passed. It pins what the Desk's defaults pin: the PNG and the QA-checked PPTX of the one Canva capture that run checked (same `designUpdatedAt`).
   - **The PNG is the photo.** The pinned PNG must be the picture this member was sent. The request's projection names its id and hash for this member (`officePhotoAlerts`), and this member's sent mark for that revision must exist. The Telegram photo is thus the Desk's human visual check. It is recorded in the turn's receipt (`inbox_events` `office_telegram_turn`, `visualCheck`: chat, message id, request revision, image hash, export id). When QA asks for an RTL visual sign-off, it is given against the checked export.
   - **No new capture.** Telegram makes no new capture. The capture is the one the automatic design made, which the bridge recorded as the revision and its QA run. A new capture would approve bytes nobody saw.
   - **Otherwise, the Desk.** A missing, stale or mismatched capture, or an alert sent only as text, is answered "please approve it in Hawa Desk".
7. **Late words and delivery.** Words the requester sent after the draft reached the office are quoted to the member before anything is approved. If the member answers with approval ("send it anyway"), the draft is approved, those words are acknowledged under the delivery's action, and delivery starts. If the member answers with a change, the draft goes back. After approval, delivery starts through the Desk's deliver action, and the member hears "Approved. Sending <title> to <requester> now." The existing alerts (ADR-155) tell the office whether the delivery succeeded or failed.
8. **Changes and rejections.** A change becomes the Desk's structured revision request (`full_design`, `aesthetic_preference`, `medium`, not reusable), with the member's words as the comment. As after the Desk's Request Revision, the requester receives the office's note and answers, and the next draft starts. The confirmation says so. The suggested "Sent your changes to the designer" would not be true on this path. A request made by hand (ADR-126) cannot go back for an automatic round, and the member is told so. A rejection goes through the Desk's reject path. The requester is sent nothing, and the confirmation says that too.
9. **Races and replays.** The turn's plan is recorded once per update, before any action. The approval body is stored and read back before it is sent, so every replay has the same fingerprint. The answer is recorded after the actions, and a replayed update returns it.
   - **Lost answer.** A gateway answer lost after commit gives 503 `OFFICE_DECISION_UNCERTAIN`. ChatInbox asks again with the same update and the same keys, so there is one approval and one delivery.
   - **Someone decided first.** If the Desk or another member decided first, the member is told truthfully ("was already approved / sent back / rejected, so I did nothing more"). A reply to an older revision's photo is told that a newer draft is waiting.
10. **Wording.** Replies come from the requester-messages catalogue's new `office` section, in English and Sorani. It may name Hawa Desk and Canva, and still names no command, reply target or internal id. The 21 new Sorani lines, and the Sorani approve and reject words the turn reads, are listed in `SORANI_REVIEW.md` for native review.

Blue/green: a worker from before this change refuses the new actor shape at the gateway (400). Core then tells the member "I couldn't record that … please use Hawa Desk", and nothing changes. Deploy the worker with Core or before it. Marks from an older sender have no chat id and are matched by their key.

Tests:

- `apps/core/test/office-telegram-approval.test.ts` runs Core's real intake route, the Desk's decision and delivery actions, the gateway's signature check, the real RequestLifecycle handlers and Core's projections against the test database. Cases:
  - a reply to the photo, the approval through the Desk's route and the delivery start, with the visual check recorded and a replay deciding nothing;
  - plain "approved" with one draft waiting;
  - two drafts waiting, a question, then "2";
  - "ok but make the title bigger" as a revision request, with the requester's office note;
  - a rejection;
  - an unclear reply, asked about;
  - a non-office requester's "approved", which changes nothing;
  - a forward and a group message, both ignored;
  - a Desk approval first, then a truthful Telegram answer;
  - a lost gateway answer, giving one approval and one delivery;
  - quoted late words, then "send it anyway";
  - a Sorani answer;
  - the QA gate.
- `apps/worker/test/office-telegram-approval.test.ts` covers the chat id on each member's alert mark, and the gateway admitting the Telegram actor and nothing looser.

Results: the Core file has 35 tests and passes. With the intake hook and the worker changes reverted to 73076f80, 11 of its 13 route cases fail, and the unit readings still pass because that module stays. The two that pass on the base are the guards for a non-office requester and for a forward or group message. The worker file has 7 tests and passes; 3 of them fail on the base. `apps/core`, `apps/worker` and `packages/integrations` together: 322 files and 3455 tests passed, with 3 files and 4 tests skipped. `pnpm typecheck` and `pnpm lint` pass.

Not exercised: live Telegram, a live Restate server and a live Canva capture.
