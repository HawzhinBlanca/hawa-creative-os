# Photo and image-file intake (ADR-068, ADR-069, ADR-143, ADR-148)

Requirements: FR-002, FR-004, FR-005, FR-011, FR-060, NFR-001, NFR-006.
Local evidence: `plans/research-grade-upgrade-2026-09-25/R07_EVIDENCE.md`; ADR-143 section 5.

## Requester flow

Requesters never need a command. Nothing sent to a requester names one.

Telegram's **send as file** option is supported for original JPEG, PNG and WebP
images. The app downloads the original file, not its thumbnail, and checks its
actual type and size. Filenames and MIME labels cannot make a PDF or other binary
file qualify as an image. An absent or generic binary MIME hint is permitted for
inspection. No conversion or recompression is applied during intake.

For a single photo or image file, supply the brief in its caption, or reply to the
current revision/clarification notice. A captionless file needs that exact reply
context.

### Albums (two to ten photos or image files)

An album settles by itself. After the newest photo, the bot waits for a quiet
period (`HAWA_ALBUM_SETTLE_MS`, default 8 s) and then:

- **caption is a brief**: one request opens with every photo and the design starts.
  The requester gets the usual "Request received" acknowledgement;
- **album replies to a request's revision or question notice**: that request's
  revision starts with the photos as reference;
- **no words** (or a caption that is only "ok", thanks or chatter): the bot asks once,
  "I have your N photos. What would you like me to design with them? Please tell me
  what it is for and the exact words to put on it." It asks in Sorani when the chat
  writes Sorani. No paid design starts without a brief.

The sender's next text in the same chat binds the waiting album. An album with no
words waits two hours (`HAWA_ALBUM_BRIEF_WINDOW_MINUTES`); a captioned one waits 72 hours
(`HAWA_ALBUM_RESUME_HOURS`). This applies before or after the album settles:

- a brief opens one request with the photos (a caption and a brief sent next to it
  are one brief, the caption first);
- "yes", "go ahead", "use them", "بەڵێ" or a plain `/use_album` starts a captioned album,
  and for an album with no words is asked again what to design;
- thanks, greetings and questions are answered as before and the album keeps waiting.

**A caption Telegram cut (ADR-148).** A standard Telegram account can send at most
1,024 characters of caption (UTF-16 units) and Telegram silently drops the rest. A caption
at that length is never designed from as it is: at the settle the bot says once "Telegram
kept only the first part of the text you sent with the photos. Please send the rest as a
message and I'll use it with these photos." (Sorani in a Sorani chat). The sender's next
message (anything but thanks, an OK or a command) is joined after a newline and the
request opens with every photo; an OK is asked for the rest again. With no rest after
10 minutes (the held-brief window; the album's delayed settle, backed by the poller's
sweep), the album opens with the caption's complete lines only: the cut last line is
dropped and never becomes copy. A single photo (not an album) is not covered yet.

A text brief sent just **before** the photos waits `HAWA_BRIEF_PHOTO_WAIT_MS`
(default 15 s) for them. An album that follows within that time takes the brief, and
one request opens. Otherwise the brief opens alone. Every text brief therefore starts
about 15 s later than before. Set the value to 0 to open text briefs at once.

For a new request while another request is already waiting for the requester, put
`/new` at the start of the brief, as for any brief.

`/use_album` replying to a photo still freezes that album (compatibility only).

## Refusals and retries

- Only JPEG, PNG and WebP still images are supported here, at most 20 MiB each
  and 100 MiB combined. Mixed media, non-image documents and video are refused
  when they arrive, and that album starts nothing.
- A photo that could not be saved stops its album: "One of your photos could not
  be saved, so I have not started a design. Please send the photos again."
- Photos with different captions are asked about: "Your photos came with different
  captions, so I am not sure which one is the brief. Please send the brief again as
  one message." The next brief from the sender binds the album.
- A photo arriving after the design started is not added (the album manifest is
  frozen with the task): "This photo arrived after I had started your design, so it
  is not part of it. When the draft is ready, reply to it with this photo and tell me
  what to change."
- A settle, a repeated settle, a sweep and a confirmation of one album freeze it
  once and open at most one request (one per language for a bilingual brief).

The quiet period, like the confirmation before it, cannot prove that every intended
photo reached Core. Inspect the resulting design and request changes if a wanted
photo was absent.

## Admission and operations

Migration `040_lifecycle_album_retention.sql` (ADR-068) must be applied. ADR-143 adds
no migration. Its state lives in `hawa.inbox_events`:

| account | key | meaning |
| --- | --- | --- |
| `lifecycle_album_part` / `_pending` | photo update ID | a saved or downloading photo |
| `lifecycle_album_confirm` | settling or binding update ID | the stored outcome: the frozen snapshot, or the message sent |
| `lifecycle_album_frozen` | album group key | the album opened its request; nothing adds to it |
| `lifecycle_album_settled` | album group key | `asked`, `refused`, `superseded` (the chat moved on) or `expired` |
| `lifecycle_brief_held` / `_consumed` / `_released` | text update ID | a brief waiting for photos, taken by an album, or opened alone |

Restate: each saved photo schedules `ChatInbox/<chat>/settle` with idempotency key
`settle:<update_id>`, and a held brief does the same after 15 s. A brief waiting for an
album re-settles under `settle:<update_id>:<n>`. The worker's poller sends overdue settles
(`settle-sweep:<update_id>`) at start and every five minutes. The Core route is
`POST /v1/internal/telegram/settle-sweep`. A settle whose Core calls keep failing is
logged and left to the sweep. It is never dead-lettered, because its update was handled
when it arrived.

Deploy Core and the worker together (one release). The new worker revision registers
the `settle` handler. Rollback to the previous release restores `/use_album`. Albums
saved in the meantime are then answered with the old notice.

### The owner's album of 2026-09-29

The 12:09:38Z album (six photos, caption = brief, never confirmed) is started by the
first sweep after the deploy, exactly once, if the deploy happens within 72 hours of it.
The plain `/use_album` refused at 12:44:37Z keeps its stored answer. If a request
opened in that chat after the album (for example, the brief was sent again), the album
starts nothing. The requester has to do nothing. After the deploy, check that the chat
received one "Request received" acknowledgement and that the request's task has six
`reference_image` files.

Before live admission, send a real captioned album, an album with no words followed by
a brief, a brief followed by an album, and a revision album. Check the task-bound image
hashes and the actual provider output, then complete named office review and approved
delivery. Also confirm a late-photo answer. Record redacted receipts and the tested
candidate identity. Local fakes and simulated approval do not establish human design
quality or live provider use.

Repeat the checks with images sent as files, including an image-file album. Verify the
stored hash against the original uploaded bytes and check the original file identity
and name in the source evidence. Confirm that a PDF renamed to look like an image is
refused and does not start a design from its caption.
