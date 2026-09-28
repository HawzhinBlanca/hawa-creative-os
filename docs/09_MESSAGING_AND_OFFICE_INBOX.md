# Messaging and Office Inbox

## 1. Decision

**Hawa Desk is the operating interface.** Telegram, WhatsApp, Slack, email, and future channels are sources and notification surfaces.

This prevents channel history, availability, permissions, and product changes from determining the office’s operational truth.

## 2. Hawa Desk intake modes

- direct task form;
- drag/drop files and source links;
- paste message/thread;
- promote an imported adapter event;
- duplicate/adapt an earlier task;
- batch task import;
- quick mobile capture.

A direct form supports exact copy, client/project, dimensions, deadline, references, sensitivity, and desired deliverables.

## 3. Passive versus production messages

By default, imported group messages remain `MESSAGE_ONLY`. They become a task through:

- an explicit bot command or mention;
- a configured reaction;
- a Telegram Mini App action;
- Hawa Desk “Create task”;
- an explicitly enabled classifier policy with confidence threshold and human confirmation.

This prevents ordinary conversation from silently spending money or creating client work.

## 4. Telegram adapter

Recommended first bridge:

- official Bot API webhook;
- secret-token verification;
- update ID deduplication;
- bot added only to selected groups/topics;
- commands/replies/reactions mapped to task actions;
- Mini App opens the full Hawa Desk task/review screen;
- file downloads copied into content-addressed staging;
- outbound status notifications treated as non-authoritative.

Telegram downtime does not block Hawa Desk.

A requester reply to a lifecycle message of a request that is in review, approved, delivering or delivered does not change that design. Core keeps the words under the update ID before answering, the office chat receives them quoted, and the requester is told they were not applied. A new request-owned delivery waits until an office member has read and acknowledged every such change; the acknowledging user and action are recorded (ADR-130).

## 5. WAHA adapter

WAHA is optional for reading existing WhatsApp groups through a dedicated office account.

Required isolation:

- dedicated number/account, not a director’s personal account;
- separate container/VM and credentials;
- no database credentials; only signed adapter API;
- allowlisted groups;
- read-only by default;
- explicit command/reaction/task promotion;
- sequence/reconciliation sweep;
- session-health and QR re-auth alerts;
- kill switch in Hawa Desk;
- documented acceptance of account/compatibility risk;
- no automatic critical outbound messages without human policy.

If WAHA stops working, tasks already persisted remain intact and staff use Hawa Desk/Telegram.

## 6. Adapter contract

Every adapter produces a normalized `MessageEnvelope`:

```text
adapter type/version
workspace/account/channel/thread identifiers
source event/message/revision identifiers
sender identity mapping
occurred/received timestamps
text and entities
attachments with hashes
reply/quote/thread context
reactions/actions
raw payload encrypted or redacted according to policy
verification evidence
```

Every adapter supports, where feasible:

- health/status;
- ingest event;
- fetch/reconcile range;
- send notification;
- resolve source permalink;
- acknowledge/update interactive action.

## 7. Identity mapping

Channel identities map to office users through explicit verified links. Unknown senders can create message records but cannot approve, change Client DNA, access other work, or trigger expensive/sensitive actions.

## 8. Client routing evidence hierarchy

1. explicit client/project selection;
2. dedicated channel/topic mapping;
3. existing thread/task association;
4. campaign code or official referenced asset;
5. sender’s allowed project scope;
6. model classification within allowed candidates;
7. human selection.

A model may never select a client outside the allowed candidate set.

## 9. Edits and deletions

Source edits do not overwrite history. They create a message revision and may mark a task brief stale.

If a source message is deleted:

- retain the minimum audit record according to policy;
- flag associated task;
- do not automatically delete already approved work;
- require a human decision if the deletion changes task facts.

## 10. Reconciliation

Each adapter keeps a cursor/sequence and periodically verifies:

- no update-ID gaps;
- recent messages are present;
- attachment hashes match;
- session/token is valid;
- outbound notifications have delivery state when available.

Gaps create an operator incident, not silent loss.

## 11. Why Slack is not selected

Slack remains supported through the same adapter interface, but it is not privileged in architecture. The office should not migrate communication merely to simplify an integration that can be built against its actual channels.
