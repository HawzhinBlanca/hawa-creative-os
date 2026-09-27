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
now aggregate Studio, fixture evaluation and retained-voice calls (ADR-096).
The evaluation Calls panel also shows shared daily balances and each original
daily allocation, separately from actual usage and the gateway request bound.
Other provider paths still require integration. A blocked voice admission keeps
the original audio and manual copy-review flow available.

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


### Exact-call cost evidence (ADR-097, 2026-09-27)

A named administrator can append snapshot-bound terminal cost evidence for an
exact Studio, evaluation or retained-voice call, including completed replies with
missing billing data. SQL verifies current authority, source identity, revision,
terminal evidence and the observed snapshot under parent/source and office locks.
Original receipts and all earlier attestations remain immutable. Shared daily and
Studio run admission retain the highest original, settled or attested cost; unused
reservations can then be released. A late receipt preserves any higher charge and
shows disagreement. Accounting does not clear execution holds or replay paid work.
Desk Operations shows paginated original costs, reserved amounts, attributed
history and conflicts. Unknown cost remains unknown; evidence files stay local.
See runbooks/CALL_COST_ACCOUNTING.md. Live billing, policy administration and typed
result recovery retain separate acceptance gates.


### Named daily budget administration (ADR-098, 2026-09-27)

Desk Operations exposes the existing shared office/client/role spending policy,
consistent current-day ledger usage and paginated revision history. Only a current
named administrator can append a policy after reviewing old and proposed limits
and supplying a reason. SQL checks session, tenant, actor, version and limits hash
under the same short lock as paid admissions. Runtime direct table writes remain
denied. The database records human identity separately from its connection identity;
historical owner revisions do not acquire fabricated human attribution.

Limits use nonnegative whole micro-dollars, including an explicit zero stop.
Removing a client or role override restores the displayed default. Lowering a cap
retains existing obligations; raising one never clears uncertain execution or
missing history. The fixed Asia/Baghdad day and current ledger accounting remain.
Desk retains an exact action scoped to the office and user before POST and retries
it after an uncertain answer or remount. Replay rechecks authority and returns the
original receipt before checking whether newer policy revisions exist. See
runbooks/SPENDING_POLICY.md. Other paid paths and live admission remain open.


### Source-bound fixture evidence (ADR-099, 2026-09-27)

Saved fixture reports identify corpus bytes by SHA-256 and individual cases as
passed, failed, not executed or unreported. Missing visual rubric scores cannot
be replaced by numeric defaults; incomplete scoring has no aggregate pass rate.
The replay protocol is v3. Completed legacy reports remain immutable and can
supply only their recorded aggregates, not reconstructed per-case outcomes.

Desk selects a saved run explicitly and matches case evidence to the exact corpus
identity. Dataset counts are measured from validated files, not fixture constants.
Browsing RTL definitions does not run the RTL corpus. Suite counts, call models,
latency and timestamps come from retained evidence. Candidate ranking, native
editability, canary results and human scores remain unknown unless independently
measured. Reading these views sends no generation request. Existing retained-action
retry, shared spending, and named settlement boundaries remain authoritative.


### Durable paid health probes (ADR-100, 2026-09-27)

Scheduled OpenAI health probes reserve their exact bounded request against the
shared office and `health_probe` role allowance before transport. PostgreSQL
serializes admission across Core instances and restarts, enforcing the longer of
the previous/current intervals and retaining uncertain calls across configuration
changes and midnight. Each attempt has a stable call ID, protocol, request hash,
reservation/policy version and one immutable outcome with actual receipt metadata,
latency and complete usage. Unknown facts remain null. Health GETs never dispatch.

Timeouts, ambiguous HTTP failures, invalid successful receipts, model mismatches
and bound overruns require reconciliation. A named administrator can append exact
terminal cost evidence through existing Operations accounting. After the interval,
this allows a new scheduled probe within current limits; it never replays the old
call or converts financial evidence into provider health. Original observations
remain immutable. Pre-ledger observations gain no fabricated costs. See
runbooks/PAID_HEALTH_PROBES.md and R21_PAID_HEALTH_PROBES_PROOF.json for qualification.
