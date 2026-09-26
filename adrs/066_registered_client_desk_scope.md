# ADR-066: Registered client scope in Desk

- Date: 2026-09-26
- Status: Accepted
- Requirements: FR-008, FR-011, FR-017, FR-078
- Sources: docs/09_MESSAGING_AND_OFFICE_INBOX.md, docs/08_MEMORY_RAG_CLIENT_DNA.md

Desk uses the authorized PostgreSQL client directory, without packaged client
choices or a default client for a new request. The directory returns canonical
client-row UUIDs and only active client/active-DNA pairs. A saved draft retains
its original scope when the client disappears; the form cannot silently pick a
replacement. An uncertain intake retries its frozen client/body/key even if the
client list has changed, so a lost response can be reconciled without duplication.

Brand DNA can open every returned client. Its detail/editor state is keyed by
client identity: switching clients creates a separate component lifetime. Delayed
reads, saves, snapshots, rules or asset inspection from a previous client cannot
replace the current client's state. Client directory refreshes also fence their
responses. Unknown reads remain visible; they do not become an empty known list.

Manual task intake rechecks active, writable client/project scope in its creation
transaction. Replay compares the original submitted request, without including
mutable server-derived DNA versions in its identity. An exact committed retry
returns the original task and recorded metadata even if client availability or
DNA has changed. A new request for that unavailable scope is refused before task,
event or outbox writes. Existing authorization and RLS remain authoritative.

This closes a Desk scope boundary. It does not establish arbitrary new-client
onboarding, cross-client creative quality, live Canva fidelity or launch admission.
