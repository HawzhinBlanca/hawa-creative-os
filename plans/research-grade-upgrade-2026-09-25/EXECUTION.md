# Completion checkpoint

Updated 2026-09-26 after the user requested faster, more economical completion.
Branch: `codex/research-grade-design-system`. Scope and acceptance remain in `PLAN.md` and `WORK_ITEMS.csv`.

## Working method

- Finish connected user journeys with their failure recovery and acceptance evidence. Keep the existing architecture.
- During implementation, run the affected unit, integration and failure tests. Run the full required release checks at a coherent milestone before qualification or deployment; repeat them for concrete new risk or changed code.
- Batch source, tests, traceability and one concise evidence update. Seal a release candidate once it is actually ready for that gate. Do not create another seal solely to rephrase status.
- Read this checkpoint and the relevant source/evidence sections on continuation. Use scoped searches and short logs. Maintain the historical evidence without copying its whole history into every update.
- Keep engineering, live-operation and human-quality acceptance separate. Complete available engineering while real corpus preparation and human review remain pending; no synthetic result substitutes for them.
- Reuse fixtures, the existing Restate workflow and the pinned dependency stack. Add a dependency or redesign only when a measured need justifies it.

## Current result

The R10 encrypted Restate archive rehearsal now boots a disposable offline node from a signed recovery pair. A synthetic durable state record survived the archive/restore path. Focused evidence is in `R10_EVIDENCE.md` and `R10_RESTORE_DRILL.json`. This does not close clean-host journal replay or production recovery.

## Next useful milestone

Close one request journey: intake → draft → requested changes → revised capture → approval → pinned delivery. Exercise restart, duplicate input and lost responses across the same journey. The current lifecycle has first-review-only revision assumptions and no complete ChatInbox question/answer/cutover path. Implement the linked worker, Core, Desk and database changes together; do not qualify isolated helpers as the finished journey.

Then qualify client-general final exports (R11–R19), finish the remaining provider boundaries (R20–R23), and run the canary, recovery and blind human admission work (R24–R27). All original acceptance criteria stay in force. The deployed build and new design flags have not changed.
