# Acceptance Gates

## Release verdicts

`scripts/enforce_release_gate.sh` is a **source and engineering preflight**. A passing run means its eight technical stages passed for a clean, tracked checkout; it does not admit the deployed product or establish design quality. `--require-admission` fails while current-candidate product evidence is open. `--skip-tests` cannot pass engineering preflight.

The previous 2026-09-21 `RELEASE_GATE_EVIDENCE.json` said `QUALIFIED` with `cleanTree: false` and Gate F unrun. That verdict is historical and invalid for the current candidate. The old script also assigned unconditional passes to Gates B and G and read other gates from older drill files. No historical drill can be silently promoted to current-candidate proof. R27 must verify the deployed image receipt, exact candidate commit and manifest hash, task/export hashes, dated gate evidence, and the independent human study before a product-admission verdict is possible.

## Gate A — Studio proof

- all critical Phase 0 tests pass;
- 40 synthetic and 20 real Sorani designs pass;
- editable source round-trip and exports pass;
- no silent overwrites/corruption;
- fallback path documented.

## Gate B — Security/client isolation

- zero unauthorized cross-client reads in API, search, retrieval, assets, source, traces, and signed URLs;
- prompt injection cannot change privileged state;
- least-privilege Google and worker credentials proven;
- WAHA/Comfy isolation proven.

## Gate C — Durable operation

- duplicate/out-of-order events create one logical task;
- API/worker/Restate/DB restart drills recover;
- ambiguous external success does not duplicate effects;
- manual pause/resume/replay audited;
- stuck/failure states show safe action.

## Gate D — Model/retrieval quality

- 200-task tournament complete;
- role winners/fallbacks selected by evidence;
- routing threshold and abstention calibrated;
- brief fact invention rate zero in critical holdout;
- retrieval cross-client leakage zero;
- positive/negative example rules pass.

## Gate E — Design QA

- exact copy, names, prices, dates, URLs, dimensions, and official assets have zero escapes;
- every completed design has editable source;
- visual judge defect performance measured and cannot override hard QA;
- repair cap and human escalation work.

## Gate F — Human review

- approval binds exact revision/QC hash;
- post-approval edits invalidate approval;
- role/stage policies enforced;
- node comments and direct edits create new revisions/diffs;
- mobile/desktop review usable by pilot staff.
- blind, randomized human comparison of final exports on the sealed current-candidate corpus, including native-language review and disagreement, meets the pre-registered quality threshold. Review-workflow tests alone do not satisfy this condition.

## Gate G — Publication

- Drive/Sheet retries/reconciliation converge;
- one task/revision produces one logical package/row;
- read-back verification succeeds;
- source package is complete and re-openable;
- chat-notification failure does not corrupt publication.

## Gate H — Recovery

- clean-host restore passes within RPO/RTO targets;
- representative editable sources and tasks recover;
- paused workflow resumes safely;
- Drive/Sheet state reconciles;
- backup encryption/retention verified.

## Pilot exit

- three representative clients live;
- at least 100 production tasks completed;
- no critical security/factual/editability escapes;
- ≥95% workflows complete without technical rescue;
- quality/revision baseline established;
- operators can follow runbooks;
- management explicitly accepts remaining known risks.
