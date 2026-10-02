# ADR260: customer requests use RequestLifecycle and real web receipts

Date: 2026-10-02. Status: implementation direction accepted under owner's full
Designer transfer; not yet qualified or deployed.
Requirements: FR-001/006/017/043/054/068/069/077, NFR-006.
Sources: docs/09_messaging_intake.md, docs/14_security_identity.md,
docs/17_ui_spec.md, docs/30_CURRENT_STUDIO_CONTRACT.md, ADR034/135/259,
Claude's shared 2026-10-02 support response (received).

ADR259's isolated ownership/admission tests qualify a customer boundary, not its
synthetic TaskWorkflow payload as the production engine. Keep public generation
disabled until this adapter and the complete real customer journey are admitted.

## Canonical entry

A customer submission atomically retains a customer-owned web request, quota
reservation and `customer.request.open` outbox command. Its externally stable
identity is the request UUID, before or after projection and across revision
rounds. A replay compares the original body hash and returns that same identity.
The worker submits signed command references through the existing `ChatInbox.webOpen` gateway, which calls the private `RequestLifecycle.open` through the SDK. It does not start
TaskWorkflow or pretend the website request came from Telegram. `hawzhin_web`
is an explicit source platform and `web:<customer UUID>` a reserved channel.

Core reconstructs the open draft from its immutable web receipt. The worker
cannot supply customer identity, brand, exact text, locale, source photos or
resource policy. Projection rechecks current account/brand access under locks,
creates an owned task with the dedicated requester, pins DNA, and records the
existing lifecycle ownership and projection receipt in one transaction. Paid
work remains the existing DesignRun/Studio engine and its spend ledger.

## Requester messages

Use the existing versioned notification seam with a distinct durable web receipt.
A web notification is never sent to Telegram and is never named `sent` or given a
fake Telegram message ID. Store the bounded payload idempotently with its actual
request/account ownership and hash, and expose only its owner's read model. A
message key reused with different content conflicts. Browser recovery reads
these durable records; websocket/SSE infrastructure is unnecessary initially.

Questions start their response window after the authenticated member confirms
seeing the current question. That is a web read receipt, separate from Telegram's
confirmed send mark, and must bind the actual event, question and expected request
revision. The site never fabricates acknowledgement of an unseen question.

## Revision and acceptance

Customer feedback is a revision of the same owned RequestLifecycle, under the
expected current revision and one action key, with costs reserved once. Source
photos remain request-bound and ordered; selection follows the owner's explicit
use-all/count rule or otherwise the content-aware composition decision.

Customer acceptance is independent of office approval or publication. A download
must match the current bound design/revision/capture and passing critical QC,
including photo/logo fidelity, and its stored bytes/hash. New revisions/captures
invalidate earlier eligibility. It activates no client taste rule, staff approval,
Drive publication or Telegram delivery. Keep original editable source and factual
copy live.

## Admission evidence

Actual DB/runtime controls must cover concurrent duplicate dispatch, revoked
access before projection, cross-account resources, restart/replay, stale revisions,
uncertain provider calls, seen-question receipts and export hash/capture mismatch.
Then test the complete hosted two-user journey with real Canva and RTL copy, and
regress the other three website tools before flipping the launcher to live.

## Implemented local slice — 2026-10-02

Migration084 and the customer API now retain the original web request and one
canonical outbox command. Core reconstructs and rechecks it; concurrent projections
reuse one task and preserve the declared Arabic/Sorani/English copy. The existing
notification service name stays bound for durable compatibility, but reserved web
channels take a distinct Core record path before any Telegram transport, mark or
question-sent callback. Customer reads use request UUIDs across task projections.
The website renders the selected request's latest messages as text and polls its
detail only; browser messages do not constitute question-seen evidence.

A new paid Studio reservation locks/rechecks the customer's account, profile,
brand, requester memberships and immutable originating web receipt. Settling an
already paid result is not gated. The request body has a total 10-second deadline
and a 49,152-byte bound; a stalled cancellation hook cannot hold the response.

Local affected tests:68 passed, plus36 timeout/ledger tests in a separate overlapping
run; no failures/skips. Website affected tests:13 passed. Full current source and
the real hosted/customer/provider/RTL journey remain pending at this checkpoint.
Photos, revision/seen-question actions, acceptance and current capture downloads
remain required work; public generation remains disabled. This is not a launch seal.

Web admission also reserves the existing global automatic allowance under the same
lock used by ordinary chat admission. Web receipts are counted once, excluding
their later task commands. Web projection uses the accepted customer allowance
and cannot silently inherit Telegram's sender cap. Concurrent members at a global
cap admit one request; committed replay remains valid at the cap.

## Private transport correction and measured proof

Mocked HTTP tests initially admitted a direct RequestLifecycle ingress call. Actual SDK
metadata marks that object private. The isolated real Restate1.7.10 server confirmed
HTTP400 with “the invoked service is not public”. That route cannot be deployed.

The existing ChatInbox now authenticates `webOpen` using the worker service secret
(current/previous rotation support), a domain-separated HMAC over immutable command
references, and the exact reserved account channel. Core matches the stored command
UUID, key, request, tenant, account and payload before rechecking live brand access.
The brief never rides in public ingress. The gateway journals the evidence read and
sends to the private lifecycle through its SDK with the stable open key. Existing
service names and lifecycle ingress privacy remain unchanged.

`apps/worker/test-support/customer-web-transport.ts` runs against a disposable
Restate instance on55570/55580 and synthetic Core, with providers disabled. It
measured a genuine identical invocation receipt across two dispatcher instances,
one Core evidence read, one actual lifecycle projection, one durable web message,
and HTTP403 for signature tampering. Qualification output:
`output/qualification/2026-10-02/customer-boundary/WEB_RESTATE_TRANSPORT.json`.
91 affected database/gateway/inbox tests pass with0 failures/skips;745 active test
roots and scripts compile. This qualifies transport only: real hosted JWT, photos,
revisions, customer acceptance/download and native RTL remain open.
