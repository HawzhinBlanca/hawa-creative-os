# ADR184: Durable requester holds at design boundaries

Date: 2026-10-01. Status: implementation and qualification in progress.
Requirements: FR-004, FR-005, FR-060, FR-063, NFR-001, NFR-006.

## Evidence and decision

ADR182 S086 records “wait, don't make it yet” as an ordinary change note. The
automatic design continues. A reassuring reply alone would preserve the defect.

Read a clear temporary stop as a hold, distinct from permanent cancellation and
from a design instruction such as “pause the animation”. Bind it using the same
requester/chat ownership and ambiguity rules as cancellation. Record the original
words and the routing receipt, and pause the current automatic task in the same
transaction. Serialize with its generation admission on the task row and with
lifecycle projections on the request lock. Preserve a versioned pause checkpoint.
If the request advanced, do not claim it was paused: pass the request to the office.

Keep RequestLifecycle as the sole request owner. A hold does not advance its
revision, create a replacement task, cancel an already accepted provider call,
or discard results/cost evidence. The worker waits durably at a paused boundary;
new model/Canva operations refuse admission. An outcome already in flight waits
before its projection rather than making the held task reviewable automatically.

An authorized office member may resume only the current held task from the saved
checkpoint, with expected task version, stable idempotency key and reason. Generic
pause/cancel on a request-owned task remain refused. Clarification pauses without
a requester-hold checkpoint must not gain a generic resume. Acknowledging delivery
notes does not itself resume design work. Desk must expose the resume action.

## Required proof

S086 must become an ordinary passing conversation with an actual paused task,
not merely a different reply. Verify ambiguous and foreign-sender holds, replay,
concurrent admission, rollback on failed receipt/event, refusal of new spend,
retention of admitted outcomes, worker journal replay and office resume authority.
Do not call the slice complete until the connected tests and traceability pass.
Live deployment remains separately qualified; the current stable runtime repair
must be preserved. No new dependency, framework or paid provider call is needed.
