# Photo and image-file intake (ADR-068, ADR-069)

Requirements: FR-002, FR-004, FR-011, FR-060, NFR-001, NFR-006.
Local evidence: `plans/research-grade-upgrade-2026-09-25/R07_EVIDENCE.md`.

## Requester flow

Telegram's **send as file** option is supported for original JPEG, PNG and WebP
images. The app downloads the original file, not its thumbnail, and checks its
actual type and size. Filenames and MIME labels cannot make a PDF or other binary
file qualify as an image. An absent or generic binary MIME hint is permitted for
inspection. No conversion or recompression is applied during intake.

For a single photo or image file, supply the brief in its caption, or reply to the
current revision/clarification notice. A captionless file needs that exact reply
context. A single image does not require `/use_album`.

In an admitted lifecycle chat, send two to ten still photos together as one album.
An album of supported original image files uses the same confirmation flow.
For a new request, put the complete brief and exact copy in one caption. Use
`/new` at the start of that caption when another request is already waiting.

For a revision or clarification, send the album as a reply to the current request's
notice. Every photo must carry that same reply context. One caption can contain
the requested changes; a captionless reply uses the existing brief and preserves
its factual copy. Images do not establish new factual text.

After all photos have finished sending, **reply to any photo in that album with
`/use_album`**. The saved photos become one frozen input set. Collection itself
starts no task or paid design. A group receipt explains this confirmation step.

## Refusals and retries

- Only JPEG, PNG and WebP still images are supported here, at most 20 MiB each
  and 100 MiB combined. Mixed media, non-image documents and video need a corrected album.
- Confirmation requires the same sender, chat and topic as the saved album.
  Conflicting captions or replies cannot be merged into a guessed request.
- If a received photo has not downloaded successfully, confirmation refuses the
  entire collection. Let its delivery retry, then send a new `/use_album` reply.
  Replaying a previously refused confirmation preserves that refusal.
- A photo arriving after confirmation is refused explicitly. It cannot change
  the submitted design. Send a new album or ask the office to revise the request.
- Retrying a successful confirmation returns the original task/request. A second
  distinct confirmation cannot start another design from the same album.

Telegram supplies a media group identity without an expected total. Confirmation
defines the selected set; it cannot prove that every intended photo reached Core.
Inspect the resulting design and request changes if a wanted photo was absent.

## Admission and operations

Apply migration `040_lifecycle_album_retention.sql` through the normal upgrade
gate before this Core candidate starts. It indexes collection/reply lookups and
keeps stored album images reachable by the garbage collector before task creation.
Use the existing authorized-sender policy and lifecycle chat flag; this feature
does not enable either in production.

Before live admission, send a real new-brief album and a revision album, check
the exact task-bound image hashes and actual provider output, then complete named
office review and approved delivery. Also confirm an early refusal and a late-photo
refusal. Record redacted receipts and the tested candidate identity. Local fakes
and simulated approval do not establish human design quality or live provider use.

Repeat the new-brief and revision checks with images sent as files, including an
image-file album. Verify the stored hash against the original uploaded bytes and
check the original file identity/name in source evidence. Confirm a PDF renamed
to look like an image is refused and does not start a design from its caption.
