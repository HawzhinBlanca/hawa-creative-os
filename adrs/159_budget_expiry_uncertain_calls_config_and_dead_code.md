# ADR-159 — Price-policy review date, uncertain-call expiry, configuration and dead code

Date: 2026-09-30
Status: implemented on branch `claude/fix-budget-config`; not deployed
Requirements: FR-015, FR-071, FR-079, FR-082, NFR-001, NFR-015.
Sources: audit of production commit 6bd479c1 (2026-09-30), items #4, #8 and the P2/P3 budget,
configuration, safety and cleanup findings; ADR-091, ADR-093, ADR-101, ADR-135, ADR-142, ADR-146.

## Decisions and reasons

**Price-policy review date (audit #4).** The Canva planner refused every paid call from
2026-11-22 through a date written into its code, with no warning, reported as
`PLANNER_NOT_DISPATCHED`. That date is the gateway policy's (ADR-093: the GPT-5.6 Sol price was
published "through at least 2026-11-21") and it is a real limit: the rates must be re-checked by a
person before then, because a stale price makes every reservation wrong. It is not pushed out. It
now lives with the prices (`STUDIO_SPENDING_POLICY` in `packages/creative/src/studio/price-review.ts`,
`GATEWAY_SPENDING_POLICY_REVIEW_BY` in `gateway-spending.ts`, same instant). The planner refuses
with `SPENDING_POLICY_EXPIRED` and sends nothing. `/v1/health` reports both review dates under
`spendingPolicy`. From 14 days before the date, `dependencies.spendingPolicy` says `expiring`
(then `expired`), and the watchdog alerts on it. Renewal is a human step
(runbooks/SPENDING_POLICY.md, "Renewing the price policy").

**Uncertain calls (audit #8).** A Studio call with no provider outcome blocked its task for good.
It also held its whole reservation against every later office day. Only a Google-signed-in
administrator could settle it, and production has no Google sign-in. Neither provider can be asked
about a request whose answer never arrived: OpenAI and Gemini have no lookup by request id for a
lost response. So automatic reconciliation is not possible. Instead, Core charges each such call its
whole reservation (never less than its estimate) after `HAWA_UNCERTAIN_CALL_HOLD_HOURS` (default 6,
1 to 168). The charge is recorded as System Automation's evidence (`evidence_type`
`reservation_expiry`, conclusion `reservation_charged`). Money is counted conservatively, the task
is unblocked, and later days are released. The wait is the office's chance to record the real
charge first. A Studio run is settled only once it has stopped, and whole, when all its unresolved
calls are old enough. A planner call gets the same charge as a call-cost attestation; its plan must
still be failed or abandoned before the task plans again. SQL enforces all of this (migration 071):
only System Automation, only in full, only after an hour. The sweep runs every 15 minutes
(`enableUncertainCallExpiry`, on in production).

**Trusted-office attestation.** In `trusted_office` mode (ADR-146) the studio-recovery route passes
the verified `authMethod`. The office team, acting as the shared office administrator, may record
settlement evidence as `trusted_office_attestation`. The GET answer then says `canSettle` and the
receipt names `trusted_office_team`. SQL requires the marker Core sets for such a request and an
administrator membership. This is weaker than a named session by design: there is no individual
sign-in. `office-access.ts` and `verifyRequestAuth` are unchanged. Planner attestations
(`call-cost-accounting.ts`) still need a named session; that route belongs to Codex's office stream.

**Final costs (P2).** A Gemini image's listed per-image price is the charge: cost basis
`price_list` is final. A size with no listed price stays an `estimate`. An estimate becomes final
once its run has stopped, at the estimate; a zero estimate is charged its whole reservation. It no
longer holds its reservation on every later day.

**Office day (P2).** The shared daily allowance running out is `OFFICE_DAY_EXHAUSTED`, with its
scope and reset time (midnight in Baghdad, 21:00 UTC). It was reported as "no candidates passed
hard QA". The office alert says it is used up, that nothing was sent, and when it resets. The
requester hears the existing "needs a little more time" line; no new wording, no new Sorani.

**Configuration.** `AUTO_GENERATE_CHAT_DESIGNS` is documented as the switch for automatic drafting
of chat requests; WhatsApp read it, but Telegram lifecycle drafting ignored it. It now governs
Telegram too (text briefs and confirmed voice/PDF copy). Only `true` drafts. Production sets the
variable. The pre-ADR-135 Telegram intake required `true` to draft, and production drafted then
(the 2026-09-13 review records drafts declined only by the daily cap). So production's value is
`true` and nothing changes there. **Confirm this before deploying.** The value was not printed
here, per the audit's secrecy rule.

A non-numeric `AUTO_GENERATE_DAILY_CAP_*` is treated as 0 and logged: it had become NaN, which
switched the cap off. The integrations report accepts `PHOENIX_COLLECTOR_ENDPOINT` (production's
name) as well as `_URL`. `.env.production.example` marks the variables nothing reads as removable:
`HAWA_DOMAIN`, `GOOGLE_SHARED_DRIVE_ID`, `GOOGLE_SPREADSHEET_ID`, `KAAE_*`, `FIGMA_*`,
`HAWA_FIGMA_BRIDGE_URL` and `HAWA_LIFECYCLE_CHATS`. The Phoenix client exports no spans yet.

Studio tier and imagery now use one vocabulary (`standard|premium`, `auto|none|generated`). Intake's
older names are mapped once (`fast`/`quality`, `abstract`/`photographic`); a `fast` tier had
failed the runs table's CHECK. Unknown values are refused with `STUDIO_OPTIONS_INVALID`. The worker
now checks that Core's text fields in an intake answer are text.

**Review links (P3 safety).** A GET on `/webhooks/whatsapp/actions` approved a task, and with
`publish=true` delivered it, so a link preview could approve. A GET now shows a confirmation page,
and its button POSTs. Links are signed (v2) over the task, action, publish flag, a 72-hour expiry
and the phone they were sent to. An altered link is 403, an expired one 410; older links are
refused. The only producer, `POST /campaigns/:id/dispatch-review`, has no Desk or worker caller,
and WAHA is not configured in production. It is kept, not retired, because it is the tested signed
delivery path.

**Dead code (P3).** Removed, with their tests:
- Core's Telegram polling loop, command handler, update normaliser, review-card and
  publication-notice formatters, `setWebhook` and `parseCallbackData`. None had a production caller
  since ADR-135.
- The poll-state failure counter and Core's unused re-export of it.
- The test-only offset storage types and the one phrase only the command handler said.
- The `publish.drive` and `notify.whatsapp` outbox handlers; nothing enqueues them, and an unknown
  command still fails visibly.
- Stale comments.

`sweepFailedTasks` stays: the Desk's API client names its route.

## Database tables with no application reference (candidates, not dropped)

`glossary_terms`, `visual_examples`, `knowledge_documents`, `knowledge_chunks`, `prompt_versions`,
`model_invocations`, `design_plans` (also `tasks.current_plan_id`), `design_operations`,
`qc_findings`, `eval_cases`, `eval_results`, `audit_events`, `design_jobs`, `figma_leases`,
`figma_mutations`, and `inbox_event_duplicates` (a one-off quarantine table). `backup_drills`,
`model_deployments`, `model_roles` and `pre_admission_spending` are used by scripts or SQL
functions and stay. Dropping any table needs its own ADR and a backup check.

## Verification

Regression tests fail on 6bd479c1 and pass here:
- `apps/core/test/uncertain-call-expiry.test.ts`
- `spending-policy-review-health.test.ts` (fake clock)
- `canva-design-planner.test.ts` (fake-clock expiry, planner expiry charge)
- `design-studio-orchestrator.test.ts` 4c
- `canva-status-message.test.ts`
- `packages/db/test/studio-scope-budget.test.ts` (price list, closed estimates, office day)
- `packages/domain/test/studio-budget.test.ts`
- `chat-intake-durability.test.ts` (cap typo)
- `lifecycle-internal-intake.test.ts` (switch off)
- `core.test.ts` (Phoenix name, link tampering, GET does not approve)
- `design-studio-routes.test.ts` (option vocabulary)
- `apps/worker/test/chat-inbox.test.ts` (non-text fields)
- `outbound-approval.test.ts`

Chaos was not run: the shared project is locked. No paid call was made. Migration 071 replaces
`studio_scope_budget_internal` and `office_call_cost_evidence`. Integrate it after any other
branch's migration that also replaces them, and re-apply its changes on top.

## Open

- Pass a failed plan's code to Core (`canva-draft-workflow.ts`, durability stream), so the planner's
  `SPENDING_POLICY_EXPIRED` reaches the office alert by name. Today the plan row and the logs carry
  it.
- Name `spendingPolicy` in the watchdog's alert text. It already alerts on `expiring` and `expired`
  as a degraded Core.
- Let trusted-office administrators attest planner calls. That route belongs to Codex.
- Before deploy: confirm `AUTO_GENERATE_CHAT_DESIGNS=true` in `.env.production`, and remove the
  unused variables.
