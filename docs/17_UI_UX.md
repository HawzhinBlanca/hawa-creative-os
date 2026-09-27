# Hawa Desk UI/UX Specification

## 1. Design goal

The interface should feel like a focused creative control room, not an enterprise project-management suite. A user must understand what the system believes, what it is doing, what is blocked, and what can safely happen next.

## 2. Primary navigation

```text
Inbox
Tasks
Review
Clients
Creative Library
Operations
Evaluations
Settings
```

Role permissions hide irrelevant sections.

## 3. Inbox

Columns/lanes:

- New messages
- Needs promotion
- Needs routing/facts
- In production
- Awaiting review
- Failed/blocked

Each card shows source, client confidence, task type, language, due date, current step, and one primary action.

## 4. Task workspace

Three-pane desktop layout:

```text
[Request + thread] [Design/preview/editor] [Brief, DNA, QA, actions]
```

Mobile uses stacked tabs and preserves approval evidence.

Required affordances:

- original source always one click away;
- assumptions visibly distinct from supplied facts;
- exact copy has lock indicator;
- routing explanation and correction;
- variant/revision switcher;
- open editable design;
- node-targeted comments;
- before/after semantic and visual diff;
- cost/latency/provenance collapsible—not cluttering primary review;
- safe next action on every blocked state.

Studio spending uses cumulative call-ledger totals, including checks after Canva
transfer. Display recorded estimates, additional administrator-reported cost,
unknown costs, admitted call count and admission refusal separately. Missing
accounting is unavailable, never an invented zero or default cap. Also display
funds reserved for unfinished/estimated calls and remaining funds. Every new call
must fit its conservative reservation within that remainder before transport.
Provider billing can differ from the quote; an overrun blocks further calls for
pricing review. Preserve original snapshots and receipts. See ADRs 088/091 and
runbooks/STUDIO_RECOVERY.md.

The Studio spending panel also shows office, client and model-role daily limits,
recorded charges, held obligations and remaining allocations in the Asia/Baghdad
office day (ADR-092). It distinguishes the run balance from the daily balances,
flags historical accounting gaps and exposes no other client identifiers. These
are Studio-only limits until the remaining provider paths are integrated.

## 5. Client DNA screen

Tabs:

- Identity
- Logos/assets
- Colors/fonts/layout
- Language/glossary
- Approved examples
- Avoid/rejected examples
- Templates/style families
- Rules and evidence
- Projects/folders/approvals
- Model/retention policy
- Version history

Draft changes are reviewed before activation. The UI shows scope and conflicts.

## 6. Operations

- failed/retrying/paused workflows;
- adapter sequence/health;
- model/provider health and budgets;
- GPU queue and workflow quarantine;
- studio version/health;
- Drive/Sheet reconciliation;
- backup and restore status;
- trace links;
- replay controls.

Do not expose low-level stack traces as the primary message. Show error class, impact, evidence, and safe action.

## 7. Evaluations

- dataset browser;
- candidate model/editor/workflow versions;
- blind comparison assignments;
- hard metrics and human scores;
- cost/latency;
- admission decision and rollback;
- regression history.

## 8. Interaction principles

- one dominant action per state;
- destructive/privileged actions require clear scope and reason;
- optimistic updates only for reversible local UI state, not approvals/publication;
- no hidden auto-generation on page load;
- progress describes completed/current/next durable step;
- uncertainty and assumptions are visible;
- keyboard-first review and search;
- RTL content is isolated correctly inside an LTR or localized UI.

## 9. Accessibility

Target WCAG 2.2 AA:

- semantic landmarks/headings/status regions;
- keyboard navigation and focus management;
- sufficient contrast and non-color indicators;
- text alternatives/previews;
- reduced-motion support;
- no inaccessible canvas-only controls without semantic alternatives;
- shortcuts discoverable and remappable where feasible.

## 10. Notifications

Notifications are grouped by actionability:

- requires my decision;
- blocked operationally;
- completed;
- informational.

Users can choose Hawa Desk, Telegram, WhatsApp, or email notification routes, but the actionable record remains in Hawa Desk.

## 11. Wireframes

Browser-viewable wireframes are provided in `ui/wireframes.html`. They define information architecture and interactions, not final visual branding.


Evaluation call receipts distinguish the original request cost bound and output
cap from an estimate based on reported usage (ADR-093). Missing usage remains
unknown, including historical receipts whose usage completeness was not recorded.
An observed overrun stays visible beside the original bound. The displayed request
bound does not imply that evaluation has joined the office's durable allocation.
