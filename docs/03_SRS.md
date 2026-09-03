# 03 — Software Requirements Specification

## Status

Normative. Requirement IDs are traced in `plans/traceability.csv`.

## Actors and user stories

- **US-001:** As a **Requester**, I want to **promote a Telegram message into a design task**, so that **the task is captured without copying it into another tool**.
- **US-002:** As a **Requester**, I want to **create a task directly in Hawa Desk**, so that **I can provide complete information and attachments**.
- **US-003:** As a **Project manager**, I want to **see why a client was selected**, so that **I can trust or correct routing**.
- **US-004:** As a **Project manager**, I want to **choose the client when evidence conflicts**, so that **the system never guesses across clients**.
- **US-005:** As a **Designer**, I want to **see the original request beside the brief**, so that **I can detect interpretation errors**.
- **US-006:** As a **Designer**, I want to **open the design as editable layers**, so that **I can refine one detail without restarting**.
- **US-007:** As a **Designer**, I want to **compare current and prior revisions**, so that **I can understand what changed**.
- **US-008:** As a **Language reviewer**, I want to **see exact source copy and rendered output**, so that **I can verify Sorani and Arabic accurately**.
- **US-009:** As a **Brand manager**, I want to **upload and version an official logo**, so that **automation always uses the approved asset**.
- **US-010:** As a **Brand manager**, I want to **define “must” and “never” rules**, so that **future work follows explicit brand policy**.
- **US-011:** As a **Brand manager**, I want to **approve a prior design as an example**, so that **retrieval learns the correct direction**.
- **US-012:** As a **Brand manager**, I want to **mark a design as rejected with a reason**, so that **it is never retrieved as positive inspiration**.
- **US-013:** As a **Reviewer**, I want to **approve an exact design hash**, so that **approval cannot drift after editing**.
- **US-014:** As a **Reviewer**, I want to **request a node-specific revision**, so that **the next attempt changes only the intended part**.
- **US-015:** As a **Reviewer**, I want to **mark feedback as one-time or reusable**, so that **preference learning remains controlled**.
- **US-016:** As a **Operator**, I want to **pause a failing workflow**, so that **external outages do not cause endless costly retries**.
- **US-017:** As a **Operator**, I want to **resume or restart from a safe checkpoint**, so that **completed generation is not repeated**.
- **US-018:** As a **Operator**, I want to **see all blocked tasks and the next action**, so that **daily production does not hide failures**.
- **US-019:** As a **Operator**, I want to **reconcile Drive and Sheet state**, so that **partial publication is repaired safely**.
- **US-020:** As a **Administrator**, I want to **disable a compromised message adapter**, so that **the office inbox continues operating**.
- **US-021:** As a **Administrator**, I want to **pin model and component versions**, so that **updates cannot silently alter output**.
- **US-022:** As a **Administrator**, I want to **set a client to local-only processing**, so that **sensitive data never leaves office infrastructure**.
- **US-023:** As a **Administrator**, I want to **restore the platform onto a clean host**, so that **a server failure is recoverable**.
- **US-024:** As a **Creative director**, I want to **generate a private art-direction reference**, so that **the system can explore boldly without shipping bad text**.
- **US-025:** As a **Creative director**, I want to **choose the best asset topology**, so that **the final design remains flexible and coherent**.
- **US-026:** As a **Designer**, I want to **replace a generated visual ingredient**, so that **copy and layout remain intact**.
- **US-027:** As a **Designer**, I want to **create linked square and story variants**, so that **changes can be synchronized without forced identical layouts**.
- **US-028:** As a **Finance/manager**, I want to **see model and generation cost per task**, so that **expensive retries are visible and governed**.
- **US-029:** As a **Project manager**, I want to **search historic tasks and feedback by client**, so that **institutional knowledge is usable**.
- **US-030:** As a **Requester**, I want to **receive the final Drive link in the originating conversation**, so that **the loop closes where work started**.
- **US-031:** As a **Operator**, I want to **use the system during a Telegram or WhatsApp outage**, so that **the canonical Hawa Desk remains available**.
- **US-032:** As a **Designer**, I want to **export SVG/PDF/PNG plus editable source**, so that **deliverables suit review, print, and future edits**.
- **US-033:** As a **Administrator**, I want to **test a challenger model in shadow mode**, so that **quality can improve without risking live work**.
- **US-034:** As a **Brand manager**, I want to **review proposed learned rules with evidence**, so that **automation improves without self-modifying silently**.
- **US-035:** As a **Language reviewer**, I want to **test mixed Sorani, Latin, prices, dates, and URLs**, so that **bidirectional errors are caught before clients see them**.
- **US-036:** As a **Operator**, I want to **see source provenance for every image**, so that **licensing and regeneration remain possible**.
- **US-037:** As a **Project manager**, I want to **route difficult tasks to a human from any stage**, so that **automation never becomes a trap**.
- **US-038:** As a **Administrator**, I want to **switch the design studio adapter**, so that **a young upstream project cannot hold the business hostage**.
- **US-039:** As a **Designer**, I want to **recover an unsaved or interrupted edit**, so that **workstation/browser failure does not erase a revision**.
- **US-040:** As a **Auditor**, I want to **trace who changed a rule, design, approval, or file**, so that **accountability is complete**.

## Primary use case: message to approved design

### Preconditions

- Source adapter and identity are authorized.
- At least one permitted client/project can be resolved.
- Required Client DNA version and destination mappings exist.
- The selected studio and model roles are admitted.

### Main flow

1. Source event is verified, normalized, and persisted.
2. Task promotion rule succeeds.
3. Restate starts or resumes the stable task workflow.
4. Client/project resolution succeeds or pauses for human input.
5. Client security scope is locked.
6. Design Brief is created and schema-validated.
7. Missing facts pause the task; optional creative choices do not.
8. Retrieval builds a cited Context Pack.
9. Design Router selects a production route.
10. Editable design is produced and versioned.
11. Hard QA passes; visual QA provides findings.
12. Reviewer approves the exact hash or requests revision.
13. Publisher uploads and verifies the package.
14. Sheet mirror is upserted and source channel notified.
15. Feedback and evaluation records are written.

### Alternate flows

- **Duplicate event:** return existing logical event/task.
- **Ambiguous client:** wait for selection; perform no retrieval or generation.
- **Missing fact:** ask a precise question and suspend.
- **Provider outage:** retry/fallback according to model policy; preserve completed assets.
- **Studio failure:** retry deterministic command, then open human/fallback route.
- **Hard QA failure:** repair only affected nodes; maximum two automatic loops.
- **Rejected design:** store negative evidence; do not publish.
- **Drive success / Sheet failure:** mark `PUBLISHED_DRIVE_PENDING_SHEET`; reconciliation completes later.
- **Notification failure:** publication remains complete; adapter notification retries independently.

## Business rules

- BR-001: A task belongs to exactly one tenant and one active client scope per attempt.
- BR-002: A project may inherit client rules but may explicitly override only fields permitted by policy.
- BR-003: Authoritative assets are addressed by ID and hash, never semantic similarity alone.
- BR-004: Exact copy cannot be altered by a creative prompt without a separate copy proposal and approval.
- BR-005: A design is approvable only when its source document, render, and QC report hashes agree.
- BR-006: A post-approval edit invalidates approval and creates a new revision.
- BR-007: No model may approve, publish, grant access, or activate a permanent rule.
- BR-008: Every external effect carries an idempotency identity derived from task, revision, operation, and content.
- BR-009: Rejected examples are excluded from positive retrieval.
- BR-010: The creator and visual judge should use different model families where practical.
- BR-011: A fallback may lower visual ambition but may never relax security, exact-copy, editability, or destination rules.
- BR-012: WAHA loss or account restriction cannot delete, complete, or roll back a task.
- BR-013: All dates are stored in UTC and displayed in `Asia/Baghdad` by default.
- BR-014: Auto-approval is disabled globally until a scoped policy is separately approved.
- BR-015: A model alias that can silently change is not an admissible production identifier unless the provider offers no fixed option and the role has daily regression monitoring.

## State model

```text
DRAFT
→ RECEIVED
→ ROUTING
→ ROUTING_BLOCKED | BRIEFING
→ INFORMATION_BLOCKED | CONTEXT_READY
→ DESIGNING
→ QA
→ QA_BLOCKED | AWAITING_REVIEW
→ REVISION_REQUESTED → DESIGNING
→ APPROVED
→ PUBLISHING
→ PUBLISHED_DRIVE_PENDING_SHEET | COMPLETE

Any active state may enter:
PAUSED_OPERATOR | FAILED_RETRYABLE | FAILED_TERMINAL | CANCELLED
```

## Acceptance conventions

- `MUST`/`shall` are mandatory.
- “Exactly once” refers to logical business effects implemented on top of at-least-once delivery.
- Model quality acceptance requires the evaluation datasets, not anecdotal demos.
- Visual correctness includes native-speaker review for Sorani/Arabic until sufficient measured evidence supports narrowing that gate.
