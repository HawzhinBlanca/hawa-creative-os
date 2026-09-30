# Reliability and design implementation — 2026-09-30

Owner request: implement the reliability plan; then review and improve Claude's six-image and art-direction work. Branch: `codex/reliability-and-design-hardening`. Base: `051d5606` (Sol office primary). Work happens in an isolated managed worktree.

## Execution and evidence

| Workstream | Changes / gate | Current evidence |
|---|---|---|
| Office and worker boundaries | ADR-163; verified nginx proof, office cookie CSRF, legacy operator value retired into the scoped design principal for safe previous-Core rollback, minimal worker environment, matching configuration revision | Local real-auth tests pass; exact sealed release and live readback still required |
| Provider configuration | ADR-165; retire transient browser overrides; canonical host credentials, verified coordinated deploy, atomic update and value-free audit | Core negative controls pass; no production credential rotated |
| Review / cost recovery | ADR-164; explicit shared-office exact-call cost receipts; visible saved findings, administrator read of worker plans, unknown APCA shown as unmeasured | Local SQL/HTTP/restart/accounting and Desk tests pass; deployment pending |
| Recovery | Exact-release crash/duplicate/ambiguous-effect/rollback scenarios and clean-host restore; preserve RPO ≤15m and RTO ≤4h | Prepare and run against this final candidate; historical runs are not reused as current proof |
| Model/design evaluation | Freeze baseline/candidate, 200-case corpus and independent lineage splits; strict cost ceiling; adversarial and native-language labels | Existing preregistration/corpus/study tools retained. Additional API budget and historical brief authorization requested; no paid 200-case batch admitted |
| Product admission | Genuine native edit → approve → export → deliver/reconcile; 100 real tasks, 3 clients, zero critical escapes and ≥95% completion without technical rescue | Requires genuine office operation and reviewer evidence; fixtures never count as pilot tasks |
| Claude design integration | Read completed photo-burst and art-direction branches, verify all six photos have independent reports and required coverage; assess composition against reference and plain baseline | Photo-burst branch sealed; art-direction branch still being edited. Do not merge incomplete work or repeat its implementation |

## Efficiency constraints

Use existing durable workflows, receipts, test isolation, provider adapters, rendering and study tools. Add no multi-agent framework, orchestration product or speculative dependency. Run focused regressions as repairs are made, then one complete release gate and exact candidate recovery suite. Paid acceptance-unknown calls are never blindly replayed. Do not claim research superiority, native language correctness, pilot acceptance or flawless operation without their actual evidence.

Production remains on its current sealed release until the integrated candidate passes the gates. Production hosting separation remains a prepared migration plan: purchasing a host requires the owner's selection; local code cannot make that physical separation true.
