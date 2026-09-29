# Natural-language friction audit: Telegram intake (2026-09-29)

**Scope.** Mainline `codex/research-grade-design-system` at `73b75f44`, which production runs. The path
audited is worker poller → Restate `ChatInbox` → Core `POST /v1/internal/telegram/intake` →
`RequestLifecycle` / `DesignRun` / `Delivery`, plus the old intake's finish-only scope. Lifecycle
messages fall through to that scope for greetings, questions, stickers, edits and commands.

**Owner rule (2026-09-29).** Requesters write naturally. Nobody should need slash commands, special
keywords, exact formats or "reply to message X" tricks. A natural message must never be refused,
silently dropped or misread. Safety still holds: no paid design without an instruction, no double
start and no accidental jobs.

**Method.** I read every Telegram send path in `apps/core`, `apps/worker` and `packages/*`. I traced
each natural message shape through `lifecycle-internal.routes.ts` and checked the top findings
against the real intake code on the isolated test database. No product code was changed.

**Evidence status.**
- Findings marked **tested** have an `it.fails` test on this branch. The test asserts the natural
  behaviour and passes only because the product still behaves otherwise.
- Every test was also run with `AUDIT_SHOW_FAILURES=1`, which turns each one into a plain `it`. In
  that run, all 30 Core and 8 worker audit tests failed on the stated assertion, not on setup.
- Findings marked **code-traced** have not been executed.

Test files:
- `apps/core/test/natural-language-friction-audit.test.ts`: 32 tests (30 expected-fail, 2 evidence
  tests that pass). It is database-backed.
- `apps/worker/test/natural-language-friction-audit.test.ts`: 8 tests, all expected-fail. It exercises
  the `ChatInbox` notice texts.

Some existing tests assert today's behaviour on purpose. A fix must change them deliberately:
- `apps/core/test/lifecycle-internal-intake.test.ts:211` ("a reply to a request that is designing
  again stays a stale reply").
- `apps/core/test/lifecycle-internal-intake.test.ts:440` ("requests an explicit client for voice and
  PDF sources and holds unlinked photos").
- `apps/core/test/lifecycle-internal-intake.test.ts:590` (a brief in a chat with an open legacy
  request is answered with `new-brief-required`, which asks for `/new`).

Severity scale:
- **B** (blocks a request, or misreads it: wrong work, lost words, or a paid run nobody asked for).
- **C** (confuses a requester).
- **M** (cosmetic).

---

## 1. Ranked findings

### F1 (B, tested). "thanks", "ok", "👍" or any chatter becomes a paid design round while a design waits for changes or for an answer

- **What the requester does.** The office sends "Your design needs adjustments…", or the bot asks one
  question. The requester writes "thanks", "ok", "👍", "سوپاس", "/start", "is it ready?" or a new idea.
- **What happens today.**
  - When exactly one request is waiting (stage `manual` with rev 3 or more, or `awaiting_answer`),
    `mayOpen` is false (`lifecycle-internal.routes.ts:543`).
  - `chooseWaitingChatRequest` (`:612`) binds the message to that request.
  - `projectLifecycleRequesterRevisionWithIntake` starts a new automatic design round, with the word
    itself as the directive or answer.
  - There is no acknowledgement filter on this path. The classifier's `isAcknowledgement` exists but
    is only consulted when a message may open a request.
  - The requester hears "Your answer is saved. I am continuing the same design with that detail."
    (`chat-inbox.ts:201`) for an answer, and nothing for a revision.
- **Why it is friction.** A polite reply spends money and burns the round. The real change, sent
  next, finds no waiting request and opens a second request (see F4).
- **Natural behaviour.**
  - Acknowledgements, receipts and emoji-only messages never start or answer a round. Reply "Thanks!
    I'm still waiting for what you'd like changed on *\<title\>*."
  - Questions and commands are answered, not applied.
  - Keep "no paid design without an instruction": only a message that asks for a change or answers
    the question may start the round.
- **Affected code.** `apps/core/src/routes/lifecycle-internal.routes.ts:543-676`;
  `apps/core/src/services/telegram-classifier.ts:188` (`isAcknowledgement`, unused here).
- **Test.** F1 × 7 (`thanks`, `ok`, `👍`, `سوپاس`, `/status`, `/start`, `when will it be ready?`):
  Core answers `lifecycleAction: 'requester-revision'` for every one. Commands are included, as the
  stage-2 agent reported.
- **Status on the stage-2 branch.** The binding is unchanged on `worktree-agent-a75fb1fe056346f7f`
  (`lifecycle-internal.routes.ts:529`, the same `mayOpen` rule). The chat answers of
  `lifecycle-chat-answers.ts` are only reached when `mayOpen` is true, which it never is while a
  request waits.

### F2 (B, tested). A new, unrelated brief while one design waits is swallowed as that design's revision

- **What the requester does.** While the Nawroz poster waits for changes, they send a complete new
  brief ("New poster please for the graduation ceremony…").
- **What happens today.** The same `mayOpen` rule applies: a new request opens only with `/new` or
  when nothing waits. The brief becomes the Nawroz poster's revision directive, so the old design is
  redone with the new event's words. The same happens to an answer that is pending.
- **Why it is friction.** The requester would need to know `/new`. Nothing tells them that before
  the misread.
- **Natural behaviour.**
  - A message that reads as a full brief ("new poster", event details, several paragraphs) while
    something waits should ask one plain question: "Is this a new design, or a change to *\<title\>*?"
  - The question is answerable in words ("new", "the poster", "نوێ"), keeps the words, and starts
    nothing until answered.
  - A message that is clearly a change keeps today's routing.
- **Affected code.** `lifecycle-internal.routes.ts:543`; `packages/domain` `chooseWaitingChatRequest`.
- **Test.** F2: Core answers `requester-revision` where `open-request` (or a question) is expected.

### F3 (B, tested). With two designs waiting, every message is refused with "reply directly to the revision notice"

- **What the requester does.** Two designs wait for changes, and the requester writes anything:
  "thanks", a change, a new brief.
- **What happens today.** `AMBIGUOUS_REQUEST` (`lifecycle-internal.routes.ts:540`, `:612-615`), and
  the words are dropped. The bot answers: "More than one design is waiting for your changes. Please
  reply directly to the revision notice for the design you mean." (`chat-inbox.ts:211`).
- **Natural behaviour.**
  - Acknowledgements get a thank-you.
  - For a real change, keep the words and ask "Which design is this for? 1. Nawroz poster 2.
    Graduation flyer". The answer can be a number, a title word or a reply, and the stored change is
    then applied.
  - If the words name one design (its title, client or a date in its copy), use it.
- **Tests.**
  - Core F3: "thanks" with two waiting designs is answered `AMBIGUOUS_REQUEST`.
  - Worker N2 × 2: both notice texts demand a reply to a specific message.

### F4 (B, tested). A correction sent while the design is being made opens a second request, or is refused as a "stale reply"

- **What the requester does.** Right after the brief, while the draft is being made, they add a
  correction:
  - As a new message: "the date should be 5 October not 4", "make the title bigger" or "also add
    the phone number…".
  - Or as a reply to the bot's "Request received…", to their own brief, or to a colleague.
- **What happens today.**
  - **Plain message.** No request is "waiting" (stage `designing`), so `mayOpen` is true.
    `classifyWithHeuristics(text, false, false)` (`:545`) never knows a design is running. It reads a
    factual correction as a full `new_brief` (automatic when the chat has an auto-draft client) and
    "make the title bigger" as an instruction-only new brief. Either way a second request opens. The
    requester hears "Request received. I am preparing a draft for art director review." or "Request
    received. An art director will review it." (`request-lifecycle.ts:283`, `:240`). The first
    design finishes without the correction.
  - **Reply to any message that is not a revision notice or reminder.** It is refused at `:539`
    (`STALE_REQUEST_REPLY`), and the words are dropped. The bot answers: "That design is no longer
    waiting for changes. Please reply to the current revision notice for the design you mean."
    (`chat-inbox.ts:210`). At that moment there *is* no revision notice.
- **Why it is friction.** This is the most common real behaviour: people remember details a minute
  later. It creates duplicate work, and in a client-bound chat a paid design titled "the date should
  be 5 October not 4".
- **Natural behaviour.**
  - While a request is `designing` or `in_review`, a message that reads as a change or an addition
    (including any reply) is kept as a *pending change* on that request.
  - Reply "Got it, I'll add that to *\<title\>*." The change is folded into the next round: for
    `designing`, the round after the draft; for `in_review`, it is shown to the office. This is
    today's late-change store, generalised.
  - Nothing new is paid for until an instruction exists, and nothing opens twice.
- **Affected code.** `lifecycle-internal.routes.ts:516-545`; `classifyWithHeuristics` is called with
  `hasRecentTask=false`.
- **Tests.**
  - Core F4 × 3: plain corrections are answered `open-request`.
  - Core F4: a reply to the "Request received" message (`1:ack`) is answered `STALE_REQUEST_REPLY`.
  - Core F4: a reply to the requester's own message is answered `STALE_REQUEST_REPLY`.

### F5 (B, tested). A photo sent before or after the words is parked for an operator; files the phone produces are parked too

- **What the requester does.** They send the photo, then type the brief. Or the brief, then the
  photo. Or they forward a photo, send a HEIC "as file", an `.m4a` or `.mp3` audio file, or a short
  video.
- **What happens today.**
  - `lifecyclePhotoInput` needs a caption or a reply (`lifecycle-photo.ts:47`). The media check at
    `lifecycle-internal.routes.ts:427-430` parks anything else.
  - `LIFECYCLE_MEDIA_NOT_ADMITTED` leads to `ChatInbox` → `park`, a dead letter, an office alert and
    a generic notice: "We received your message but could not process it automatically. The office
    has been alerted and will follow up with you." (`polled-update-dispatch.ts:47-48`).
  - HEIC documents fail the MIME list (`lifecycle-photo.ts:26-28`). Non-Ogg audio fails
    `telegramVoiceSource` (`packages/domain/src/telegram-source-review.ts:44-45`). Video is always
    held.
  - The old intake joined a captionless photo to a brief sent within 5 minutes
    (`chat-intake.ts:142`, `findRequestAwaitingReference`). The lifecycle path dropped that
    behaviour.
- **Natural behaviour.**
  - Keep a short per-chat, per-sender collection window of about 2 minutes. A captionless photo
    joins the brief sent just before it. A photo sent first is held until words arrive, then attached.
  - Tell the requester "Photo saved. Send the text for the design and I'll use it." Never "could not
    process".
  - Convert HEIC and accept common audio containers. The safety gates remain byte sniffing and the
    size limits.
- **Test.** Core F5: a brief opens, then a captionless photo 1 message later is answered
  `park-update`.

### F6 (B, tested). Voice briefs are effectively impossible; PDFs need exact `Client:`, `Size:`, `/new` and `/use_source` formats

- **What the requester does.** They send a voice note describing the design. Telegram voice notes
  carry no caption. Or they send a PDF programme with "Please make a poster from this".
- **What happens today.** `admitSource` (`lifecycle-source-admission.ts:39-60`) needs a
  `Client: <code>` caption line unless the upload replies to a waiting request's notice. The refusals:
  - No usable `Client:` line: "Name one active client in the source caption: Client: <client code or
    full name>. A request reply must keep its existing client." (`:57`)
  - Anything waiting, or a group chat: "For a new design, start the source caption with /new and
    Client: <client code>. For a revision, reply to its current notice." (`:51`)
  - A reply that does not bind: "That reply does not identify a current request waiting for changes.
    Reply to its latest notice or send a new source with /new." (`:48`)
  - `Size:` must be exactly `Size: WxH` (`:42`).

  Even after admission, the copy must be confirmed by replying to the original with `/use_source` on
  its own line, followed by the exact text (`lifecycle-source-intake.ts:37-38`, admission `:28`).
  The review notice itself shows internal detail: "Canvas: 1080 × 1350 px (default)", "Reserved
  estimate: $0.003; actual billed cost unknown", "Unreviewed transcript preview".
- **Why it is friction.** The `/start` text promises "Voice notes in Kurdish or English work too" and
  "Send brand guidelines as a PDF…" (`telegram-bridge.ts:991-993`). A caption-less voice note in a
  fresh chat can never pass.
- **Natural behaviour.**
  - Resolve the client exactly as text briefs do: the chat binding, or a client named in the words.
  - Transcribe the voice note, or extract the PDF, then ask in plain words: "Here is what I heard:
    … Is this the exact text? Reply 'yes', or send the corrected text."
  - "yes", "correct", "باشە" or "بەڵێ" confirms. Any other text is the corrected copy, with no
    command and no reply required.
  - Sizes are read naturally ("A4", "Instagram story", "1080x1350"), with the default otherwise.
  - Keep "no paid design until copy is confirmed".
- **Tests.** Core F6 × 3:
  - A caption-less voice note is answered with the `Client:` demand.
  - A PDF with a natural caption is answered with the `Client:` demand.
  - A voice note while a design waits is told to use `/new` or "reply to its current notice".

### F7 (B, tested). Replies to the draft while it is with the office: "thanks" and "looks good, send it" become late changes that block delivery

- **What the requester does.** The requester receives "🎨 Your Canva draft is ready … Review the
  layout, font and exact copy in Canva" (`canva-status-message.ts:56-57`). They reply "thanks",
  "looks good, send it" or "make the logo bigger".
- **What happens today.**
  - Every reply to that message in `in_review`, `approved`, `delivering` or `delivered` is a
    `LATE_REQUESTER_CHANGE` (`lifecycle-internal.routes.ts:516-538`).
  - The office is alerted with the words quoted, and Deliver will not proceed until someone
    acknowledges them in the Desk (`lifecycle-chat-target.ts:275-282`).
  - The requester hears: "Your message arrived after this design went to the office, so it was not
    applied to the design. The office has been told and has your words." (`chat-inbox.ts:224-229`).
    The draft message had invited them to review it.
- **Natural behaviour.**
  - An acknowledgement or approval ("thanks", "looks good", "send it", "باشە بینێرە") is passed to
    the office as a *requester approval note*, with no acknowledgement gate. The requester hears
    "Thanks! I've told the office you're happy with it."
  - A real change keeps today's safe behaviour, with friendlier words: "Got it. The office is
    checking this draft now; I've passed your change to them."
  - The ready message should not ask the requester to review "in Canva".
- **Tests.**
  - Core F7 × 2: `LATE_REQUESTER_CHANGE` for "thanks" and "looks good, send it".
  - Worker N4: an approval gets "was not applied to the design".

### F13 (B, tested). Approvals, cancellations and deadlines written as plain messages open new design requests

- **What the requester does.** Without replying, while the draft is with the office, they write
  "looks good, send it", "please cancel the poster" or "we need it by tomorrow".
- **What happens today.** Nothing is "waiting", so `mayOpen` is true. The heuristics read all three
  as a standard `new_brief` with `isInstructionOnly: false` (evidence test in the file). A second
  request opens with the sentence as its copy. It is automatic, and therefore paid, when the chat is
  bound to an auto-draft client (`chat-campaign-intake.ts:74-146`, code-traced). The test chat has
  no client, so the test shows the open as manual.
- **Natural behaviour.** Recognise approval, cancellation, deadline and status intents before
  new-brief intent, using the chat's active requests:
  - Approval: passed on as in F7.
  - Cancel: "Do you want me to stop *\<title\>*?", then on "yes" the office is told and the request
    is cancelled or held.
  - Deadline: attached to the active request as a remark.
- **Test.** Core F13 × 3 plus the heuristics evidence test.

### F9 (B, tested). A request that opens with a greeting, or is phrased as a question, gets a canned reply and is dropped

- **What the requester does.**
  - "Hi, can you make a poster for our Nawroz party?"
  - "Can you make a poster for Nawroz?"
  - "سڵاو، پۆستەرێک بۆ نەورۆز دروست بکە" ("Hello, make a poster for Nawroz")
  - "Eid Mubarak" (the copy itself)
- **What happens today.**
  - The heuristics return `other` ("Greeting or command detected") or `question`
    (`telegram-classifier.ts:337-359`). The message falls through to the old intake.
  - That intake answers "👋 Hello! How can Hawa Creative OS assist you today? Please send your event
    brief or announcement copy to start." or "ℹ️ Question received: "…" To generate a design, please
    send your announcement text, date, and venue. For revisions on an existing design, reply
    directly to the preview message." (`telegram-intake/replies.ts:529-533`). Nothing is kept.
  - The next message ("Friday 7pm at the Rotana") opens a request without the first message's
    content.
- **Natural behaviour.**
  - A greeting or question that contains a design request ("make", "need", "poster", "flyer",
    "دروست بکە", "پۆستەر") is a request. Keep it and ask only for what is missing ("What text should
    go on it? Date, time, place?").
  - Its answer joins the same request. No paid run starts until the copy exists, which matches
    today's instruction-only/manual rule.
- **Tests.** Core F9 × 2 (the bot's actual answers are captured in the failure messages), plus the
  heuristics evidence test.

### F8 (B, tested). Group chats: chatter opens design requests, and any member can revise

- **What the requester does.** The bot sits in an office group. Colleagues talk: "Colleagues, the
  conference dinner is on Monday at the Rotana hotel, please be on time."
- **What happens today.**
  - The lifecycle path has no group rule. The legacy `MESSAGE_ONLY` rule
    (`telegram-webhook.routes.ts:164-184`) is only reached on fall-through.
  - Any allowlisted sender's message with event words opens a request.
  - Revisions and answers are bound per chat, not per sender (`lifecycle-internal.routes.ts:612-676`
    never compares `from.id` with the requester), so any member's "haha nice" can become a waiting
    design's revision (F1).
  - Only PDFs have a group rule (`lifecycle-source-admission.ts:50`).
  - Unknown: if the bot runs with Telegram's default group privacy mode, natural group messages
    never reach it at all. Nothing in `runbooks/`, `docs/` or `adrs/` records the BotFather setting.
- **Natural behaviour.**
  - In groups, open a request only when the bot is mentioned, replied to, or addressed by name.
    Ask "Should I make a design from this?" rather than start.
  - Revisions and answers come only from the original requester (or an office member).
  - Document the privacy-mode setting.
- **Test.** Core F8: a supergroup chat message is answered `open-request`.

### F10 (C, tested). No status answer and no natural cancel

- **What the requester does.** "when will it be ready?", "any update?", "کەی ئامادە دەبێت؟", "cancel
  that", "forget it", "هەڵیوەشێنەوە" ("cancel it").
- **What happens today.**
  - Status questions get the canned "Question received … reply directly to the preview message".
  - "cancel that" is read as short chatter and answered "👋 Hello! How can Hawa Creative OS assist
    you today?…". The design keeps running.
  - With a design waiting, the same words become its revision (F1). There is no cancel path on the
    lifecycle at all.
  - `/status` exists (`telegram-intake/callbacks-and-commands.ts:180-216`), but it is a command.
- **Natural behaviour.**
  - Answer status from the request stage: "*\<title\>* is being designed; the draft usually arrives
    in a few minutes", "It's with the office for a final check", or "It was delivered at 14:05".
  - Cancel phrases confirm, then hold the request and tell the office.
- **Tests.** Core F10 × 2 (the actual texts are shown by `AUDIT_SHOW_FAILURES=1`).

### N1 (C, tested). The bot asks for `/new`

- **What happens today.** "Please send /new followed by the full design brief and the exact words to
  place on it." (`chat-inbox.ts:235`). It is sent when:
  - `/new` has no brief (`lifecycle-internal.routes.ts:497`, `:547`).
  - The old intake refuses to start work (`LEGACY_REQUEST_REFUSED`). That happens in any chat whose
    newest request of the last 48 hours is an open legacy one (`:505-511`,
    `legacy-telegram-routing.ts:93`), or when legacy reads a message as a change to a lifecycle task.
- **Natural behaviour.** Ask "Is this a new design, or a change to *\<title\>*?", answerable in words.
  Never mention `/new`. The legacy half disappears with the retirement, but the `/new` wording also
  lives in the source notices (`:48`, `:51`).
- **Test.** Worker N1 × 2.

### N3 (C, tested). Every lifecycle message is English only

- **What happens today.** No Sorani string exists in any of these:
  - `apps/worker/src/lifecycle/*`
  - `lifecycle-album.ts`
  - `lifecycle-source-*.ts`
  - `lifecycle-voice.ts`
  - `lifecycle-projection.ts` (question text)
  - `canva-status-message.ts`
  - `delivery-notification.ts`
  - `polled-update-dispatch.ts`

  A Sorani requester's brief, answer or change is acknowledged in English. Only the old intake's
  greeting, question, thanks and clarification replies have Sorani.
- **Natural behaviour.** Answer in the language of the requester's last message. Every template gets
  a Sorani version for native review.
- **Tests.** Worker N3 × 2 (answer accepted, late change).

### F11 (C, tested). Edits: a text edit is ignored with a reply trick; a caption edit is parked

- **What happens today.**
  - An `edited_message` with text reaches the old intake. It answers "✏️ Edits to a message already
    sent are not picked up. Send the corrected text as a new message. To change a draft you already
    received, reply to its image with the change." (`telegram-webhook.routes.ts:126-137`).
  - On the lifecycle, "reply to its image" during office review is a late change (F7), and "send the
    corrected text as a new message" opens a second request (F4).
  - An edited *caption* matches the media check (`lifecycle-internal.routes.ts:427-430`) and is
    parked with an office alert and "could not process it automatically".
- **Natural behaviour.**
  - An edit to the brief of a request that is still `designing` is a pending change (F4).
  - An edit to a message that opened nothing is re-read as a new message.
  - Otherwise: "I saw your edit. I've passed it to the office."
- **Test.** Core F11 (caption edit answered `park-update`).

### N5 (C, tested; conditional). Senders missing from the intake allowlist are dropped silently

- **What happens today.** In production, when `TELEGRAM_INTAKE_ALLOWED_USERS` is not `*`, a new staff
  member's brief is answered `403 SENDER_NOT_ALLOWED` at any of four places
  (`lifecycle-internal.routes.ts:280`, `:287`, `:413`, `:554`, `:638`). `ChatInbox` sends nothing
  for a 403. The requester waits forever.
- **Natural behaviour.** "I don't recognise this account yet. I've asked the office to add you." Tell
  the office once, and keep the words.
- **Test.** Worker N5. The production allowlist value was not checked (production is off-limits for
  this audit).

### F14 (C, code-traced). A numbered question accepts "2", but the model receives only "2"

- **What happens today.** The question text lists "1. … 2. …" and says "Reply to this message with
  your answer." (`lifecycle-projection.ts:466`). The answer is stored as "…the requester answered: 2"
  (`lifecycle-projection.ts:818-821`). The option text is not substituted. A reply with no
  quote-reply works only while exactly one request is waiting; otherwise F3 applies.
- **Natural behaviour.** Map "2", "the second", "دووەم" ("second") or an option's words to the option
  text. Drop "Reply to this message".

### F12 (M, tested). A sticker in reply to a lifecycle draft is told to tap a button that does not exist

- **What happens today.** "🙏 Thank you. If the design is right, tap ✅ Approve design under it; to
  change anything, reply to the design with the change in words." (`telegram-intake/media.ts:178-179`).
  Lifecycle drafts carry no buttons (`legacy-telegram-routing.ts:33`), and replying with a change is
  a late change.
- **Test.** Core F12.

### F15 (C, code-traced). The `/start` and `/help` text promises flows that the lifecycle refuses

The welcome text (`packages/integrations/src/telegram-bridge.ts:986-996`) makes these promises:
- "Send photos with it (one by one or as an album)". One by one parks (F5); an album needs
  `/use_album`.
- "To change a draft, reply to its image". Late change (F7).
- "Send brand guidelines as a PDF". Needs `Client:` (F6).
- "Voice notes … work too". F6.
- "/rules lists the saved rules; /forget 2 removes one". Commands.
- "Hawa Creative OS Bot". Jargon.

**Rewrite it once the behaviours are natural.**

### F16 (C and M, code-traced). Internal jargon in requester messages

- `canva-status-message.ts:41`: a header on every outcome, "📌 Task ID: `<uuid>`".
- `:130`: "Open review in Hawa Desk (office sign-in required)". The requester cannot sign in.
- `:42`: "Every design is reviewed by the art director in Hawa Desk before release".
- `:76`: "revision handoff in Hawa Desk, edit a separate copy and capture it".
- `:85`: "verified brand reference pack".
- `request-lifecycle.ts:570`: "(revision 1)".
- `delivery-notification.ts:213-225`: "Office archive: not saved to Google Drive yet (…)" and
  "Production log: row 12 recorded" are office facts.
- `lifecycle-source-intake.ts:181`: "Source review refused: <internal exception message>". It
  exposes e.g. "Source event changed".
- `:189`: "extraction stopped (\<ERROR_CODE\>)".
- `lifecycle-album.ts:202`: "The album scope is inconsistent".
- `replies.ts:533`: "How can Hawa Creative OS assist you today?".

### F17 (C, code-traced). Exact-format requests left in text

- `canva-status-message.ts:79`: COPY_REQUIRED asks for "the exact text … below a divider line (---)".
- `telegram-classifier.ts:301-302`: the old clarification asks the requester to type exactly
  "revise" or "دەستکاری" ("revise").
- `telegram-rules-intake.ts:174`: "/forget and the number, for example `/forget 2`".

### Album friction beyond the `/use_album` fix (C; another agent owns the album flow; listed, not tested)

1. A captionless album followed by the brief as a separate text message is not joined. The album
   waits for `/use_album`. The text opens a request without the photos (`lifecycle-album.ts:209`
   refuses a captionless, non-reply album).
2. One video or GIF in an album fails the whole album ("This album contains unsupported media…",
   `:153`). The still photos should be kept and the video set aside.
3. More than ten photos is refused (`:141`) instead of using ten and saying so.
4. Different captions on different photos is refused: "Use one complete caption for the album.
   Multiple different captions need office review." (`:208`). A natural album often has a caption on
   one photo and a note on another; join them.
5. An album whose photos reply to different messages, or only some replying, is refused (`:206-207`).
6. A late photo after confirmation: "This album was already submitted… Send a new album or ask the
   office to revise the request." (`:137`). It should be offered as an addition to the same request.
7. All album messages are English only, and "album scope is inconsistent" is jargon (`:202`).
8. An album sent while a design waits for changes is not routed as that design's revision unless its
   photos reply to the notice (`:205-207`). A plain album follows the new-brief path, which is F2
   in reverse.

---

## 2. Refusal, park and drop paths found (51)

**Parks** (dead letter, office alert, generic "could not process" notice): 3 paths.
- `holdMedia`, which covers 9 media shapes: captionless photo, non-image document (HEIC), audio file,
  video, video note, animation, live photo, an edited caption, and an unsupported image after
  download.
- The album and photo "unsupported" routes into it.
- Intake failing 5 times.

**Album refusals: 13.** `lifecycle-album.ts:137`, `141`, `153`, `160`, `188`, `193`, `197`, `200`,
`202`, `207`, `208`, `209`, `218`.

**Source refusals: 12.** `lifecycle-source-admission.ts:28`, `30`, `40`, `42`, `48`, `51`, `57`, `60`;
`lifecycle-source-intake.ts:139`, `181`, `187`, `189`.

**Routing refusals: 5.**
- `STALE_REQUEST_REPLY`
- `AMBIGUOUS_REQUEST`
- `LATE_REQUESTER_CHANGE`
- `NEW_BRIEF_EMPTY`
- `LEGACY_REQUEST_REFUSED`

**Revision blocks: 3.**
- `DAILY_CAP_REACHED`
- `PARENT_BRIEF_MISSING`
- `QUESTION_MISSING`

**Silent drops** (Core answers, `ChatInbox` sends nothing): 7.
- `SENDER_NOT_ALLOWED`, reachable at 5 call sites.
- `BRIEF_TOO_LONG` (`:556`).
- `INVALID_BRIEF` (`:591`, `:595`).
- Other `LifecycleProjectionConflict` codes (`:687`).
- `IDEMPOTENCY_CONFLICT`.
- Legacy group `MESSAGE_ONLY` (`telegram-webhook.routes.ts:182`).
- `Desk review required` for any typed `/approve` (it does answer, `:116`).

**Canned-reply drops** (answered, words not kept): 5.
- Greeting.
- Question.
- Short chatter of 3 words or fewer, which includes "cancel that".
- Edited message.
- Sticker.

**Misreads that start work: 3 paths.**
- The waiting-request binding (F1 and F2).
- New-brief heuristics while designing or in review (F4 and F13).
- Group chat opening (F8).

---

## 3. Message inventory and proposed natural rewrites

The inventory covers 80 templates (about 115 distinct strings, counting branches and variants).

Flags:
- **CMD**: names a slash command.
- **REPLY**: requires a reply to a specific message.
- **FMT**: asks for an exact word or format.
- **JAR**: internal jargon.
- **EN**: no Sorani version.
- **CONF**: likely to confuse a non-technical person.

The rewrites are in English. **Every Sorani version, existing or new, needs native review.**

### 3a. Lifecycle path: every new chat

| # | Where | When | Current text (abridged only where marked …) | Flags | Proposed natural rewrite |
|---|---|---|---|---|---|
| 1 | `chat-inbox.ts:201` | answer taken | "Your answer is saved. I am continuing the same design with that detail." | EN | "Thanks, I'll use that and carry on with *\<title\>*." |
| 2 | `chat-inbox.ts:210` | stale reply | "That design is no longer waiting for changes. Please reply to the current revision notice for the design you mean." | REPLY EN CONF | (replace behaviour, F4) "Got it, I'll add that to *\<title\>*." |
| 3 | `chat-inbox.ts:211` | two waiting | "More than one design is waiting for your changes. Please reply directly to the revision notice for the design you mean." | REPLY EN | "Which design is this for? 1. \<title A\> 2. \<title B\> You can answer with the number or the name." |
| 4 | `chat-inbox.ts:228-229` | late change | "Your message arrived after this design went to the office / was delivered, so it was not applied to the design. The office has been told and has your words." | EN CONF | Approval: "Thanks! I've told the office you're happy with it." Change: "The office is checking this design now; I've passed your change to them." |
| 5 | `chat-inbox.ts:235` | `/new` refusal | "Please send /new followed by the full design brief and the exact words to place on it." | CMD FMT EN | "Is this a new design, or a change to *\<title\>*?" |
| 6 | `chat-inbox.ts:244` | daily cap | "The automatic design limit has been reached. No revision started. Please send this change again after the daily limit resets, or ask the office for help." | EN | "I've saved your change. The office will make it today, and there's no need to send it again." (keep the words) |
| 7 | `chat-inbox.ts:246` | question missing | "I could not safely recover the question for this design, so no answer was applied. Please ask the office to check this request." | EN CONF | "I've saved your answer and asked the office to finish this one." (office alerted) |
| 8 | `chat-inbox.ts:247` | parent missing | "I could not safely find the original design brief, so no revision started. Please ask the office to check this request." | EN CONF | same as #7 |
| 9 | `request-lifecycle.ts:240` | manual open | "Request received. An art director will review it." | EN | "Got it. A designer will pick up *\<title\>* and reply here." |
| 10 | `request-lifecycle.ts:283` | automatic open | "Request received. I am preparing a draft for art director review." | EN JAR | "Got it. I'm making a first draft of *\<title\>*; the office checks it before you get it." |
| 11 | `request-lifecycle.ts:570` | office revise | "Your design needs adjustments (revision N).\n\n\<comment\>\n\nPlease reply with your updated direction or the changes you want." | JAR EN | "The office has a note on *\<title\>*: \<comment\>. What would you like changed? Just write it here." |
| 12 | `request-lifecycle.ts:595` | question reminder | "Reminder: This design is waiting for your answer.\n\n\<q\>\n\nPlease reply to this message when you are ready." | REPLY EN | "*\<title\>* is still waiting for one answer: \<q\> (1. … 2. …)" |
| 13 | `request-lifecycle.ts:604` | revision reminder | "Reminder: Your design is waiting for your revision direction. Please reply when you are ready." | JAR EN | "*\<title\>* is still waiting for your changes. What should I change?" |
| 14 | `lifecycle-projection.ts:466` | question | "I need one detail before I can finish your requested change.\n\n**\<q\>**\n\n1. …\n\nReply to this message with your answer. No new design has started yet." | REPLY EN | "One question about *\<title\>*: \<q\> 1. … 2. … Answer with a number or in your own words." |
| 15 | `lifecycle-projection.ts:468` | no office chat | "A person needs to review it in Hawa Desk and follow up with you here." | JAR EN | "Someone from the office will follow up here." |
| 16 | `canva-status-message.ts:41-42,130` | every outcome | Header "📌 Task ID: `<uuid>` 📜 Title: …"; footer "Every design is reviewed by the art director in Hawa Desk before release." + "Open review in Hawa Desk (office sign-in required)" | JAR EN CONF | Title only; drop the ID, the Desk link and the art-director line |
| 17 | `canva-status-message.ts:56-57` | draft ready | "🎨 Your Canva draft is ready … Open in Canva: \<url\> Review the layout, font and exact copy in Canva. Automatic copy and font checks passed." | JAR EN CONF | "Your draft of *\<title\>* is ready and the office is giving it a final check. Tell me if anything should change." (image preview, not a Canva edit link) |
| 18 | `canva-status-message.ts:59-67` | draft with a failed check | "…created, with a check to resolve … the automatic copy and font check could not be completed. The art director will correct this in Canva before release." | JAR EN | "Your draft is made; the office is fixing a small detail before you get it." |
| 19 | `canva-status-message.ts:69-70` | no client | "Request saved, client assignment needed … The art director will assign the client in Hawa Desk…" | JAR EN | "Which organisation is this for?" (answerable in words) |
| 20 | `canva-status-message.ts:72-73` | manual design | "Request queued for manual design … queued in Hawa Desk…" | JAR EN | "A designer will make *\<title\>* and send it here." |
| 21 | `canva-status-message.ts:75-76` | native revision | "Revision saved for native editing … revision handoff in Hawa Desk, edit a separate copy and capture it for review." | JAR EN | "A designer will make this change by hand and send it here." |
| 22 | `canva-status-message.ts:78-79` | no copy | "…Please send the exact text to put on the design, for example below a divider line (---) after your instructions." | FMT EN | "What text should go on the design? Send it as you'd like it to read." |
| 23 | `canva-status-message.ts:81-82` | unsupported script | "…contains text it cannot set safely (another script, symbols or emoji)…" | EN | "A designer will set this text by hand and send it here." |
| 24 | `canva-status-message.ts:84-85` | no brand pack | "…verified brand reference pack only…" | JAR EN | same as #20 |
| 25 | `canva-status-message.ts:87-88` | already bound | "…A Canva design is already linked to this task…" | JAR EN | "This one is already being worked on; you'll get it here." |
| 26 | `canva-status-message.ts:90-91` | uncertain | "…could not be confirmed and will not be retried automatically to avoid a duplicate…" | JAR EN | "The office is checking this draft and will send it here." |
| 27 | `canva-status-message.ts:94-103` | question (old intake) | "One question before I make your change … Tap an answer below, or reply to this message…" | REPLY EN | as #14 |
| 28 | `canva-status-message.ts:106-111` | change not possible | "This change needs a designer … you can still reply to it with any other change." | REPLY EN | "A designer will make that part by hand. Anything else to change? Just write it." |
| 29 | `canva-status-message.ts:113-114` | blocked | "A safety check stopped the automatic draft … The office has been alerted…" | JAR EN | "The office will finish this one and send it here." |
| 30 | `canva-status-message.ts:119-120` | failed | "We could not make the automatic draft for this request. The office has been alerted…" | EN | same as #29 |
| 31 | `delivery-notification.ts:190-225` | delivered | "Your approved design has been delivered. Request: … The approved file is attached above. In Google Drive: … Office archive: not saved to Google Drive yet (…). Production log: row N recorded." | JAR EN | "Here is your final *\<title\>*. 🎉" (Drive link optional; office-only lines removed) |
| 32 | `delivery.ts:147` | file caption | the file name | — | "*\<title\>*, final" |
| 33 | `polled-update-dispatch.ts:47-48` | park | "We received your message but could not process it automatically. The office has been alerted and will follow up with you." | EN CONF | Per case: "Photo saved; send the text…" / "I've passed this to the office." |
| 34 | `lifecycle-album.ts:116` | album part | "Album photos are being saved. After every photo has finished sending, reply to any photo in this album with /use_album. No design has started yet." | CMD REPLY EN | (another agent's fix) "Got your N photos." |
| 35 | `lifecycle-album.ts:137` | late photo | "This album was already submitted. This late photo was not added… Send a new album or ask the office to revise the request." | EN | "Add this photo to *\<title\>* too?" |
| 36 | `lifecycle-album.ts:141` | more than 10 | "This album exceeds ten photos… send a smaller album." | EN | "I'll use the first ten photos." |
| 37 | `lifecycle-album.ts:153` | unsupported | "This album contains unsupported media. Send only still photos in a new album…" | EN | "I kept the photos; videos can't go on a design." |
| 38 | `lifecycle-album.ts:160` | bad photo | "An album photo is unsupported or too large. Send a corrected album…" | EN | "One photo couldn't be opened; I used the others. Send it again if it matters." |
| 39 | `lifecycle-album.ts:188` | confirm | "Reply to a photo in the album with /use_album after all photos have finished sending." | CMD REPLY EN | (removed) |
| 40 | `lifecycle-album.ts:193` | confirm | "That photo does not identify an album saved for you in this chat and topic." | JAR EN | (removed) |
| 41 | `lifecycle-album.ts:197` | confirm | "This album was already submitted. Check the existing request…" | EN | (removed) |
| 42 | `lifecycle-album.ts:200` | confirm | "The album needs two to ten successfully saved still photos. Wait for all files… then confirm again." | EN | (removed) |
| 43 | `lifecycle-album.ts:202` | confirm | "The album scope is inconsistent. Ask the office to inspect it." | JAR EN | (removed) |
| 44 | `lifecycle-album.ts:207` | confirm | "The album photos do not all reply to the same request. Send a new album with one clear request." | EN | "Which design are these photos for?" |
| 45 | `lifecycle-album.ts:208` | confirm | "Use one complete caption for the album. Multiple different captions need office review." | FMT EN | (join the captions) |
| 46 | `lifecycle-album.ts:209` | confirm | "The album has no brief or request reply. Send a captioned album with the exact copy to use." | FMT EN | "Got the photos. What should the design say?" |
| 47 | `lifecycle-album.ts:218` | confirm | "This album exceeds the 100 MiB total image limit…" | JAR EN | "These photos are too large together; I used the first N." |
| 48 | `lifecycle-source-intake.ts:32-39` | source review | "Voice original / PDF saved for review. No design has started. Canvas: 1080 × 1350 px (default). … Reserved estimate: $… ; actual billed cost unknown. … Unreviewed transcript preview: … Limits: … Reply to your original source with /use_source on its own line, then the exact corrected text to print… Hawa Desk…" | CMD REPLY FMT JAR EN | "Here's what I heard/read: «…». Is this the exact text for the design? Reply *yes*, or send the corrected text." |
| 49 | `lifecycle-source-intake.ts:139` | not a PDF | "This file is not an admitted PDF. Send a valid PDF of at most 20 MiB; its caption cannot replace the source." | JAR EN | "I couldn't open that file. Could you send it again, or paste the text?" |
| 50 | `lifecycle-source-intake.ts:181` | conflict | "Source review refused: \<internal message\>" | JAR EN | "Something went wrong with that file; the office will check it." |
| 51 | `lifecycle-source-intake.ts:187` | bad voice | "\<error\>. Send a valid single-stream Ogg Opus recording of at most 20 MiB and ten minutes…" | JAR EN | "I couldn't play that recording. Could you record it again, or type it?" |
| 52 | `lifecycle-source-intake.ts:189` | PDF failed | "The PDF is retained but extraction stopped (\<CODE\>)…" | JAR EN | "I couldn't read the text in that PDF; the office will look at it." |
| 53 | `lifecycle-source-admission.ts:28` | confirm | "Reply to your original source with /use_source on its own line, followed by the exact corrected copy." | CMD REPLY FMT EN | (removed; "yes" or the corrected text) |
| 54 | `lifecycle-source-admission.ts:30` | confirm | "No source belongs to that reply, sender and topic. Reply to the original source you sent." | REPLY JAR EN | (removed) |
| 55 | `lifecycle-source-admission.ts:40` | client line | "Use exactly one non-empty Client: \<client code or full name\> line in a new source caption." | FMT EN | (removed; client resolved like text) |
| 56 | `lifecycle-source-admission.ts:42` | size line | "Use one Size: \<width\>x\<height\> line with each dimension between 640 and 2400 pixels." | FMT EN | "What size? For example A4, Instagram post or story." (only if a size was clearly meant) |
| 57 | `lifecycle-source-admission.ts:48` | reply | "That reply does not identify a current request waiting for changes. Reply to its latest notice or send a new source with /new." | CMD REPLY EN | "Is this for *\<title\>* or a new design?" |
| 58 | `lifecycle-source-admission.ts:51` | anything waiting / group | "For a new design, start the source caption with /new and Client: \<client code\>. For a revision, reply to its current notice." | CMD REPLY FMT EN | same as #57 |
| 59 | `lifecycle-source-admission.ts:57` | client | "Name one active client in the source caption: Client: \<client code or full name\>…" | FMT JAR EN | "Which organisation is this for?" |
| 60 | `lifecycle-source-admission.ts:60` | client inactive | "The selected client is no longer active. Ask the office…" | JAR EN | "I've passed this to the office." |
| 61 | `lifecycle-voice.ts:36-129` | voice review lines (11 variants) | e.g. "Transcription was admitted but its outcome is not recorded… the office must reconcile the paid call." / "No eligible transcription model with an explicit cost policy is admitted…" / "The daily transcription reservation limit is reached…" | JAR EN | Requester sees one line: "I've saved your voice note; the office will type it up." (details go to the office) |

### 3b. Old intake, finish-only scope: still reached from lifecycle chats

| # | Where | When | Current text | Flags | Proposed natural rewrite |
|---|---|---|---|---|---|
| 62 | `replies.ts:532-533` | greeting or short chatter | "👋 Hello! How can Hawa Creative OS assist you today? Please send your event brief or announcement copy to start." / Sorani "👋 سڵاو! چۆن دەتوانم یارمەتیت بدەم لە دیزاینەکانتدا؟ تکایە دەقی دیزاینەکەت بنێرە." | JAR (Sorani: native review) | "Hi! What would you like designed? Tell me in your own words." (and keep the words, F9) |
| 63 | `replies.ts:529-530` | question | "ℹ️ Question received: "…" To generate a design, please send your announcement text, date, and venue. For revisions on an existing design, reply directly to the preview message." / Sorani version (no reply instruction) | REPLY CONF | Status answer (F10), or "Sure, what should the poster say? Date, time, place?" |
| 64 | `replies.ts:526` | thanks | "🙏 Thank you." / "🙏 سوپاس." | — | keep |
| 65 | `replies.ts:470-471` | thanks in reply | "🙏 Thank you. If the design is right, tap ✅ Approve design under it; to change anything, reply to the design with the change." / Sorani "…وەڵامی وێنەی دیزاینەکە بدەرەوە…" ("…reply to the design's image…") | REPLY CONF | "Thanks!" |
| 66 | `telegram-classifier.ts:300-302` + `replies.ts:387` | reply without a clear change | "❓ Clarification needed: Could you please clarify: is this a change to the design? Reply "revise" and it will be changed; otherwise nothing is changed." / Sorani "…ئەگەر بەڵێ، بنووسە: دەستکاری…" ("…if yes, write: revise…") | FMT (Sorani: native review) | "Should I change the design, or was that just a note?" (any yes/no wording) |
| 67 | `telegram-webhook.routes.ts:116-117` | typed `/approve` | "ℹ️ Designs are approved in Hawa Desk, not in chat. To change a draft, reply to its image with what to change. To approve it, open the task in Hawa Desk." | JAR REPLY EN | "Thanks! I've told the office you're happy with it." (F7) |
| 68 | `telegram-webhook.routes.ts:131-132` | edited message | "✏️ Edits to a message already sent are not picked up. Send the corrected text as a new message. To change a draft you already received, reply to its image with the change." | REPLY EN CONF | (F11) "I saw your edit and updated *\<title\>*." |
| 69 | `telegram-webhook.routes.ts:108` | any button (popup) | "Desk review required: Approve in Hawa Desk" | JAR EN | "The office approves designs; I've let them know." |
| 70 | `telegram-bridge.ts:986-996` | `/start`, `/help` | "👋 Welcome to Hawa Creative OS Bot • Send the text… • Send photos… (one by one or as an album)… • To change a draft, reply to its image… • /rules lists the saved rules; /forget 2 removes one. • Voice notes… work too. Designs are approved in Hawa Desk…" | CMD REPLY JAR EN | "Hi! Tell me what you'd like designed, in English or Kurdish. You can add photos, a voice note or a PDF. I'll send the draft here." |
| 71 | `callbacks-and-commands.ts:184,213` | `/status` | "📊 Your latest requests …" / "…could not be read just now. Please send /status again in a minute." / "📊 No requests from this chat yet." | CMD JAR (8-character IDs) EN | Answer "how is my poster?" in words (F10) |
| 72 | `telegram-bridge.ts:979` | office command by a non-office user | "🚫 Unauthorized: User `\<id\>` is not permitted to execute office commands." | JAR EN | "That's something the office does. I've let them know." |
| 73 | `callbacks-and-commands.ts:318,328` | `/redo` | "⚠️ No failed design task found in this chat to re-drive. Specify the task ID: /redo \<taskId\>" / "This request is managed by the office. No new design was started by /redo." | CMD JAR EN | "Want me to try *\<title\>* again? I'll ask the office." |
| 74 | `standing-rules-chat.ts:81-82` | lasting preference | "📌 Saved as a standing rule for \<client\> (number N): … /rules lists them; /forget N removes it." | CMD JAR EN | "Noted: from now on every \<client\> design will \<rule\>. Say "stop doing that" any time." |
| 75 | `telegram-rules-intake.ts:135,174,202` | rules | "Which client is this rule for? Send it again with the client's name in it" / "Send /rules to see the numbered list, then /forget and the number…" / "No longer applied…" | CMD FMT EN | Natural "which organisation?" and "stop doing X" |
| 76 | `media.ts:178-180` | sticker | "Stickers are not read as requests. Send the request, or a change to a design, as text." / (reply) "…tap ✅ Approve design under it…" | REPLY CONF EN | 👍 sticker: treat as thanks; otherwise ignore quietly |
| 77 | `media.ts:60,188-189` | voice (old intake) | "Your voice note was received but cannot be transcribed in this intake flow yet. Please resend the full brief as text…" | EN | (F6) |
| 78 | `media.ts:83-84,144-146` | file (old intake) | "…Send it as a photo instead of a file (Telegram converts it), or as a JPEG or PNG file…" / "…cannot be read here. Send brand guidelines as a PDF, pictures as photos…" | FMT EN | "I couldn't open that file. Could you send it as a photo?" |
| 79 | `media.ts:251-338` | photos (old intake, legacy tasks only) | "Picture added to your request…", "…already being made… reply to it with this picture…", "Pictures saved…", "Change received… 🆔 Task ID: …" | REPLY JAR EN | retire with legacy |
| 80 | `requester-actions.ts:95-160`, `draft-reminders.ts:33-65` | legacy draft buttons and reminders (legacy tasks only) | "…Reply to this message with everything you want changed… 🆔 Task ID: …", "Tap Approve if it is right…" | REPLY JAR EN | retire with legacy |

**Commands named in requester messages.**
- `/new` (#5, #57, #58)
- `/use_album` (#34, #39, and #42 implicitly)
- `/use_source` (#48, #53)
- `/rules` and `/forget` (#70, #74, #75)
- `/status` (#71)
- `/redo` (#73)

That is 13 messages. There are 18 slash commands in code: `/new`, `/use_album`, `/use_source`,
`/start`, `/help`, `/status`, `/rules`, `/forget`, `/redo`, `/redrive`, `/approve`, `/publish`,
`/revise`, `/reject`, plus the group prefixes `/task`, `/brief`, `/design`, `/campaign`.

**Exact formats requested.**
- `Client: <code>`
- `Size: WxH`
- a `---` divider
- the exact word "revise" or "دەستکاری" ("revise")
- the "/use_source on its own line" layout

**Reply-to-specific-message demands: 17 messages.**

**Sorani.**
- No lifecycle-path message (#1–#61) has a Sorani version.
- The old intake's Sorani lines (#62, #63, #64, #65, #66) exist.
- #66 asks for an exact keyword, and #65 keeps the reply-to-image instruction. Both need native
  review.
- #62's phrase "یارمەتیت بدەم لە دیزاینەکانتدا" ("help you in your designs") reads like a literal
  translation. It needs native review.

---

## 3c. Stage-2 branch check (`worktree-agent-a75fb1fe056346f7f`, head `a4ad8d26`; read with `git show`, not run)

Stage 2 deletes the old intake and moves its chat answers into
`apps/core/src/services/lifecycle-chat-answers.ts`. `ChatInbox` sends them as
`lifecycleAction: 'chat-answer'`. The lead asked for these checks:

1. **A waiting request swallows every unlinked message, commands included.** Confirmed on both
   branches. See F1 (7 tested variants, including `/status` and `/start`) and F2 (a new brief).
   Stage 2 does not change the `mayOpen` rule (`lifecycle-internal.routes.ts:529`).
2. **A brief in a group chat opens a request.** Confirmed on both branches (F8, tested on the base).
   On stage 2 the passive group rule (`lifecycle-chat-answers.ts`, "Group conversation is kept as a
   passive message") runs inside `answer()`. That is reached only after the lifecycle routing has
   declined to open, so any group message the heuristics read as a brief still opens a request.
3. **"That design is no longer waiting for changes. Please reply to the current revision notice for
   the design you mean."** Unchanged (`chat-inbox.ts:219` on stage 2). It has a new trigger on
   stage 2: any press of a button under an old legacy message (a legacy draft's Approve or Change, a
   reminder) is answered with this refusal. The button pop-up says "This button no longer does
   anything." (stage-2 `lifecycle-internal.routes.ts:360-385`). A requester who taps ✅ under an old
   draft is told to reply to a notice that does not exist. Severity C. Proposed answer: "That draft is
   now handled by the office. Tell me here if anything should change."
4. **A group `/task …`, `/brief …`, `/design …` or `/campaign …` asks for `/new`.** Confirmed.
   `lifecycle-chat-answers.ts` returns `NEW_BRIEF_REQUIRED` with `new-brief-required`, so `ChatInbox`
   says "Please send /new followed by the full design brief and the exact words to place on it." The
   old intake accepted these prefixes as the explicit group promotion
   (`telegram-webhook.routes.ts:166-193` on the base). Stage 2 turns a working command into a demand
   for a different command. Severity C. The same fallback answers "a change with no design waiting
   for it", which is the last line of `answer()`.
5. **Remaining `/new` mentions on stage 2.** `chat-inbox.ts:244` ("Please send /new followed by…");
   `lifecycle-source-admission.ts:48` ("…or send a new source with /new."); `:51` ("For a new
   design, start the source caption with /new and Client: \<client code\>…").
6. **Other carried-over wording on stage 2.** These have the same text as in the base, so the base
   inventory rows and rewrites apply:
   - `DESK_APPROVAL_ANSWER` still says "To change a draft, reply to its image with what to change"
     (row #67).
   - `EDITED_MESSAGE_ANSWER` still says "…reply to its image with the change" (row #68).
   - `WELCOME_ANSWER` keeps "one by one or as an album", "reply to its image" and "/rules …
     /forget 2" (row #70). Its PDF line changed to "Voice notes and PDFs are saved for review first;
     the bot tells you how to confirm the words to print", which is the `/use_source` flow of F6.
   - `inquiryAnswer` keeps "For revisions on an existing design, reply directly to the preview
     message" (row #63).
   - `/status` failure still says "send /status again" (row #71).
   - `REDO_ANSWER` still names `/redo` (row #73).
   - A sender outside the allowlist still gets a silent `403` from `answer()` (N5).

## 4. A natural design that keeps the safety rules

All proposals are inferred; none is implemented.

1. **One turn resolver before routing.** Classify every message against the chat's live state, per
   sender:
   - The live state is `designing`, `in_review`, `waiting-for-changes`, `waiting-for-answer` or
     delivered in the last few days.
   - The intents, in this order: acknowledgement or approval → cancel → status question → answer to
     a pending question → change to the active design → new request → chatter.
   - Only "change" and "answer" may start a round. Only "new request" may open one.
   - This removes F1, F2, F4, F10 and F13 without commands.
2. **Pending changes.** Words that arrive while a design is `designing` or `in_review` are stored on
   the request, shown to the office and folded into the next round. This is today's late-change
   store, generalised, without the acknowledgement gate for thanks or approval.
3. **Ask, don't refuse.** Where today's code refuses (stale reply, ambiguous, `/new`), keep the words
   and ask one short question. The question is answerable by a number, a title word, "new", "the
   poster", "نوێ" ("new"), or a reply. The stored message is replayed on the answer under its
   original update ID, so the "no double start" invariant is unchanged.
4. **Collection window.** Consecutive messages, photos and albums from one sender within about 2
   minutes form one brief before the request opens. This fixes F5, the album-plus-text case and
   split briefs. The window is a Restate timer on `ChatInbox`, keyed by chat and sender.
5. **Sources like text.** Voice and PDF use the text path's client resolution. Copy is confirmed with
   "yes" or with corrected text, never with `/use_source`.
6. **Groups.** Open only when the bot is addressed. Bind revisions to the requester.
7. **Language.** Every template is keyed and rendered in the language of the requester's last
   message. The Sorani set is reviewed by a native speaker before release.

## 5. How to reproduce

```
export PATH="$HOME/.nvm/versions/node/v22.13.1/bin:$PATH"
pnpm test:db
HAWA_TEST_WORKERS=2 npx vitest run apps/core/test/natural-language-friction-audit.test.ts apps/worker/test/natural-language-friction-audit.test.ts
# Show what each audit test fails on today:
AUDIT_SHOW_FAILURES=1 HAWA_TEST_WORKERS=2 npx vitest run apps/core/test/natural-language-friction-audit.test.ts apps/worker/test/natural-language-friction-audit.test.ts
```

The test-to-finding mapping is:

| Finding | Tests |
|---|---|
| F1 | 7 (Core) |
| F2 | 1 (Core) |
| F3 | 1 (Core) + N2 × 2 (worker) |
| F4 | 5 (Core) |
| F5 | 1 (Core) |
| F6 | 3 (Core) |
| F7 | 2 (Core) + N4 (worker) |
| F8 | 1 (Core) |
| F9 | 2 (Core) + evidence test |
| F10 | 2 (Core) |
| F11 | 1 (Core) |
| F12 | 1 (Core) |
| F13 | 3 (Core) + evidence test |
| N1 | 2 (worker) |
| N3 | 2 (worker) |
| N5 | 1 (worker) |

F14–F17 and the album list are code-traced only.
