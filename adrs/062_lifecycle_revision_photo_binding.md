# ADR-062: Bind requester revision photos to the selected lifecycle task

Date: 2026-09-26
Status: accepted for implementation
Requirements: FR-011, FR-060, NFR-001, NFR-006
Sources: `MASTER_SPEC.md` §§5–6; `docs/09_MESSAGING_AND_OFFICE_INBOX.md` §§4, 6, 8; `docs/10_WORKFLOW_RELIABILITY.md` §§1, 3–4; ADR-060 and ADR-061.

## Context

ADR-061 admits a single captioned photo as a first brief. A requester can also send a photo with change instructions while one lifecycle request waits for a revision or clarification answer. Today that update is held before request selection, so the owned revision cannot use it. A Telegram file ID cannot serve as the durable image source, and a photo selected by chat proximity would cross request boundaries in a chat with multiple open requests.

## Decision

- Route the same supported single captioned photo through the existing request selection: an exact reply to a current lifecycle notice, or the only waiting request in the chat. Stale replies and ambiguous chats keep their durable refusal. An explicit `/new` without a reply remains a first brief.
- After selecting the request, Core downloads and validates the photo, stores it by content hash, and commits a separate hash-bound revision-photo decision carrying the request, chat and blob reference. A retry reads that decision before downloading and follows lifecycle routing even after the chat flag changes. The pending decision is a blob garbage-collection reference.
- The requester-revision projection checks that the complete Telegram update and the image reference match that stored decision, checks blob metadata, then attaches the hash to the new child task in the same transaction as task creation, request advancement and replay receipt. Studio consumes only that task-owned file. Restate receives the task identity and directive, never image bytes.
- A photo without a current unique owner, unsupported media, unavailable storage or an invalid file is refused or retried through the existing explicit paths. No caption alone is promoted to a revision task after photo admission fails.

## Consequences

One captioned photo can inform an owned revision or clarification answer without borrowing images from neighboring chat work. The durable decision may outlive an interrupted projection and is retained as source evidence. This admits one media shape in local tests; albums, other media and live Telegram/creative quality remain separate gates.
