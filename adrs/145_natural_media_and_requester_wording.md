# ADR-145: Natural Media, and Plain Words in the Requester's Language

**Date:** 2026-09-29
**Status:** Implemented and locally qualified on branch `nl-media-wording`; not deployed.
**Requirements:** FR-002 (edit history and attachments are kept with the source event), FR-004 (a repeated source event gives no more than one task), FR-005 (passive messages become tasks only through an explicit instruction), NFR-001 (no acknowledged event is silently lost).
**Changes a foundation:** ADR-069 is kept (a caption never designs without its picture); ADR-071/073's reviewed-source contract is kept (no design before the requester confirms the words) but the confirmation no longer needs `/use_source`; the Core image gains two system packages (section 2.6).
**Builds on:** ADR-135 (every chat is lifecycle-owned; Core decides, ChatInbox speaks), ADR-143 (albums settle by themselves; a text brief waits 15 s for photos), ADR-144 (requester intent routing; one decision per update).
**Number:** 142 is unclaimed on every branch and worktree; 143 is the album change, 144 the routing change. No migration is added.

## 1. Context

The natural-language friction audit of 2026-09-29 (`plans/lean-design-implementation-2026-09-28/NATURAL_LANGUAGE_FRICTION_AUDIT.md`) left these after ADR-144:

- F5: a photo sent before or after the words was parked for an operator ("could not process it automatically"). HEIC files, M4A/MP3 recordings and videos were parked too.
- F6: a voice note (Telegram gives it no caption) could never pass: every voice note and PDF needed an exact `Client:` line, `/new` while a design waited, and `/use_source` in reply to the original to confirm the words.
- F11: an edited message got "Edits … are not picked up … reply to its image"; an edited caption was parked.
- N5: a sender outside the intake list was answered with nothing at all.
- Sections 3a and 3b: about 80 messages named commands, demanded replies to particular messages, asked for formats, showed Task IDs, Desk links and revision numbers, and were English only.

The owner's rule: requesters (non-technical; English, Sorani Kurdish, often mixed) never need commands, reply targets, caption formats or keywords; natural messages are never refused, dropped or misread. The safety rules stay: no paid design without an actual instruction, no double start, no approval on the owner's behalf, only the requester or the office changes a request.

## 2. Decision

### 2.1 A photo with no words joins the words next to it

A still photo (or an image sent as a file) with no caption, no reply and no album is **kept** (`lifecycle_photo_held`, its bytes in the blob store) and answered `settle-later` (kind `photo`, ADR-143's durable delayed call, the album quiet period of 8 s). The requester is told nothing yet.

- **Photo first, words second.** When the sender's words open a request within **5 minutes** of the photo (`HAWA_PHOTO_JOIN_MINUTES`), the request opens with the photo as its image (`draft.lifecycleImage`), and the requester is told "I'll use the photo you sent with this." When the words change a design that waits for them, the revision takes the photo: the revision photo decision records `heldPhotoUpdateId`, and the revision projection admits such an image only with that decision and the photo's claim for this update and request. A brief ADR-143 holds for 15 s takes photos sent during the hold when it opens.
- **Words first, photo second.** At the photo's settle, the request its sender's words opened in the 5 minutes before the photo is found. While its design has not started using pictures (no design run yet, or one still briefing or conceiving with no pinned visual basis, the old intake's rule; or a designer making it by hand), the photo is added to the task as a reference image: "Got the photo. I've added it to *T*." Otherwise (an album request, or a design already under way) it is passed to the office as a note on the request (the late-change store; Deliver waits until an office member reads it): "… is already being made, so I've passed the photo to the office to use."
- **Neither.** The bot asks once: "Got the photo. Send me the text for the design and I'll use it with the photo." It then waits as long as an album with no words (ADR-143's 2-hour window).
- **Used once.** `lifecycle_photo_used` is written once per photo (first write wins) in the same transaction as the decision that uses it; words that took the photo first keep it, and the other decision proceeds without it. A photo's settle skips a photo already used.
- A settle that finds its sender's brief still held waits another quiet period; a photo that could not be opened is asked for again in words ("I couldn't open that picture. Could you send it again as a photo?").

A captioned photo whose words are not a brief and that no design waits for is kept the same way and asked about at once. A caption still never designs without its picture (ADR-069): a captioned picture that cannot be opened is asked for again.

### 2.2 Phone formats

- **HEIC.** An image document whose declared type is HEIC/HEIF, or whose bytes are HEIF (`ftyp` brand `heic`, `heix`, `mif1`, …), is converted to JPEG with `heif-convert` before it is stored; the design path, albums included, sees only the JPEG.
- **Recordings.** A voice note, an audio message, or a document with an audio type (Ogg, MP3, M4A/MP4, WAV, AAC, WebM) is a voice source. Its container is read from its bytes; anything but Ogg is re-encoded by `ffmpeg` to mono Ogg Opus (48 kHz, 32 kbit/s, at most ten minutes), and from then on the voice path is unchanged: the same inspection, price reservation, transcription and evidence.
- Both converters run on private temporary files with a 60 s limit, one forced input format (`-f mov|mp3|wav|aac|matroska`), no network protocol (`-protocol_whitelist file`), and their output is sniffed again; sizes are limited to 20 MiB before and after.

### 2.3 Voice notes and PDFs need no format

- **Organisation.** A `Client:` caption line still chooses one (silently, for those who know it). Otherwise the organisation is the one a text brief would get: the chat's bound client pack, else the one pack the words name, else the one active client whose code or full name the words contain as a word. Two names, or none: the requester is asked, in words, "Thanks for the voice note! Which organisation is it for?", and their next short message answers it ("It's for KAAE"); a name the office does not know is asked again kindly; a longer or chatty message is read as usual and the question stays.
- **A design waiting for changes.** Without a reply to its notice, the bot asks "Is this for a change to *T*, or for a new design? Just say “change” or “new”." (or a numbered list), answered as ADR-144's questions are (a number, a name, "change", "new", "نوێ").
- **Size.** A malformed `Size:` line is no longer refused; sizes are read from the words ("A4", "A5", "Instagram story", "square post", "portrait", "landscape", "1080x1350"), scaled to fit the 640–2400 px canvas, else the default.
- **Groups.** A file in a group that is not addressed to the bot (a reply to it, or a mention in the caption) stays passive, as ADR-144's group rule keeps text.
- **The words.** Once read, the words are shown back and recorded (`lifecycle_source_candidate`): "Here is what I heard: «…». Is this exactly the text for the design? Just say “yes”, or send me the corrected text." (a PDF: "Here is the text I found in your PDF …"). Words longer than 1,500 characters are not offered for a "yes": the requester is asked to send the exact words. A voice note the bot could not turn into text: "Could you type the words that should go on the design? The office can listen to it too."
- **Confirmation.** The sender's next message confirms: "yes", "correct", "ok", "👍", "بەڵێ", "ڕاستە" use the words shown; "no" asks for the corrected text; thanks, a status question, a cancel, an approval or a command are read as usual; anything else **is** the corrected text, exactly as sent. `/use_source` in reply to the original still works. No design starts before the words are confirmed (the reviewed-source evidence is unchanged; the projection now accepts a confirmation update that carries no command, checked against the stored confirmation).
- Office-only details (the reserved transcription cost, the privacy or allowance reason a transcription was held, extraction limitations, Desk links) left the requester's notice; the office reads them in the Desk's source review.

Every question and answer is recorded per update and per source (`lifecycle_source_pending`, `lifecycle_source_resolution`, the source admission), so a replay decides the same.

### 2.4 Videos, other files, edits

- **Videos** (video, round video, GIF, live photo) are never parked. With no words: "Thanks! I can't put videos on a design. Could you send a photo instead? You can also just tell me what the design should say." With words, the words are read as a message and the video is explained beside the answer (a `notice` field ChatInbox sends once per update).
- **Other files** (a document the design cannot use): "I couldn't open that file. Could you send it as a photo or a PDF, or paste the text here?" Nothing is parked for an operator any more; updates parked before keep their replay. A channel's own media post is ignored.
- **Edits.** An `edited_message` is placed by the message it edits (`originalMessage`):
  - words not read yet (a brief ADR-143 holds, a message set behind it, a voice note or PDF whose words are not confirmed): the new words are used when it is read (`lifecycle_edit_pending`): "I saw your edit, and I'll use the new words.";
  - a kept photo that now has a caption: read again as a photo brief (the kept copy is marked used);
  - words that opened or changed a design: a note to the office on that design (late-change store): "I saw your edit to *T*. I've passed the new wording to the office so it's used." Nothing is redesigned by itself and nothing opens twice;
  - words that opened nothing (thanks, a question, a greeting): read again as a new message under the edit's own update;
  - a message with no record: "I saw your edit and passed it to the office; they'll follow up here." (with an office alert).

### 2.5 A message sent while its sender's brief waits for photos

ADR-143 holds a text brief 15 s. ADR-144's "request opening" guard only knew decided opens, so a correction sent in those 15 s opened a second request. A text from a sender whose brief is still held is now **set behind it** (`lifecycle_text_deferred`) and answered `settle-later` (kind `brief`); its settle waits while the brief is held, then reads the message as it arrived (never held again). It is settled rather than retried because ChatInbox runs one update of a chat at a time and the brief's own settle queues behind it: a waiting update would block the brief. Once the brief has opened, ADR-144's guard answers `REQUEST_OPENING` until RequestLifecycle projects it, and the correction is then kept on that request for the office. The poller's sweep (ADR-143) also settles overdue kept photos and deferred messages.

### 2.6 Senders outside the intake list

The first update of a chat each UTC day from a sender outside `TELEGRAM_INTAKE_ALLOWED_USERS` is answered "Hi! This design assistant is only set up for the Hawa office team. Please ask the office to add you." (in Sorani for a Sorani message); the rest of that day are refused with `quiet: true` and nothing is said. Only `lifecycle_unlisted_reply` (the chat, the day, the update and the answer's language) is stored: no words, no name, no office alert, no design. A ChatInbox talking to an older Core that gives no words sends the same line itself for each refused update.

### 2.7 Changes the bot cannot apply by itself

A change stopped by the day's automatic allowance, a missing question or a missing brief is passed to the office (an alert quoting the words, from Core's answer or its replay), and the requester is told "I've passed your change to the office; they'll make it and send the design here. There's no need to send it again." Without an office chat: "I couldn't make this change by myself just now. Please let the office know, and they'll take care of it."

### 2.8 One catalogue, in the requester's language

Everything the bot says to a requester is in `packages/integrations/src/requester-messages/` (sections: sources, media, inbox, access, routing, conversation, lifecycle, outcomes, albums), each phrase in English and Sorani, reworded per the audit's table: no commands, no "reply to …", no formats, no Task ID, request id, revision number, lifecycle, Hawa Desk, Canva link or art-director jargon. Office alerts keep their precise terms and stay beside the code that sends them. `/`-commands still work and are never advertised; `/start` and `/help` explain in plain words how to ask for a design.

The language is the **script with more letters** in the requester's message (`requesterLang`): Sorani when most letters are Arabic script, English when most are Latin, a tie goes to Sorani (brands are often written in Latin letters in a Sorani message); a message with no letters takes the chat's newest brief's language, then the sender's Telegram language. ADR-144's `langOf` and ADR-143's `replyLanguage` use it.

**Every Sorani line is new or reworded and needs a native speaker's review before release.** `plans/lean-design-implementation-2026-09-28/SORANI_REVIEW.md` lists all of them (generated by `scripts/sorani_review_list.ts`; `packages/integrations/test/requester-messages.test.ts` fails if one is missing, or if a phrase names a command, demands a reply, asks for a format or uses an office term).

## 3. Safety rules kept

- **No paid design without an instruction.** A kept photo never starts anything by itself; a voice note or PDF starts a design only after its words are confirmed; a caption never designs without its picture.
- **No double start.** Every decision is recorded once per update (the open, the revision receipt, the photo claim, the source admission and resolution, the edit decision, the media answer); a photo is used once; a deferred message is read once.
- **No approval on the owner's behalf.** Nothing here approves; edits and late photos reach the office as notes that hold Deliver.
- **Only the requester or the office changes a request.** Questions, confirmations, kept photos and deferrals are per sender, chat and topic.

## 4. Consequences

- **Image size.** The Core image's base grows from 490 MB to 937 MB on disk (119 MB to 246 MB of content), mostly ffmpeg's codec libraries (`ADR145_MEDIA_IMAGE_PROOF.json`). A minimal static ffmpeg (only the MP4, MP3, WAV, AAC and Matroska demuxers and decoders, and the Opus encoder) would cut most of it; it is not done here. The converters parse untrusted files: they run as the Core user, time-limited, on sniffed bytes, with no network protocol.
- **Replay across the deploy.** The worker's RequestLifecycle messages changed words (and are HTML now). A Restate invocation that is part-way through `open`, an office revision or a delivery at the moment of deploy replays with different arguments; drain in-flight lifecycle invocations (or deploy when none is mid-send), as for any change of a journaled call's arguments.
- **Mixed deployments.** An older worker refuses a `settle-later` of kind `photo` as an invalid answer, so that update waits (Restate retries it) until the new worker runs; it does not send `notice`, and sends nothing for a refused stranger. Core and the worker ship together.
- **One photo per brief.** A brief takes the newest kept photo; more photos should be sent as an album (ADR-143).
- **Not changed.** Deliveries still name the task (a revision round's delivered message may name the change); the legacy WhatsApp and Core-ingest acknowledgements (`chat-campaign-intake.ts`), and legacy-task captions in `canva-outcome.routes.ts` and `redrive.ts`, keep their wording (no lifecycle chat reaches them).

## 5. Verification

- New and updated tests (per-file PostgreSQL where they need it):
  - `apps/core/test/natural-media-intake.test.ts` (17): photo then text within and outside the window, asked then joined, text then photo joined, passed to the office, outside the window, a photo with a change to a waiting design, HEIC, videos with and without words, Sorani answer, edits before and after planning, an edit that opened nothing, a caption added to a kept photo, a correction behind a held brief (deferred, then `REQUEST_OPENING`, then kept on the request, one task), a stranger's one reply per day and what is stored.
  - `apps/core/test/lifecycle-voice.test.ts` (+5): a voice note with no caption asked, heard and confirmed with "yes"; an unknown name asked again; "change or new" while a design waits, then the corrected words revise it; an M4A recording converted, heard and confirmed; an edited caption before confirmation. The office-only details moved to the Desk review in the existing tests.
  - `apps/core/test/lifecycle-source.test.ts` (+3): a PDF whose caption names its organisation, "yes" with an Instagram-story size; "no", then the corrected words with an A4 size; thanks and a status question are not taken as the words.
  - `apps/core/test/media-conversion.test.ts` (7): sniffing, real ffmpeg and HEIC conversions.
  - `packages/integrations/test/requester-messages.test.ts`: both languages, placeholders, the lint, the review list, language selection (mixed, tie, no letters).
  - `apps/worker/test/chat-inbox.test.ts` (+5): the photo settle, `notice`, the stranger's line and `quiet`, the office alert for a stopped change.
  - The friction audit: F5, F6 x3, F11 and N5 are plain tests; with ADR-144's, all 40 audit tests pass and none is expected to fail.
  - Changed deliberately, each with its reason in the test: `lifecycle-internal-intake.test.ts` (voice/PDF ask instead of a `Client:` demand; image files and unreadable photos answered in words instead of parked; channel media ignored and an unplaceable edit passed to the office; an unlinked captionless photo kept), `lifecycle-source.test.ts` and `lifecycle-voice.test.ts` (questions instead of refusals; office details in the Desk review), `packages/domain/test/voice-audio.test.ts` (MP3 and audio files are recordings), `chat-inbox.test.ts` (the stopped change goes to the office).
- The Core image: built (`--target base`) and the conversions run inside it as the runner's uid (`ADR145_MEDIA_IMAGE_PROOF.json`).
- Chaos, worker mode, through `hawa-chaos-lock`: see section 6.
- Not run: live Telegram traffic, a real transcription model, a native Sorani review.

## 6. Local qualification — 2026-09-29

- **Chaos, worker mode, through `hawa-chaos-lock`** (`npx tsx packages/testkit/chaos/run.ts --poller worker`; summary `ADR145_CHAOS_RUNS.json`):
  - First, the new and neighbouring scenarios (R1.NL.VOICE, R1.NL.PHOTO_TEXT, R1.S3.MEDIA, R1.S3.PHOTO, R1.S3.CAPTIONLESS_PHOTO, R1.S3.ALBUM_BRIEF, R1.S3.ALBUM_ASK, R1.NL.DESIGNING): 7/8. R1.NL.DESIGNING failed one check only: it read the correction's record as soon as the update completed, but the correction, set behind the held brief (section 2.5), is recorded by its settle a few seconds later. Everything else in it held (one request, one task, one office alert, one plain answer). The scenario now waits for the record.
  - Then the whole suite once: **53 passed, 2 skipped** (R10.K1 and R10.K2 need `--previous-release` and run alone), **755/755 invariants**, no uncovered model call, 32 minutes, peak 922 MiB. The stack was taken down after the run.
- **Full test suite** (`HAWA_TEST_WORKERS=3 pnpm test`, Desk built, on a machine shared with other agents' runs; 55 minutes): 588 files; 5,327 passed, 66 skipped, 27 failed. Rerun alone, the 15 failing files other than the two below pass (237/241), except `terminal-notification-durability.test.ts`, whose three cases asserted the old requester wording of the legacy outcome route (a Canva edit link, "queued for manual design"); they were changed deliberately and pass (the other 24 were 30 s timeouts under load, `gate-modes` included). The remaining two are expected: `r11-release-gate` test 1 (`RELEASE_MANIFEST.json` is not re-sealed on this branch) and `validate-pack-tool-caches` ("the committed manifest lists only tracked files", which passes once this ADR and its evidence are committed).
- `pnpm typecheck:tests` and `pnpm lint` (type check, scripts, `any` ratchet 941/1053, egress lint) pass.
