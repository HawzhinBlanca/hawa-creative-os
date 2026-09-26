# ADR-073: Bind requester-reviewed source copy to the existing lifecycle

Date: 2026-09-27
Status: locally qualified by focused, process-crash, Restate transport and sealed regression evidence; production admission pending
Requirements: FR-001, FR-002, FR-004, FR-009, FR-010, FR-011, FR-018, FR-060, NFR-006, NFR-014
Sources: docs/09_MESSAGING_AND_OFFICE_INBOX.md §§3–10; docs/10_WORKFLOW_RELIABILITY.md §§1–7; docs/08_MEMORY_RAG_CLIENT_DNA.md §§2–6; ADR-061, ADR-069–072.

## Decision and reasoning

Reuse the existing Core inbox ledger, content-addressed store, local PDF parser,
request lifecycle, expected revisions and idempotent Telegram sender. A source file
is evidence for a request; retaining or extracting it neither approves knowledge
nor makes its text final copy. No new workflow engine or provider is introduced.

Before extraction, lock an active client from an explicit `Client: <code/name/UUID>`
caption or the exact current request reply. Never infer scope from file contents.
Save original bytes, sender/chat/topic/message identity and source payload hash.
Record extraction separately, preserving native text limitations and provenance.

The requester replies to the original file with `/use_source` on its own line,
followed by the exact corrected copy to print. Only that command line is removed.
The same sender, chat and topic must match the source. Group intake requires an
explicit new-request command or an exact current request reply. A second source
confirmation cannot fork a request. Retries reconcile stored source/confirmation
and Core decisions before today's flags or request state can change their meaning.

A new source confirmation uses the existing lifecycle open. A request-bound source
uses its captured expected request revision; stale confirmations are refused.
Projection independently verifies the Core-owned decision, source/extraction/copy
hashes and original bytes before it creates a task. Restate receives small reference
identities, never source files or unreviewed extraction. The planner preserves
confirmed strings exactly, without legacy message cleanup. No chat copy confirmation
can approve a design, publication, Client DNA or knowledge indexing.

## Resource and failure boundary

Telegram downloads have actual streamed-byte bounds, a total deadline, bounded
metadata and fixed provider paths with redirects refused. Receipt/confirmation
keys and GC roots protect interrupted operations. Parse failures remain visible;
unsupported input cannot silently become caption-only work. Voice must additionally
satisfy locked client egress policy and durable paid-call uncertainty before it is
admitted; recording this decision alone does not qualify transcription.

## Acceptance required

Real PostgreSQL and runtime RLS: source retention and exact-copy projection,
source/client/sender/topic isolation, immutable decisions and one logical request,
changed-payload conflict, current-revision refusal, missing/corrupt original refusal,
restart/replay after flags change, GC protection and bounded downloads. Worker notice
transport and normal regression must pass. Live adapter, actual multilingual source
fidelity, editor/export and human quality retain their separate gates.

## Implemented failure and office inspection boundaries

Admission is committed under a short per-update PostgreSQL advisory lock before
external IO. It freezes the selected client/request or refusal. The lock is released
before downloading/parsing. Transient IO failure can resume the admission; a client
code reassignment cannot reroute it. Permanent source answers are retained separately.
An altered update cannot overwrite the legitimate event's answer. Exact confirmation
JSON is retained as a string as well as structured audit data: JSONB reorders keys,
which otherwise invalidated the source hash during revision replay.

Migration 043 admits `source_document` attachments and adds mandatory restrictive
task-file policies over the original tenant gate. They depend on the visible
task/client and survive raw replay of the older permissive policy. A red-before test demonstrated a designer downloading a
known task/hash from an unassigned client under the earlier tenant-only policy.
Source-file list/download routes join the active RLS-visible client and expose only
retained-file status/identities; failed extraction never hides the saved original.
Desk discards late responses after client changes. Explicit source Size captions use
the existing lifecycle's 640–2400 pixel bounds.

The streamed download bound follows the official Bot API getFile boundary;
original MIME/name metadata comes from the update because getFile need not preserve
it: https://core.telegram.org/bots/api#getfile (checked 2026-09-27).
The local bound counts actual bytes, covers stalled bodies and does not await a
broken cancellation callback.

Usage and recovery: `runbooks/REQUEST_SOURCE_REVIEW.md`. Measured results and
remaining release limitations: `R07_EVIDENCE.md`, `R12_EVIDENCE.md` and
`R07_SOURCE_RECOVERY_PROOF.json` in the research-grade plan directory.
