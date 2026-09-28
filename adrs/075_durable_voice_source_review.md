# ADR-075: Retained voice uses source review and durable paid-call admission

Date: 2026-09-27
Status: implemented; local engineering acceptance passed, live admission pending
Requirements: FR-001, FR-002, FR-011, FR-013, FR-014, FR-018, FR-060, FR-066, FR-067, FR-079, NFR-006, NFR-007
Sources: docs/09_MESSAGING_AND_OFFICE_INBOX.md; docs/10_WORKFLOW_RELIABILITY.md;
docs/14_SECURITY_THREAT_MODEL.md; docs/17_UI_UX.md; ADR-073 and ADR-074.

## Decision

Extend the existing source inbox ledger, content-addressed originals and request
owner. A voice original belongs to one client before download. Inspection and
transcription are unapproved evidence; only the requester's exact `/use_source`
copy enters a design. The original remains downloadable through current client
authorization even when transcription is unavailable or its outcome is uncertain.

Admit bounded, single-stream Ogg Opus voice recordings. Validate container framing,
checksums, packet timing and duration locally without decoding or new dependencies.
Do not trust Telegram's declared duration for a cost reservation. Unsupported or
malformed audio cannot become caption-only work. Other codecs remain explicitly
unsupported until they have equivalent byte/timing validation.

Resolve current active Client DNA privacy and client policy inside PostgreSQL.
Cloud transcription additionally requires a current tenant-scoped canary/primary
`voice_transcriber` deployment with explicit cost and daily call/spend limits.
No deployment or human evaluation is fabricated. The current adapter supports
OpenAI `whisper-1`; broader model admission requires adapter/evaluation work.

Before dispatch, commit one attempt keyed by tenant/client/original hash, the
source's decision, locked policy/model identity and conservative cost reservation.
Concurrent delivery, duplicate sources and process restart may read that attempt
but cannot dispatch it again. Save the first returned outcome separately and
immutably. A crash after admission or dispatch with no saved outcome remains
uncertain. Cached results can be inspected without another provider request.
Manual exact-copy review may proceed from the original while a paid call remains
unresolved; it neither retries nor settles that call's financial outcome.

Reserve estimated cost from validated packet duration, rounding up to whole
minutes. Actual billed cost is unknown unless independently reconciled and must
never be reported as zero. A saved manual decision stays manual on replay; changing
flags, credentials or policy does not silently start a previously held source.

## Standards and current rate evidence

- Ogg Opus timing/headers: RFC 7845 §§3–6, https://www.rfc-editor.org/rfc/rfc7845
- Opus packet duration: RFC 6716 §3, https://datatracker.ietf.org/doc/html/rfc6716
- Whisper model/rate: https://developers.openai.com/api/docs/models/whisper-1
  reports $0.006/minute when checked 2026-09-27. This is an estimate basis, not an
  invoice or proof that a model passed multilingual quality admission.

## Required proof

Actual PostgreSQL/runtime RLS, concurrent and restarted intake, denied privacy and
budget making zero provider requests, byte corruption and caller duration lies,
exact copy through new/revision requests, Desk original/transcript isolation and
real process kills around paid admission/response/outcome. Provider responses may
be synthetic for fault tests; real multilingual transcription and design quality
retain independent admission gates. Production remains unchanged during this work.

## Authorization detail and measured evidence

The first paid-path tests exposed a PostgreSQL permission interaction: ordinary
`SELECT ... FOR SHARE` also applies the model update policy, so the runtime operator
could not see an otherwise readable admitted model. Migration 044 uses a narrow
security-definer reader that checks actual current tenant membership and locks only
eligible voice deployments. It grants no model mutation permission; a designer
claiming an operator context is still refused.

The five-kill/six-start Core drill passed 40 invariants with local synthetic provider
responses. Focused acceptance covers new and revised exact-copy requests, replay,
client privacy, daily budget concurrency, current client authorization and byte/timing
limits. The initial over-duration fixture was itself malformed; it now proves both
600 encoded seconds accepted and 601 refused. Test failures and final release gates
are recorded in R07_VOICE_RECOVERY_PROOF.json and R07/R12/R20 evidence. Operation and
manual reconciliation limits are in runbooks/REQUEST_SOURCE_REVIEW.md. No live model
is admitted, and production configuration remains unchanged.
