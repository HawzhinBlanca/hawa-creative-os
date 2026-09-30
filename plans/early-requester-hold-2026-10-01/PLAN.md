# Holds before initial design admission

Date: 2026-10-01. ADR185. Base: 6723d208. Branch: codex/requester-hold-reliability.
Requirements: FR-004, FR-005, FR-060, FR-063, NFR-001, NFR-006.
Normative sources: docs/09_MESSAGING_AND_OFFICE_INBOX.md;
docs/10_WORKFLOW_RELIABILITY.md; MASTER_SPEC.md.

## Acceptance

- A clear hold during brief settlement commits an immutable original-brief latch.
- The first task projection inherits it atomically; actual worker dispatch sees paused.
- The real paid-call ledger admits zero calls before office resume, then one saved call.
- Both PostgreSQL advisory-lock orderings pass, with an observed blocked backend.
- Exact original words and answers replay after resume without re-pausing; changed bytes fail.
- Failed receipt transactions leave no hold or task side effect.
- Sender/chat/topic, replies and other active or pending designs prevent wrong-target holds.
- Consumed text/album anchors and language siblings keep their original owner and hold.
- Manual fallback keeps an initial paused checkpoint with human/version/revision-bound resume.
- Requester acknowledgements are honest; all office members receive durable alerts.
- Reviewed Core briefs cannot be mutated by the worker at projection.

## Evidence and limits

Connected 13-file suite: 299 passed, zero failed, two existing expected failures.
Production remains healthy4e500451 with nginx validation, stable proof bind, independent
worker token, restricted worker login and unsafe releases absent. See LIVE_INFRA_READBACK.json.
Tested seal cdc8e311 (source fb5051c8): full6,262 passed/0failed/2existing expected
failures/67skipped,650 typed roots, lint and source manifest pass. All source changes
after this tested seal are qualification metadata/manifests; runtime/test bytes stay
unchanged. See LOCAL_PROOF.json for log digests and retained negative evidence.

The two unrelated ADR182 title and multiple-design defects remain open. Later-stage
holds, permanent cancellation, native Sorani admission and broader content-aware
W3/W5/W6/native/Canva/human design proof remain separate. No paid provider was called.
Early hold proof covers clear Telegram text holds on a pending original brief or its
recorded opening decision, including consumed albums; it does not claim a universal
stop for voice/PDF processing before a brief exists. This candidate is not deployed.
