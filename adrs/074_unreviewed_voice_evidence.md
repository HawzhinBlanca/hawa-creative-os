# ADR-074: Keep voice candidates separate from confirmed copy

Date: 2026-09-27
Status: implemented; local regression qualification in progress
Requirements: FR-013, FR-014, FR-060, FR-066, FR-067, NFR-006, NFR-007
Sources: docs/09_MESSAGING_AND_OFFICE_INBOX.md §§6–10;
docs/08_MEMORY_RAG_CLIENT_DNA.md §7; docs/10_WORKFLOW_RELIABILITY.md §§4–6;
docs/14_SECURITY_THREAT_MODEL.md §§3–5; ADR-073.

## Reason and decision

The existing voice adapter combined caption and transcript, rewrote spoken prices,
and returned constant confidence 0.96, language ckb and a fabricated duration.
Its error path read/logged provider bodies, and an unavailable Telegram download
could silently produce a design from only the caption. These are unsafe inputs
to the reviewed-source workflow, regardless of transcription model quality.

The adapter now returns exact provider text as an unreviewed candidate and keeps
supplied text in a separate field. The legacy `normalizedText` field preserves
exact source text; it no longer transforms facts. The optional normalization helper
remains explicitly a suggestion utility and has no automatic intake caller.
Unknown confidence/language/duration are null. A valid caller duration is labeled
`caller`, never measured. This boundary cannot infer that every design needs a
price or discount or select a campaign objective from keywords.

Each call reports `not_sent`, `rejected`, `received` or `uncertain`. The adapter
makes at most one HTTP request. Missing credentials and absent/disallowed client
policy cannot dispatch. Explicit recognized client-error statuses are rejected;
timeouts, network errors, server errors and unusable success bodies stay uncertain.
No caption replaces missing audio. Success still requires copy review and cannot
approve a design, factual claim, publication or memory entry.

Audio is bounded at 20 MiB before transport; response bytes at 1 MiB and text at
100,000 characters. The 30-second maximum deadline also covers streamed body reads.
Redirects are refused. Provider error bodies and thrown errors are never logged;
stream cancellation cannot hold the caller indefinitely.

## Current admission limit

Legacy Telegram intake has no durable transcription reservation or trusted locked
client policy, so it holds every voice source before download and requests the full
brief as text. The standalone text-inspection endpoint continues to refuse uploaded
audio with 412. This correction does not enable cloud voice in production or replace
the selected workflow/registry. No new dependency, model or database is introduced.

Next admission requires retained bytes, immutable client policy from PostgreSQL,
an admitted model/cost profile, durable paid-call admission/outcome, explicit source
copy confirmation and process-crash proof. An uncertain call must remain held across
restart until separately attributed reconciliation; an in-memory outcome flag alone
cannot provide that guarantee. Real Sorani/Arabic/English accuracy remains unmeasured.

## Verification

See `plans/research-grade-upgrade-2026-09-25/R20_EVIDENCE.md` for red-before,
affected regression, exact release checkpoint and remaining qualification limits.
