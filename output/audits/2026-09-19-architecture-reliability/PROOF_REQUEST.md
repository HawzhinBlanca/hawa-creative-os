# Completion request: show proof, not reassurance
Use this with the implementing agent or team.

Implement the tasks in TASK_SHEET.md without changing the selected architectural foundations unless a measured need and approved ADR justify it. This audit is a baseline, not permission to deploy or spend.

For EACH task, return:

1. **Claim and scope:** task ID, exact requirement IDs, affected workflows/clients, commit/tree state, image digests, migration, feature flags and relevant model/prompt/QA versions.
2. **Before/after counterexample:** an automated or faithfully recorded reproduction that fails on the baseline and passes after the repair. Include adversarial negatives, not just happy paths.
3. **What actually ran:** exact commands, UTC timestamps, environment identity, exit codes, test totals and all failures/skips. Clearly separate mocks, real isolated DB, external staging and production.
4. **Raw evidence:** logs plus machine-readable outcomes; request/invocation/receipt IDs; DB rows/queries; actual remote object counts and read-back; artifact/checksum chain. Redact secrets and personal data. Screenshots support visual claims but do not prove durability.
5. **Independent checking:** a reviewer who did not author the fix reruns the critical probe and inspects the raw artifacts. A second AI opinion alone is not human design or security certification.
6. **Change and recovery safety:** migration/rollback proof, preservation of existing tasks/data, tested failure windows, cost limits and any required authorization.
7. **Result:** PASS, FAIL, PARTIAL, BLOCKED or NOT_RUN, with residual risk and next action. Nothing may be marked PASS with a mandatory sub-proof missing.

Submit one versioned proof manifest with SHA-256 hashes and an index linking every claim to its artifact. Hashes show integrity, not truth: the reviewer must verify provenance and behavior. Preserve unsuccessful runs and predeclare thresholds; report the complete denominator and every retry.

Rejected as completion proof:
- “All tests passed” without raw output, test scope and applicable acceptance gates.
- “Restate is durable,” “PostgreSQL has RLS,” or “a hash exists” without the actual crash/isolation/content test.
- Fresh mocks pretending to be real-provider receipts or production lifecycle counts.
- Tests that set `status=complete`, hardcode a score, always abstain or skip unknown values into success.
- A local source revision, declared stamp or healthy container used as proof that production runs the repaired feature.
- A schema-only restore or same-server dump check described as clean-host business recovery.
- AI-written human ratings, selected beautiful examples, self-judging alone, or undocumented post-result threshold changes.
- “Exactly once,” “zero risk,” “100% secure,” or “10/10” without a narrow measurable scope.

Final release answer must say:
“Qualified for [scope] on [build/configuration], with [remaining limitations], supported by [proof manifest].”
If the mandatory evidence does not exist, say:
“Not qualified yet. Missing or failing proof: [specific list].”

Do not erase or rewrite the audit to obtain a green result. Append remediation evidence and independently demonstrate that the counterexamples no longer hold.
