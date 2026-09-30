# Requester design holds

ADR184, 2026-10-01. This candidate is not deployed until its release is qualified.

A clear temporary stop from the current requester pauses the current automatic
design task while the request is `designing`. The message and checkpoint commit
with the intake receipt. An ambiguous hold asks which design; a different group
member cannot hold someone else's request.

New model and Canva work refuses admission. A provider operation already admitted
may finish; retain its result and cost. A completed outcome waits before review
advances. The requester sees the design as paused when asking for status.

In Desk, open the task, read the requester's original hold message, confirm any
changed facts, then use **Resume this design** with a reason. Core checks office
authority, the current task version, request revision and saved checkpoint.
Retries with the same key return the original receipt. A service credential,
clarification pause, stale task or different request revision cannot resume here.

The worker waits using durable timers: 30, 60, 120, 240 seconds, then at most
five minutes between checks. Resume may therefore take up to five minutes to be
observed. It continues the saved run; it does not start a replacement design or
clear uncertain model calls. A hold message still needs the existing delivery-note
acknowledgement before delivery. Resume alone does not acknowledge it.

## Limits still requiring work

This slice automatically pauses an already projected automatic task. A hold sent
while the initial brief is still settling follows the existing message deferral;
its ordering against the first worker admission is not qualified by this slice.
Do not claim an early-intake hold prevents all initial spend until that separate
boundary is proved. Requests already beyond `designing` pass the hold to the office
without claiming an automatic pause. Permanent cancellation semantics are unchanged.
New Sorani phrases require native human review.

Proof: `plans/requester-hold-reliability-2026-10-01/LOCAL_PROOF.json`.
