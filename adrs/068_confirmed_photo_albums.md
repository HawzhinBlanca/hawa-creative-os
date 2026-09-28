# ADR-068: Freeze a confirmed photo album before starting a design

Date: 2026-09-26
Status: accepted; implemented behind existing lifecycle admission
Requirements: FR-004, FR-011, FR-060, NFR-001, NFR-006
Sources: `docs/09_MESSAGING_AND_OFFICE_INBOX.md` §§3–8; `docs/10_WORKFLOW_RELIABILITY.md` §§1–4; ADR-061–067; Telegram Bot API `Message` contract, https://core.telegram.org/bots/api#message (read 2026-09-26).

## Decision

Telegram supplies a chat-scoped media group identity on individual messages, with
no total part count in the Message contract. A quiet timer cannot establish that
all files arrived. Core therefore stores each lifecycle album part and its image
hash durably before acknowledging it. No task or paid design starts yet.

The sender replies to any part with `/use_album` after all files have been sent.
Under a per-album transaction lock, Core freezes the ordered part set and the
confirmation's exact source hash. The original captions and reply context become
one admitted intake. New briefs and replies use the existing lifecycle owner and
expected-revision projection; a captionless album requires an exact current reply.

- Scope includes tenant, chat, sender, topic and media group. Mixed scope,
  unsupported media, missing files, conflicting captions/replies and oversized
  albums are refused explicitly. The limit is ten photos and 100 MiB total.
- A confirmation cannot select a neighboring album by recency. It must reply to
  a stored part in the same sender/chat/topic scope. A group already frozen cannot
  acquire another part or create another request from a second confirmation.
- Each received part identity is persisted before download. A failed download
  stays in the collection and blocks confirmation until its exact update retries
  successfully; confirmation cannot silently omit it. Completed parts retain
  their blobs through garbage collection. Projection checks
  the frozen manifest and attaches every image atomically. The active Canva
  planner and Studio consume the manifest order, verify every owned blob, and
  retain only hashes/metadata in durable model requests.
- Exact source replays survive Core/worker restart and flag rollback. Restate
  continues to carry small references; no new workflow service, timer or framework
  is added. Original updates remain audit evidence alongside the normalized intake.
- Changed source content or media kind conflicts with the original identity.
  Historical holds keep their original result after upgrade; they are not newly
  collected on retry. A refusal to confirm is durable, so the user sends a fresh
  confirmation after correcting a temporary condition.

## Limits

The explicit confirmation defines the selected set; it does not prove Telegram
delivered every intended file. Late parts receive an actionable refusal. Real
model interpretation, visual quality and production admission require separate
evidence. Voice, documents/PDFs and mixed-media albums remain outside this slice.
