# ADR223 — Current resource authority for live events

Date: 2026-10-01. Status: reproduced and locally implemented; qualification pending.
Requirements: NFR-006, FR-011, FR-064, NFR-011, NFR-014.
Sources: MASTER_SPEC.md, docs/14_SECURITY_THREAT_MODEL.md,
docs/09_MESSAGING_AND_OFFICE_INBOX.md, docs/10_WORKFLOW_RELIABILITY.md,
docs/29_ACCEPTANCE_GATES.md; ADR037.

## Observed code gap

The live event subscriber tests an optional `auth.clientId`. Current authenticated
principals carry tenant, user and role, but no client ID. A tenant match alone
therefore permits a designer to receive another client's task, asset, feedback or
publication payload. A stream also retains its initial principal for events while
only its heartbeat checks the current credential. Neither immutable task scope nor
current database client membership is consulted for event disclosure.

The actual Core/RLS regression on the 930d596d source line reproduces this: a
named designer assigned only to client A receives client B's asset ID, filename
and content hash before the allowed A event. RED_REAL_STREAM.log retains the
failure. The repaired real-session stream refuses B and still receives A.

## Decision

Authorize every resource event using its actual task/client row under current RLS,
before writing any payload to the subscriber. Task-only events derive their client
from the stored task; a declared client must agree with that task. UUID, client code
and the existing `client-` code form must resolve to the same visible stored row.
Unknown, missing, malformed, contradictory or unavailable scope cannot disclose
the event. No system-name prefix bypasses this check. Only explicitly identified
office operation events may use current broad office authority without a resource.

Revalidate the stream credential when processing events and retain one-use tickets,
heartbeat revocation, native cookie/office access and existing SQL permissions.
Preserve event order with a bounded subscriber queue; errors or an overloaded/
unusable stream close that subscription. No models, new storage, migration,
membership cache, client permission expansion or workflow side effects are added.
Database-free streams cannot establish resource-read authority. Client and tenant
membership are checked for each resource read without a permission cache. The
existing 60-second session refresh cache and 15-second heartbeat remain; this
change does not claim instantaneous session revocation across Core instances.
Same-instance sign-out closes before the next resource disclosure.

## Required evidence

Reproduce disclosure with actual authenticated sessions, runtime RLS and two
clients through the real Core event endpoint. Then verify allowed events, multiple
assigned clients, task-only events, mismatched task/client/tenant/ID claims,
membership removal and role/session changes, read failure, explicit office events,
queue ordering and bounded overload. Preserve the red receipt and verify the
current deployed candidate boundary. Engineering and synthetic isolation evidence
do not admit genuine native/human/model/pilot or the whole production Gate B.


Candidate qualification,1 October2026: clean0816e8a6 passes216 deployed controls,
including14 current named-session stream controls through production nginx, plus
both encrypted fresh-volume PostgreSQL/Restate/blob restores. Each retains105
tables,176 policies and16 blobs without missing references. External adapters and
staff actions are synthetic; production unchanged. The full source suite records
6960 pass/1 fail/67 skips: its existing positive event test used database-free Core.
The fixture now creates a persisted scoped task and asserts its exact ID/title/client
from complete SSE frames under a bounded deadline. This preserves the deliberate
no-database authority refusal and all cross-client negative assertions. Full rerun
pending; candidate runtime and harness remain identical.
