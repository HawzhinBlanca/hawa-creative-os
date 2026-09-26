# ADR-069: Admit image files through the existing request-owned image path

Date: 2026-09-26
Status: accepted; implemented behind existing lifecycle admission
Requirements: FR-002, FR-004, FR-011, FR-060, NFR-001, NFR-006
Sources: `docs/09_MESSAGING_AND_OFFICE_INBOX.md` §§3–10; `docs/10_WORKFLOW_RELIABILITY.md` §§1–7; ADR-061, ADR-062, ADR-067, ADR-068; Telegram Bot API [Document](https://core.telegram.org/bots/api#document) (read 2026-09-26).

## Decision

An image sent as a Telegram document must retain its original bytes and source
identity while using the same scoped intake, confirmation and replay rules as a
photo. It does not need a new workflow, table, provider call or image conversion.

- Share carrier parsing between singleton intake, task projection and album
  collection. Exactly one photo or document carrier is allowed; mixed media,
  animations/live photos and text-plus-media shapes are refused.
- Use the document's original `file_id`, never its thumbnail. An explicitly
  unsupported MIME hint is refused before download. An absent hint or generic
  binary MIME may be inspected, but only verified JPEG, PNG or WebP bytes may be
  retained. Names and MIME hints cannot authorize unsupported bytes. Declared
  over-limit sizes are refused before download; actual downloaded bytes remain
  authoritative for the existing 20 MiB per-image limit.
- Keep filenames, source file identity and reply context in the original source
  update. Store bytes under their content hash; no filename becomes a local path.
  Reuse the existing `lifecycleImage` / `lifecycleAlbum` references and GC roots.
  New image briefs previously dropped that original update while constructing
  the small worker draft. Persist it separately in the Core decision, then copy
  only that trusted stored source into the task's inbox record during projection.
  The worker cannot supply replacement source evidence. Historical decisions
  without the extra record remain replayable without invented metadata.
- Captionless files require an exact current request reply. Albums still require
  explicit `/use_album` confirmation and freeze the whole selected set. Invalid
  documents cannot be omitted to admit the remaining caption or album photos.
- Historical refusals and admitted decisions replay unchanged after upgrade or
  flag rollback. Projection independently requires a stored image decision for
  either carrier, so a document cannot be reduced to unverified text internally.

## Limits

This admits supported still-image files, not PDF text extraction, office documents,
audio, animations or other binary formats. A signature establishes an admitted
image type; downstream decoding/QA can still refuse corrupt content. Live
Telegram/provider and independent visual-quality admission remain separate.
